/** MCP server catalog and Vision Bridge registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import mcpSettingsRemote from '../remote.js'
import visionBridgeRemote from '../vision-remote.js'
import type { McpServerUpsertRequest, McpSettingsSnapshot } from '../types.ts'
import type { VisionBridgeSnapshot, VisionSaveRequest, VisionTestResult } from '../vision-types.ts'
import { McpSettingsTab, type McpSettingsTabInjected } from './McpSettingsTab.tsx'
import { VisionSettingsTab, type VisionSettingsTabInjected } from './VisionSettingsTab.tsx'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'
import { en as visionEn, zh as visionZh, type VisionSettingsLocaleKey } from './vision-locales.ts'

export type { McpSettingsTabInjected, McpSettingsTabProps } from './McpSettingsTab.tsx'
export type { McpSettingsLocaleKey } from './locales.ts'
export type { VisionSettingsTabInjected, VisionSettingsTabProps } from './VisionSettingsTab.tsx'
export type { VisionSettingsLocaleKey } from './vision-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP server catalog copy. */
    'settings.mcp': McpSettingsLocaleKey
    /** Vision Bridge copy. */
    'settings.vision': VisionSettingsLocaleKey
  }
}

/** Dictionary namespace owned by the MCP tab. */
export const NS = 'settings.mcp'

/** Dictionary namespace owned by the Vision tab. */
export const VISION_NS = 'settings.vision'

/** Services required by the Settings registration; remotes are mounted in apply. */
export const inject = ['slots', 'locale', 'remote']

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

type McpSettingsRemote = {
  list: () => Promise<RemoteResult<McpSettingsSnapshot>>
  upsert: (request: McpServerUpsertRequest) => Promise<RemoteResult<{ ok: true }>>
  delete: (request: { serverName: string }) => Promise<RemoteResult<{ ok: true }>>
}

type VisionBridgeRemote = {
  snapshot: () => Promise<RemoteResult<VisionBridgeSnapshot>>
  save: (request: VisionSaveRequest) => Promise<RemoteResult<{ ok: true }>>
  testConnection: (request: {
    baseURL: string
    model: string
    apiKey?: string
  }) => Promise<RemoteResult<VisionTestResult>>
}

type PluginRemote = {
  mcpSettings?: McpSettingsRemote
  visionBridge?: VisionBridgeRemote
}

async function wrap<T>(result: Promise<RemoteResult<T>>, name: string): Promise<T> {
  const resolved = await result
  if (!resolved.ok) {
    throw new Error(`${name} failed: ${resolved.error.code}: ${resolved.error.message}`)
  }
  return resolved.value
}

/**
 * Mount Host Remotes if this dsh assembly did not already, then contribute MCP and Vision tabs.
 * @param ctx - browser plugin context carrying slots, locale, and the Client Remote.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const remote = ctx.remote as ClientContext['remote'] & PluginRemote
  if (remote.mcpSettings === undefined) {
    const unmount = await ctx.remote.$mount(mcpSettingsRemote)
    ctx.effect(() => unmount, 'dsh-plus: mcpSettings remote')
  }
  if (remote.visionBridge === undefined) {
    const unmount = await ctx.remote.$mount(visionBridgeRemote)
    ctx.effect(() => unmount, 'dsh-plus: visionBridge remote')
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')
  ctx.effect(() => ctx.locale.register(VISION_NS, { zh: visionZh, en: visionEn }), 'ui-settings-vision: dictionaries')

  const t = ctx.locale.bind(NS)
  const visionT = ctx.locale.bind(VISION_NS)
  const mounted = ctx.remote as ClientContext['remote'] & {
    mcpSettings: McpSettingsRemote
    visionBridge: VisionBridgeRemote
  }
  const injected = (): McpSettingsTabInjected => ({
    list: () => wrap(mounted.mcpSettings.list(), 'mcpSettings.list'),
    upsert: async (request) => {
      await wrap(mounted.mcpSettings.upsert(request), 'mcpSettings.upsert')
    },
    remove: async (serverName) => {
      await wrap(mounted.mcpSettings.delete({ serverName }), 'mcpSettings.delete')
    },
  })
  const visionInjected = (): VisionSettingsTabInjected => ({
    snapshot: () => wrap(mounted.visionBridge.snapshot(), 'visionBridge.snapshot'),
    save: async (request) => {
      await wrap(mounted.visionBridge.save(request), 'visionBridge.save')
    },
    testConnection: (request) => wrap(mounted.visionBridge.testConnection(request), 'visionBridge.testConnection'),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcp',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, McpSettingsTab))

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'vision',
    order: 6,
    label: () => visionT('tab'),
    locale: VISION_NS,
    inject: visionInjected,
  }, VisionSettingsTab))
}
