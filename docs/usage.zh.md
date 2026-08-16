# 飞书插件使用指南

本文说明如何把 `dsh-feishu-bot` 接入已有的 DeepSeek Harness `web` Profile，并在飞书私聊中创建、续接和审批智能体任务。

## 1. 配置飞书应用

在飞书开放平台创建企业自建应用并启用机器人，然后完成以下配置：

- 开通接收私聊消息权限 `im:message.p2p_msg:readonly`。
- 开通以机器人身份发送消息权限 `im:message:send_as_bot`。
- 使用长连接订阅事件 `im.message.receive_v1`，不需要公网回调地址。
- 启用卡片回调事件 `card.action.trigger`，用于允许或拒绝审批卡。
- 每次修改权限或事件配置后发布新的应用版本；只保存草稿不会生效。

从飞书事件调试记录的 `sender.sender_id.open_id` 获取允许使用机器人的用户标识。白名单要求 `ou_` 开头的 `open_id`，不要使用 `on_` 开头的 `union_id`。

## 2. 配置凭据

推荐把 App ID 和 App Secret 保存到 `$DSH_HOME/.credentials.yaml`；未设置 `DSH_HOME` 时默认路径为 `~/.dsh/.credentials.yaml`：

```yaml
FEISHU_APP_ID: "cli_xxx"
FEISHU_APP_SECRET: "替换为真实 App Secret"
```

在 macOS 或 Linux 上限制文件权限：

```sh
chmod 600 ~/.dsh/.credentials.yaml
```

也可以在启动 `dsh` 的同一个 shell 中设置同名环境变量。进程环境优先于凭据文件；修改环境变量后需要重启进程。不要把真实凭据写入本仓库、Profile Patch 或聊天记录。

## 3. 安装插件

在 `deepseek-harness` 仓库根目录执行：

```sh
pnpm dsh plugin --profile web add /path/to/dsh-feishu-bot
```

当前仓库依赖使用相邻 `deepseek-harness` 的 `link:` 路径，这是源码联调方式。阶段 6 已提供预览产物门禁：在干净工作树执行 `pnpm release:preview`，脚本会生成 `artifacts/tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz`、`SHA256SUMS`、同名 `.cdx.json` SBOM 与 `release.json` descriptor，并自动检查 packed manifest 无 `link:`/本机路径、隔离安装、四入口导入和干净 DSH Profile 配置组合。安装预览包时使用绝对路径：`dsh plugin --profile web add /absolute/path/to/tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz`。重复安装或更换插件版本后，需要重启 `web` Profile。本地产物已完成 tarball-backed 真实 Profile 启动和 HTTP smoke；正式 RC workflow 虽已在源码中实现并通过本地合同校验，但尚未创建 tag、GitHub Release 或 npm 版本，不应描述为已发布。registry 发布并核验 tarball、`next` 和 npm provenance 后，安装 spec 才是 `@tingrudeng/dsh-feishu-bot@next`。

如果现有 `web` Profile 仍安装旧 unscoped 包 `dsh-feishu-bot`，切换到正式 scoped RC 前必须先执行 `dsh plugin --profile web remove dsh-feishu-bot`，再执行 `dsh plugin --profile web add @tingrudeng/dsh-feishu-bot@next`。DSH 按真实 package name 维护 bundle，直接 add scoped 包不会自动替换旧包，两者并存会重复插入同名 `feishu-*` 行。npm RC 尚未真实发布时不要执行后一条 add 命令。

维护者执行首次 npm 发布前，必须先创建受保护的 `npm-release` Environment，启用阻止既有 `v*-rc.*` tag 被移动/删除的 tag rules，并启用 Immutable Releases。workflow 不使用 GitHub 只保留一个 pending run 的原生 concurrency：Environment 放行后，publish job 会以只读 Actions 权限等待所有更小 `run_number` 完成，再拒绝任何不严格高于当前 npm `next` 的 RC。按 run number 从小到大审批；要放弃旧 run 时先显式取消它。rerun 会被正式门禁拒绝，失败后使用新的更高 RC tag。workflow 会在 draft 创建前后、npm publish 前和 Release finalize 前 peel 远端 tag 并比对 `GITHUB_SHA`，但 repository policy 才能封闭 tag 检查与写入之间的窄窗口。GitHub API 也无法把 draft asset 的最终 GET 校验与公开 PATCH 合成一个原子操作；finalize 期间不得让其他 `contents: write` 主体修改 draft，PATCH 后校验失败应按发布事故处理，不能使用已公开的异常 Release。首包把 `NPM_AUTH_MODE` 设为 `bootstrap`，把 `NPM_BOOTSTRAP_GIT_SHA` 固定为已批准的 tag commit，并只给 publish step 提供短期 `NPM_TOKEN`。首包成功后立即撤销 token、删除 secret 与 bootstrap SHA，配置绑定本仓库、`.github/workflows/release.yml` 和 `npm-release` Environment 的 Trusted Publisher，再把模式切为 `oidc`。这些都是远程写操作，必须单独确认；普通安装者无需配置。

