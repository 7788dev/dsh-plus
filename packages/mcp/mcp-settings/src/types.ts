/**
 * Public request and view vocabulary for UI-managed MCP servers.
 * This module contains types only so generated Remote clients can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-mcp-settings/types
 */

/** Where one visible MCP server came from. */
export type McpServerOrigin = 'settings' | 'composition'

/** Lifecycle of the mcp-client fiber that currently serves this server. */
export type McpServerFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** Transport used to reach one MCP server. */
export type McpServerTransport = 'stdio' | 'streamable-http'

/** Shared fields every Settings-page row carries. */
interface McpServerViewBase {
  /** Model-facing namespace (`mcp__<serverName>__…`). */
  readonly serverName: string
  /** Whether this row is owned by the Settings document or a cordis composition. */
  readonly origin: McpServerOrigin
  /** Whether the Settings document (or Loader entry) currently enables the server. */
  readonly enabled: boolean
  /** Current mcp-client fiber phase, or null when nothing is mounted. */
  readonly fiberPhase: McpServerFiberPhase
  /**
   * Globally registered tools whose public names start with
   * `mcp__<serverName>__`. An active fiber can still report `0` while the
   * first `tools/list` is in flight.
   */
  readonly toolCount: number
  /** Transport used to reach the server. */
  readonly transport: McpServerTransport
  /** Names of configured environment keys; values never leave the Host. */
  readonly envKeys: readonly string[]
  /** Names of configured HTTP header keys; values never leave the Host. */
  readonly headerKeys: readonly string[]
  /** Per-call timeout forwarded to mcp-client. */
  readonly toolCallTimeoutMs: number
  /** Whether an initial connect failure rejects the mcp-client fiber. */
  readonly failOnStartupError: boolean
}

/** stdio MCP server as shown to a trusted client. */
export interface McpStdioServerView extends McpServerViewBase {
  readonly transport: 'stdio'
  /** Executable spawned for the server. */
  readonly command: string
  /** Arguments passed without a shell. */
  readonly args: readonly string[]
  /** Working directory for the child process. */
  readonly cwd: string
}

/** Streamable HTTP MCP server as shown to a trusted client. */
export interface McpHttpServerView extends McpServerViewBase {
  readonly transport: 'streamable-http'
  /** MCP endpoint URL. */
  readonly url: string
}

/** One MCP server projected to the Settings page. */
export type McpServerView = McpStdioServerView | McpHttpServerView

/** Point-in-time catalog returned by `mcpSettings/list`. */
export interface McpSettingsSnapshot {
  readonly servers: readonly McpServerView[]
}

/** Create or replace one Settings-owned stdio MCP server. */
export interface McpStdioUpsertRequest {
  readonly transport: 'stdio'
  readonly serverName: string
  /**
   * Settings-owned namespace to replace when renaming.
   * Omit, or set equal to `serverName`, to create or replace `serverName`.
   * When it differs, omitted env stays with that row; the row must exist,
   * and `serverName` must not already name another Settings server.
   */
  readonly fromServerName?: string
  readonly enabled?: boolean
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /**
   * Replacement environment map. Omission keeps the stored map on edit and
   * stores `{}` on create.
   */
  readonly env?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
}

/** Create or replace one Settings-owned HTTP MCP server. */
export interface McpHttpUpsertRequest {
  readonly transport: 'streamable-http'
  readonly serverName: string
  /**
   * Settings-owned namespace to replace when renaming.
   * Omit, or set equal to `serverName`, to create or replace `serverName`.
   * When it differs, omitted headers stay with that row; the row must exist,
   * and `serverName` must not already name another Settings server.
   */
  readonly fromServerName?: string
  readonly enabled?: boolean
  readonly url: string
  /**
   * Replacement header map. Omission keeps the stored map on edit and
   * stores `{}` on create.
   */
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly failOnStartupError?: boolean
}

/** Create or replace one Settings-owned MCP server. */
export type McpServerUpsertRequest = McpStdioUpsertRequest | McpHttpUpsertRequest

/** Delete one Settings-owned MCP server by namespace. */
export interface McpServerRemoveRequest {
  readonly serverName: string
}

/** Acknowledgement after a durable Settings mutation. */
export interface McpSettingsMutationResult {
  readonly ok: true
}
