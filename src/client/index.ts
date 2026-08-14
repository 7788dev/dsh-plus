/** MCP server catalog registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import mcpSettingsRemote from '../remote.js'
import type { McpServerUpsertRequest, McpSettingsSnapshot } from '../types.ts'
import { McpSettingsTab, type McpSettingsTabInjected } from './McpSettingsTab.tsx'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'

export type { McpSettingsTabInjected, McpSettingsTabProps } from './McpSettingsTab.tsx'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP server catalog copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Services required by the Settings registration; mcpSettings is mounted in apply. */
export const inject = ['slots', 'locale', 'remote']

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

type McpSettingsRemote = {
  list: () => Promise<RemoteResult<McpSettingsSnapshot>>
  upsert: (request: McpServerUpsertRequest) => Promise<RemoteResult<{ ok: true }>>
  delete: (request: { serverName: string }) => Promise<RemoteResult<{ ok: true }>>
}

/**
 * Mount the Host Remote if this dsh assembly did not already, then contribute the MCP tab.
 * @param ctx - browser plugin context carrying slots, locale, and the Client Remote.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const remote = ctx.remote as ClientContext['remote'] & { mcpSettings?: McpSettingsRemote }
  if (remote.mcpSettings === undefined) {
    const unmount = await ctx.remote.$mount(mcpSettingsRemote)
    ctx.effect(() => unmount, 'dsh-plus: mcpSettings remote')
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')

  const t = ctx.locale.bind(NS)
  const wrap = async <T>(
    result: Promise<RemoteResult<T>>,
    name: string,
  ): Promise<T> => {
    const resolved = await result
    if (!resolved.ok) {
      throw new Error(`${name} failed: ${resolved.error.code}: ${resolved.error.message}`)
    }
    return resolved.value
  }
  const mcpSettings = (ctx.remote as ClientContext['remote'] & { mcpSettings: McpSettingsRemote }).mcpSettings
  const injected = (): McpSettingsTabInjected => ({
    list: () => wrap(mcpSettings.list(), 'mcpSettings.list'),
    upsert: async (request) => {
      await wrap(mcpSettings.upsert(request), 'mcpSettings.upsert')
    },
    remove: async (serverName) => {
      await wrap(mcpSettings.delete({ serverName }), 'mcpSettings.delete')
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcp',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, McpSettingsTab))
}
