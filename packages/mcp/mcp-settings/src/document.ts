/**
 * On-disk Settings document for UI-managed MCP servers.
 * @module @deepseek-ai/dsh-mcp-settings/document
 */

import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type {
  McpHttpServerView,
  McpServerFiberPhase,
  McpServerOrigin,
  McpServerUpsertRequest,
  McpServerView,
  McpStdioServerView,
} from './types.ts'

/** Current Settings document envelope version. */
export const MCP_SETTINGS_DOCUMENT_VERSION = 1

/** Default filename under the harness home. */
export const MCP_SETTINGS_DOCUMENT_FILENAME = 'mcp-servers.json'

/** Module specifier of every Settings-owned and composition-owned MCP client. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** One persisted stdio MCP server. */
export interface McpStdioRecord {
  readonly transport: 'stdio'
  readonly serverName: string
  readonly enabled: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

/** One persisted Streamable HTTP MCP server. */
export interface McpHttpRecord {
  readonly transport: 'streamable-http'
  readonly serverName: string
  readonly enabled: boolean
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

/** One persisted Settings-owned MCP server. */
export type McpServerRecord = McpStdioRecord | McpHttpRecord

/** Durable Settings document stored under the harness home. */
export interface McpSettingsDocument {
  readonly version: typeof MCP_SETTINGS_DOCUMENT_VERSION
  readonly servers: readonly McpServerRecord[]
}

/**
 * Return an empty Settings document.
 * @returns version 1 document with no servers.
 */
export function emptyMcpSettingsDocument(): McpSettingsDocument {
  return { version: MCP_SETTINGS_DOCUMENT_VERSION, servers: [] }
}

/**
 * Parse and validate a Settings document body.
 * @param text - UTF-8 JSON file contents.
 * @returns the validated document.
 */
export function parseMcpSettingsDocument(text: string): McpSettingsDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('mcp-settings: document is not valid JSON', { cause })
  }
  if (!isRecord(parsed)) {
    throw new Error('mcp-settings: document must be a JSON object')
  }
  assertKnownKeys(parsed, ['version', 'servers'], 'document')
  if (parsed.version !== MCP_SETTINGS_DOCUMENT_VERSION) {
    throw new Error(`mcp-settings: unsupported document version ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.servers)) {
    throw new Error('mcp-settings: document.servers must be an array')
  }
  const servers = parsed.servers.map((entry, index) => parseRecord(entry, `servers[${index}]`))
  const names = new Set<string>()
  for (const server of servers) {
    if (names.has(server.serverName)) {
      throw new Error(`mcp-settings: duplicate serverName ${JSON.stringify(server.serverName)}`)
    }
    names.add(server.serverName)
  }
  return { version: MCP_SETTINGS_DOCUMENT_VERSION, servers }
}

/**
 * Serialize a Settings document as stable JSON.
 * @param document - validated document.
 * @returns UTF-8 JSON with a trailing newline.
 */
export function serializeMcpSettingsDocument(document: McpSettingsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Apply an upsert to a document. `env` / `headers` omission keeps the stored map.
 * A distinct `fromServerName` replaces that Settings row in place.
 * @param document - current document.
 * @param request - create, replace, or rename payload.
 * @returns a new document.
 */
export function upsertMcpServerRecord(
  document: McpSettingsDocument,
  request: McpServerUpsertRequest,
): McpSettingsDocument {
  const nextName = parseServerName(request.serverName)
  const fromName = request.fromServerName === undefined
    ? nextName
    : parseServerName(request.fromServerName, 'fromServerName')
  const existing = document.servers.find(server => server.serverName === fromName)
  if (fromName !== nextName) {
    if (existing === undefined) {
      throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(fromName)}`)
    }
    if (document.servers.some(server => server.serverName === nextName)) {
      throw new Error(
        `mcp-settings: cannot rename ${JSON.stringify(fromName)} to ${JSON.stringify(nextName)} because that serverName is already in use`,
      )
    }
  }
  const next = mergeRecord(existing, request)
  const servers = existing === undefined
    ? [...document.servers, next]
    : document.servers.map(server => server.serverName === fromName ? next : server)
  return { version: MCP_SETTINGS_DOCUMENT_VERSION, servers }
}

/**
 * Remove one Settings-owned server.
 * @param document - current document.
 * @param serverName - namespace to delete.
 * @returns the document without that server.
 */
export function removeMcpServerRecord(
  document: McpSettingsDocument,
  serverName: string,
): McpSettingsDocument {
  return {
    version: MCP_SETTINGS_DOCUMENT_VERSION,
    servers: document.servers.filter(server => server.serverName !== serverName),
  }
}

