# Sophon

连接消息、模型与记忆的个人 AI 网关。

可自行部署的消息网关框架：连接 Telegram 与可选微信 iLink，管理模型接入、会话历史和本地上下文。默认提供中性的助手配置，身份、风格和服务由使用者自行设置。

Self-hosted messaging gateway with local SQLite context, optional memory graph, durable delivery and provider routing. Framework source is MIT licensed; optional components keep their own licenses.

## 能力与范围

- Telegram 管理员私聊、消息合并、原生回复、媒体传输与持久化交付状态。
- [Telegram 贴纸](docs/telegram-stickers.md)：静态图片识别、动态贴纸预览，以及当前或历史贴纸的选择发送。
- 可选微信 iLink；通过 Telegram 管理员管理绑定。
- SQLite 会话历史、全文检索、Core 与 Recent 上下文、可编辑的表达风格。
- 通用 OpenAI 兼容 API（自定义地址、密钥、模型）；可选 OpenRouter 专用模式与 ChatGPT 登录适配器。
- 可选语音、图片生成和主动消息。
- 内置 Core、Recent 和聊天历史工具。
- 可选本地文件浏览、保存与发送、确认后修改或删除，以及独立的后台 Recent 整理。
- 可选 [Sophon 控制中心](docs/control-center.md)：聊天历史与 Core/Recent 管理、上下文观察、主动任务调用轨迹和主机走势；与已有 slash 面板分工。

当前是单用户、单实例框架。API、数据库格式和配置仍可能演进。主动消息默认关闭；没有内置个人资料、私人业务工作流或固定角色设定。

## 快速开始

需要 Node.js **22.16.0 或更高版本**（推荐 Node.js 24）及 npm。

```sh
git clone https://github.com/chkf/sophon.git
cd sophon
npm ci
```

将 `.env.example` 复制为 `.env`，填写：

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_OWNER_ID=your-numeric-user-id
GATEWAY_PROVIDER=api
GATEWAY_API_BASE_URL=https://your-api.example/v1
GATEWAY_API_KEY=your-api-key
GATEWAY_API_MODEL=your-selected-model-id
GATEWAY_TIMEZONE=UTC
```

使用自己的真实配置替换示例值。接口需兼容 Chat Completions，模型需支持工具调用；地址保留服务要求的 `/v1` 等路径，不要填写完整的 `/chat/completions` 地址。API 调用和可选媒体服务按对应服务商规则计费。

```sh
npm run init
npm run gateway:check
npm run serve
```

`init` 只创建全新的数据目录，写入中性 Core 和独立描写设置，并初始化 SQLite；如果目录已存在会停止，避免覆盖。运行后可通过 Telegram `/expression` 面板控制心理和动作描写。Core 可导出为 Markdown 后编辑并重新导入：

```sh
mkdir private
npm run core -- export ./private/assistant-core.md
# 编辑 private/assistant-core.md，再执行：
npm run core -- import ./private/assistant-core.md
```

Core 导出不会覆盖已有文件；导入会校验内容。私人 Core、聊天历史导出和备份建议放在已被 Git 忽略的 `private/`、`exports/`、`backups/` 或仓库外，不要提交到源码仓库。数据保存在 `GATEWAY_DATA_DIR`，默认 `./data`；备份时停止服务后完整复制该目录，并单独保管加密密钥。

正式运行可使用编译后的入口：

```sh
npm run build
npm start
```

## 配置与扩展

详细环境变量见 [`.env.example`](.env.example)。

默认是通用 API，不指定供应商。自建本地服务也可使用；支持标准流式响应或 `GATEWAY_API_STREAM=false` 的普通响应。接入示例、能力限制与连通性检查见 [通用 API 配置](docs/api.md)。

**默认使用 SQLite，不需要另外安装数据库服务。** `npm run init` 会在默认的 `data/sessions/gateway.sqlite` 建立数据库，保存身份指令、人格风格、话题记忆、聊天历史和已登记的运行状态。媒体文件与凭据等仍可能存放在数据目录的其他位置。

Core、描写和记忆如何配置，见 [存储与表达设置指南](docs/personalization.md)，包含 Telegram 面板步骤和可编辑的 [Core 示例](examples/core.example.md)。

- **主动消息**：显式启用 `GATEWAY_HEARTBEAT_ENABLED=true` 后才运行。通用 API 还需设置 `GATEWAY_API_HEARTBEAT_ENABLED=true`，OpenRouter 则设置 `OPENROUTER_HEARTBEAT_ENABLED=true`；频率、静默时间和时区由环境变量控制。
- **ChatGPT 登录**：可选，安装方式和非商业许可限制见 [SIWC 说明](docs/optional-siwc.md)。默认安装不下载该组件。
- **语音**：安装可从命令行访问的 `ffmpeg` 与 `ffprobe`，配置自己的 `DASHSCOPE_API_KEY` 和匹配账号地域的 `GATEWAY_VOICE_BASE_URL`（HTTPS API Host，不含路径），再在 `/model` 面板进入语音设置。npm 不安装这些系统工具；不启用语音时照常使用文字。
- **微信 iLink**：启用 `GATEWAY_ILINK_ENABLED=true`，通过 `/proactive` 绑定。在无系统凭据存储的主机上，先用 `npm run credentials:create -- ./secrets/chatgpt-credential.key` 生成密钥，再设置 `GATEWAY_CREDENTIAL_KEY_FILE=./secrets/chatgpt-credential.key`；此密钥不依赖 SIWC。

提供商不会因出错自动切换；选择和历史各自持久保存。模型与服务可用性由对应账号和上游服务决定。

文件工具与后台记忆整理默认关闭，启用方法及边界见 [文件操作](docs/files.md) 和 [Recent 后台整理](docs/recent-review.md)。两项功能均使用现有服务和 SQLite；后台整理无需开启主动消息。

服务启动后将带时间戳并脱敏的日志写入 `data/logs/gateway.log`，供 Telegram `/logs` 读取；单文件最多约 5 MiB，并保留一份轮换文件。`GATEWAY_LOG_DIR` 可覆盖目录，`GATEWAY_LOG_ENABLED=false` 可关闭文件日志。

## 开发与验证

完整测试包含离线音频转换用例，开发环境还需安装 `ffmpeg` 与 `ffprobe` 并加入 PATH。类型检查、测试和构建均通过下面的本地命令执行。

```sh
npm run typecheck
npm test
npm run build
```

测试使用隔离的临时目录及合成数据，无需私有仓库或真实服务凭据。测试名称、示例对话、表达设置和预期结果统一使用中性的任务、文档或消息内容；角色描写用例使用翻页、查看文档等普通动作，不复制实际聊天或个人设定。真实 Telegram、微信、付费模型及 SIWC 登录需使用自己的账号另行验证。

框架没有内置跨仓库自动更新或个人服务器部署操作。使用 Git 更新源码前先备份，检查变更与数据库兼容性。

## 许可证

框架源码按 [MIT](LICENSE) 发布。依赖和可选组件的许可范围见 [第三方说明](THIRD_PARTY_NOTICES.md)。`package.json` 的 `private: true` 仅防止意外发布到 npm，不限制源码使用。

可选的[记忆图与三日上下文窗口](docs/memory-graph.md)需要显式停机迁移和历史回填，默认关闭。
