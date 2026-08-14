/**
 * Settings-owned MCP server catalog: persist UI-managed servers and mount
 * one mcp-client child fiber per enabled record.
 * @module @deepseek-ai/dsh-mcp-settings
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import {
  countMcpTools,
  emptyMcpSettingsDocument,
  MCP_CLIENT_MODULE,
  parseMcpSettingsDocument,
  removeMcpServerRecord,
  serializeMcpSettingsDocument,
  toMcpClientConfig,
  upsertMcpServerRecord,
  viewCompositionConfig,
  viewMcpServerRecord,
  type McpServerRecord,
  type McpSettingsDocument,
} from './document.ts'
import type {
  McpServerFiberPhase,
  McpServerRemoveRequest,
  McpServerUpsertRequest,
  McpServerView,
  McpSettingsMutationResult,
  McpSettingsSnapshot,
} from './types.ts'

export type * from './types.ts'
export {
  emptyMcpSettingsDocument,
  MCP_CLIENT_MODULE,
  MCP_SETTINGS_DOCUMENT_FILENAME,
  MCP_SETTINGS_DOCUMENT_VERSION,
  parseMcpSettingsDocument,
  removeMcpServerRecord,
  serializeMcpSettingsDocument,
  toMcpClientConfig,
  upsertMcpServerRecord,
  viewCompositionConfig,
  viewMcpServerRecord,
} from './document.ts'
export type { McpHttpRecord, McpServerRecord, McpSettingsDocument, McpStdioRecord } from './document.ts'

/** Plugin config: path of the Settings-owned MCP server document. */
export interface Config {
  /** Absolute path of `mcp-servers.json`. */
  readonly path: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings-owned MCP server catalog and generated Remote. */
    mcpSettings: McpSettingsGateway
  }
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, McpServerFiberPhase>

/**
 * Host Remote that stores UI-managed MCP servers and mounts mcp-client
 * children for enabled Settings-origin records.
 */
