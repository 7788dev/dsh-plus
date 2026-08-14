# @deepseek-ai/dsh-client-ui-settings-mcp

[English](README.md) | 中文

Web 设置中的 **MCP** 标签页。浏览器插件注册一个 id 为 `mcp`、order 为 `5` 的本地化 `settings.plugins.tab` 贡献（位于「插件配置」与「插件列表」之间）。插件激活期间不会读取 Remote；首次选择该标签页时才挂载组件，并通过 [`api-remotes`](../../api/remotes/README.md) 懒调用 `ctx.remote.mcpSettings.list()`。

该标签页以卡片列出设置页拥有和组合拥有的服务器。每张卡片显示 mcp-client fiber 是否在运行，以及该服务器当前在全局注册了多少个工具。设置页拥有的行可以添加、编辑（包括名称）或删除；组合拥有的行保持只读。重命名设置页行时会发送 `fromServerName`，由 Host 原地替换该行。环境变量与请求头按 `KEY=value` 逐行输入。编辑时文本框留空则保留已存储映射；页面从不显示密钥值。加载、空结果与通用失败状态只属于已挂载组件。任一已启用 fiber 处于 pending、loading 或 unloading 时，标签页会再次请求 `list`，因此卡片可以在不离开本页的情况下离开「加载中」。删除设置页拥有的行会先弹出确认对话框，再调用 `mcpSettings/delete`。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

## 模型体验

无，因为本包只在浏览器设置中展示并编辑 Host 拥有的 MCP 目录，不注册任何模型接口。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **无实时 Host 订阅** —— 标签页只在已启用 fiber 处于 pending、loading 或 unloading 时轮询 `list`；不经过这些阶段的变化（例如进程外改写 `mcp-servers.json`）要等到下次挂载 Settings。
- **工具数来自全局 `ctx.tools` 命名空间** —— 设置页拥有的 mcp-client 子实例注册到全局。位于 agent preset 内的组合 mcp-client 不计入此处。
- **无重连或超时编辑器** —— 这些 mcp-client 字段保持 Host 默认值。
- **无法用空文本框清空已存储的密钥映射** —— 留空表示保留；替换映射需要提交新的 `KEY=value` 行。