/**
 * Convert a persisted record into mcp-client plugin config.
 * @param record - Settings-owned server.
 * @returns config matching mcp-client's schema defaults.
 */
export function toMcpClientConfig(record: McpServerRecord): McpClientConfig {
  switch (record.transport) {
    case 'stdio':
      return {
        transport: 'stdio',
        serverName: record.serverName,
        command: record.command,
        args: [...record.args],
        env: { ...record.env },
        cwd: record.cwd,
        toolCallTimeoutMs: record.toolCallTimeoutMs,
        failOnStartupError: record.failOnStartupError,
      }
    case 'streamable-http':
      return {
        transport: 'streamable-http',
        serverName: record.serverName,
        url: record.url,
        headers: { ...record.headers },
        toolCallTimeoutMs: record.toolCallTimeoutMs,
        failOnStartupError: record.failOnStartupError,
      }
    /* v8 ignore start -- transport union is exhaustive at the type boundary */
    default: {
      const exhaustive: never = record
      return exhaustive
    }
    /* v8 ignore stop */
  }
}

/**
 * Public-name prefix mcp-client uses for every tool in one server namespace.
 * @param serverName - MCP `serverName` (1–32 `[A-Za-z0-9_-]`).
 * @returns `mcp__<serverName>__`, including the trailing separators.
 */
export function mcpToolNamePrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/**
 * Count globally registered tools owned by one MCP server namespace.
 * The prefix includes the trailing separators so `js` does not count `js_extra`.
 * @param names - public tool names from the global `ctx.tools` view.
 * @param serverName - MCP `serverName`.
 * @returns matching name count.
 */
export function countMcpTools(names: readonly string[], serverName: string): number {
  const prefix = mcpToolNamePrefix(serverName)
  let count = 0
  for (const name of names) {
    if (name.startsWith(prefix)) count += 1
  }
  return count
}

/**
 * Project a Settings-owned record for the Remote, omitting secret values.
 * @param record - persisted server.
 * @param origin - settings vs composition.
 * @param fiberPhase - live fiber phase.
 * @param toolCount - globally registered tools in this server's namespace.
 * @returns client-safe view.
 */
export function viewMcpServerRecord(
  record: McpServerRecord,
  origin: McpServerOrigin,
  fiberPhase: McpServerFiberPhase,
  toolCount: number,
): McpServerView {
  switch (record.transport) {
    case 'stdio': {
      const view: McpStdioServerView = {
        serverName: record.serverName,
        origin,
        enabled: record.enabled,
        fiberPhase,
        toolCount,
        transport: 'stdio',
        command: record.command,
        args: [...record.args],
        cwd: record.cwd,
        envKeys: Object.keys(record.env),
        headerKeys: [],
        toolCallTimeoutMs: record.toolCallTimeoutMs,
        failOnStartupError: record.failOnStartupError,
      }
      return view
    }
    case 'streamable-http': {
      const view: McpHttpServerView = {
        serverName: record.serverName,
        origin,
        enabled: record.enabled,
        fiberPhase,
        toolCount,
        transport: 'streamable-http',
        url: record.url,
        envKeys: [],
        headerKeys: Object.keys(record.headers),
        toolCallTimeoutMs: record.toolCallTimeoutMs,
        failOnStartupError: record.failOnStartupError,
      }
      return view
    }
    /* v8 ignore start -- transport union is exhaustive at the type boundary */
    default: {
      const exhaustive: never = record
      return exhaustive
    }
    /* v8 ignore stop */
  }
}

/**
 * Best-effort projection of a composition-owned mcp-client config.
 * Secret maps contribute keys only. Unrecognized config yields null.
 * @param config - Loader entry config after interpolation.
 * @param enabled - Loader enablement.
 * @param fiberPhase - live fiber phase.
 * @param toolNames - public tool names from the global `ctx.tools` view.
 * @returns a read-only view, or null when the config is not an MCP client.
 */
export function viewCompositionConfig(
  config: unknown,
  enabled: boolean,
  fiberPhase: McpServerFiberPhase,
  toolNames: readonly string[] = [],
): McpServerView | null {
  if (!isRecord(config) || typeof config.serverName !== 'string') return null
  if (!SERVER_NAME_PATTERN.test(config.serverName)) return null
  const toolCount = countMcpTools(toolNames, config.serverName)
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string') return null
    return viewMcpServerRecord({
      transport: 'stdio',
      serverName: config.serverName,
      enabled,
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter(item => typeof item === 'string') : [],
      env: stringMap(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
      failOnStartupError: config.failOnStartupError === true,
    }, 'composition', fiberPhase, toolCount)
  }
  if (config.transport === 'streamable-http') {
    if (typeof config.url !== 'string') return null
    return viewMcpServerRecord({
      transport: 'streamable-http',
      serverName: config.serverName,
      enabled,
      url: config.url,
      headers: stringMap(config.headers),
      toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
      failOnStartupError: config.failOnStartupError === true,
    }, 'composition', fiberPhase, toolCount)
  }
  return null
}

