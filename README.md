# dsh-plus

DeepSeek Harness 插件：在 **设置 → 插件** 里管理 MCP，并为文本模型外挂视觉识图。

Installable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. MCP catalog + Vision Bridge, without forking the harness.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-111.svg)](https://github.com/deepseek-ai/deepseek-harness)

<p align="center">
  <img src="docs/vision-look-at.png" alt="Chat: paste images, look_at_image Call, text model answers from captions" width="820" />
</p>
<p align="center"><sub>贴图 → <code>look_at_image</code> Call → 原文本模型作答</sub></p>

## 特性

- **MCP**：在设置页添加 stdio 或 Streamable HTTP 服务器，工具名 `mcp__<名称>__…`
- **视觉**：配置 OpenAI 兼容的多模态接口，按文本模型勾选外挂；聊天里直接贴图
- **Call 识图**：`look_at_image` 和 Curl 一样走工具 Call，不写进模型自己的 Think
- **GitHub 安装**：仓库已包含构建好的 `lib/`，不需要 `allowBuilds`

## 环境

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **0.1.0-rc.5** 或兼容版本（`dsh` / `npx @deepseek-ai/dsh`）
- 官方发行版。不要装到已经自带 MCP 设置页的改版上（会和现有 `mcp-settings` 冲突）

## 安装

```sh
dsh plugin --profile web add github:7788dev/dsh-plus
dsh web
```

打开 Web UI → **设置 → 插件**。

只要 Host、不要设置页：

```sh
dsh plugin --profile headless add github:7788dev/dsh-plus
```

卸载：

```sh
dsh plugin --profile web remove dsh-plus
```

## MCP

**设置 → 插件 → MCP**

| | |
| --- | --- |
| 传输 | stdio、Streamable HTTP |
| 配置 | `$DSH_HOME/mcp-servers.json` |
| 工具名 | `mcp__<serverName>__<tool>` |

环境变量和请求头只留在 Host，页面不会回显密钥。

## 视觉

**设置 → 插件 → 视觉**

1. 填写多模态 Chat Completions 接口（Base URL、模型 ID、API Key）
2. 测试连接
3. 勾选需要收图的文本模型（已自带视觉的模型不会走外挂）
4. 在聊天里粘贴 PNG / JPEG / WebP / GIF

硅基流动可用 `https://api.siliconflow.cn/v1` 和 `Qwen/Qwen3-VL-32B-Instruct`。

配置在 `$DSH_HOME/vision-bridge.json`，API Key 只保存在本机：

```json
{
  "version": 1,
  "vision": {
    "baseURL": "https://api.siliconflow.cn/v1",
    "apiKey": "",
    "model": "Qwen/Qwen3-VL-32B-Instruct"
  },
  "targets": [
    { "provider": "your-provider", "model": "your-text-model", "enabled": true }
  ]
}
```

勾选的模型遇到图片时，Host 注入 `look_at_image`，视觉模型写成文字，再交给原来的文本模型（上下文里是 `[Image: …]`）。

## 结构

| 入口 | 运行侧 | 作用 |
| --- | --- | --- |
| `dsh-plus` | Host | 读写 `mcp-servers.json`，把已启用的服务器挂成 `mcp-client` |
| `dsh-plus/vision` | Host | 读写 `vision-bridge.json`，声明可收图，注入 `look_at_image` |
| `dsh-plus`（client） | Web | 设置页的 MCP / 视觉标签 |

Loader 行见 [`cordis.patch.yml`](cordis.patch.yml)。两个 Host Remote 共用同一个 Typert 包名 `dsh-plus`。

## License

[MIT](LICENSE) © 7788dev
