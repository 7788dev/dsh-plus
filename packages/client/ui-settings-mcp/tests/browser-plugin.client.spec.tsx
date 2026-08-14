// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { McpSettingsTab } from '../src/client/McpSettingsTab.tsx'
import type { McpSettingsTabInjected } from '../src/client/McpSettingsTab.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

const EMPTY = { servers: [] }
type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  const list = vi.fn<() => Promise<RemoteResult<typeof EMPTY>>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const upsert = vi.fn<() => Promise<RemoteResult<{ ok: true }>>>()
    .mockResolvedValue({ ok: true, value: { ok: true } })
  const deleteServer = vi.fn<() => Promise<RemoteResult<{ ok: true }>>>()
    .mockResolvedValue({ ok: true, value: { ok: true } })
  ctx.provide('remote.mcpSettings', { list, upsert, delete: deleteServer })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, upsert, deleteServer }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-mcp browser plugin', () => {
  it('declares only the services used by the Settings Remote contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.mcpSettings'])
  })

  it('registers a localized tab without reading the Remote eagerly', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(McpSettingsTab)
    expect(entry.options).toMatchObject({ id: 'mcp', order: 5 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('MCP')
    expect(b.list).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => McpSettingsTabInjected)()
    await expect(injected.list()).resolves.toEqual(EMPTY)
    await injected.upsert({ transport: 'stdio', serverName: 'a', command: 'echo' })
    await injected.remove('a')
    expect(b.upsert).toHaveBeenCalledOnce()
    expect(b.deleteServer).toHaveBeenCalledWith({ serverName: 'a' })
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.list()).rejects.toThrow('mcpSettings.list failed: REMOTE_ERROR: unavailable')
    b.upsert.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'denied' } })
    await expect(injected.upsert({ transport: 'stdio', serverName: 'a', command: 'echo' }))
      .rejects.toThrow('mcpSettings.upsert failed: REMOTE_ERROR: denied')
    b.deleteServer.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'denied' } })
    await expect(injected.remove('a')).rejects.toThrow('mcpSettings.delete failed: REMOTE_ERROR: denied')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and recovers across late declaration and declarer reload', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('MCP')

    stop()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => {
      expect(b.slots.entries('settings.plugins.tab')[0]?.component).toBe(McpSettingsTab)
    })

    await fiber.dispose()
    expect(b.slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