## 4. 配置用户和工作区白名单

不要修改插件自带的 `cordis.patch.yml`。在部署方 Profile Patch `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖 `feishu-bridge`：

```yaml
- id: feishu-bridge
  config:
    allowedOpenIds:
      - ou_xxxxxxxxxxxxxxxx
    allowedWorkspaces:
      - /Users/your-name/code
    defaultWorkspace: /Users/your-name/code
```

- `allowedOpenIds` 为空时拒绝所有飞书用户。
- `allowedWorkspaces` 为空时不能通过飞书列出、绑定或新建会话。
- `defaultWorkspace` 可省略；配置后必须位于某个 `allowedWorkspaces` 根目录内。
- `/new <cwd>` 的目标目录也必须位于允许根目录内。
- 通常不要配置 `agentProvider` / `agentModel`：插件会跟随 Harness 当前的 `agent-default-model`。如需为飞书通道单独覆盖，两个字段必须同时配置。

常用可靠性配置可以继续放在同一个 `feishu-bridge.config` 下；默认值通常无需修改：

```yaml
    recoveryTtlMs: 86400000
    disposeDrainTimeoutMs: 5000
    inboundMaxRecords: 50000
    deliveryMaxRecords: 10000
    approvalMaxRecords: 1000
    projectionCursorMaxRecords: 10000
    maintenanceIntervalMs: 86400000
```

这些 `MaxRecords` 是硬上限，不是内存提示值。受保护的可恢复入站、pending delivery、活动审批和保护性 cursor 不会为了腾位被删除；无法安全清理时插件会记录 `*-backpressure` 并拒绝新 admission/让路审批。完整 TTL、retention 与 Gateway 重试配置见 [README](../README.md#configuration-reference)。

## 5. 检查组合并启动

先查看最终合并配置：

```sh
pnpm dsh --profile web --dump-config
```

应当同时看到以下四行：

```text
feishu-gateway    @tingrudeng/dsh-feishu-bot/gateway
feishu-bridge     @tingrudeng/dsh-feishu-bot/bridge
invariants        @deepseek-ai/dsh-invariants
feishu-invariant  @tingrudeng/dsh-feishu-bot/invariant
```

然后启动：

```sh
pnpm dsh --profile web
```

看到 `dsh web: http://127.0.0.1:3080` 且进程保持运行后，在飞书中私聊机器人。

启动顺序上，Gateway 不会在构造时立即接收消息。Bridge 先完成审批失效、binding 校验、入站对账、保留清理和 cursor 初始化，再按 chat FIFO 排入旧 outbox、canonical delivery 与 session-log catch-up，然后注册 admission 并启动长连接。排入的网络发送可在就绪后继续，不得因一条挂起的飞书请求阻塞插件激活；同 chat 新入站仍排在已排入的恢复工作之后。正常启动日志中的 `long connection started` 因而只表示本地恢复编排与接收门槛已就绪，不表示排队的网络恢复已全部送达，也不表示真实飞书收发已经验收。

## 6. 飞书聊天命令

建议首次使用依次发送：

```text
/help
/ls
/new /Users/your-name/code/example-project
```

| 命令 | 作用 |
|---|---|
| `/new [cwd]` | 在允许工作区内创建会话并绑定当前私聊 |
| `/ls` | 返回“工作空间 → 会话”两级可点击卡片；两级都每页最多 7 条，不截断未归档会话 |
| `/use <编号或 sessionId>` | 绑定未归档会话；编号对应当前已打开工作空间的会话卡，亦作为卡片不可用时的文本兜底 |
| `/status` | 查看当前绑定状态 |
| `/stop` | 停止正在运行的任务，同时保留排队的后续消息 |
| `/release` | 解除当前私聊与会话的绑定，停止后续飞书同步；会话继续在 Web 运行 |
| `/help` | 查看命令帮助 |

绑定成功后，普通文本会原样进入该 Harness 会话。chat 保持绑定期间，从飞书或 Web 发起的每条直接用户任务都会在飞书对应一张原位更新的任务卡；该任务内部的 subagent report/settled 与 continuation turn 不会另建卡，也不会把含工具调用的过程说明逐条发回。任务收口后只发送一次最新最终回复；正文超过单卡上限时才拆为必要的绿色结果卡分段。发送 `/release` 后停止 Web/飞书会话同步。需要人工授权时，可在飞书审批卡或 Web 页面作出决定，先完成的有效决定生效。

