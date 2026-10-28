# 通用 API 配置

默认 `GATEWAY_PROVIDER=api`，支持 OpenAI 兼容的 Chat Completions 接口。可以使用云端服务、代理或本地模型服务，不需要 OpenRouter 账户。兼容协议仍有边界：接口和模型必须支持 `messages`、函数工具调用及对应的工具结果，不能把任何厂商的原生接口直接填入。

## 最小配置

在 `.env` 填写实际值：

```dotenv
GATEWAY_PROVIDER=api
GATEWAY_API_BASE_URL=https://your-api.example/v1
GATEWAY_API_KEY=your-api-key
GATEWAY_API_MODEL=your-model-id
```

`BASE_URL` 是 API 根地址。框架在后面拼接 `/chat/completions`，因此按服务要求保留 `/v1`、`/api/v1` 等前缀，不要填写完整聊天接口。地址中不能包含用户名、密码、查询参数或片段；密钥单独填写。

本地服务示例：

```dotenv
GATEWAY_API_BASE_URL=http://127.0.0.1:8000/v1
GATEWAY_API_KEY=
GATEWAY_API_MODEL=your-local-model-id
```

仅当该服务不需要认证时才留空密钥。不会要求服务实现 `/key`、余额接口或 OpenRouter 模型目录格式；模型名由你明确提供，不自动替换。

## 能力开关

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `GATEWAY_API_STREAM` | `true` | 使用标准 SSE 流式响应；设为 `false` 使用普通 JSON 响应。 |
| `GATEWAY_API_VISION` | `false` | 模型支持图片输入时才开启，采用 `image_url` 内容格式。 |
| `GATEWAY_API_HEARTBEAT_ENABLED` | `false` | 允许通用 API 的后台文字请求；还需开启全局主动消息开关。 |

本地人格、记忆、历史、工具调用和消息交付都沿用同一框架。通用模式没有内置厂商搜索、余额查询或图片生成；图片输入与图片生成是不同能力。语音仍使用单独配置的语音服务。

## 上下文与回复长度

通用 API 和 OpenRouter 的普通聊天发送本轮会话完整的文字历史，不再按 24 条、24,000 字符或本地估算 token 预算截断，也不再固定预留 4,096 个回复 token 和 2,000 个工具 token。普通请求不设置固定的 `max_tokens`，上下文容量和回复长度由所选服务及模型处理；动态加载工具后也不会触发本地预算拦截。

旧配置中的 `GATEWAY_API_CONTEXT_WINDOW` 已停用，保留该环境变量不影响升级或启动。若请求超过服务容量，由接口返回错误，框架不会自动截短后重试或切换模型。测试面板中明确选择的测试历史预算和测试输出上限仍独立生效。

## 检查和切换

```sh
npm run init
npm run gateway:check
```

`gateway:check` 在通用 API 模式检查本地数据、渠道与 API 配置是否齐全，**不会发起远端聊天请求**；显示配置就绪不等于密钥已验证或服务可达。实际连通性可显式测试：

```sh
npm run runtime:test -- --allow-paid
```

该命令会向当前选定的模型发送一条真实请求，可能计费。失败或结果不确定时，框架不会自动换供应商或重新发送相同付费操作。

通过面板保存的 Provider 和固定模型会持久保存，修改环境变量中的初始值不会覆盖这些选择；尚未保存选择时才使用环境初始值，`Auto` 则跟随环境中的默认模型。通过 Telegram `/model` 的 Provider 设置选择“通用 API”并确认。

更换通用 API 模型时，修改 `.env` 中的 `GATEWAY_API_MODEL` 并重启。如果之前固定选择了某个模型，还需在 `/model` 的聊天模型页面选择 `Auto` 并确认，恢复使用环境配置。通用模式的列表只展示当前配置的模型，不自动请求供应商模型目录；面板暂不提供任意模型 ID 的文本输入。

## 可选 OpenRouter 专用模式

OpenRouter 也可以作为通用兼容服务接入。需要它的专用模型目录、联网搜索或生图功能时，显式选择专用适配器：

```dotenv
GATEWAY_PROVIDER=openrouter
OPENROUTER_API_KEY=your-api-key
OPENROUTER_DEFAULT_MODEL=your-model-id
```

这套配置与 `GATEWAY_API_*` 分开。通用模式不会因为缺少某种能力自动调用专用适配器，也不会自动使用另一套密钥。
