import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import McpSettingsGateway from '../src/index.ts'
import { MCP_CLIENT_MODULE } from '../src/document.ts'

const { mockApply } = vi.hoisted(() => ({ mockApply: vi.fn() }))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  return {
    ...actual,
    inject: [],
    apply: () => {
      mockApply()
    },
  }
})

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  mockApply.mockReset()
  mockApply.mockImplementation(() => {})
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(options?: {
  readonly body?: string
  readonly loader?: unknown
  readonly toolNames?: readonly string[]
}): Promise<{
  ctx: Context
  path: string
  gateway: McpSettingsGateway
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-settings-'))
  dirs.push(dir)
  const path = join(dir, 'mcp-servers.json')
  if (options?.body !== undefined) await writeFile(path, options.body)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', {
    schemas: () => (options?.toolNames ?? []).map(name => ({ name })),
  })
  if (options?.loader !== undefined) ctx.provide('loader', options.loader)
  await ctx.plugin(McpSettingsGateway, { path })
  const gateway = ctx.get('mcpSettings') as McpSettingsGateway
  return { ctx, path, gateway }
}

describe('McpSettingsGateway', () => {
  it('publishes list, upsert, and delete under the mcpSettings namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'mcpSettings',
      namespace: 'mcpSettings',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'upsert', invocation: { kind: 'direct' } },
      { method: 'delete', invocation: { kind: 'direct' } },
    ])
    await expect(gateway.list()).resolves.toEqual({ servers: [] })
  })

  it('treats a missing document as empty and persists upserts without leaking secrets', async () => {
    const { gateway, path } = await harness()
    await gateway.upsert({
      transport: 'stdio',
      serverName: 'memory',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'secret-value' },
      cwd: '',
    })
    const snapshot = await gateway.list()
    expect(snapshot.servers).toEqual([expect.objectContaining({
      serverName: 'memory',
      origin: 'settings',
      enabled: true,
      transport: 'stdio',
      envKeys: ['TOKEN'],
      fiberPhase: 'active',
      toolCount: 0,
    })])
    expect(JSON.stringify(snapshot)).not.toContain('secret-value')
    const stored = JSON.parse(await readFile(path, 'utf8')) as { servers: Array<{ env: Record<string, string> }> }
    expect(stored.servers[0]?.env).toEqual({ TOKEN: 'secret-value' })

    await gateway.upsert({
      transport: 'stdio',
      serverName: 'memory',
      command: 'node',
      enabled: false,
    })
    const updated = await gateway.list()
    expect(updated.servers[0]).toMatchObject({
      command: 'node',
      enabled: false,
      envKeys: ['TOKEN'],
      fiberPhase: null,
    })

    await gateway.delete({ serverName: 'memory' })
    await expect(gateway.list()).resolves.toEqual({ servers: [] })
  })

  it('renames a Settings row in place and keeps omitted secrets', async () => {
    const { gateway, path } = await harness()
    await gateway.upsert({
      transport: 'stdio',
      serverName: 'memory',
      command: 'npx',
      env: { TOKEN: 'secret-value' },
    })
    await gateway.upsert({
      transport: 'stdio',
      serverName: 'mem2',
      fromServerName: 'memory',
      command: 'npx',
    })
    const snapshot = await gateway.list()
    expect(snapshot.servers).toEqual([expect.objectContaining({
      serverName: 'mem2',
      envKeys: ['TOKEN'],
      fiberPhase: 'active',
    })])
    expect(snapshot.servers.some(server => server.serverName === 'memory')).toBe(false)
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      servers: Array<{ serverName: string; env: Record<string, string> }>
    }
    expect(stored.servers).toEqual([expect.objectContaining({
      serverName: 'mem2',
      env: { TOKEN: 'secret-value' },
    })])

    await gateway.upsert({
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
    await gateway.upsert({
      transport: 'streamable-http',
      serverName: 'web2',
      fromServerName: 'web',
      url: 'http://127.0.0.1:9/mcp',
    })
    expect((await gateway.list()).servers.map(server => server.serverName)).toEqual(['mem2', 'web2'])
    expect((await gateway.list()).servers[1]).toMatchObject({
      serverName: 'web2',
      headerKeys: ['Authorization'],
    })

    await expect(gateway.upsert({
      transport: 'stdio',
      serverName: 'ghost',
      fromServerName: 'missing',
      command: 'echo',
    })).rejects.toThrow('no Settings-owned server named "missing"')
    await expect(gateway.upsert({
      transport: 'stdio',
      serverName: 'web2',
      fromServerName: 'mem2',
      command: 'echo',
    })).rejects.toThrow('already in use')
    await gateway.upsert({
      transport: 'stdio',
      serverName: 'mem2',
      fromServerName: 'mem2',
      command: 'node',
    })
    expect((await gateway.list()).servers[0]).toMatchObject({ serverName: 'mem2', command: 'node' })
  })

  it('mounts HTTP servers, skips disabled records at boot, and lists composition rows read-only', async () => {
    const { gateway } = await harness({
      body: JSON.stringify({
        version: 1,
        servers: [
          {
            transport: 'streamable-http',
            serverName: 'web',
            enabled: true,
            url: 'http://127.0.0.1:9/mcp',
            headers: { Authorization: 'Bearer secret' },
          },
          {
            transport: 'stdio',
            serverName: 'off',
            enabled: false,
            command: 'echo',
          },
        ],
      }, null, 2),
      loader: {
        entries: () => [{
          options: {
            name: MCP_CLIENT_MODULE,
            config: {
              transport: 'stdio',
              serverName: 'yaml',
              command: 'npx',
              env: { KEY: 'hidden' },
            },
          },
          disabled: false,
          fiber: { state: 2 },
        }, {
          options: { name: '@deepseek-ai/dsh-tools' },
          disabled: false,
        }, {
          options: {
            name: MCP_CLIENT_MODULE,
            config: { transport: 'stdio', serverName: 'broken' },
          },
          disabled: true,
        }],
      },
      toolNames: [
        'mcp__web__fetch',
        'mcp__web__search',
        'mcp__yaml__read',
        'mcp__web_extra__nope',
        'bash',
      ],
    })
    const snapshot = await gateway.list()
    expect(snapshot.servers.map(server => server.serverName)).toEqual(['web', 'off', 'yaml'])
    expect(snapshot.servers[0]).toMatchObject({
      origin: 'settings',
      transport: 'streamable-http',
      headerKeys: ['Authorization'],
      fiberPhase: 'active',
      toolCount: 2,
    })
    expect(snapshot.servers[1]).toMatchObject({ origin: 'settings', enabled: false, fiberPhase: null, toolCount: 0 })
    expect(snapshot.servers[2]).toMatchObject({
      origin: 'composition',
      serverName: 'yaml',
      envKeys: ['KEY'],
      fiberPhase: 'active',
      toolCount: 1,
    })
    expect(JSON.stringify(snapshot)).not.toContain('hidden')
    expect(JSON.stringify(snapshot)).not.toContain('secret')

    await expect(gateway.upsert({
      transport: 'stdio',
      serverName: 'yaml',
      command: 'echo',
    })).rejects.toThrow('composition')
    await expect(gateway.upsert({
      transport: 'stdio',
      serverName: 'from-yaml',
      fromServerName: 'yaml',
      command: 'echo',
    })).rejects.toThrow('composition')
    await gateway.upsert({ transport: 'stdio', serverName: 'ok', command: 'echo' })
    await expect(gateway.upsert({
      transport: 'stdio',
      serverName: 'yaml',
      fromServerName: 'ok',
      command: 'echo',
    })).rejects.toThrow('composition')
    await expect(gateway.delete({ serverName: 'yaml' })).rejects.toThrow('composition')
    await expect(gateway.delete({ serverName: 'missing' })).rejects.toThrow('no Settings-owned server')
  })

  it('fails loud on invalid JSON and refuses a colliding Settings name after composition appears', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-settings-bad-'))
    dirs.push(dir)
    const path = join(dir, 'mcp-servers.json')
    await writeFile(path, '{')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('tools', { schemas: () => [] })
    await expect(ctx.plugin(McpSettingsGateway, { path }).await()).rejects.toThrow('not valid JSON')

    const live = await harness()
    await live.gateway.upsert({
      transport: 'stdio',
      serverName: 'taken',
      command: 'echo',
    })
    live.ctx.provide('loader', {
      entries: () => [{
        options: {
          name: MCP_CLIENT_MODULE,
          config: { transport: 'stdio', serverName: 'taken', command: 'npx' },
        },
        disabled: false,
        fiber: undefined,
      }],
    })
    await expect(live.gateway.upsert({
      transport: 'stdio',
      serverName: 'taken',
      command: 'echo',
    })).rejects.toThrow('composition')

    const dirPath = await mkdtemp(join(tmpdir(), 'dsh-mcp-settings-dir-'))
    dirs.push(dirPath)
    const blocked = new Context()
    contexts.push(blocked)
    blocked.provide('tools', {})
    await expect(blocked.plugin(McpSettingsGateway, { path: dirPath }).await()).rejects.toThrow()
  })

  it('projects every composition fiber phase and keeps mutating after a failed delete', async () => {
    const { gateway } = await harness({
      loader: {
        entries: () => [0, 1, 2, 3, 4, 5].map(state => ({
          options: {
            name: MCP_CLIENT_MODULE,
            config: { transport: 'stdio', serverName: `p${String(state)}`, command: 'echo' },
          },
          disabled: false,
          fiber: { state },
        })),
      },
    })
    const phases = (await gateway.list()).servers.map(server => server.fiberPhase)
    expect(phases).toEqual(['pending', 'loading', 'active', 'failed', null, 'unloading'])
    await expect(gateway.delete({ serverName: 'missing' })).rejects.toThrow('no Settings-owned server')
    await gateway.upsert({ transport: 'stdio', serverName: 'ok', command: 'echo' })
    expect((await gateway.list()).servers.some(server => server.serverName === 'ok')).toBe(true)
  })

  it('logs a child fiber failure without rejecting the Settings upsert', async () => {
    mockApply.mockImplementationOnce(() => {
      throw new Error('connect failed')
    })
    const { ctx, gateway } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await gateway.upsert({ transport: 'stdio', serverName: 'boom', command: 'echo' })
    await vi.waitFor(async () => {
      const snapshot = await gateway.list()
      expect(snapshot.servers[0]).toMatchObject({ serverName: 'boom', fiberPhase: 'failed' })
    })
    expect(warn).toHaveBeenCalled()
  })

  it('does not mount a Settings record whose serverName a composition row already owns', async () => {
    await harness({
      body: JSON.stringify({
        version: 1,
        servers: [{ transport: 'stdio', serverName: 'yaml', command: 'echo' }],
      }),
      loader: {
        entries: () => [{
          options: {
            name: MCP_CLIENT_MODULE,
            config: { transport: 'stdio', serverName: 'yaml', command: 'npx' },
          },
          disabled: false,
          fiber: { state: 2 },
        }],
      },
    })
    expect(mockApply).not.toHaveBeenCalled()
  })
})