export class McpSettingsGateway extends TypertRemoteService {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    path: z.string().required(),
  })

  private readonly filename: string
  private document: McpSettingsDocument = emptyMcpSettingsDocument()
  private readonly fibers = new Map<string, Fiber>()
  private chain: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context carrying `ctx.tools`.
   * @param config - resolved document path.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpSettings')
    this.filename = resolve(config.path)
  }

  /** Read the document and mount enabled Settings-origin servers. */
  protected async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    this.syncAll()
    this.ctx.effect(() => async () => {
      const names = [...this.fibers.keys()]
      for (const name of names) await this.dropFiber(name)
    }, 'mcp-settings.dispose-children')
  }

  /**
   * Project Settings-owned records and composition-owned mcp-client rows.
   * Secret maps contribute keys only. Each row includes the live fiber phase
   * and the number of globally registered tools in that server's namespace.
   * @returns the current catalog snapshot.
   */
  @Remote('list')
  list(): Promise<McpSettingsSnapshot> {
    return this.enqueue(() => Promise.resolve({ servers: this.snapshot() }))
  }

  /**
   * Create or replace one Settings-owned MCP server and remount its fiber.
   * A distinct `fromServerName` renames that Settings row in place, keeps
   * omitted env/headers, and remounts tools under the new namespace.
   * @param request - create, replace, or rename payload.
   * @returns acknowledgement after the document commit.
   */
  @Remote('upsert')
  upsert(request: McpServerUpsertRequest): Promise<McpSettingsMutationResult> {
    return this.enqueue(async () => {
      this.assertNotComposition(request.serverName, 'upsert')
      const fromName = request.fromServerName
      if (fromName !== undefined && fromName !== request.serverName) {
        this.assertNotComposition(fromName, 'upsert')
      }
      this.document = upsertMcpServerRecord(this.document, request)
      await this.persist()
      if (fromName !== undefined && fromName !== request.serverName) {
        await this.dropFiber(fromName)
      }
      const record = this.document.servers.find(server => server.serverName === request.serverName)
      /* v8 ignore start -- upsertMcpServerRecord always inserts or replaces request.serverName */
      if (record === undefined) {
        throw new Error(`mcp-settings: upsert did not persist ${JSON.stringify(request.serverName)}`)
      }
      /* v8 ignore stop */
      await this.syncRecord(record)
      return { ok: true as const }
    })
  }

  /**
   * Delete one Settings-owned MCP server and dispose its fiber.
   * @param request - namespace to delete.
   * @returns acknowledgement after the document commit.
   */
  @Remote('delete')
  delete(request: McpServerRemoveRequest): Promise<McpSettingsMutationResult> {
    return this.enqueue(async () => {
      this.assertNotComposition(request.serverName, 'delete')
      if (!this.document.servers.some(server => server.serverName === request.serverName)) {
        throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(request.serverName)}`)
      }
      this.document = removeMcpServerRecord(this.document, request.serverName)
      await this.persist()
      await this.dropFiber(request.serverName)
      return { ok: true as const }
    })
  }

  private snapshot(): McpServerView[] {
    const toolNames = this.toolNames()
    const settings = this.document.servers.map((record) => {
      const fiber = this.fibers.get(record.serverName)
      return viewMcpServerRecord(
        record,
        'settings',
        fiberPhase(fiber),
        countMcpTools(toolNames, record.serverName),
      )
    })
    return [...settings, ...this.compositionViews(toolNames)]
  }

  private compositionViews(toolNames: readonly string[] = this.toolNames()): McpServerView[] {
    const views: McpServerView[] = []
    for (const entry of this.loaderEntries()) {
      if (entry.options.name !== MCP_CLIENT_MODULE) continue
      const view = viewCompositionConfig(
        entry.options.config,
        !entry.disabled,
        fiberPhase(entry.fiber),
        toolNames,
      )
      if (view !== null) views.push(view)
    }
    return views
  }

  private toolNames(): readonly string[] {
    return this.ctx.tools.schemas().map(schema => schema.name)
  }

  private compositionNames(): Set<string> {
    return new Set(this.compositionViews().map(view => view.serverName))
  }

  private assertNotComposition(serverName: string, action: 'upsert' | 'delete'): void {
    if (this.compositionNames().has(serverName)) {
      throw new Error(
        `mcp-settings: cannot ${action} ${JSON.stringify(serverName)} because a composition mcp-client row already owns that serverName`,
      )
    }
  }

  private syncAll(): void {
    for (const record of this.document.servers) {
      if (record.enabled && !this.compositionNames().has(record.serverName)) {
        this.mount(record)
      }
    }
  }

  private async syncRecord(record: McpServerRecord): Promise<void> {
    await this.dropFiber(record.serverName)
    if (record.enabled && !this.compositionNames().has(record.serverName)) {
      this.mount(record)
    }
  }

  private mount(record: McpServerRecord): void {
    const fiber = this.ctx.plugin({
      name: mcpClient.name,
      inject: mcpClient.inject,
      Config: mcpClient.Config,
      apply: mcpClient.apply,
    }, toMcpClientConfig(record))
    this.fibers.set(record.serverName, fiber)
    void Promise.resolve(fiber).then(
      () => undefined,
      (error: unknown) => { this.ctx.logger.warn(error) },
    )
  }

  private async dropFiber(serverName: string): Promise<void> {
    const fiber = this.fibers.get(serverName)
    if (fiber === undefined) return
    this.fibers.delete(serverName)
    await fiber.dispose()
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(this.filename, serializeMcpSettingsDocument(this.document), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private async readDocument(): Promise<McpSettingsDocument> {
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return emptyMcpSettingsDocument()
      throw error
    }
    return parseMcpSettingsDocument(text)
  }

  private loaderEntries(): Iterable<{
    readonly options: { readonly name: string; readonly config?: unknown }
    readonly disabled?: boolean | null
    readonly fiber?: Fiber
  }> {
    const loader = this.ctx.get('loader')
    if (loader === undefined) return []
    return loader.entries()
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Read the Fiber phase used by the Settings projection.
 * @param fiber - live child or Loader fiber, if any.
 * @returns the public phase, or null when nothing is mounted.
 */
function fiberPhase(fiber: Fiber | undefined): McpServerFiberPhase {
  return fiber === undefined ? null : FIBER_PHASE[fiber.state]
}

/**
 * Whether a filesystem error means the Settings document is absent.
 * @param error - caught rejection.
 * @returns true only for ENOENT.
 */
function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export default McpSettingsGateway
