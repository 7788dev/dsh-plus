# @deepseek-ai/dsh-mcp-settings

[English](README.md) | 中文

面向 UI 管理的 MCP 服务器的 Host Remote。`McpSettingsGateway` 注册 `mcpSettings` 服务，并发布 `mcpSettings/list`、`mcpSettings/upsert` 与 `mcpSettings/delete`。设置页拥有的服务器持久化在 `$DSH_HOME/mcp-servers.json`（权限 `0600`），使 Web 与 headless 共用一份目录，而不写入无法往返 `!!js` 密钥的 `cordis.patch.yml`。每条已启用的设置页来源记录会挂载一个 `@deepseek-ai/dsh-mcp-client` 子 fiber；组合来源的 `mcp-client` Loader 行在 `list` 中只读出现。

视图从不包含环境变量或请求头的**值**，只包含键名。`list` 的每一行包含当前 mcp-client fiber 阶段，以及该服务器在 `mcp__<serverName>__` 命名空间下已全局注册的工具数量。若某个 `serverName` 已被组合行占用，upsert 与 delete 会拒绝。upsert 上与 `serverName` 不同的 `fromServerName` 会原地重命名该设置页行，并保留省略的环境变量/请求头。对 JSON 文件的外部编辑在下次进程启动时生效；设置页写入会立即重新挂载。

公开 payload 类型位于 `./types`。Typert 生成由 `./typert` 与 `./remote` 导出的 Host 和 Client Remote 产物。Client 包通过 [`api-remotes`](../../api/remotes/README.md) 消费该服务。

## 模型体验

无，因为这个 Host 目录只持久化配置并挂载 mcp-client 子实例；发现的工具及其面向模型的 schema 属于 mcp-client。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **无文件监视** —— 对 `mcp-servers.json` 的外部编辑要到下次进程启动才会重新挂载；设置页写入会在进程内立即重新挂载。
- **组合行仍走 YAML** —— 由 `--patch` 或 profile patch 引入的服务器不能在此编辑或删除。
- **密钥在 UI 中只写** —— 编辑时环境变量/请求头文本框留空则保留已存储映射；页面从不回显值。
- **不暴露重连策略** —— 设置页拥有的服务器使用 mcp-client 默认值，而不是按服务器编辑重连。
