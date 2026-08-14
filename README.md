# dsh-plus：MCP 设置页插件

只包含接到 DeepSeek Harness 里的 **MCP 设置页**，不是完整的 dsh 仓库。

| 目录 | 包名 | 作用 |
| --- | --- | --- |
| `packages/mcp/mcp-settings` | `@deepseek-ai/dsh-mcp-settings` | Host：把服务器写进 `$DSH_HOME/mcp-servers.json`，并挂上 mcp-client |
| `packages/client/ui-settings-mcp` | `@deepseek-ai/dsh-client-ui-settings-mcp` | Web：**设置 → 插件 → MCP** 标签页 |

拷进现有 dsh 树后，还需要在 `dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 和 `package.json` 里挂上这两个包（以及 remotes、tsconfig 引用）。本仓库不带那些 harness 本体文件。
