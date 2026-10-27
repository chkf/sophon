# 更新与多个上游

默认上游为公开仓库 `chkf/sophon` 的 `main`，可从 Telegram 管理员私聊使用 `/update`。不需要维护者 Token 或公网 IP。部署主机需要 Git、Node.js 22.16+（推荐 24）、npm；代码验证需要 ffmpeg 和 ffprobe。

## 首次启用与旧安装

新安装完成 README 初始化后，使用 `npm start`。系统服务或容器也应使用此入口；部署目录、配置、数据及 `.sophon-updates` 必须持久保存。不要同时启动另一个实例。

**采用旧管理程序的安装需要一次引导升级。** 旧版 `/update` 只更新业务发布目录，无法替换仍在运行的旧管理程序。停止服务并备份数据与配置，按原安装方式更新最初的部署目录（有本地源码改动时先保存并处理），然后执行：

```sh
npm ci
npm run build
npm start
```

保留 `.env` 和已有数据，不要重新运行 `init`。完成这一次升级后，管理程序、通知、组件检查和终端更新命令会跟随所选发布版本加载，不必为了每次更新器改动再次手动更新原目录。启动入口只负责持有实例所有权、加载版本及恢复失败的切换。

`npm run serve` 和开发入口仍可用，但不提供聊天内自动更新重启。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/update` | 更新默认上游 |
| `/update sources` | 列出已配置上游，星号标记默认项 |
| `/update custom` | 更新名为 custom 的上游 |
| `/update status` | 显示阶段、结果、版本和检查计划 |
| `/update rollback` | 恢复上一运行版本代码 |

终端对应使用 `npm run update`、`npm run update -- custom`、`npm run update -- sources`、`npm run update -- status` 和 `npm run update -- rollback`。

管理进程运行时，终端提交请求并等待自己的结果，显示变化的阶段；Ctrl+C 只停止等待。管理员也会收到最终通知。最近 50 个请求的结果保存在 `results.json`，后续请求不会覆盖正在等待的结果。未运行时，命令仅准备版本，下次 `npm start` 验证健康后才生效；不会重启直接启动的服务。

## 自定义上游

在原部署目录把 `update-sources.example.json` 复制为 `update-sources.json`：

```json
{
  "default": "official",
  "sources": {
    "official": {"repository": "chkf/sophon", "branch": "main"},
    "custom": {"repository": "example-account/sophon", "branch": "main"}
  }
}
```

配置文件被 Git 忽略，每次请求重新读取。最多 16 个上游；名称以小写字母开头，后接小写字母、数字、下划线或连字符，最多 32 字符。`sources`、`status`、`rollback` 是保留名称。仓库使用 `owner/repository`，不能包含 URL、`.git` 后缀或凭据；分支须明确配置。

仅添加信任的兼容仓库：更新会运行其依赖脚本、构建、测试及服务代码。聊天命令只能选择已配置名称。公开仓库无需认证；私有仓库使用主机 Git 凭据机制，不能把 Token 写在上游配置中。

## 按变更验证

候选放在 `.sophon-updates/releases/`，准备期间原服务继续运行：

- 同一提交且已有完整、同平台的验证产物：不重新安装、构建或测试。
- 仅文档变化：复制上一版本的独立依赖与构建产物，不重新测试、不重启服务。
- 依赖未变化且产物可复用：复制依赖，不重复 `npm ci`。依赖或 Node ABI 变化、产物缺失、旧发布版本未记录验证信息时完整安装。
- 应用源码或构建输入变化：构建并运行完整测试。管理脚本变化：检查脚本语法并运行完整测试。
- 未识别的变更保守执行验证。失败的候选不成为当前版本，再次 `/update` 会重新验证。

不同版本的依赖与产物是独立副本，不共享可写链接。原工作区、本地配置及数据不被覆盖；本地源码改动不会自动合入候选，需要自己的代码时请使用自定义上游。运行版本以 `current.json` 和状态为准，不以原目录的 `git log` 为准。

## 激活、恢复与数据

验证通过后，先用候选读取器只读检查数据库兼容性，再记录切换检查点、停止旧业务进程与临时隧道，重新加载候选管理程序并启动业务进程。只有就绪且本机 `/healthz` 报告正确 PID、健康状态及 Core 可用，才确认当前版本并通知成功。

候选管理模块加载、启动或健康检查失败时，恢复上一版本的管理程序和业务代码；停止超时不会启动第二个写入进程。中断的切换保留 `activation.json`，下次启动继续验证或回退。停机准备不等于更新成功。健康检查不代表所有模型和外部渠道均已完成端到端验证。

`.env`、Core、Recent、历史、凭据和相对路径仍属于原部署目录。更新准备和回退不迁移主数据库、不恢复旧数据快照。回退期间产生的数据继续保留；主 schema 不兼容时必须显式迁移。候选启动阶段的功能初始化遵循相应配置。协议中的 `startupExtensions: ["memory-v2"]` 声明默认记忆扩展准备：取得业务实例锁、验证主库、保存快照后才处理扩展，详见 [记忆图](memory-graph.md)。

兼容上游需保留 `update-protocol.json` 的 version 1 / explicit-only 主状态协议及就绪、关闭 IPC；`host: 1` 表示提供 `scripts/host/manager.mjs` 的 `runManager` 与 `scripts/host/update-cli.mjs` 的 `runUpdateCLI` 入口。仅复制协议文件不能让任意项目兼容。旧 version 1 发布可通过已安装的管理适配器运行和回退。

## 结果与排错

结果主动发送给配置的 Telegram 管理员，独立于业务进程、不调用模型、不写入聊天上下文。成功、失败、无需更新、回退、健康异常和中断各有明确结果；通知包含提交短 SHA、失败阶段及下一步提示，不附带原始构建输出。

`/update status` 或 `npm run update -- status` 显示可读阶段。原部署目录的 `.sophon-updates/update.log` 保存最近一次更新的命令输出和阶段，最多 2 MiB；仅在本机查看失败用例或编译错误。日志过滤已知环境密钥，不能保证第三方命令输出永远没有敏感内容，分享前仍应检查。日志不会自动发到聊天。

通知队列存放在 `.sophon-updates/notifications.json`，失败每 30 秒重试并可在重启后补发。仅 Telegram 确认有效消息 ID 后移除；发送成功但确认丢失可能重复。未运行管理程序或网络不通时无法即时送达。

启动和更新会自动检查并补齐 cloudflared，包括代码无变更的情况；已有显式路径、PATH 程序或已校验缓存会复用。组件失败不阻止业务代码更新。管理进程自动启用隧道，入口仍要求管理员登录；重载管理程序时临时网址可能变化，重新获取控制中心链接即可。详见 [控制中心](control-center.md)。

突然断电可能留下 `host.lock`、`update.lock` 或 `cloudflared.lock`。`npm start` 会自动回收能确认原管理进程已退出、记录完整的 `host.lock`；仍有进程、记录不完整或离线更新留下的锁不会自动回收。其他残留锁仍需先检查各目录 `owner.json` 的 PID，并确认管理进程、业务进程和更新任务全部停止，再手动删除。不要在运行时删除锁。待处理的 `request.json` 下次启动会继续处理；不需要的请求仅在停机时删除。保留 `activation.json` 以便恢复未完成的切换。

发布目录不自动清理。停机时可清理不被 `current.json`、`previous.json`、`activation.json` 引用的版本及残留 `staging-*`。预留依赖副本和测试所需空间，不要删除数据目录。

### Windows

推荐 Node.js 24。在 PowerShell 检查：

```powershell
node --version
npm.cmd --version
git --version
ffmpeg -version
ffprobe -version
```

执行策略阻止 `npm.ps1` 时可直接用 `npm.cmd`，无需修改系统策略。安装依赖后重新打开终端并重启服务，才能继承 PATH。不要通过跳过整个测试套件解决依赖缺失。

符号链接用例仅在 Windows 明确返回 `EPERM` 时跳过，普通文件和目录安全检查仍执行。报错时记录失败用例、错误码、Node 版本及运行命令；不要分享 `.env`、登录码或密钥。Linux 测试通过不等于完成 Windows 真机验证。

## 自动启用的功能

更新后的业务进程统一启用文件工具、Recent 后台整理、记忆图和 Cloudflare 手机控制中心。旧 `.env` 的对应 `false/off` 不再生效，无需改写配置文件。`npm start` 自动准备手机入口，管理员通过 `/status` 获取登录链接；需要正常的出站网络和管理员配置。图分类仍需要受支持的 SIWC 模型；缺失能力时显示等待状态，不切换到其他付费服务。Recent 使用当前 Provider 额度，主动消息仍保持原有独立开关。旧引导程序的一次性升级要求不变。
