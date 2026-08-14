# @deepseek-ai/dsh-mcp-settings

English | [中文](README.zh.md)

Host Remote for UI-managed MCP servers. `McpSettingsGateway` registers `mcpSettings` and publishes `mcpSettings/list`, `mcpSettings/upsert`, and `mcpSettings/delete`. Settings-owned servers persist in `$DSH_HOME/mcp-servers.json` (mode `0600`) so Web and headless share one catalog without writing `cordis.patch.yml` (which cannot round-trip `!!js` secrets). Each enabled Settings-origin record mounts one `@deepseek-ai/dsh-mcp-client` child fiber; composition-origin `mcp-client` Loader rows appear in `list` as read-only.

Views never include environment or header **values** — only key names. Each `list` row includes the live mcp-client fiber phase and the number of globally registered tools in that server's `mcp__<serverName>__` namespace. Upsert and delete refuse a `serverName` that a composition row already owns. A distinct `fromServerName` on upsert renames that Settings row in place and keeps omitted env/headers. External edits of the JSON file apply on the next process start; Settings writes remount immediately.

Public payload types live under `./types`. Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`. Client packages consume this service through [`api-remotes`](../../api/remotes/README.md).

## Model Experience

None, as this Host catalog persists configuration and mounts mcp-client children; discovered tools and their model-visible schemas belong to mcp-client.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No file watcher** — an external edit of `mcp-servers.json` is not remounted until the next process start; Settings-page writes remount in-process.
- **Composition rows stay YAML** — a server introduced by `--patch` or a profile patch cannot be edited or deleted here.
- **Secrets are write-only in the UI** — edit with an empty env/header textarea keeps the stored map; the page never echoes values.
- **Reconnect policy is not exposed** — Settings-owned servers use mcp-client defaults rather than a per-server reconnect editor.
