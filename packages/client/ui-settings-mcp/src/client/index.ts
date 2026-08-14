/** MCP server catalog registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
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

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.mcpSettings']

/**
 * Contribute the MCP tab to the Plugins settings section.
 * @param ctx - browser plugin context carrying slots, locale, and the generated Remote.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')

  const t = ctx.locale.bind(NS)
  const wrap = async <T>(
    result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>,
    name: string,
  ): Promise<T> => {
    const resolved = await result
    if (!resolved.ok) {
      throw new Error(`${name} failed: ${resolved.error.code}: ${resolved.error.message}`)
    }
    return resolved.value
  }
  const injected = (): McpSettingsTabInjected => ({
    list: () => wrap(ctx.remote.mcpSettings.list(), 'mcpSettings.list'),
    upsert: async (request) => {
      await wrap(ctx.remote.mcpSettings.upsert(request), 'mcpSettings.upsert')
    },
    remove: async (serverName) => {
      await wrap(ctx.remote.mcpSettings.delete({ serverName }), 'mcpSettings.delete')
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
