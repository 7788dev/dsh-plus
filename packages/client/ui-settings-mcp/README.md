# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

**MCP** tab for Web Settings. The browser plugin registers one localized `settings.plugins.tab` contribution with id `mcp` and order `5` (between Plugin configuration and Plugin list). It performs no Remote read during plugin activation. Selecting the tab for the first time mounts it and lazily calls `ctx.remote.mcpSettings.list()` through [`api-remotes`](../../api/remotes/README.md).

The tab lists Settings-owned and composition-owned servers as cards. Each card shows whether the mcp-client fiber is running and how many tools that server currently has registered globally. Settings-owned rows can be added, edited (including the name), or deleted; composition-owned rows stay read-only. Renaming a Settings row sends `fromServerName` so the Host replaces that row in place. Environment variables and headers are entered as `KEY=value` lines. An empty textarea on edit keeps the stored map; the page never displays secret values. Loading, empty, and generic failure states stay local to the mounted component. While any enabled fiber is pending, loading, or unloading, the tab refetches `list` so a card can leave Loading without switching pages. Deleting a Settings-owned row opens a confirmation dialog before `mcpSettings/delete`. The registration uses `ctx.slots.inject()`, so it follows late tab declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Model Experience

None, as this package only visualizes and edits a Host-owned MCP catalog in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No live Host subscription** — the tab polls `list` only while an enabled fiber is pending, loading, or unloading; a change that does not go through those phases (for example an external process rewrite of `mcp-servers.json`) waits for the next Settings mount.
- **Tool count is the global `ctx.tools` namespace** — Settings-owned mcp-client children register globally. A composition mcp-client inside an agent preset is not counted here.
- **No reconnect or timeout editor** — those mcp-client fields keep their Host defaults.
- **Cannot clear a stored secret map from an empty textarea** — empty means keep; replacing the map requires submitting new `KEY=value` lines.
