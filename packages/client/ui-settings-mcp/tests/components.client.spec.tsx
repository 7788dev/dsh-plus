// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSettingsTab } from '../src/client/McpSettingsTab.tsx'
import type {
  McpSettingsTabInjected,
  McpSettingsTabProps,
} from '../src/client/McpSettingsTab.tsx'
import { en, type McpSettingsLocaleKey } from '../src/client/locales.ts'
import type { McpSettingsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'

afterEach(cleanup)

function t(key: McpSettingsLocaleKey, params?: Record<string, unknown>): string {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

function props(face: McpSettingsTabInjected): McpSettingsTabProps {
  return { t, ...face } as McpSettingsTabProps
}

const SNAPSHOT: McpSettingsSnapshot = {
  servers: [
    {
      serverName: 'memory',
      origin: 'settings',
      enabled: true,
      fiberPhase: 'active',
      toolCount: 3,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      cwd: '/tmp',
      envKeys: ['TOKEN'],
      headerKeys: [],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    },
    {
      serverName: 'web',
      origin: 'settings',
      enabled: false,
      fiberPhase: null,
      toolCount: 0,
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
      envKeys: [],
      headerKeys: ['Authorization'],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    },
    {
      serverName: 'yaml',
      origin: 'composition',
      enabled: true,
      fiberPhase: 'failed',
      toolCount: 0,
      transport: 'stdio',
      command: 'echo',
      args: [],
      cwd: '',
      envKeys: [],
      headerKeys: [],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    },
    {
      serverName: 'idle',
      origin: 'settings',
      enabled: true,
      fiberPhase: null,
      toolCount: 0,
      transport: 'stdio',
      command: 'echo',
      args: [],
      cwd: '',
      envKeys: [],
      headerKeys: [],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    },
  ],
}

describe('McpSettingsTab', () => {
  it('lists settings and composition servers and saves a new stdio row', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const upsert = vi.fn(async () => {})
    const remove = vi.fn(async () => {})
    render(<McpSettingsTab {...props({ list, upsert, remove })} />)

    expect(await screen.findByRole('heading', { name: en.catalog })).toBeTruthy()
    expect(screen.getByText('memory')).toBeTruthy()
    expect(screen.getByText('yaml')).toBeTruthy()
    expect(screen.getByText(en.compositionHint)).toBeTruthy()
    expect(screen.queryByText(en.transportStdio)).toBeNull()
    expect(screen.getByRole('img', { name: en.active })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.failed })).toBeTruthy()
    expect(screen.getByText(en.active)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.getByText(en.unobserved)).toBeTruthy()
    expect(document.querySelector('[data-mcp-server="memory"]')?.getAttribute('data-mcp-running')).toBe('true')
    expect(document.querySelector('[data-mcp-server="memory"] [data-mcp-tool-count]')?.textContent)
      .toBe(`3 ${en.toolCountUnit}`)
    expect(document.querySelector('[data-mcp-server="web"] [data-mcp-tool-count]')?.textContent)
      .toBe(`0 ${en.toolCountUnit}`)

    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'newsrv' } })
    fireEvent.change(screen.getByLabelText(en.command), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText(en.args), { target: { value: '-y\nserver' } })
    fireEvent.change(screen.getByLabelText(en.env), { target: { value: 'TOKEN=abc' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(upsert).toHaveBeenCalledWith({
        transport: 'stdio',
        serverName: 'newsrv',
        enabled: true,
        command: 'npx',
        args: ['-y', 'server'],
        env: { TOKEN: 'abc' },
      })
    })

    fireEvent.click(screen.getAllByRole('button', { name: en.edit })[0]!)
    expect(screen.getByLabelText<HTMLInputElement>(en.serverName).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'mem2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(upsert).toHaveBeenLastCalledWith({
        transport: 'stdio',
        serverName: 'mem2',
        fromServerName: 'memory',
        enabled: true,
        command: 'npx',
        args: ['-y', 'server'],
      })
    })
    fireEvent.click(screen.getAllByRole('button', { name: en.edit })[0]!)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(upsert).toHaveBeenLastCalledWith({
        transport: 'stdio',
        serverName: 'memory',
        enabled: true,
        command: 'npx',
        args: ['-y', 'server'],
      })
    })
    fireEvent.click(screen.getAllByRole('button', { name: en.remove })[0]!)
    expect(remove).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) })
    fireEvent.click(within(dialog).getByRole('button', { name: t('deleteConfirm', { name: 'memory' }) }))
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('memory') })
  })

  it('edits an HTTP server, keeps omitted headers, and reports kv and remote failures', async () => {
    const list = vi.fn(async () => SNAPSHOT)
    const upsert = vi.fn(async () => { throw new Error('host') })
    const remove = vi.fn(async () => { throw new Error('host') })
    render(<McpSettingsTab {...props({ list, upsert, remove })} />)
    await screen.findByText('web')

    fireEvent.click(screen.getAllByRole('button', { name: en.edit })[1]!)
    fireEvent.change(screen.getByLabelText(en.transport), { target: { value: 'streamable-http' } })
    fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://127.0.0.1:9/mcp' } })
    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: 'not-a-pair' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.invalidKv)
    expect(upsert).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.saveFailed)
    expect(upsert).toHaveBeenCalledWith({
      transport: 'streamable-http',
      serverName: 'web',
      enabled: false,
      url: 'http://127.0.0.1:9/mcp',
    })

    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'web2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(upsert).toHaveBeenLastCalledWith({
      transport: 'streamable-http',
      serverName: 'web2',
      fromServerName: 'web',
      enabled: false,
      url: 'http://127.0.0.1:9/mcp',
    })

    fireEvent.click(screen.getAllByRole('button', { name: en.remove })[0]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) }))
      .getByRole('button', { name: t('deleteConfirm', { name: 'memory' }) }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.removeFailed)
    expect(screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) })).toBeTruthy()
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<McpSettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ servers: [] })
    render(<McpSettingsTab {...props({
      list,
      upsert: async () => {},
      remove: async () => {},
    })} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as McpSettingsTabInjected['list']
    const failed = render(<McpSettingsTab {...props({
      list: syncFailure,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<McpSettingsSnapshot>()
    const pending = render(<McpSettingsTab {...props({
      list: () => deferred.promise,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<McpSettingsSnapshot>()
    const pendingFailure = render(<McpSettingsTab {...props({
      list: () => deferredFailure.promise,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })

  it('renders zero tools when the Host omits toolCount', async () => {
    const server = SNAPSHOT.servers[0]!
    const { toolCount: _omitted, ...rest } = server
    render(<McpSettingsTab {...props({
      list: async () => ({ servers: [{ ...rest } as typeof server] }),
      upsert: async () => {},
      remove: async () => {},
    })} />)
    await screen.findByText('memory')
    expect(document.querySelector('[data-mcp-server="memory"] [data-mcp-tool-count]')?.textContent)
      .toBe(`0 ${en.toolCountUnit}`)
  })

  it('cancels the editor and switches a new draft to HTTP before save', async () => {
    const upsert = vi.fn(async () => {})
    render(<McpSettingsTab {...props({
      list: async () => SNAPSHOT,
      upsert,
      remove: async () => {},
    })} />)
    await screen.findByText('memory')
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByLabelText(en.serverName)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.add }))
    fireEvent.change(screen.getByLabelText(en.serverName), { target: { value: 'http1' } })
    fireEvent.change(screen.getByLabelText(en.transport), { target: { value: 'stdio' } })
    fireEvent.change(screen.getByLabelText(en.transport), { target: { value: 'streamable-http' } })
    fireEvent.change(screen.getByLabelText(en.url), { target: { value: 'http://localhost/mcp' } })
    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: 'Authorization=Bearer x\n\n' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.enabled }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => {
      expect(upsert).toHaveBeenCalledWith({
        transport: 'streamable-http',
        serverName: 'http1',
        enabled: false,
        url: 'http://localhost/mcp',
        headers: { Authorization: 'Bearer x' },
      })
    })
  })

  it('refetches a loading fiber until it is active without hiding the catalog', async () => {
    const loading = {
      ...SNAPSHOT.servers[0]!,
      fiberPhase: 'loading' as const,
      toolCount: 0,
    }
    const list = vi.fn<McpSettingsTabInjected['list']>()
      .mockResolvedValueOnce({ servers: [loading] })
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ servers: [SNAPSHOT.servers[0]!] })
    render(<McpSettingsTab {...props({
      list,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    expect(await screen.findByText(en.loadingPhase)).toBeTruthy()
    expect(screen.queryByText(en.loading)).toBeNull()
    await waitFor(() => {
      expect(screen.getByText(en.active)).toBeTruthy()
    }, { timeout: 3000 })
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('stops polling after unmount and does not poll a settled catalog', async () => {
    const loading = {
      ...SNAPSHOT.servers[0]!,
      fiberPhase: 'pending' as const,
      toolCount: 0,
    }
    const settling = vi.fn(async () => ({ servers: [loading] }))
    const view = render(<McpSettingsTab {...props({
      list: settling,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    await screen.findByText(en.pending)
    expect(settling).toHaveBeenCalledTimes(1)
    view.unmount()
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(settling).toHaveBeenCalledTimes(1)

    const list = vi.fn(async () => SNAPSHOT)
    render(<McpSettingsTab {...props({
      list,
      upsert: async () => {},
      remove: async () => {},
    })} />)
    await screen.findByText('memory')
    const settledCalls = list.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(list).toHaveBeenCalledTimes(settledCalls)
  })

  it('asks before deleting and keeps the dialog open until the Host returns', async () => {
    const deferred = Promise.withResolvers<undefined>()
    const remove = vi.fn(() => deferred.promise)
    render(<McpSettingsTab {...props({
      list: async () => SNAPSHOT,
      upsert: async () => {},
      remove,
    })} />)
    await screen.findByText('memory')
    fireEvent.click(screen.getAllByRole('button', { name: en.remove })[0]!)
    expect(remove).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) })
    expect(dialog.textContent).toContain(en.deleteDescription)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: en.remove })[0]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) }))
      .getByRole('button', { name: en.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: en.remove })[0]!)
    const open = screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) })
    fireEvent.click(within(open).getByRole('button', { name: t('deleteConfirm', { name: 'memory' }) }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(within(open).getByRole<HTMLButtonElement>('button', { name: en.deleting }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: t('deleteTitle', { name: 'memory' }) })).toBeTruthy()
    await act(async () => { deferred.resolve(undefined) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
