# 架构与扩展边界

```text
Telegram / optional WeChat iLink
                |
      owner authorization + queue
                |
             Gateway
       /        |
   Core/Recent  runtime
   SQLite       routing
                |
         provider response
                |
        durable delivery ledger
                |
         channel confirmation
```

`src/gateway.ts` 协调上下文、工具、模型和交付；`src/service.ts` 负责启动、渠道接线与关闭。传输适配器只处理渠道协议、所有者校验和交付确认。

## 上下文与历史

`src/setup.ts` 提供显式初始化。`src/core` 读取和校验 Core，`src/expression` 管理独立的心理和动作描写开关，`src/memory` 管理可选的记忆图，`src/knowledge` 保存 Recent 话题。`src/sessions` 保存会话原文。正式状态集中于 `data/sessions/gateway.sqlite`，启动时校验完整性，缺失或损坏的正式上下文不静默恢复为默认身份。

Core 可以通过 CLI 以 Markdown 导入导出。Core 与 Recent 的模型工具使用修订检查，防止覆盖较新的状态。不要用示例配置替换已有用户数据库。

## 模型与渠道

`src/runtime/types.ts` 定义运行时接口，`src/runtime/providers.ts` 保存显式 Provider 选择。默认 `api` 使用自定义地址的 OpenAI 兼容 Chat Completions 协议；`openrouter` 保留该服务的专用能力；`siwc` 延迟加载、独立安装，不影响默认 API 路径。新增 Provider 需同时更新配置、选择持久化和 UI，不能自动切换到会收费的提供商。

通用 API 通过显式模型 ID 和上下文窗口配置运行，不依赖供应商的余额、认证探测或模型目录接口。请求只发送标准聊天和工具调用字段；厂商专用联网搜索、生图和余额查询由专用适配器负责。API 的配置就绪与远端实际连通性分别检查，避免启动时自动发出付费测试。

`src/channels/types.ts` 定义输入消息和平台引用。新渠道应保持所有者授权、输入去重、按序处理、真实交付确认，以及对不确定交付结果不盲目重发的约束。

## 本地工具

Gateway 为正式对话提供本地 Core、Recent 和聊天历史工具，并按渠道与配置开放语音、原生回复等能力。工具执行范围由代码定义，未知工具调用会被拒绝。

Core 与 Recent 的修改写入本地 SQLite，执行前校验参数和修订号，执行后读取确认。工具输出与异常不能改变用户授权或持久指令。

## 主动消息

Heartbeat 默认关闭。管理员可在 `/proactive` 面板即时启停，选择持久保存在本地 SQLite，优先于环境变量初始值。面板开启同时授权当前 Provider 的后台文字请求；语音、图片和 MCP 仍遵循各自配置。关闭阻止后续工具调用和消息交付，但不撤销已发出的外部请求。启用后保留静默时间、冷却时间、每日次数、重复内容过滤及 `SILENT` 结果；不内置个人日程或第三方业务任务。

## 运行边界

单个数据目录同时运行一个实例；新实例通过受保护的本地接管流程处理旧实例。关闭顺序先停止渠道与待处理任务，再关闭模型连接、数据库和实例锁。

源码更新、数据库维护和生产部署由操作者执行。框架不依赖任何私人仓库、固定服务器或个人资料目录。