`/ls` 首张卡只显示工作空间 basename 与其中的会话数；点击后在原卡展示该工作空间内与 Web 端一致的真实会话标题，没有标题的空会话显示“未命名会话”。同名工作空间会用本次快照内的序号区分，不展示父目录或完整路径。工作空间只有一个会话时会直接进入绑定；有多个会话时直接点击标题即可绑定。返回、上一页和下一页始终更新原卡，所有卡片动作先快速返回状态提示，再在 chat FIFO 中完成标题加载、patch 或绑定；异步更新失败会另发文本回执。

卡片及对应编号快照默认有效 5 分钟，只允许原 chat 中发起 `/ls` 的操作者使用；过期、转发、重复点击或归档状态变化都会拒绝绑定。按钮 payload 只含随机 token、层级、页码和索引，不含 cwd 或 sessionId。进入某个工作空间后，`/use <编号>` 才引用该工作空间冻结的会话顺序；返回工作空间列表后编号失效。卡片永久不可用时才降级为最多 20 条的命名编号文本列表，可回复 `/use <编号>`；若建卡结果因 timeout 或断连而不确定，不会再补发另一种形态以免重复，因为拿不到原卡 message ID，此时即使迟到出现的卡片也会拒绝点击，须重新发送 `/ls`。进程重启后旧卡片的内存快照失效，需要重新发送 `/ls`。Web 端已归档的会话不会显示，也不能通过完整 sessionId 从飞书重新绑定；需要先在 Web 端取消归档。

## 7. 常见问题

### 启动时报 `waiting for service: invariants`

确认 `--dump-config` 同时包含 `invariants` registry 和 `feishu-invariant` companion。若缺少 registry，更新本插件后重新执行安装命令并重启 Profile。

### 机器人收不到消息

依次检查：

1. 飞书应用版本是否已经发布。
2. 是否使用长连接订阅了 `im.message.receive_v1`。
3. App ID、App Secret 是否由启动进程实际读取。
4. `allowedOpenIds` 是否填写事件中的 `ou_` open_id。
5. 发送者是否在白名单内。

### `/new` 或 `/use` 被拒绝

检查目标会话的真实路径是否位于 `allowedWorkspaces` 下。工作区白名单按规范化后的真实路径校验，符号链接不能绕过限制。

### 审批按钮没有响应

确认飞书后台已启用并发布 `card.action.trigger`。若日志中没有 `feishu-audit action=card-click-received`，说明回调尚未送达插件，应先检查飞书应用的事件配置与版本状态。

### 出现 `*-backpressure` 或 `capacity exhausted`

这表示受保护记录已经占满硬容量。先根据固定审计字段确认是 inbound、delivery、approval 还是 cursor，再检查 Profile 是否长期未重启、maintenance 是否被设为 `0`、对应 TTL 是否合理，以及是否存在持续失败的 pending。不要通过删除 storage 文件或盲目调大上限掩盖恢复事实。

### 出现 `bridge-drain-timeout`

Bridge 在 `disposeDrainTimeoutMs` 内未能排空已接纳的 chat/card/approval/projection 工作，随后会关闭存储写入。此时不能把 reload 当作无损成功；保留 storage，重启后观察 canonical pending 是否续发，并记录 `chatQueues`、`cardActors`、`approvalGroups`、`background` 计数。不要把消息正文或完整 ID 粘贴到问题单。

### 卡片失败后为什么没有立即发文本

只有飞书明确拒绝卡片形态时才允许文本 fallback。timeout、断连和 5xx 属于结果模糊：原 create 可能已经在平台成功，立即换成文本会造成跨形态重复，所以插件会保留原形态和稳定 UUID 重试/恢复。

## 8. 实机验收与记录边界

正式使用前，在不含真实业务信息的专用测试 chat 按 [HANDOFF 的阶段 5 矩阵](HANDOFF.md#阶段-5真实飞书故障验收欠账) 验证重复事件、启动期消息、进程中止、重启补投、create timeout、patch 失败、审批 fallback 和 HMR drain。

验收记录只保存：时间、错误 code/status、hash 标识、消息数量、最终状态。不要保存消息正文、凭据、完整 open_id/chat_id/message_id 或本机绝对路径。自动化测试证明本地状态机，不等同于飞书平台的 ACK、UUID 去重和迟到完成证据。

## 9. 数据安全边界

绑定会话后，助手回复会发送到飞书服务器，其中可能包含源代码、文件内容、命令输出、本机路径或模型复述的敏感信息。插件没有出站正文过滤器。

`allowedWorkspaces` 只限制飞书可以列出、创建和绑定哪些会话，并不限制智能体以当前 OS 用户身份读取其他文件。不要允许包含不可离机信息的工作区；需要真正的读取隔离时，应使用独立的 OS 用户或独立运行环境。