function mergeRecord(existing: McpServerRecord | undefined, request: McpServerUpsertRequest): McpServerRecord {
  const enabled = request.enabled ?? existing?.enabled ?? true
  const toolCallTimeoutMs = request.toolCallTimeoutMs
    ?? existing?.toolCallTimeoutMs
    ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  const failOnStartupError = request.failOnStartupError
    ?? existing?.failOnStartupError
    ?? false
  switch (request.transport) {
    case 'stdio':
      return {
        transport: 'stdio',
        serverName: parseServerName(request.serverName),
        enabled,
        command: requiredString(request.command, 'command'),
        args: request.args === undefined ? [] : parseStringArray(request.args, 'args'),
        env: request.env ?? (existing?.transport === 'stdio' ? existing.env : {}),
        cwd: request.cwd ?? '',
        toolCallTimeoutMs,
        failOnStartupError,
      }
    case 'streamable-http':
      return {
        transport: 'streamable-http',
        serverName: parseServerName(request.serverName),
        enabled,
        url: requiredString(request.url, 'url'),
        headers: request.headers ?? (existing?.transport === 'streamable-http' ? existing.headers : {}),
        toolCallTimeoutMs,
        failOnStartupError,
      }
    /* v8 ignore start -- upsert transport union is exhaustive at the type boundary */
    default: {
      const exhaustive: never = request
      return exhaustive
    }
    /* v8 ignore stop */
  }
}

function parseRecord(value: unknown, label: string): McpServerRecord {
  if (!isRecord(value)) {
    throw new Error(`mcp-settings: ${label} must be an object`)
  }
  const serverName = parseServerName(value.serverName, label)
  const enabled = value.enabled === undefined ? true : parseBoolean(value.enabled, `${label}.enabled`)
  const toolCallTimeoutMs = value.toolCallTimeoutMs === undefined
    ? DEFAULT_TOOL_CALL_TIMEOUT_MS
    : parsePositive(value.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`)
  const failOnStartupError = value.failOnStartupError === undefined
    ? false
    : parseBoolean(value.failOnStartupError, `${label}.failOnStartupError`)
  if (value.transport === 'stdio') {
    assertKnownKeys(value, [
      'transport', 'serverName', 'enabled', 'command', 'args', 'env', 'cwd',
      'toolCallTimeoutMs', 'failOnStartupError',
    ], label)
    return {
      transport: 'stdio',
      serverName,
      enabled,
      command: requiredString(value.command, `${label}.command`),
      args: parseStringArray(value.args, `${label}.args`),
      env: parseStringMap(value.env, `${label}.env`),
      cwd: parseCwd(value.cwd, `${label}.cwd`),
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  if (value.transport === 'streamable-http') {
    assertKnownKeys(value, [
      'transport', 'serverName', 'enabled', 'url', 'headers',
      'toolCallTimeoutMs', 'failOnStartupError',
    ], label)
    return {
      transport: 'streamable-http',
      serverName,
      enabled,
      url: requiredString(value.url, `${label}.url`),
      headers: parseStringMap(value.headers, `${label}.headers`),
      toolCallTimeoutMs,
      failOnStartupError,
    }
  }
  throw new Error(`mcp-settings: ${label}.transport must be "stdio" or "streamable-http"`)
}

function parseServerName(value: unknown, label = 'serverName'): string {
  const serverName = requiredString(value, label)
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`mcp-settings: ${label} must match [A-Za-z0-9_-]{1,32}`)
  }
  return serverName
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`mcp-settings: ${label} must be a non-empty string`)
  }
  return value
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`mcp-settings: ${label} must be a boolean`)
  }
  return value
}

function parsePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`mcp-settings: ${label} must be a positive number`)
  }
  return value
}

function parseCwd(value: unknown, label: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    throw new Error(`mcp-settings: ${label} must be a string`)
  }
  return value
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`mcp-settings: ${label} must be an array of strings`)
  }
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`mcp-settings: ${label} must be an array of strings`)
    }
    items.push(item)
  }
  return items
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error(`mcp-settings: ${label} has unknown key ${JSON.stringify(key)}`)
    }
  }
}

function parseStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new Error(`mcp-settings: ${label} must be an object of strings`)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`mcp-settings: ${label}.${key} must be a string`)
    }
    result[key] = entry
  }
  return result
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
