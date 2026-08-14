import { describe, expect, it } from 'vitest'
import {
  countMcpTools,
  emptyMcpSettingsDocument,
  MCP_SETTINGS_DOCUMENT_FILENAME,
  mcpToolNamePrefix,
  parseMcpSettingsDocument,
  removeMcpServerRecord,
  serializeMcpSettingsDocument,
  toMcpClientConfig,
  upsertMcpServerRecord,
  viewCompositionConfig,
  viewMcpServerRecord,
  type McpHttpRecord,
  type McpStdioRecord,
} from '../src/document.ts'

const stdio: McpStdioRecord = {
  transport: 'stdio',
  serverName: 'memory',
  enabled: true,
  command: 'npx',
  args: ['-y', 'server'],
  env: { TOKEN: 'secret' },
  cwd: '/tmp',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

const http: McpHttpRecord = {
  transport: 'streamable-http',
  serverName: 'web',
  enabled: false,
  url: 'http://127.0.0.1:3000/mcp',
  headers: { Authorization: 'Bearer secret' },
  toolCallTimeoutMs: 12_000,
  failOnStartupError: true,
}

describe('mcp-settings document', () => {
  it('round-trips an empty document and redacts secret values in views', () => {
    const empty = emptyMcpSettingsDocument()
    expect(MCP_SETTINGS_DOCUMENT_FILENAME).toBe('mcp-servers.json')
    expect(parseMcpSettingsDocument(serializeMcpSettingsDocument(empty))).toEqual(empty)
    expect(viewMcpServerRecord(stdio, 'settings', 'active', 3)).toEqual({
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
    })
    expect(viewMcpServerRecord(http, 'composition', 'failed', 0)).toMatchObject({
      origin: 'composition',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
      envKeys: [],
      headerKeys: ['Authorization'],
      toolCount: 0,
    })
    expect(JSON.stringify(viewMcpServerRecord(stdio, 'settings', null, 0))).not.toContain('secret')
    expect(JSON.stringify(viewMcpServerRecord(http, 'settings', null, 0))).not.toContain('secret')
  })

  it('parses omitted optional fields and rejects malformed documents', () => {
    const parsed = parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [
        { transport: 'stdio', serverName: 'a', command: 'echo', cwd: '/tmp', toolCallTimeoutMs: 5_000, enabled: false },
        { transport: 'streamable-http', serverName: 'b', url: 'http://localhost/mcp', failOnStartupError: true },
      ],
    }))
    expect(parsed.servers[0]).toMatchObject({
      enabled: false,
      args: [],
      env: {},
      cwd: '/tmp',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: false,
    })
    expect(parsed.servers[1]).toMatchObject({ headers: {}, enabled: true, failOnStartupError: true })

    expect(() => parseMcpSettingsDocument('{')).toThrow('not valid JSON')
    expect(() => parseMcpSettingsDocument('[]')).toThrow('must be a JSON object')
    expect(() => parseMcpSettingsDocument('{"version":2,"servers":[]}')).toThrow('unsupported document version')
    expect(() => parseMcpSettingsDocument('{"version":1}')).toThrow('servers must be an array')
    expect(() => parseMcpSettingsDocument('{"version":1,"servers":[null]}')).toThrow('must be an object')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      extra: true,
      servers: [],
    }))).toThrow('unknown key')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo' }, { transport: 'stdio', serverName: 'a', command: 'echo' }],
    }))).toThrow('duplicate serverName')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'udp', serverName: 'a' }],
    }))).toThrow('transport must be')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'bad name', command: 'echo' }],
    }))).toThrow('must match')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', enabled: 'yes' }],
    }))).toThrow('must be a boolean')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', toolCallTimeoutMs: 0 }],
    }))).toThrow('must be a positive number')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', args: [1] }],
    }))).toThrow('array of strings')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', args: {} }],
    }))).toThrow('array of strings')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', env: 'TOKEN' }],
    }))).toThrow('object of strings')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', env: { TOKEN: 1 } }],
    }))).toThrow('must be a string')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', cwd: 1 }],
    }))).toThrow('must be a string')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: '' }],
    }))).toThrow('non-empty string')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'stdio', serverName: 'a', command: 'echo', extra: true }],
    }))).toThrow('unknown key')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'streamable-http', serverName: 'a', url: 'http://localhost/mcp', extra: true }],
    }))).toThrow('unknown key')
    expect(() => parseMcpSettingsDocument(JSON.stringify({
      version: 1,
      servers: [{ transport: 'streamable-http', serverName: 'a', url: 'http://localhost/mcp', failOnStartupError: 'no' }],
    }))).toThrow('must be a boolean')
  })

  it('upserts with env/header keep-on-omit, switches transport, and removes by name', () => {
    expect(upsertMcpServerRecord(emptyMcpSettingsDocument(), {
      transport: 'stdio',
      serverName: 'plain',
      command: 'echo',
    }).servers[0]).toMatchObject({ env: {}, args: [], cwd: '', enabled: true })
    let document = upsertMcpServerRecord(emptyMcpSettingsDocument(), {
      transport: 'stdio',
      serverName: 'memory',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'secret' },
      cwd: '/tmp',
    })
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'memory',
      command: 'node',
    })
    expect(document.servers[0]).toMatchObject({
      command: 'node',
      args: [],
      env: { TOKEN: 'secret' },
      cwd: '',
      enabled: true,
    })
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'mem2',
      fromServerName: 'memory',
      command: 'node',
    })
    expect(document.servers).toEqual([expect.objectContaining({
      serverName: 'mem2',
      env: { TOKEN: 'secret' },
    })])
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'memory',
      fromServerName: 'mem2',
      command: 'node',
    })
    document = upsertMcpServerRecord(document, {
      transport: 'streamable-http',
      serverName: 'memory',
      url: 'http://localhost/mcp',
      enabled: false,
      failOnStartupError: true,
      toolCallTimeoutMs: 5_000,
    })
    expect(document.servers[0]).toMatchObject({
      transport: 'streamable-http',
      url: 'http://localhost/mcp',
      headers: {},
      enabled: false,
    })
    document = upsertMcpServerRecord(document, {
      transport: 'streamable-http',
      serverName: 'memory',
      url: 'http://localhost/mcp',
      headers: { Authorization: 'Bearer x' },
    })
    expect(document.servers[0]).toMatchObject({ headers: { Authorization: 'Bearer x' } })
    document = upsertMcpServerRecord(document, {
      transport: 'streamable-http',
      serverName: 'memory',
      url: 'http://localhost/other',
    })
    expect(document.servers[0]).toMatchObject({
      url: 'http://localhost/other',
      headers: { Authorization: 'Bearer x' },
    })
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'other',
      command: 'echo',
    })
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'other',
      command: 'printf',
    })
    document = upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'renamed',
      fromServerName: 'other',
      command: 'printf',
    })
    expect(document.servers.map(server => server.serverName)).toEqual(['memory', 'renamed'])
    expect(document.servers[1]).toMatchObject({ command: 'printf', env: {} })
    expect(() => upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'ghost',
      fromServerName: 'missing',
      command: 'echo',
    })).toThrow('no Settings-owned server named "missing"')
    expect(() => upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'memory',
      fromServerName: 'renamed',
      command: 'echo',
    })).toThrow('already in use')
    expect(() => upsertMcpServerRecord(document, {
      transport: 'stdio',
      serverName: 'ok',
      fromServerName: 'bad name',
      command: 'echo',
    })).toThrow('fromServerName')
    expect(removeMcpServerRecord(document, 'memory').servers).toEqual([
      expect.objectContaining({ serverName: 'renamed', command: 'printf' }),
    ])
    expect(toMcpClientConfig(stdio)).toMatchObject({
      transport: 'stdio',
      serverName: 'memory',
      env: { TOKEN: 'secret' },
    })
    expect(toMcpClientConfig(http)).toMatchObject({
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  it('projects composition configs best-effort and ignores unusable rows', () => {
    expect(viewCompositionConfig({
      transport: 'stdio',
      serverName: 'yaml',
      command: 'npx',
      args: ['ok', 1],
      env: { A: '1', B: 2 },
      cwd: '/work',
      toolCallTimeoutMs: 9_000,
      failOnStartupError: true,
    }, true, 'active')).toMatchObject({
      origin: 'composition',
      serverName: 'yaml',
      args: ['ok'],
      envKeys: ['A'],
      cwd: '/work',
      toolCallTimeoutMs: 9_000,
      failOnStartupError: true,
    })
    expect(viewCompositionConfig({
      transport: 'streamable-http',
      serverName: 'http',
      url: 'http://localhost/mcp',
      headers: { H: '1', N: 1 },
    }, false, null)).toMatchObject({
      origin: 'composition',
      enabled: false,
      headerKeys: ['H'],
    })
    expect(viewCompositionConfig(null, true, null)).toBeNull()
    expect(viewCompositionConfig({ serverName: 'x' }, true, null)).toBeNull()
    expect(viewCompositionConfig({ transport: 'stdio', serverName: 'bad name', command: 'echo' }, true, null)).toBeNull()
    expect(viewCompositionConfig({ transport: 'stdio', serverName: 'ok' }, true, null)).toBeNull()
    expect(viewCompositionConfig({ transport: 'streamable-http', serverName: 'ok' }, true, null)).toBeNull()
    expect(viewCompositionConfig({ transport: 'udp', serverName: 'ok' }, true, null)).toBeNull()
    expect(viewCompositionConfig({
      transport: 'stdio',
      serverName: 'ok',
      command: 'echo',
      toolCallTimeoutMs: 0,
    }, true, null)?.toolCallTimeoutMs).toBe(60_000)
    expect(viewCompositionConfig({
      transport: 'stdio',
      serverName: 'ok',
      command: 'echo',
      env: null,
      args: 'nope',
    }, true, null)).toMatchObject({ args: [], envKeys: [] })
    expect(viewCompositionConfig({
      transport: 'stdio',
      serverName: 'js',
      command: 'npx',
    }, true, 'active', [
      'mcp__js__select_page',
      'mcp__js_extra__other',
      'bash',
    ])).toMatchObject({ toolCount: 1 })
  })

  it('counts tools by the mcp-client public-name prefix', () => {
    expect(mcpToolNamePrefix('js')).toBe('mcp__js__')
    expect(countMcpTools([], 'js')).toBe(0)
    expect(countMcpTools([
      'mcp__js__select_page',
      'mcp__js__click',
      'mcp__js_extra__other',
      'bash',
    ], 'js')).toBe(2)
  })
})
