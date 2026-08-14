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

/** One Typert package per npm package — a second $mount with the same name throws. */
const pluginRemote = {
  package: 'dsh-plus',
  descriptors: [
    ...mcpSettingsRemote.descriptors,
    ...visionBridgeRemote.descriptors,
  ],
}

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
  try {
    const unmount = await ctx.remote.$mount(pluginRemote)
    ctx.effect(() => unmount, 'dsh-plus: remotes')
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already registered')) {
      throw error
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')
  ctx.effect(() => ctx.locale.register(VISION_NS, { zh: visionZh, en: visionEn }), 'ui-settings-vision: dictionaries')

  const t = ctx.locale.bind(NS)
  const visionT = ctx.locale.bind(VISION_NS)
  // Nested remotes are Cordis services; read them from a fiber that injects those keys.
  ctx.inject(['remote.mcpSettings', 'remote.visionBridge'], (inner: ClientContext) => {
    const remotes = inner.remote as ClientContext['remote'] & {
      mcpSettings: McpSettingsRemote
      visionBridge: VisionBridgeRemote
    }
    const mcpSettings = remotes.mcpSettings
    const visionBridge = remotes.visionBridge
    inner.slots.inject('settings.plugins.tab', () => inner.slots.register({
      name: 'settings.plugins.tab',
      id: 'mcp',
      order: 5,
      label: () => t('tab'),
      locale: NS,
      inject: (): McpSettingsTabInjected => ({
        list: () => wrap(mcpSettings.list(), 'mcpSettings.list'),
        upsert: async (request) => {
          await wrap(mcpSettings.upsert(request), 'mcpSettings.upsert')
        },
        remove: async (serverName) => {
          await wrap(mcpSettings.delete({ serverName }), 'mcpSettings.delete')
        },
      }),
    }, McpSettingsTab))

    inner.slots.inject('settings.plugins.tab', () => inner.slots.register({
      name: 'settings.plugins.tab',
      id: 'vision',
      order: 6,
      label: () => visionT('tab'),
      locale: VISION_NS,
      inject: (): VisionSettingsTabInjected => ({
        snapshot: () => wrap(visionBridge.snapshot(), 'visionBridge.snapshot'),
        save: async (request) => {
          await wrap(visionBridge.save(request), 'visionBridge.save')
        },
        testConnection: (request) => wrap(visionBridge.testConnection(request), 'visionBridge.testConnection'),
      }),
    }, VisionSettingsTab))
  })
}
