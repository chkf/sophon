# 更新与多个上游

默认更新源为公开仓库 `chkf/sophon` 的 `main` 分支，任何能访问 GitHub 和 npm registry 的部署都可获取更新，不需要项目维护者的 Token，也不需要公网 IP。主机需要 Git、Node.js 22.16+（推荐 24）、npm，以及测试所需的 ffmpeg、ffprobe。

## 首次启用

旧版本没有更新管理进程，需要先停止服务，备份数据目录和配置，再按原安装方式取得包含此功能的版本。保留自己的 `.env` 和数据，不要对已有数据重新运行 `init`。新安装按 README 完成初始化。

```sh
npm ci
npm run build
npm start
```

以后使用 `npm start` 启动。`npm run serve` 和开发入口仍可使用，但不会提供聊天内自动重启。系统服务或容器应以 `npm start` 为入口，且需要可写的部署目录；更新目录、配置和数据应持久保存。不要同时启动另一个实例。

## 命令

仅 Telegram 已配置管理员的私聊可请求更新：

| 命令 | 作用 |
| --- | --- |
| `/update` | 使用默认上游 |
| `/update sources` | 列出已配置上游，星号标记默认项 |
| `/update custom` | 使用名为 custom 的上游 |
| `/update status` | 查看进度与结果 |
| `/update rollback` | 切回上一运行版本的代码 |

主机终端也可以使用 `npm run update`、`npm run update -- custom`、`npm run update -- sources`、`npm run update -- status` 和 `npm run update -- rollback`。管理进程运行时，终端命令提交请求；未运行时只准备下次 `npm start` 使用的版本。直接启动的服务不会被终端命令重启，应先自行停止。

## 自定义上游

在最初的部署目录中，将 `update-sources.example.json` 复制为 `update-sources.json`，替换示例仓库：

```json
{
  "default": "official",
  "sources": {
    "official": {"repository": "chkf/sophon", "branch": "main"},
    "custom": {"repository": "example-account/sophon", "branch": "main"}
  }
}
```

此文件被 Git 忽略，更新不会替换它。每次请求都会重新读取配置，无需重启。最多配置 16 个上游；名称使用小写字母开头，后接小写字母、数字、下划线或连字符，最多 32 字符。`sources`、`status`、`rollback` 是保留名称。仓库填写 `owner/repository`，不要填写 URL、`.git` 后缀或凭据。目前支持 GitHub 仓库，默认分支必须明确配置。

配置的上游会安装依赖、执行构建和测试，并作为本机服务运行，因此仅添加你信任的兼容仓库。聊天命令只能选择本地已配置的名称，不能传入任意仓库或 shell 命令。公开仓库无需认证；私有仓库须由主机自身 Git 凭据机制授权，不能在这个配置里放 Token。

## 验证、切换与数据

候选代码放在 `.sophon-updates/releases/`，依次获取分支提交、安装锁定依赖、构建、运行测试，并使用候选版本的只读数据库检查器验证现有 schema v2 数据。准备阶段原服务继续运行。通过后等待原进程退出，再启动候选进程；候选发出就绪消息后才保存当前版本指针。候选启动失败会尝试重新启动原版本；停止超时则不启动第二个写入进程。

`.env`、Core、Recent、聊天记录、凭据和相对路径配置继续属于最初的部署目录。更新不覆盖这些文件，不自动迁移数据库，也不恢复旧数据快照。回退只回退代码，期间产生的数据仍保留。存在不兼容数据库变化时需停止自动更新，按该版本迁移说明操作并做好备份。

这是独立发布目录更新：最初 Git 工作区和本地源码改动不会被覆盖，也不会自动合入新版本。需要自己的代码时，应将改动放入自定义上游。运行版本以状态文件和 `current.json` 为准，不以最初工作区的 `git log` 为准。

兼容上游需保留 `update-protocol.json` 的 version 1 / explicit-only 协议，提供 `dist/main.js serve`、就绪与关闭 IPC，以及数据库只读检查接口。仅复制协议文件不足以兼容任意项目。原部署目录中的管理进程作为稳定引导程序；未来若升级管理进程或更新协议本身，仍需按首次启用步骤手动升级引导程序。

## 故障处理

通过 `npm run update -- status` 查看阶段。失败不会将构建日志或配置内容回传聊天；先检查网络、上游配置、Node 与系统依赖，再检查服务是否仍在运行。就绪仅表示启动完成，不等于对所有模型、消息渠道和长期运行行为做了完整健康检查。

突然断电或强制结束可能留下 `.sophon-updates/host.lock` 或 `update.lock`。先检查各目录中的 `owner.json` PID，并确认管理进程、Gateway 子进程和更新任务全部停止，再删除残留锁目录；不要在运行时删除锁。未消费的 `request.json` 会在下次启动时处理，不希望继续时在停机状态删除该文件。之后运行 `npm start`。

发布目录不会自动清理，应预留依赖安装和测试所需空间。停机后可清理不被 `current.json` 与 `previous.json` 引用的发布目录和遗留 `staging-*`；保留当前及上一版本才能回退。不要删除自己的数据目录。

## Windows 测试与更新排错

使用 Node.js 24，在 PowerShell 中检查下列程序是否可用：

```powershell
node --version
npm.cmd --version
git --version
ffmpeg -version
ffprobe -version
npm.cmd run typecheck
npm.cmd test
```

如果执行策略阻止 `npm.ps1`，可直接使用 `npm.cmd`，无需更改系统执行策略。完整测试需要 ffmpeg 和 ffprobe；未安装时先安装并加入 PATH，再重新打开终端。更新管理进程也需重启才能继承新的 PATH。不要通过跳过整个测试套件来处理依赖缺失。

Windows 普通账号可能没有创建符号链接的权限。相关用例仅在创建链接明确返回 Windows `EPERM` 时标记 skipped，并显示原因；普通文件、超限文件和目录越界检查仍执行。需要运行符号链接用例时可开启 Windows 开发者模式或使用具备该权限的测试环境。其他错误仍然使测试失败。

如仍失败，请记录失败用例名称、错误码、Node.js 版本和运行命令；不要分享 `.env`、登录码或服务密钥。Linux 上测试通过不代表已经完成 Windows 真机验证。

## 更新结果主动通知

管理进程中的更新（包括终端提交给运行中管理进程的请求）在成功、失败、无需更新、启动回退或检测到中断后，会主动向配置的 Telegram 管理员发送结果，不需要一直查询 `/update status`。回退命令成功也会通知。通知由管理进程直接发送，不依赖 Gateway 子进程是否存活，不调用模型，不写入聊天上下文。

待发送结果写入原部署目录的 `.sophon-updates/notifications.json`；发送失败时保留，每 30 秒重试，下次启动管理进程也会重试。管理员 ID 和 Bot Token 从本机配置读取，不存入通知队列。通知只包含简短结果、上游名称及提交短 SHA，不附带异常堆栈、构建输出或配置内容。网络断开或管理进程未运行期间不能即时送达；发送成功但确认丢失时可能收到重复通知。队列文件写入失败会在管理进程终端提示，不能保证断电后补发。

此功能修改了原部署目录的更新管理进程。已有安装需要先停止服务，手动更新原工作区、运行 `npm ci` 和 `npm run build`，再用 `npm start` 启动一次，才能启用通知；仅通过旧版 `/update` 更新发布目录不会替换旧管理进程。停机状态下执行的 `npm run update` 仍以终端结果为准，并在下次启动验证失败回退时通知。
