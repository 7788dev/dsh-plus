# dsh-plus

给已安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加上 **设置 → 插件 → MCP** 和 **视觉** 页。别人装上这个包就能直接用，不用改 harness 源码、也不用拷贝目录。

需要本机已能运行 `dsh`（或 `npx @deepseek-ai/dsh`），版本 **0.1.0-rc.5** 或兼容版本。仓库里已经提交了构建好的 `lib/`，从 GitHub 安装时 **不需要** `allowBuilds`。

## 安装

```sh
dsh plugin --profile web add github:7788dev/dsh-plus
dsh web
```

然后打开 Web UI → **设置 → 插件**：

- **MCP**：添加 stdio 或 Streamable HTTP 服务器。配置写在 `$DSH_HOME/mcp-servers.json`，模型看到的工具名是 `mcp__<名称>__…`。
- **视觉**：配置一个 OpenAI 兼容的多模态接口，并勾选要外挂视觉的渠道模型。聊天里的图片会先由该视觉模型识别，再把描述交给原来的文本模型。配置写在 `$DSH_HOME/vision-bridge.json`（密钥只留在本机）。硅基流动可用 `https://api.siliconflow.cn/v1` 和 `Qwen/Qwen3-VL-32B-Instruct`。

只跑 headless、不要设置页时：

```sh
dsh plugin --profile headless add github:7788dev/dsh-plus
```

卸载：

```sh
dsh plugin --profile web remove dsh-plus
```

不要装到已经内置 MCP 设置页的改版 dsh 上（会和现有 `mcp-settings` 行冲突）。官方发行版没有这一页，装这个包就是为了补上它。

## 这个包做什么

| 半侧 | 作用 |
| --- | --- |
| Host（`lib/index.js`） | 读写 `mcp-servers.json`，把已启用的服务器挂成 `mcp-client` 子 fiber |
| Host（`lib/vision.js`） | 读写 `vision-bridge.json`，把勾选的文本模型声明为可收图，并在 `llm/stream` 里用视觉模型替换图片 |
| Web（`lib/client.js`） | 设置页 MCP 标签与视觉标签 |
