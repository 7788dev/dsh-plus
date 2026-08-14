import { readFileSync, writeFileSync } from 'node:fs'

const replacements = [
  [
    'E:/dev/魔改/dp/packages/mcp/mcp-settings/lib/typert.host.js',
    'E:/dev/魔改/dsh-plus/lib/typert.host.js',
  ],
  [
    'E:/dev/魔改/dp/packages/mcp/mcp-settings/lib/typert.remote-client.js',
    'E:/dev/魔改/dsh-plus/lib/typert.remote-client.js',
  ],
  [
    'E:/dev/魔改/dp/packages/mcp/mcp-settings/lib/typert.remote-client.js',
    'E:/dev/魔改/dsh-plus/src/remote.js',
  ],
  [
    'E:/dev/魔改/dp/packages/mcp/mcp-settings/lib/invariant.js',
    'E:/dev/魔改/dsh-plus/lib/invariant.js',
  ],
]

for (const [from, to] of replacements) {
  let text = readFileSync(from, 'utf8')
  text = text.split('@deepseek-ai/dsh-mcp-settings').join('dsh-plus')
  if (!text.endsWith('\n')) text += '\n'
  writeFileSync(to, text, 'utf8')
  console.log('wrote', to)
}
