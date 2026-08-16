# M4–M5 完成清单

## 目标

完成 `docs/HANDOFF.md` 与 `docs/implementation.md` 中尚未交付的 M4 体验/可靠性要求，并完成 M5 文档、审计日志、配置说明和 DSH 版本证据。

## 范围

- M4 剩余任务卡 UX、时间线归并和导航卡适用性审计。
- M4 启动恢复、绑定校验、outbox 续发/清理、HMR 释放和状态不变量。
- M5 README、审计事件、配置参考和 DSH 版本记录。
- 不重启用户正在运行的 `dsh web`；飞书实机验收由用户执行并回传结果。

## 验收标准

- 运行中任务卡仅保留一个“思考中……”尾标，终态卡不含该尾标。
- 时间线拒绝旧序号事件，同一调用 ID 原位更新，成功图标使用 `✅`。
- 启动时能使悬空绑定失效、拒绝超龄入站恢复项、续发有效 pending outbox，并按 TTL/容量清理终态数据。
- dispose 后不再接收入站/领域事件，定时器、监听器和领域存储均释放；活跃绑定始终指向存在的 session。
- README 准确描述 Model Experience、配置项、审计边界和经核实的 DSH 版本。
- 受影响测试、类型检查、全量测试和最终 diff 审查通过。

## 实施步骤

### M4 体验

- [x] 用 RED 测试定义“思考中……”尾标的幂等追加与终态移除。
- [x] 用 RED 测试定义旧序号拒绝、同 ID 原位更新及 `✅` 图标，再完成实现。
- [x] 核对“命令结果回写原卡 + accepted/completed 两阶段”是否存在实际消费者；当前仅审批卡按钮且同步决定，无耗时导航按钮，故本期无适用入口，不制造无入口功能。

### M4 可靠性

- [x] 启动恢复：pending 卡失效、绑定 session 校验、入站恢复、outbox pending 续发。
- [x] 恢复时拒绝超过 TTL 的 `received/recovering` 入站项并留下无正文审计记录。
- [x] outbox 记录发送尝试，超龄 pending 转 abandoned；终态记录按 TTL 和容量清理。
- [x] 以持久化 watermark 阻止已清理 sent 记录被重复投影。
- [x] dispose 关闭入站、监听器、定时器和领域存储，并验证可控发送队列收敛。
- [x] 增加并执行“活跃绑定必须指向存在 session”的不变量检查。

### M5

- [x] 补齐安全审计事件，确保日志不包含消息正文、命令正文、凭据和完整路径。
- [x] 更新 README 的 Model Experience、当前状态和验收边界。
- [x] 补齐配置参考、默认值和可靠性参数说明。
- [x] 记录本地链接 DSH 的版本与源码提交证据。

### 验证与交付

- [x] 执行聚焦测试、类型检查和全量测试。
- [x] 复核实际 diff、敏感信息和未跟踪文件。
- [x] 提交并推送，使用远端 SHA 复核。
- [x] 记录飞书实机验收待用户执行的明确步骤与结果边界。

## 验证方式

- `npm test -- --runInBand`（以仓库实际脚本为准）
- `npm run typecheck`（以仓库实际脚本为准）
- `git diff --check`
- `git status --short --branch`
- `git ls-remote origin refs/heads/master`

## Review

- RED→GREEN 覆盖任务卡时间线、workspace symlink 逃逸、审批跨 chat/伪造卡片、SDK `formatErrors` 重复响应体、非文本事件去重等边界。
- `npm run typecheck`：通过（exit 0）。
- `npm test`：16 个测试文件、140/140 通过（exit 0）。
- `npm run build`：通过，生成 17 个 ESM/声明文件；四个导出入口均可导入。
- `git diff --check`、敏感凭据模式和原始错误正文日志扫描：无输出；未跟踪文件均为本任务新增实现、测试或清单。
- 主交付提交 `893d93db734d1b3e748b29ea1e57dd2a0bd18d9f` 已推送至 `origin/master`，首次 `git ls-remote` 返回同一 SHA。
- 剩余风险：未重启用户的 `dsh web`，飞书真实长连接、结果卡降级、重启续发及 Web/飞书审批 race 仍须按 `docs/HANDOFF.md` 实机验收。

---

# M6–M7 发布前可靠性加固计划

## 当前状态与执行纪律

- 当前状态：计划已落地，实施尚未开始。
- 当前源码安装使用 `link:../deepseek-harness/...` 是本地联调方案，不作为缺陷处理；在正式产物阶段再消除本机路径依赖。
- 一次只开始一个阶段；每个阶段完成后立即更新本清单中的勾选项和实际验证证据，向用户汇报并等待“继续”后再进入下一阶段。
- 未经单独授权，不提交、不推送、不发布正式产物，也不重启用户正在运行的 `dsh web`。
- 后续核心行为修复采用 RED→GREEN；本计划本身不修改实现代码。

## 目标

- 修复审查确认的五个 P1 可靠性问题：入站持久化边界、终态投影缺口、飞书发送幂等、审批卡可见性、绑定切换补偿。
- 修复三个 P2 长期运行问题：任务卡并发竞争、关闭/容量边界、SDK 日志泄露面。
- 用自动化故障注入和真实飞书验收证明“崩溃、重试、超时、重启”下不会静默丢消息、重复执行或无限等待。
- 在源码联调通过后生成可复现、可校验、无本机 `link:` 路径的正式安装产物；实际发布仍需用户单独确认。
- 让 README、设计文档、使用文档和交接文档只陈述已有证据支持的能力。

## 非目标

- 不引入 WeClaw 的 host writer lease、跨主机接管协议或完整 CardKit 2.0 流式渲染；当前 DSH Bridge 是单进程、按 chat 串行模型。
- 不复制 WeClaw 的 AGPL 源码；只借鉴故障模型、串行化方式、关闭顺序和测试思路，在本 MIT 项目中独立实现。
- 不重构无关 DSH 核心模块，不改变 Web 端既有会话/审批语义。
- 不在本阶段上传凭据、消息正文、完整本地路径或用户标识，也不把真实密钥写入仓库和测试夹具。

## 已确认事实、推论与未知项

### 已确认事实

- 现有全量测试和类型检查只能证明当前实现自洽，尚未覆盖本计划列出的故障窗口。
- Gateway 当前在自身初始化期间启动长连接；Bridge 尚未完成领域存储恢复和入站监听注册时，飞书事件已经可能到达。
- 当前 `feishu/message` 是同步事件通知，Gateway 不会等待 Bridge 把入站正文持久化后再让 SDK 回调完成。
- 终态结果只跟随实时 `session/event` 投影；启动恢复只扫描既有 outbox，没有按会话日志补投遗漏终态。
- 创建消息未传稳定 `uuid`，所有错误共用重试逻辑；卡片失败可直接跨形态回退为文本，超时场景存在重复发送风险；卡片 patch 未校验业务返回码。
- 已有审批组卡 patch 失败会被吞掉，调用方仍可能把审批视为已经展示；`/use`、`/new` 的绑定持久化失败没有完整清理新建 handle。
- 任务卡发送/patch 没有统一串行化；Bridge dispose 未等待全部 chat/card/watermark 队列；容量和 watermark 清理还不是硬边界。
- Harness `storage-domain` 只有单域写队列，没有多记录事务；JSON/SQLite 后端对版本不匹配直接拒绝，没有原地迁移能力。

### 推荐推论

- 入站 ACK 的提交点应是“正文已进入持久化领域”，而不是业务处理完成；这样既缩短回调耗时，也保留崩溃后恢复能力。
- 飞书消息 `message_id` 比可能变化的事件投递 ID 更适合作为业务去重主键；`event_id` 保留为别名/审计事实。
- 终态投影应以会话日志为权威来源，用持久 cursor 和确定性 delivery key 重放；网络发送不是 cursor 的提交点。
- 对同一逻辑发送，重试和重启必须复用同一飞书 `uuid`；不确定的传输失败不得立即改用另一发送形态。
- 由于当前存储没有跨记录事务，安全顺序应是先确定性写 delivery、再推进 cursor；两步之间崩溃只会重复覆盖同一 key，不会漏投影。
- 为避免 `feishu_bot` 版本升级导致旧联调数据无法打开，新的终态 delivery/cursor 优先放入独立的 v1 存储域；原有领域只做可向后读取的可选字段扩展。

### 尚待实施阶段核实

- 飞书官方对 create-message `uuid` 的长度、字符集、有效期和业务错误码分类；先以当前 SDK 类型为入口，再以官方文档和实测收敛。
- DSH 会话持久层补读日志的最小稳定接口，以及冷恢复生成合成终态事件时的 cursor 语义。
- 真实飞书长连接在处理器抛错、超时和进程中止后的重投时间窗。
- 正式产物应依赖已发布的 DSH 包版本，还是由 DSH 官方打包流程内联工作区依赖；在 M7 前根据实际发布渠道决策。

## 问题清单与发布门槛

| 优先级 | 问题 | 当前影响 | 完成门槛 |
| --- | --- | --- | --- |
| P1-1 | 启动顺序与入站 ACK 早于持久化 | 启动/崩溃窗口可丢入站正文 | Bridge 恢复并注册异步 admission 后才启动 WS；回调等待 durable `received` |
| P1-2 | 终态只实时投影，无日志补读 | 进程在事件与 outbox 写入之间退出会永久漏结果 | 启动/事件触发均从日志 cursor 补读，确定性写 delivery 后再推进 cursor |
| P1-3 | 创建消息无 UUID、错误分类粗糙 | 重试/重启或跨形态回退可重复发消息 | 稳定 UUID 跨重试复用；区分确定失败与不确定失败；patch 校验业务码 |
| P1-4 | 审批组卡 patch 失败被隐藏 | 用户看不到审批，agent 可无限等待 | patch 失败回滚组内项并发独立审批卡；只有可见卡才能进入等待态 |
| P1-5 | 绑定切换无事务补偿 | 失败后泄漏新 session 或留下错误绑定 | 只清理 `created-here`；CAS 式恢复仍为当前 after-image 的绑定 |
| P2-1 | 任务卡发送/patch 并发 | 可能产生两张卡或终态被迟到的 running 覆盖 | 每张卡一个串行 actor、一个 timer；终态关闭后拒绝迟到更新 |
| P2-2 | 关闭、容量和 watermark 无硬边界 | HMR/长运行可能写后关闭、内存增长或超容量 | 停止 admission 后有界 drain；硬容量背压；终态/水位可回收 |
| P2-3 | SDK 辅助路径日志未统一静默 | SDK 错误可能带请求/响应正文 | EventDispatcher 与 smoke 使用静默 logger；自有日志只输出固定脱敏事实 |
| Release | 调试安装依赖本机 `link:` | 打包物不能在干净环境安装 | 单一发布脚本完成 clean build、pack 检查、干净安装、启动 smoke 和校验和 |

## 关键设计约束

### 1. 入站 durable admission

- Gateway 初始化只解析凭据并构造 Client、WSClient、EventDispatcher，不立即启动长连接。
- Gateway 暴露单一、Promise-returning 的入站 admission 注册点；不依赖同步 `ctx.emit` 表达提交结果。
- Bridge 顺序执行：打开领域存储 → 完成恢复/清理 → 注册 admission 与卡片动作处理器 → 明确启动 Gateway intake。
- SDK 消息回调必须 `await` admission。Admission 只负责校验最小信封、以 `message_id` 去重并持久化 `received`；后续 command/followup 处理继续进入 per-chat FIFO，不占用 ACK 窗口。
- 新入站以 `message_id` 为主键，保存 `event_id` 作为审计别名；兼容窗口内同时查询旧 `event_id` 键，避免已有数据立刻失效。
- 达到硬容量时先清理可淘汰终态；若剩余全是不可淘汰项，则明确拒绝 admission，让飞书重投并记录无正文背压审计，不伪装成功。

### 2. 会话日志投影与 canonical delivery

- 新增独立的 `feishu_bot_delivery` v1 领域，至少包含 per `(chat, session)` cursor 与 canonical delivery 记录；不修改现有 `feishu_bot` 的版本戳。
- cursor 表达已物化到 delivery 的最高日志序号，不表达网络已送达；启动和实时通知都调用同一 catch-up 函数。
- 以会话日志为权威输入，从 cursor 后补读；遇到终态时先用确定性 key 写完整 canonical 文本，再推进 cursor。
- delivery key 至少包含 chat、session、源事件序号和逻辑阶段；重复补读只覆盖同一记录。
- 完整文本只持久化一次；发送时按固定规则确定性分段，segment index 参与 UUID 派生，避免逐段持久化造成部分物化。
- 升级启动先续发旧 `outbound_segments` pending 记录，再从旧 watermark 初始化新 cursor；切换完成后不再生成旧 segment。

### 3. 飞书传输幂等与错误语义

- `sendText`/`sendCard` 接收逻辑 delivery identity，由 Gateway 生成或校验稳定 UUID；同一逻辑段在即时重试和进程重启后保持一致。
- 显式分类：成功、确定性永久失败、可重试失败、不确定提交结果。只有可重试/不确定结果复用同一 UUID 重试。
- 卡片转文本只允许发生在飞书明确返回“不支持/内容非法”等确定性错误时，并使用可追踪的 fallback stage；超时、断连、5xx 等不确定结果不得跨形态发送。
- create/patch 都校验 HTTP 调用和飞书业务 `code`；错误日志只保留 code、status、attempt、hash 后的目标等固定字段。

### 4. 审批可见性与绑定补偿

- 审批组更新返回明确结果，不吞掉 patch 失败。
- 已有组卡 patch 失败时，撤销本次尚未展示的组内项，改发独立审批卡；独立卡成功并持久化 message ID 后才 claim/wait。
- 若独立卡发送结果不确定，保持可恢复状态并审计，禁止把审批标成已展示；重启恢复按持久事实重试或安全拒绝。
- `/use`、`/new` 共用绑定切换 helper：记录旧 binding、目标 handle 来源、candidate after-image 和持久化结果。
- 失败补偿只在当前 binding 仍等于本次 after-image 时恢复旧值，避免覆盖后续操作；仅 dispose `created-here`，绝不 dispose `existing`，且 cleanup 使用独立有界超时。

### 5. 卡片串行化、关闭顺序与安全边界

- 每个任务卡只有一个 promise chain/actor 和一个受管 throttle timer；send、patch、terminal 全部进入同一队列。
- terminal 操作原子关闭 actor、取消 timer，再写最终卡；关闭后的 running update 被丢弃并留下固定字段审计。
- Bridge dispose 顺序：关闭 admission → 注销 intake/listener → 有界等待 chat 队列、卡片 actor、审批队列、投影/outbox 队列 → 关闭领域存储 → Gateway 关闭连接并 drain 统一发送/patch 队列。
- pending/terminal/dead-letter 分别设硬容量和 TTL；不可淘汰集合占满时背压，不允许“soft cap”继续增长。
- watermark/cursor 在 binding 失效且相关 delivery 均终态后回收；每次清理都有计数审计，不输出正文和完整标识。
- EventDispatcher、WS/Client 和 `scripts/feishu-smoke.mjs` 统一使用静默或严格脱敏 SDK logger。

## 分阶段实施步骤

### 阶段 0：锁定契约与 RED 测试

- [x] 保存当前基线：Git 状态、现有 140 项测试、类型检查和构建结果；不把用户已有文档改动纳入实现 diff。
- [x] 为 Gateway 可控启动、Promise admission 和“持久化完成前回调不结束”补 RED 测试。
- [x] 为相同 `message_id`、不同 `event_id` 的重复投递补 RED 测试。
- [x] 为终态投影在 delivery 写入前/后崩溃、cursor 写入前/后崩溃补 RED 测试。
- [x] 为 UUID 跨立即重试/重启稳定、超时不跨形态 fallback、patch 非零业务码补 RED 测试。
- [x] 为审批组 patch 失败回滚并降级为独立卡、绑定写失败按来源补偿补 RED 测试。
- [x] 为快速 `turn/start → turn/end`、首个 send 阻塞、迟到 running patch 补 RED 测试。
- [x] 为 dispose drain、容量背压、cursor 清理和 SDK 日志无正文补 RED 测试。
- [x] 用旧 `feishu_bot` 存储 fixture 验证新代码可读取；验证新增 delivery 领域不会破坏旧领域数据。

阶段 0 验收：新增测试只因缺失目标行为而失败，失败信息能对应上述风险，不修改生产代码来制造 RED。

阶段 0 验证记录（2026-08-15）：

- 修改前基线：`./node_modules/.bin/vitest run` 为 16 个文件、140/140 通过；`./node_modules/.bin/tsc --noEmit` exit 0；`npm run build` exit 0、生成 17 个文件。
- 新增 20 项契约/兼容测试后：17 个文件、160 项测试，其中 142 通过、18 项按预期 RED；没有未处理 rejection 或测试夹具异常。
- RED 分布：Gateway 7 项（启动/admission/UUID/业务码/patch drain/logger）、Bridge 8 项（message ID/模糊失败/任务卡/审批/绑定/日志补投/cursor）、可靠性 2 项（硬背压/cursor 清理）、存储领域 1 项（独立 delivery domain）。
- 两项新增绿色护栏：旧 `feishu_bot` v1 fixture 可直接读取；`/use` 绑定失败不会销毁 existing live session。
- 修改后 `./node_modules/.bin/tsc --noEmit` 仍为 exit 0；本阶段未修改 `src/`、配置、脚本或生产依赖。

### 阶段 1：修复启动顺序与入站提交点

- [x] 拆分 Gateway 构造与 intake 启动，保证 start/stop 幂等并覆盖未启动即 dispose。
- [x] 增加 Promise-returning admission 注册/注销协议，Bridge 完成恢复后才启动 intake。
- [x] 将入站主键切换为 `message_id`，保留 `event_id` 审计别名和旧键兼容查询。
- [x] Admission 在 durable `received` 后返回；业务处理仍按 chat FIFO 异步推进。
- [x] 落地硬容量清理与背压语义，并验证拒绝时不会 ACK 成功或记录正文。
- [x] 运行阶段 1 聚焦测试、全量测试、类型检查和 diff 审查。

阶段 1 验收：任何消息回调完成时都已有可恢复记录；Bridge 未 ready 时 WS 不接流量；重复 message ID 只执行一次。

阶段 1 验证记录（2026-08-15）：

- Gateway 初始化不再启动 WS；显式 `startIntake`/`stopIntake` 串行且幂等，未启动即 dispose、停止后 HMR 重启和关闭先停 intake 均有测试覆盖。
- SDK 入站回调等待 Bridge 的 Promise admission；Bridge 在恢复、清理和 outbox 续发完成后注册 admission，再启动 intake。持久化成功后业务才进入 per-chat FIFO。
- 新入站以 `message_id` 为 `inbound_events` 键，记录 `event_id`/`message_id` 审计事实；旧 v1 `event_id` 键仍可命中并复用已提交结果。
- 容量达到上限时先执行可淘汰终态清理；不可淘汰记录仍占满时 admission 明确抛错，测试确认不新增记录、不保存新正文且不发送回复。
- 阶段 1 聚焦测试：3 个文件、10/10 通过；`./node_modules/.bin/tsc --noEmit`、`npm run build`、`git diff --check` 均 exit 0。
- 全量测试：17 个文件、164 项测试，其中 150 通过、14 项按阶段 0 约定继续 RED；分布为 Gateway 5、Bridge 7、可靠性 1、存储领域 1，均对应阶段 2–6 尚未实现的契约，因此全量命令预期 exit 1。

### 阶段 2：修复终态投影与飞书发送幂等

- [x] 定义 `feishu_bot_delivery` v1 领域、旧 outbox 兼容读取和旧 watermark 到新 cursor 的初始化规则。
- [x] 实现统一 catch-up：启动与实时事件都从会话日志 cursor 后补读。
- [x] 以 canonical delivery 单行持久化完整结果，确定性分段，先写 delivery 再推进 cursor。
- [x] 为每个逻辑段派生稳定 UUID，并让 text/card create 的所有重试复用该 UUID。
- [x] 实现错误分类；不确定失败只重试同一形态/UUID，确定性卡片错误才允许文本 fallback。
- [x] 校验 create/patch 业务码，消除 patch“HTTP resolved 即成功”的假设。
- [x] 验证旧 pending segment 可续发，新路径不再产生部分 segment 集合。
- [x] 运行阶段 2 聚焦测试、全量测试、类型检查、构建和存储兼容测试。

阶段 2 验收：在每个故障注入点重启后，终态最终恰好形成一组逻辑 delivery；没有永久漏投影或跨形态重复发送。

阶段 2 验证记录（2026-08-15）：

- 新增独立 `feishu_bot_delivery` v1：完整结果先作为单行 canonical delivery 持久化，分段仅在发送时确定性派生；旧 `feishu_bot` v1、pending segment 和 watermark 保持可读并可迁移。
- 启动恢复与实时通知共用 cursor catch-up；离线期间提交的终态可在重启后补投影，新 `/use` 绑定从现有日志头开始，不回放绑定前历史。
- card/text create 按 delivery、阶段和分段派生稳定 UUID；重试和 Gateway 重启复用同一 UUID。不确定错误保留原形态 pending，只有确定性卡片拒绝才切换文本 fallback。
- create 与 patch 的非零飞书业务码均显式失败；旧 pending segment 可继续发送，新结果只产生一条 canonical delivery，不再写入旧分段表。
- 聚焦验证：Gateway 的 6 项 Phase 2 契约全部通过；结果卡与存储兼容 7/7 通过；Bridge 的实时投影、永久/不确定失败、长结果、旧 outbox、离线追赶、cursor 恢复和历史不回放用例全部通过。
- 工程验证：`npm run typecheck`、`npm run build`、`git diff --check` 均 exit 0。全量 `npm test` 共 167 项，160 通过、7 项按阶段 0 约定继续 RED：Bridge 4、Gateway 2、可靠性 1，分别留给阶段 3–5。
- 交付前复核结论：阶段 2 通过；未发现新增凭据硬编码、正文日志或旧 v1 数据破坏。项目整体仍未完成，后续 RED 不属于本阶段通过范围。

### 阶段 3：修复审批可见性与绑定切换补偿

- [x] 让审批组 send/patch 返回显式展示结果，删除吞错路径。
- [x] 已有组卡 patch 失败时回滚本次 item，发送并持久化独立审批卡；可见后才进入等待态。
- [x] 为卡 ID 回填失败定义可观察、可恢复的状态，重启不重复决定审批。
- [x] 抽取 `/use`、`/new` 共用的绑定切换 helper，按 `existing | created-here` 所有权补偿。
- [x] 用 after-image 条件保护 binding 回滚，cleanup 超时独立于主失败，命令结果如实标记失败/不确定。
- [x] 运行阶段 3 聚焦测试、全量测试、类型检查和 diff 审查。

阶段 3 验收：agent 只等待用户实际可见的审批卡；任何绑定写失败都不销毁已有 session、不泄漏本次新建 handle、不覆盖后续绑定。

阶段 3 验证记录（2026-08-15）：

- 审批组 send/patch 通过显式结果返回成功或失败；既有组卡 patch 失败会撤销未展示 item，并发送独立审批卡，不再把失败 patch 当作已经展示。
- pending approval 使用 `staged | visible | uncertain` 展示状态；只有卡片 message ID 成功持久化后才进入等待。回填失败会冻结可见卡并委派，不确定 create 保留 `uncertain` 事实并安全拒绝按钮。
- `/use`、`/new` 共用 binding switch：cursor 初始化和 binding 写入处于同一补偿边界，只有 `created-here` 持有 dispose 权限；existing agent 永不由失败操作销毁。
- binding 写入若可能已生效，仅在当前值仍等于本次 candidate after-image 时恢复旧值；检测到更新后的 binding 时不覆盖。cleanup 使用独立 `bindingCleanupTimeoutMs`，超时只留下审计，不改变主失败原因。
- 失败命令持久化为 `rejected` 并返回“失败 / 状态不确定”结果；同一 `message_id` 重投只回放首次结果，不重复创建 session 或切换 binding。
- RED→GREEN 覆盖：组卡 patch 独立 fallback、卡 ID 回填失败、不确定独立卡发送、created-here/existing 所有权、applied after-image、较新 binding 保护、cleanup timeout、cursor 准备失败和 rejected 命令重投。
- 工程验证：`npm run typecheck`、`npm run build`、`git diff --check` 均 exit 0；旧 `feishu_bot` v1 兼容测试 2/2 通过。全量 `npm test` 共 174 项，170 通过、4 项按计划继续 RED：任务卡 actor 1、Gateway patch drain/logger 2、cursor 清理 1。
- 交付前复核结论：阶段 3 通过；未发现新增凭据硬编码、消息正文日志、existing agent 误销毁或旧 v1 数据破坏。项目整体仍需继续阶段 4–6。

### 阶段 4：消除卡片竞争并收紧生命周期/容量/日志

- [x] 将每张任务卡的 create、throttle patch、terminal patch 纳入单一 actor，统一 timer 所有权。
- [x] terminal 关闭 actor 并取消迟到更新，证明只产生一张最终卡且不会被 running 覆盖。
- [x] 将 card patch 也纳入 Gateway 队列和 shutdown drain；Bridge 等待所有已接纳工作后再关闭 domain。
- [x] 为 inbound、delivery、dead-letter、approval、cursor 定义硬容量、TTL 和安全淘汰顺序。
- [x] 清理失效 chat/session 的 watermark/cursor，验证长运行集合有界。
- [x] EventDispatcher 与 smoke 脚本改用静默 SDK logger，补请求/响应正文不可见测试。
- [x] 运行阶段 4 聚焦测试、全量测试、类型检查、构建、diff 和敏感信息检查。

阶段 4 验收：HMR/dispose 不发生 domain close 后写入；已接纳工作在期限内收敛或明确留作恢复；内存/持久集合有硬边界；日志不含消息正文。

阶段 4 验证记录（2026-08-15）：

- 每个任务 turn 的 create、throttle patch、terminal patch 共用一个 actor promise 与一个 timer；running create 被阻塞、10 秒 throttle 且 `/stop` 快速到达时，仍只 create 一次并在同一 message 上立即写入“已停止”，迟到 running 不会覆盖终态。
- Gateway 的 card patch 纳入按 message 串行的发送队列和 shutdown drain；card action 注册返回显式 unregister。Bridge 以单一 lifecycle effect 关闭 admission、注销 inbound/card listener、排空 chat/card/approval/projection/maintenance tail，再关闭两个 domain，避免 Cordis 并行 effect 提前关闭存储。
- Bridge 新增 `disposeDrainTimeoutMs`；超时后关闭写入闸门并留下固定字段审计。被阻塞的 canonical delivery 保持 durable pending，晚到网络完成不能写已关闭 domain，重启按同一 delivery key/UUID 恢复并收敛。
- canonical delivery、pending approval、projection cursor 新增独立 TTL/硬容量；旧 outbound segment 继续承担兼容 dead-letter 的 pending TTL、终态 retention 与容量规则。不可安全淘汰的 pending/active 集合占满时显式背压或委派，不删除恢复事实。
- maintenance 只在 binding 已失效且相关 delivery 均终态后删除 cursor/watermark；chat tail 完成后移出内存，过期 `/ls` snapshot 在维护时清理。旧 cursor 的 `updatedAt` 为可选字段，`feishu_bot` v1 与旧 delivery cursor 仍可读取。
- EventDispatcher 和独立 smoke 使用全 no-op SDK logger；Client/WS 继续使用严格 redactor。请求/响应正文、循环对象和 SDK 重复 response body 的测试均不可见原文，自有审计只输出 hash、计数、状态和错误事实。
- 聚焦验证：Gateway/reliability/domain compat/logger 4 个文件 30/30；Bridge Phase 4 actor、正常/超时 drain、容量、stale cursor 与 HMR 场景通过。全量 `npm test` 为 17 个文件、182/182，exit 0。
- 工程验证：`npm run typecheck`、`npm run build`、`git diff --check` 均 exit 0；高置信 token 形态扫描为 0，凭据关键词命中仅为凭据引用读取，不含硬编码值。
- 交付前复核结论：阶段 4 通过；未发现 domain close 后写入、重复任务卡、活跃审批/cursor 被容量淘汰或消息正文日志。真实飞书延迟、断连、SDK late completion 与平台 UUID 去重仍按阶段 5 做专用 chat 验收。

### 阶段 5：文档校准与真实飞书故障验收

- [x] 行为实现后再更新 `README.md`、`docs/design.md`、`docs/implementation.md`、`docs/usage.zh.md`、`docs/HANDOFF.md`，删除无证据的“已完全幂等/可靠”表述。
- [x] 更新启动顺序、提交点、UUID、错误分类、恢复模型、容量/TTL 和运维诊断说明。
- [ ] 使用专用测试 chat 执行：重复事件、启动期消息、进程中止、重启补投、创建超时、patch 失败、审批 fallback、HMR drain。
- [ ] 只记录时间、错误码、哈希标识、消息数量和最终状态；不保存真实正文、凭据和完整用户 ID。
- [ ] 将真实验收结果和仍未覆盖的平台风险写回本清单 Review。

阶段 5 验收：自动化与真实飞书结果一致；文档中的每项可靠性声明都能指向测试或实机证据。

阶段 5 文档检查点（2026-08-15）：

- README/design/implementation/usage/HANDOFF 已按阶段 1–4 的当前源码校准；M0 记录与 WeClaw 借鉴文档中的旧 source/outbox/fallback 结论也补充了后续修订说明。
- 文档明确区分 durable admission、业务处理、canonical materialization、网络 delivery 四个提交点；只把稳定 UUID、故障注入和恢复状态机列为自动化证据，不声明飞书平台端到端 exactly-once。
- 配置默认值已对照 Gateway/Bridge schema；硬容量、受保护集合背压、Bridge/Gateway 各自 drain deadline 与无正文诊断规则已写入使用/交接文档。
- 归档会话过滤、默认模型与 Loader readiness 修复后的新鲜验证：`npm test` 17 个文件、189/189；`npm run typecheck`、`npm run build` 均 exit 0；build 生成 16 个文件。差异、文档链接与凭据扫描结果见下方最新实机检查点。
- 本文档检查点形成时，真实飞书矩阵尚未执行；后续进展见下方“首次实机检查点”，阶段 5 后三项仍保持未完成。

阶段 5 首次实机检查点（2026-08-15）：

- 首次启动暴露了真实问题：一条 durable pending delivery 的网络恢复被 Bridge 启动同步等待，导致 `feishuBridgeReady` 未发布，Profile 以 `pending (waiting for service: feishuBridgeReady)` 失败。
- 已以 RED 用例复现，将旧 outbox、canonical delivery 与 session-log catch-up 改为启动时按 chat FIFO 排队，不再等待外部网络完成后才 ready。同 chat 恢复顺序与 dispose drain 跟踪仍保留。
- 第二次真实 Profile 启动稳定超过 40 秒；专用 chat 的 `/help` 只收到 1 条命令回复。另 1 条 Markdown 类型消息被按非文本路径拒绝，用户确认收到 1 条“暂不支持非文本消息”提示，符合当前设计。
- 启动 catch-up 在 `/help` 之前将 canonical delivery 从 23 条增至 224 条，均属于同一个哈希化 chat/session，并在本地记录为 `sent`；用户端未报告历史结果刷屏。内部 API 成功记录与客户端可见数量尚未建立可复核映射，不将该次观察用作平台 exactly-once 证据。
- 专用 chat 实际发送 `/release` 后，持久化聚合显示该命令为 `committed`、binding 为 0、pending approval 与旧 pending outbox 均为 0。为避免命名不直观，`/help`、解绑回执与使用文档已明确“停止后续飞书同步，会话继续在 Web 运行”。
- `/release` 后用户又执行 `/ls`、`/use` 并发送普通文本，因此 chat 已按显式命令重新绑定；随后任务卡显示失败。只读检查目标 session 的终态错误为 `NO_ADAPTER: no adapter registered for provider "deepseek"`：Bridge 旧默认值绕过了 Harness 当前 `agent-default-model`。现已改为默认跟随 `agentDefaultModel.currentSelection()`，仅在 `agentProvider` 与 `agentModel` 成对配置时覆盖。
- 同次实机反馈确认 `/ls` 会列出 Web 已归档会话。根因是 Bridge 只按 workspace/subagent 过滤，未读取 Harness 的 `workspaceRegistry.archivedSessionIds`；现已在 `/ls` 与 `/use`（含完整 id、旧编号解析后）统一拦截归档会话。聚焦 RED→GREEN 覆盖 4 项，全量为 187/187。
- 最终源码快照重新执行 `npm test`（17 文件、189/189）、`npm run typecheck`、`npm run build`，均 exit 0；build 生成 16 个文件。`git diff --check`、8 份 Markdown 相对链接检查和高置信凭据模式扫描均 exit 0。
- 当前 Profile 已用 readiness 修复后的新构建重启并稳定运行，等待飞书端实测：`/ls` 不显示归档会话、普通文本使用 Harness 当前默认模型完成任务。重复事件、中止窗口、timeout/断连、patch/审批 fallback、Web/Feishu race 与 HMR drain 仍未完成真实矩阵。
- 新构建首次重启再次暴露 Loader 时序问题：Bridge 在异步恢复末尾动态 `provide('feishuBridgeReady')`，真实 Loader 已先把 invariant 固定为等待该未知服务，最终 Profile exit 1。现改为复用先于 Bridge 激活的稳定 `feishu` Gateway 服务承载一次性 readiness latch：Bridge 成功 resolve、失败 reject，invariant 在检查 domain 前 await；不再跨 Loader entry 动态引入 marker 服务。

### 阶段 5 追加：`/ls` 交互式会话选择卡（自动化完成，实机待验收）

目标：`/ls` 默认返回显示真实会话名称的可点击卡片，不再要求复制编号或手工输入 `/use`；文本 `/use` 继续作为兼容兜底。

范围与关键决策：

- [x] 新增纯函数会话列表卡 renderer：每页最多 7 个未归档会话，每项提供“选择”按钮，并提供上一页/下一页；卡片显示真实会话名称、所属工作区、时间和页码，不把短 session ID 当主标题。
- [x] 会话名称与 Web 端保持同一事实来源：live session 读取当前 `title` projection，cold session 通过 `sessionProjectionCache.coldSnapshot()` 补齐最新持久化 `title`；没有标题的空会话明确显示“未命名会话”，再以工作区和短 ID 辅助区分。
- [x] 扩展 `/ls` snapshot：使用随机 token 绑定 chat、发起人、卡片 message ID、稳定 session 顺序、名称快照和 TTL；卡片 payload 只携带 token、页码或索引，不携带可篡改的完整 session ID。
- [x] 扩展 card action 分派，以 `kind` 区分 session-list 与 approval；校验 allowlist、chat ID、message ID、token、TTL、操作者和 active binding 的 `boundBy`，点击前再次检查 workspace 与归档状态。
- [x] 抽取 `/use` 公共绑定流程，让按钮选择与文本 `/use` 共用同一绑定事务及失败补偿，避免形成两套语义。
- [x] 点击采用两阶段状态：先 patch 原卡为蓝色“正在绑定”，完成后 patch 为绿色成功或红色失败；patch 失败必须显式发文本回执，不吞掉结果；成功后冻结该卡，双击、旧卡和转发卡均拒绝并返回可见提示。
- [x] 翻页只 patch 原卡并读取原始稳定快照，不重新查询导致会话顺序漂移；快照默认沿用现有 5 分钟 `listingTtlMs`，过期后提示重新发送 `/ls`。
- [x] `/ls` 建卡使用稳定 delivery identity；只有确定性卡片拒绝才降级为现有文本列表，timeout、断连等不确定结果不跨形态重复发送；由于拿不到原卡 message ID，不确定态的迟到卡点击 fail-closed。
- [x] 先补 RED 测试：真实标题及无标题回退、分页稳定性、点击成功、过期、越权、转发、归档后点击、非 `boundBy` 操作、双击、patch fallback；保留现有文本 `/use` 契约测试。
- [x] 同步 `README.md`、`docs/design.md`、`docs/usage.zh.md` 与 `docs/HANDOFF.md`。
- [ ] 获得单独重启授权后执行飞书实机验收：按名称点击绑定、原卡分页、过期/归档拒绝和终态回执。

验收标准：

- `/ls` 正常路径展示会话名称，用户只需点击一次即可发起绑定，无需手输编号或 session ID。
- 20 条会话可稳定分页，5 分钟快照内名称、顺序和按钮索引不漂移。
- 已归档、越权、过期或来源不匹配的卡片不能绑定；失败原因在卡片或文本回执中可见。
- 文本 `/use <编号|sessionId>` 仍可作为兼容兜底。
- 聚焦测试、全量测试、类型检查、构建和 diff 检查通过；真实飞书完成一次按名称点击绑定及分页验收。

阶段 5 追加验证记录（2026-08-15）：

- TDD RED→GREEN 覆盖 renderer、live/cold/无标题名称、点击绑定、稳定分页、过期/伪造/转发/越权/非 `boundBy`/双击/归档后点击、terminal patch 文本回执、永久建卡拒绝文本 fallback、模糊建卡不跨形态、稳定 delivery identity。
- 交付前复核补出两条 RED→GREEN：模糊建卡拿不到原 message ID 时，复制/转发卡点击必须 fail-closed；原卡翻页 patch 失败必须返回可见 toast。
- `npm test`：18 个测试文件、207/207，exit 0；其中 `tests/bridge.spec.ts` 83/83，`tests/session-list-card.spec.ts` 3/3。
- `npm run typecheck`：exit 0；`npm run build`：exit 0，生成 16 个 ESM/声明文件；`git diff --check`：exit 0。
- 高置信凭据扫描只命中 `docs/usage.zh.md` 的中文占位示例 `FEISHU_APP_SECRET: "替换为真实 App Secret"`，未发现硬编码真实凭据。
- review-gate 结论：自动化与代码审查有条件通过；未重启当前 Web Profile，真实飞书按名称点击、分页和终态回执仍是发布前验收项。

#### WeClaw 两级导航修订（用户已确认）

目标：把上一版单层会话卡改为 WeClaw 风格的“工作空间 → 会话”两级导航，减少同名项目和大量会话下的选择成本，同时保留 DSH 现有的安全快照与绑定补偿。

- [x] 使用 CardKit 2.0 渲染工作空间卡：按钮直接显示工作空间名称与会话数，每页最多 7 项，payload 只携带 token 和索引。
- [x] `/ls` 按规范化 cwd 聚合全部未归档、非子代理会话，按 SessionHeader `createdAt` 降序；移除全局 20 条截断，并把标题 projection 延迟到用户进入工作空间后。
- [x] 在原卡内完成工作空间、会话、返回与分页导航；会话按钮直接显示真实标题，唯一会话工作空间点击后直接绑定。
- [x] 卡片动作快速返回 toast，把 projection、patch 和绑定放入已有 chat FIFO；异步 patch 失败仍发送可见文本回执。
- [x] `/use <编号>` 继续作用于当前打开工作空间的稳定会话顺序；建卡确定性失败时保留命名文本列表回退。
- [x] 以 RED→GREEN 覆盖两级导航、延迟标题、分页、同名工作空间、唯一会话直绑、旧卡/越权/过期和失败回执。
- [x] 同步 README、设计、使用与交接文档，并完成聚焦测试、全量测试、类型检查、构建、diff 和敏感信息检查。
- [x] 重启本地 Web Profile 后完成飞书实机：工作空间选择、标题选择、返回/分页、唯一会话直绑。

验收标准：首张卡只展示不泄露完整路径的工作空间选项；进入后按真实标题直接点击；超过 7 个工作空间或会话可稳定翻页；5 分钟快照内 token/索引不漂移，归档、越权、过期及来源不匹配均不能绑定。

自动化验证记录（2026-08-15）：

- renderer RED：缺少工作空间 renderer、CardKit 2.0 schema、标题按钮和工作空间标题时 4/4 失败；GREEN 后 `tests/session-list-card.spec.ts` 4/4。
- Bridge 主路径 RED：旧单层 `/ls` 未生成工作空间卡；GREEN 后首层不含任何 session title，进入目标 workspace 后只解析并原卡展示该组标题。
- 回归覆盖同 basename 无父路径泄露、返回工作空间、21 条会话可到达第三页、单会话直绑、当前 workspace `/use` 编号、原快照分页、建卡/patch 模糊与永久失败、过期/越权/归档/转发/双击。
- `npm test`：18 个测试文件、212/212，exit 0；其中 Bridge 87/87、renderer 4/4。
- `npm run typecheck`、`npm run build`、`git diff --check` 均 exit 0；build 生成 16 个 ESM/声明文件。高置信凭据扫描无命中。
- Web Profile 已重启到新构建：PID 52357 监听 `127.0.0.1:3080`，宿主 HTTP GET 成功，启动后未见 Loader/invariant 错误。用户随后明确确认真实飞书 CardKit 2.0 验收通过，覆盖工作空间选择、真实标题选择、返回/分页与单会话直绑；该结论为用户真机证据，不替代阶段 5 的重复事件、断连、进程中止、审批 fallback 与 HMR 完整故障矩阵。

### 阶段 6：正式产物与发布门禁

- [x] 确定正式依赖策略：release bundle 内联 DSH helper、Lark SDK、zod 及其运行时闭包，只保留 Harness 已有的 Cordis peer；packed manifest 无 `link:`、绝对路径或未发布的本机引用。
- [x] 建立单一权威发布脚本：验证 clean checkout/冻结依赖 → test/typecheck/release build → pack → 清单/运行时闭包审计 → 干净临时环境安装 → 四入口导入 → DSH 配置 smoke → 生成校验和。真实凭据 startup smoke 单列为下项。
- [x] CI 只委托 `pnpm release:preview`，Harness checkout/build 仅作为未发布宿主的固定前置，不复制插件发布步骤。
- [x] 检查 tarball 只含 `files` 白名单及 npm 自动包含的 README/LICENSE/package.json，四个导出入口均已从隔离安装包导入。
- [x] 在一次性 DSH profile 完成 tarball 安装与四行 `--dump-config`，再将真实 web Profile 从源码 `link:` 切换到 tarball：四条插件配置均激活，Web 根页面返回 200，观察期无 Loader/Gateway/Bridge/Invariant 错误。真实消息与故障矩阵继续由用户实际使用验收。
- [x] 输出版本、产物路径、大小和 SHA-256；在 tarball-backed 真实启动和独立发布授权完成前，预览脚本始终标记 `publishable: false`，并单列 `sourceClean` / `dshConfigSmoke`。实际推送 tag、上传 Release 或发布 registry 前再次请求用户确认。

阶段 6 本地预览记录（2026-08-15）：

- RED/GREEN：发布清单测试先以 5/5 失败证明缺少清洗/拒绝规则，再覆盖 tarball 白名单与 export target；安装时真实暴露 `protobufjs` build approval，新增“除 Cordis peer 外无安装期依赖”契约并先 RED 后 GREEN；review-gate 再以 RED 证明非本地 export 会被忽略，收紧后转绿。`tests/release.spec.ts` 最终 8/8。
- 权威脚本最终 exit 0：19 个测试文件、220/220；typecheck；release bundle；packed manifest/运行时闭包/tarball 清单；隔离 npm 安装；四入口导入；一次性 DSH web Profile tarball 安装与四行配置快照。
- 产物：`artifacts/dsh-feishu-bot-0.1.0-rc.1.tgz`，397,732 bytes，SHA-256 `78230c5c8db2874bf9c5084e04b4bbd36531822f9d40f44db5e25f21a46739b6`。本轮使用 `--allow-dirty --use-existing-deps` 保护正在运行的源码联调环境，输出同时记录 `sourceClean: false`、`dshConfigSmoke: true`、`publishable: false`，只供本机实际验收。
- 真实 Profile 验收（2026-08-15）：依赖已从源码 `link:` 替换为 `file:.../dsh-feishu-bot-0.1.0-rc.1.tgz`，安装目录 manifest 与 tarball 一致；旧源码 PID 52357 经确认后停止，新 tarball-backed PID 80763 监听 `127.0.0.1:3080`，Web 根页面 HTTP 200，30 秒观察期无启动错误。
- 未完成：真实飞书消息与故障矩阵；GitHub Actions 尚未远程运行；未提交、未推送、未创建 tag、未上传 Release、未发布 registry。

阶段 6 验收：正式 tarball 在干净环境离线于源码树安装并通过启动 smoke，manifest 无 `link:`/本机路径，校验和可复核；未获授权前不做远程发布。

### 阶段 6.1：单任务卡片与结果收口（真实使用回归）

目标：将飞书展示粒度从 Harness 内部 `turn` 提升为绑定会话的直接用户任务；从飞书或 Web 发起的一条普通用户消息只占用一张飞书任务卡和一组必要的最终结果分段，内部 commentary、subagent report/settled 和 continuation turn 不再产生新消息刷屏；`/release` 后停止同步。

范围：

- 任务身份锚定直接 `user/message` 的 `source.kind=user`、`source.via=feishu|web`；下一条 Web/飞书直接用户消息才开启下一任务。是否向某个 chat 投影仍以 active binding 为准。
- 同一任务后续的 `subagent-report`、`subagent-settled` 与 continuation turn 只更新原任务卡；错误/完成状态允许在原卡上演进，不创建第二张任务卡。
- 含 `tool-call` 的 assistant 文本只作为过程信息，不进入 canonical result delivery；每个内部 turn 的文本不能被当成独立最终回复。
- 同一任务的最新合格终态文本复用一个 durable result 投影；短结果只保留一个结果消息，超过 24 KiB 时仍按既有字节预检产生必要分段。后续内部结果更新原消息，不按 turn 追加新消息。
- result card message ID、任务锚点和待 patch 状态必须可恢复；重启、patch 模糊失败与旧 `feishu_bot_delivery` v1 行不得造成重复发送或破坏兼容。

验收标准：

- [x] 用真实日志同构 fixture 覆盖：一个飞书用户 turn、多个 subagent spawn/report/settled、多个 error/completed continuation turn；最终只出现一个任务卡 message ID。
- [x] 同一 fixture 的中间 `text + tool-call` 不产生 result delivery；小于 24 KiB 的多次内部终态文本最终只占一个结果 message ID。
- [x] 第二条直接飞书用户消息明确开启第二个任务，不错误覆盖上一任务。
- [x] patch 永久失败、模糊失败、进程重启和 sent-before-cursor 窗口均保持可恢复且不重复建卡；旧 delivery fixture 继续读取。
- [x] 长结果仍满足 24 KiB envelope 上限，必要分段数量由最终内容决定，而不是内部 turn 数量。
- [x] 聚焦测试、全量测试、typecheck、release build、tarball 隔离安装与真实 Profile HTTP smoke 全部通过。
- [ ] 用户在真实飞书复测一次 subagent 多轮任务，确认一张任务卡和一组必要结果分段。

实施步骤：

- [x] 先补任务归属纯函数与 Bridge 集成 RED 测试，复现当前“每 turn 一张任务卡、每含文本消息一张结果卡”。
- [x] 将任务卡 tracker 从 turn 身份改为飞书入站任务身份，保留单 actor/timer 和原 message ID。
- [x] 将 canonical projection 从逐 assistant event 改为任务级最新终态投影，并补最小兼容字段与恢复折叠。
- [x] 运行聚焦与全量门禁，复核隐私、容量、关闭 drain、旧数据和长结果边界。
- [x] 重新生成预览产物、安装真实 Web Profile；不创建 tag、不上传 Release、不发布 registry。

诊断证据（2026-08-15，未读取或记录消息正文）：

- 当前绑定会话的一条直接飞书任务后，日志连续出现内部 turn 12–23，触发源均为 `subagent-report` / `subagent-settled`；其中截图的“耗时 2分1秒”完成卡与内部 turn 14 的边界精确对应。
- 同一任务区间已形成 14 条 `sent` canonical delivery；任务卡 listener 当前注释和实现明确按 `(chat, session, turn)` 新建卡，result catch-up 则对每个含文本的 `assistant/message` 立即物化。
- WeClaw 参考以入站任务持有单一 serialized replier/stream，进度原位更新，最终回复独立收口；可借鉴其任务粒度与串行所有权，不复制其 Go/平台层实现。
- `0.1.0-rc.2` 基线门禁已通过 19 个测试文件、223/223、typecheck、release build、隔离安装、四入口与干净 DSH 配置 smoke；产物 398,313 bytes，SHA-256 `7f7952bf4c809207930019e83a6cc4292c6bea5fbb3b0fd786665514791266d6`。该包仅包含失败原因可见性改进，尚未包含本阶段刷屏修复，因此暂不替换真实 Profile。

阶段 6.1 review（2026-08-15）：

- RED→GREEN：真实日志同构测试修复前得到 3 个任务卡 message ID，修复后同一直接飞书任务稳定为 1 个任务卡 message ID、1 个短结果 message ID；含 tool-call 的中间说明未进入 delivery。
- 任务边界：第二条直接飞书消息的纯函数测试首次暴露“下一 turn/start 被误归上一任务”，修正回滚边界后通过；Bridge 集成测试确认两个直接任务分别产生两个任务卡和两个 delivery。
- rc.3 初版自动化为 19 个测试文件、228/228，但用户实测发现 active binding 下 Web 发起任务未同步飞书，因此不再作为当前验收版本。
- rc.4 回归修复自动化：19 个测试文件、229/229；`tsc --noEmit`、普通 build、release build、manifest/路径审计、隔离安装、四入口、干净 DSH Profile smoke 和 `git diff --check` 均通过。rc.4 为 399,883 bytes，SHA-256 `ff6b3ad6ca8d88c970cb2738da8da4eb380a4cc3cae6f520b3e73c2a48edff93`，`publishable: false`。差异凭据扫描仅命中文档里的中文占位示例，无真实凭据。
- 本机 Profile：manifest、lockfile spec 与实际 node_modules 包内容均为 `dsh-feishu-bot@0.1.0-rc.4`，PID 23932 监听 `127.0.0.1:3080`，主机网络 HTTP 200。安装命令被同 Profile 的 smart-approval rc.5 minimumReleaseAge 策略拦截，但没有放宽策略；包文件落盘后仅校准了 feishu-bot manifest 路径。pnpm `.modules.yaml` 仍记录 rc.3，因此 `dsh plugin list` 暂显示 rc.3；待 minimumReleaseAge 满足后重新正常安装收敛元数据。未创建 tag、未上传 Release、未发布 registry。
- 剩余验收：自动化不能替代真实飞书平台的消息去重与 UI 数量观察；用户需用同类 subagent 多轮任务复测一次。
- rc.3 回归修复：用户实测发现 active binding 下 Web 发起的任务未同步飞书。根因是任务起点只接受 `via=feishu`，且纯函数测试错误地锁定“Web task 不投影”。修复先将该测试反转并新增完整 Bridge 回归；生产代码未改时两层 RED 分别得到空结果与 0 张任务卡，最小修复后均 GREEN。以后再次过滤 Web 来源会同时触发纯函数与绑定会话集成测试。

### 阶段 6.2：FIFO、所有权与生命周期审查修复

目标：修复重构后仍存在的 10 个高优先级控制流缺陷，保证失败投递不破坏 FIFO、Bridge 创建或恢复的 Agent 在所有权转移前失败时必被释放、审批在 abort/HMR 下必定结算，并防止启动/注销竞争留下新一代 handler 或外部副作用。

范围与关键决策：

- Canonical cursor 继续遵循既有权威语义“已持久物化，不代表已送达”；用跨 session 的 per-chat pending delivery barrier 和失败即停保证实时/启动 FIFO，不把 cursor 偷换成网络确认位点。
- Legacy outbox 按 chat 作为一个恢复 actor；任一 segment 失败即停止该 chat 的剩余 segment、后续结果组与 Canonical 投递。
- Cold `/use` 与 `/new` 的 staging、cursor、binding 和 session metadata 准备放在 Agent 发布前的 setup 边界内；失败或启动期 dispose 通过 exact after-image 补偿迟到写入，现存或已发布 Agent 不再因绑定命令后续失败被释放。
- Approval 用单一幂等终态入口区分回答结果与卡片状态；abort 返回 `cancelled`，Bridge dispose/HMR 返回 `unavailable`，不伪造 allow/reject。
- 启动取消沿用 Cordis 既有的 `internal/plugin` + `AbortController` 模式；同一 Fiber 进入 `uid === null` 时主动中止持久化扫描，被取消的旧实例不得启动 intake、注册 timer 或发布 ready。

验收标准：

- [x] Canonical 首条发送失败时，后续结果不会越过；同一 pending 会在下一次 catch-up 先重试，cursor 仍保持“已物化”语义。
- [x] 启动恢复中，同 chat 的 Canonical 首条失败会阻断后续 delivery。
- [x] Legacy segment 0 失败时，segment 1 和同 chat 后续结果组均保持未尝试，watermark/cursor 不推进。
- [x] 第二个 storage domain 打开失败时，第一个 domain 句柄被关闭，原始打开错误仍可见。
- [x] `/new` 的 session metadata 注册失败时不发布新 Agent并回滚候选绑定；`/use` 的 staging/binding 准备失败时不发布 cold-resumed Agent，existing Agent 不被释放。
- [x] Approval 在 visible 后 abort 时 Bridge waterfall 结算 `cancelled`；初始化窗口 abort 不创建僵尸卡或 durable pending row。
- [x] Bridge dispose 会把存量审批结算 `unavailable` 并使卡片失效，不留下跨 HMR 的悬空 Promise。
- [x] 启动恢复尚未完成时 dispose，不启动 intake、不注册 maintenance timer、不发布 ready。
- [x] Gateway 旧 generation 的重复 unregister 不会撤销同一 handler 的新 generation。

实施步骤：

- [x] 逐项复核当前控制流、现有测试缺口及权威设计约束。
- [x] 记录修复范围、验收标准、验证方式与回滚边界。
- [x] 先补 Canonical/Legacy FIFO、Domain 回滚和启动取消 RED 测试并确认失败原因。
- [x] 先补 `/new`/`/use` 所有权 RED 测试并确认失败原因。
- [x] 先补 Approval abort/初始化/dispose 与 Gateway stale unregister RED 测试并确认失败原因。
- [x] 分组实施最小修复，每组运行聚焦测试并保持已完成组为 GREEN。
- [x] 执行全量测试、typecheck、build、diff/敏感信息检查和独立 review-gate。

验证方式：

- 聚焦：`./node_modules/.bin/vitest run tests/bridge.spec.ts tests/gateway-lifecycle.spec.ts`，必要时按 `-t` 单独观察 RED→GREEN。
- 全量：`./node_modules/.bin/vitest run`、`./node_modules/.bin/tsc --noEmit`、`npm run build`、`git diff --check`。
- 完成前复核本阶段 diff，不重启当前真实 Web Profile，不生成或发布新预览产物；若后续需要替换运行包，另行征得授权。

回滚边界：只撤销本节新增测试及 `src/bridge/index.ts`、`src/bridge/resolver.ts`、`src/bridge/reliability.ts`、`src/gateway/index.ts` 的对应最小实现；不改 storage schema、不清理现有持久数据、不触碰用户其他未提交改动。

阶段 6.2 review（2026-08-15）：

- 原审查 10 项均已落地回归测试和对应修复；额外覆盖了跨 session Canonical FIFO、Legacy/Canonical 混合队列、审批 ambiguous create 与 patch/abort 竞争、启动期审批和 Domain 注册窗口、跨 chat Agent adoption 以及 setup 迟到写入补偿。
- 关键 RED→GREEN：跨 session 后续结果曾越过旧 pending；审批组卡曾出现重复 create/失效按钮；cold `/use` setup dispose 后曾残留 active binding。修复后相关稳定故障注入全部通过。
- 最终验证：`./node_modules/.bin/vitest run` 通过 19 个测试文件、250/250；`./node_modules/.bin/tsc --noEmit`、`npm run build`、`git diff --check` 均以退出码 0 完成。
- 本阶段新增行扫描未发现硬编码凭据值、用户绝对路径或消息正文日志；独立 review-gate 未发现可稳定复现的阻断项。
- 本轮未重启真实 Web Profile、未生成或发布新预览产物；飞书端 ambiguous create 的真实平台幂等表现仍留待后续预览版真机验收。

### 阶段 6.3：Markdown 动态字面量一致性修复

目标：修复 Approval 与 Task card 中动态字面量直接进入 Markdown 模板造成的展示完整性风险，同时保留 Result card 对助手 Markdown、代码块和 Web 链接的既有产品契约。

范围与关键决策：

- 抽取共享的 Markdown 字面量转义 helper，供 CardKit `markdown` 与旧 interactive `lark_md` 的惰性字段使用。
- Approval 仅转义 `toolName`、`reason`、`sessionTitle`；固定粗体标签、审批按钮和 Web GUI 链接结构保持不变。
- Task card 仅转义 `currentTools`、`recentTools` 中的工具名；固定状态文案、数字、allowlist 错误码和 `plain_text` 标题保持不变。
- Result card 正文明确排除，不套用字面量转义；其助手 Markdown 保留测试必须继续通过。
- 本阶段不改变 DLP、pending 持久化、审计指纹或发布供应链策略。

验收标准：

- [x] Approval 的三个动态字段不能通过 `[]()`、反引号、`<>`、Unicode 行分隔符或 Markdown 控制字符改变卡片结构。
- [x] Task card 的工具名不能注入新行、链接、列表或 Markdown 格式，固定进度布局保持不变。
- [x] Session status 继续使用同一共享 helper，并阻断 Unicode 换行与列表前缀注入。
- [x] Result card 继续保留 Web Markdown 链接、换行和代码表达能力。

实施步骤：

- [x] 复核四个渲染器的数据来源、schema 和有意 Markdown 契约。
- [x] 记录字段级修复范围、验收标准和回滚边界并获得用户确认。
- [x] 先补 Approval 与 Task card 对抗性 RED 测试并确认失败原因。
- [x] 实现共享 helper，迁移 Session status，并在 Approval/Task 动态槽调用。
- [x] 运行聚焦测试、全量测试、typecheck、build、diff/敏感信息检查和独立 review-gate。

验证方式：

- RED/GREEN：`./node_modules/.bin/vitest run tests/approval.spec.ts tests/task-card-render.spec.ts tests/session-list-card.spec.ts tests/result-card.spec.ts`。
- 全量：`./node_modules/.bin/vitest run`、`./node_modules/.bin/tsc --noEmit`、`npm run build`、`git diff --check`。
- 完成前确认 Result card 的 Markdown-preservation 测试仍通过；不重启真实 Web Profile、不生成或发布预览产物。

回滚边界：只撤销本节新增测试、共享 Markdown helper 及 Approval/Task/Session status 的字段级调用；不改 Result card、不改 storage schema、不触碰运行配置和用户其他改动。

阶段 6.3 review（2026-08-16）：

- 新增共享字面量 helper，统一折叠 ECMAScript 空白、U+0085 与 Unicode 行分隔符，并转义链接、代码、HTML、列表和其他 Markdown 控制字符；Approval、Task card 与 Session status 已按字段接入，Result card 保持原有助手 Markdown 契约。
- 关键 RED→GREEN：Approval/Task/Session 的 Unicode 分隔符曾可重新制造 Markdown 行首；转义后 500 个 `&` 曾把审批原因从 500 字节放大到 2500 字节。修复后各动态字段保持单行惰性文本，审批原因按完整转义原子限制在 500 字节内。
- 最终验证：聚焦测试通过 4 个文件、35/35；`./node_modules/.bin/vitest run` 通过 19 个测试文件、254/254；`./node_modules/.bin/tsc --noEmit`、`npm run build`、`git diff --check` 均以退出码 0 完成。
- 本阶段新增行扫描未发现硬编码凭据值、用户绝对路径、消息正文日志或调试输出；独立 review-gate 未发现代码级阻断项。
- 本轮未重启真实 Web Profile、未生成或发布预览产物；真实飞书端渲染仍留待后续实际使用验收，审批组卡完整 envelope 的统一容量预检属于既有后续设计范围。

### 阶段 6.4：CI 第三方 Action 不可变引用

目标：在首次对外分发前消除 GitHub Actions 可移动主版本标签带来的构建时间差风险，不改变预览产物内容或远程发布状态。

- [x] 盘点仓库全部 workflow 的外部 `uses:`，确认唯一工作流共有四处 `@v4` 引用。
- [x] 从各 Action 官方仓库核对最新稳定 v4 release、完整 commit SHA 与 tag 类型。
- [x] 将 checkout、setup-node、upload-artifact 全部固定到 40 位 commit，并保留精确版本注释。
- [x] 解析 workflow YAML，扫描全部外部 Action 引用，运行发布聚焦测试及 `git diff --check`。

阶段 6.4 review（2026-08-16）：

- `actions/checkout` 固定到 `v4.4.0` 的 `11d5960a326750d5838078e36cf38b85af677262`，`actions/setup-node` 固定到 `v4.4.0` 的 `49933ea5288caeca8642d1e84afbd3f7d6820020`，`actions/upload-artifact` 固定到 `v4.6.2` 的 `ea165f8d65b6e75b540449e92b4886f43607fa02`；三个精确 release tag 均直接指向 commit。
- Ruby YAML 解析与全 workflow 引用扫描通过；`tests/release.spec.ts` 通过 8/8，`git diff --check` 退出码 0。
- 本阶段未运行远程 workflow、未生成产物、未修改 GitHub 权限、未创建 tag/Release、未发布 registry。正式产物签名或可验证 provenance、以及独立 SBOM 仍属于下一阶段 S7。

### 阶段 6.5：双渠道 RC provenance 与 SBOM（渠道与包身份已确认）

目标：从同一受信 tag、同一次构建产生唯一 RC tarball，同时发布到 GitHub Prerelease 与 npm `next`；两端都能验证来源与文件摘要，并提供与该 tarball 绑定的真实软件成分清单。RC 不创建或移动 npm `latest`，也不把校验和、provenance 与 SBOM 混为同一种保证。

已确认的发布边界：

- [x] 首次对外分发采用 GitHub Prerelease + npm `next` 双渠道，不直接发布 npm `latest`。
- [x] 两个渠道使用同一个受信 tag、同一次正式构建和同一个 `.tgz`；npm 必须直接发布已经验收的 tarball，不能从目录重新执行 `npm pack` 或产生第二份字节。
- [x] 现有 `pull_request` preview workflow 继续只做 `publishable: false` 的测试产物，显式保持 `contents: read`，不持有 OIDC、attestation、Release 或 npm 发布权限。
- [x] 首次真实 `npm publish`、创建 tag/Release、配置 Trusted Publisher、写入 GitHub secret/environment，以及修改远程仓库策略仍需用户逐项确认，计划确认本身不授权这些远程写操作。

只读核验结论（2026-08-16）：

- unscoped `dsh-feishu-bot` 已由 `plutokeating` 发布到 `0.11.0`，公开仓库指向 `PlutoKeating/dsh-lark-bot`，当前身份不能把本仓库发布到该包名。当前 npm 登录身份为 `tingrudeng`，`@tingrudeng/dsh-feishu-bot` 尚未公开存在；用户已确认采用该 scoped 名称。
- `@deepseek-ai/cordis@4.0.1` 已公开发布，当前 peer 范围 `^4.0.1` 可从 npm registry 解析。
- npm Trusted Publishing 要求 GitHub-hosted runner、Node `>=22.14.0`、npm CLI `>=11.5.1` 与发布 job 的 `id-token: write`；当前本机 Node `24.18.1`、npm `11.16.0` 满足版本门槛。配置 trust 的 `npm trust` 命令还要求 npm `>=11.15.0`、包写权限和账号 2FA。
- 新包不能直接配置 Trusted Publisher，因为 npm 要求目标 package 已存在。若首个 RC 也必须有 npm provenance，需要在受保护 GitHub Environment 中用一次短期、最小权限 token 完成 bootstrap 发布；随后立刻配置 Trusted Publisher、撤销 token，并用新的 RC 版本验证纯 OIDC 发布。同一 `name@version` 永远不能覆盖或复用。
- Trusted Publishing 的 GitHub OIDC 发布会自动生成 npm provenance；显式 `--provenance` 可保留为意图断言，但不是第二份 provenance。GitHub artifact attestation 与 npm provenance 是两个独立验证面，都必须指向同一个 tarball。
- 当前 release bundle 内联除 Cordis peer 外的运行时闭包，而 packed manifest 有意移除这些 dependencies；不能只扫描最终 `package.json` 生成 SBOM。SBOM 工具必须覆盖实际内联依赖、保留 Cordis peer 身份，并通过人工已知组件断言。

实施前待确认门禁：

- [x] 确认正式 npm 包名为 `@tingrudeng/dsh-feishu-bot`，并允许在实现阶段同步修改 `package.json`、产物名、安装命令和发布校验。
- [x] 确认 SBOM 实现依赖：精确使用 `rollup-plugin-sbom@4.0.0`、`@cyclonedx/cyclonedx-library@10.1.0`，并把 `tsdown` 精确升级到 `0.22.14`；本次授权不包含远程发布或远程配置写入。
- [x] 确认 bootstrap 方案：在受保护 GitHub Environment 中临时保存最小权限、短有效期 npm token，仅允许固定 commit 的首次 RC publish job 使用；成功后立即删除 secret、撤销 token并配置 Trusted Publisher。任何 token 不写入源码、产物、日志或任务文档。
- [x] 确认 tag 创建后自动构建、attest、暂存 GitHub draft、以 npm `next` 发布同一 tarball，再把 draft 转为 prerelease；任一步失败时保留 tag、失败 run 与已有远程审计事实，不自动删除或覆盖。
- [x] 确认可新增 release job 的 `id-token: write`、`attestations: write`，以及仅 GitHub 发布步骤持有的 `contents: write`；bootstrap token 仅对 npm publish step 可见，后续 OIDC job 不再配置 npm token。
- [x] 已另行授权并把仓库远程策略 `sha_pinning_required` 设为 `true`，阻止 workflow 重新使用可移动 Action tag；每次新 RC 前仍需复核远端状态。
- [x] 已另行授权并启用匹配 `v*-rc.*` 的 tag rules，禁止既有 RC tag update/deletion 且无 bypass；workflow 仍在 draft 前后、npm publish 前和 Release finalize 前 peel 远端 tag 并比对 `GITHUB_SHA`。
- [x] 已另行授权并启用 GitHub Immutable Releases，防止已发布 Prerelease 的 tag 和六个 asset 事后被改写；该策略不替代发布前 tag rules。

实施步骤：

- [x] 确定 scoped 包身份并递增到下一个未使用 RC；补齐精确匹配本仓库的 `repository.url` 与 public access 声明。正式脚本拒绝 unscoped 冲突名、已存在版本、非 RC 版本以及会移动 `latest` 的发布参数。
- [x] 在现有 preview workflow 明确最小只读权限；新增独立 tag-triggered release workflow，所有外部 Action 固定完整 SHA，锁定满足 Trusted Publishing 的 Node/npm 版本，并检查 repository、Git HEAD、tag 与 package version 完全一致。
- [x] 扩展单一权威 release 脚本的正式模式：禁止 dirty/skip/use-existing-deps，在校验 repository、tag、HEAD、workflow、runner 和 npm 版本之后才允许安装依赖；只有全部正式门禁通过才输出 `publishable: true`，本地 preview 语义保持 `false`。
- [x] 正式链路只构建一次 `.tgz` 与 `SHA256SUMS`，生成并验证 SBOM；构建 job 仅持有 `contents: read`，独立 attestation job 下载并复核四文件摘要后，才使用 `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6`（v4.2.2）分别生成 build provenance 与 SBOM predicate，并以 signer workflow、source ref/SHA 和 hosted runner 约束做离线验签。不得使用已弃用的 `actions/attest-sbom`。
- [x] 先创建 GitHub draft 并上传 `.tgz`、`SHA256SUMS`、SBOM、descriptor 与两份 attestation bundle；按 release ID 和六个 asset digest 核对后，执行 `npm publish <同一 tgz> --tag next --access public --provenance`，重新下载 registry tarball、验证 npm 签名、SLSA statement 与 Sigstore 证书中的 repository/workflow/ref/commit/hosted-runner identity 后，才按同一 release ID 转为 prerelease。workflow 不执行第二次 pack，不发布源码目录。
- [ ] 首包 bootstrap 成功后配置 Trusted Publisher，精确绑定 `TingRuDeng/dsh-feishu-bot`、release workflow 文件名和受保护 environment；撤销 bootstrap token。用新的 RC 版本完成一次无 `NODE_AUTH_TOKEN` 的 OIDC 发布验证，随后启用禁止 token 的 publishing access。
- [x] 评估并锁定 CycloneDX 1.7 生成方式；校验实际内联的 Lark SDK、zod 与 DSH runtime 组件，把 Cordis 标为唯一外部 peer，把 tsdown 只列为 build tool，不把 dev-only 工具混入 runtime 清单。
- [x] 增加 scoped name、release 模式、tag/version、`next`/`latest`、单 tarball 摘要、SBOM 已知组件和 bootstrap/OIDC 分支的自动化拒绝测试；完成全量测试、typecheck、build、workflow YAML/action pin 扫描、干净临时构建和 `git diff --check`。
- [x] 在不创建正式 tag 的本地 fixture、只读 workflow 校验和不可发布 Preview Gate 中完成演练。
- [x] 移除只保留一个 pending run 的顶层 GitHub concurrency；在受保护 `npm-release` Environment 之后按 `run_number` 等待全部更早 release run 进入终态，确保快速连续 tag 不会静默丢失中间 RC，且 npm publish/finalize 严格串行。
- [x] npm publish 前重新读取 package metadata；已有 `next` 时只允许严格更高的 `x.y.z-rc.n`，拒绝乱序或回退 RC，并补纯函数与 workflow mutation 回归测试。正式 workflow rerun 同样被拒绝，防止旧 `run_number` 重入临界区。
- [x] 补充从旧 unscoped `dsh-feishu-bot` 切换到 `@tingrudeng/dsh-feishu-bot@next` 的先 remove 后 add 步骤；披露 GitHub draft asset 校验与公开 PATCH 之间无法原子封闭的窄窗口。
- [x] 用户已单独确认远程保护策略、首次真实 tag/bootstrap publish，以及失败后使用全新 rc.6 tag 继续；rc.5 的既有远程事实全部保留。
- [ ] rc.6 发布后重新下载 npm tarball并核对 SHA-256/registry integrity，确认 `next` 指向新 RC 且 `latest` 不存在或保持原值；分别验证 npm provenance 证书身份与限定 repository、signer workflow、source ref 的 GitHub attestation。

验收标准：

- PR 或普通分支不能生成仓库关联 attestation、创建 Release 或发布 npm；只有版本匹配的受信 tag 能进入正式 job。
- GitHub Prerelease 与 npm registry 下载到的 tarball SHA-256 完全一致，且等于本次唯一正式构建的摘要；npm `next` 精确指向该 RC，`latest` 未被创建或移动。
- `gh attestation verify` 可验证 tarball 与 `SHA256SUMS` 的 GitHub provenance，并限定正式 workflow 与 tag；npm provenance 除 registry statement 与 subject digest 外，还必须通过同一 verifier 校验证书中的 repository、signer workflow、source ref/SHA 与 hosted runner 身份。
- SBOM 是有效 SPDX/CycloneDX JSON，与同一 tarball 建立独立 predicate；已知内联、peer 与 dev-only 组件断言符合实际构建边界。
- bootstrap 凭据已从 GitHub secret/environment 删除并在 npm 撤销；后续新 RC 能在无 npm token 的条件下通过 Trusted Publishing 发布。
- 任一构建、attestation、SBOM、npm publish 或 GitHub 发布步骤失败时不输出整体成功状态；不自动删除 tag、覆盖 Release、复用版本或执行 unpublish。

回滚边界：代码侧可删除独立 release workflow 并撤销 release 脚本正式模式，现有 PR preview 仍可独立运行；远程 `sha_pinning_required`、tag rules 与 Immutable Releases 的调整必须单独评估并再次授权。已发布 npm 版本不可覆盖，异常 RC 优先把 `next` 移回已知正常版本或移除该 tag，并对问题版本执行 deprecate；Trusted Publishing 不覆盖 dist-tag/deprecate 管理动作，这些操作仍需维护者交互认证与再次授权。unpublish 受 npm 严格条件限制、不可撤销且版本号永远不能复用，不作为常规回滚。已创建的 tag、Release、attestation、provenance 与 registry 版本均属远程审计事实，任何清理必须再次获得用户明确授权。

阶段 6.5 本地实现 review（2026-08-16）：

- 正式 workflow 已形成 `build -> build_attest -> stage_draft -> publish_npm -> finalize_release` 的固定五 job 链，权限按 job 最小化，所有外部 Action 使用完整 SHA；合同测试额外拒绝未知高权限 job、表达式形式的 fail-open、额外 pack/publish 和 `latest` 移动。
- 独立复核发现的两项供应链缺口已关闭：draft 前后、npm publish 前与 finalize 前都会解析轻量/annotated tag 并要求最终 commit 等于 `GITHUB_SHA`；npm audit 导出的 SLSA bundle 还会用 `gh attestation verify --digest-alg sha512` 校验证书中的 repository、workflow、ref、commit 与 hosted runner，而不只信任 statement 自述。
- 独立复核发现的 RC 顺序缺口也已关闭：workflow 不使用只保留一个 pending run 的原生 concurrency；publish job 按 `run_number` 等待全部更早 run，并要求候选严格高于 no-store 读取的 npm `next`。formal build、队列入口和三个远程权限 job 都 fail-closed 拒绝完整或 partial rerun；最终 targeted review 未发现新增 P1/P2。
- 阶段 6.5 结束时 Preview Gate 退出码 0：22 个测试文件、339/339，`tsc --noEmit`、release build、唯一 pack、CycloneDX 1.7 SBOM、隔离安装、四入口导入和干净 DSH Profile smoke 全部通过；标准 `npm run build` 也退出 0。发布聚焦测试 85/85，workflow 的 Ruby YAML 解析、26 个 `run` block 的 `bash -n`、actionlint v1.7.10 与 `git diff --check` 均通过。
- 阶段 6.5 结束时不可发布 rc.5 为 650,211 bytes，SHA-256 `a718bdb9222f6ac3556d3d7076dd5c0a46aa20ea3d98fa7d1ee32589384a54dc`；`/private/tmp/dsh-feishu-final.62SVQ2` 精确包含 tarball、`SHA256SUMS`、CycloneDX SBOM 与 `release.json`，Preview Gate 输出明确 `sourceClean: false`、`dshConfigSmoke: true`、`publishable: false`。
- 差异安全扫描未发现凭据/token 前缀、私钥、真实飞书 open/app id 或用户绝对路径；新增的唯一 `console.log` 只输出更早 RC run 的数量，不含 id、ref、正文或 token。本轮未创建 tag、GitHub Release/attestation、npm 版本、Environment/secret、Trusted Publisher 或远程 ruleset。
- 阶段 6.5 结束时远程发布仍被外部门禁阻塞：当时 `npm-release` Environment 尚不存在，package 尚未 bootstrap，远端无 tag rules、Action SHA enforcement 或 Immutable Releases。该历史状态已由阶段 6.6 的远程配置与 rc.5 运行事实取代。

### 阶段 6.6：rc.5 Draft 查询修复与 rc.6 发布

目标：保留 rc.5 的失败 run、tag 与 Draft Release 作为审计事实，修复 GitHub 对未发布 Draft 不支持 tag endpoint 查询导致的发布中断，并以全新的 rc.6 完成首次双渠道发布。

已确认事实（2026-08-16）：

- rc.5 tag 指向提交 `641902db09903509d6395a4fdaafbadbcb8e99c9`；workflow run `31949610430` 的 build 与 attestation 成功，`stage_draft` 在上传六个附件后失败，npm 尚无该包。
- rc.5 Draft Release ID 为 `371332167`，必须保留；不得删除、重跑、移动 tag 或复用版本。
- 根因是 `/releases/tags/v0.1.0-rc.5` 对未发布 Draft 返回 404；按 Release ID 查询和 Release 列表均能读取该 Draft。
- 用户已确认生成并推送新的 GitHub 发布；本阶段授权范围为修复、提交、推送 rc.6 源码与新 tag，并观察正式 workflow，不包含清理 rc.5 审计事实。

实施步骤：

- [x] 用 RED 测试复现分页 Release 列表中精确选择 Draft 的缺失契约。
- [x] 实现 fail-closed 的 `selectStagedDraftRelease`，拒绝缺失、重复、非 Draft、非 prerelease 和非法 Release ID。
- [x] 让 `stage_draft` checkout 精确触发提交，通过分页 Release 列表选出 Draft ID，删除 Draft tag endpoint 查询。
- [x] 递增源码和当前版本文档到 `0.1.0-rc.6`；`pnpm-lock.yaml` 不记录根包版本，无需改动，并保留 rc.5 历史证据。
- [x] 执行发布聚焦测试、全量测试、typecheck、build、YAML、shell、actionlint、diff 与敏感信息检查。
- [ ] 提交并推送 `master`，核对远端 SHA；同步 `NPM_BOOTSTRAP_GIT_SHA` 后创建并推送全新 annotated `v0.1.0-rc.6` tag。
- [ ] 观察 rc.6 workflow 到终态，核对 GitHub Prerelease、六个附件、npm `next`、tarball 摘要及两侧 provenance；失败时保留所有远程事实并停止。
- [ ] 首包成功后撤销 bootstrap token/secret，并转入 Trusted Publisher 与下一 RC 的纯 OIDC 验证。

阶段 6.6 本地验证记录（2026-08-16）：

- TDD RED：聚焦测试最初为 93 项中 10 项失败，均由缺失 selector/workflow 契约触发；实现后同组 93/93 通过。
- 全量 `./node_modules/.bin/vitest run`：22 个文件、350/350；`./node_modules/.bin/tsc --noEmit` 与 `./node_modules/.bin/tsdown` 均 exit 0。
- 不可发布 Preview Gate：22 个文件、350/350，release build、唯一 pack、CycloneDX 1.7 SBOM、隔离安装、四入口和干净 DSH Profile smoke 全部通过；rc.6 tarball 为 650,332 bytes，SHA-256 `beb5a1ea343d569cc0924df48921638449dd73e8f95e7597d5216e76866672ea`，明确 `sourceClean: false`、`dshConfigSmoke: true`、`publishable: false`。
- workflow 的 Ruby YAML 解析、21 个 `run` block 的 `bash -n` 与 actionlint v1.7.10 均通过；`git diff --check` 通过。
- 独立定向审查未发现 P0–P3：确认 `gh api --paginate --slurp` 的分页数组形状、唯一 tag fail-closed、精确 commit checkout、远端 tag 重验与 Release ID 下游链路。
- 本机 pnpm 11.18.0 默认运行前检查因 workspace state 仍记录 rc.5 而试图重装依赖；lockfile 与已安装快照字节一致，故基础门禁直接使用现有锁定二进制，Preview Gate 使用明确的 `--use-existing-deps`，没有修改依赖或把该环境提示误报为代码失败。

## 文件级影响预估

| 文件/模块 | 计划改动 |
| --- | --- |
| `src/gateway/index.ts` | 可控启动、异步 admission、统一 create/patch 队列、UUID、错误分类、业务码校验、关闭 drain、SDK logger |
| `src/gateway/envelope.ts` | text/card create 信封加入稳定 UUID 及对应类型/尺寸约束 |
| `src/bridge/domain.ts` | 入站 message ID 兼容字段；新增独立 delivery/cursor 领域或其声明入口 |
| `src/bridge/index.ts` | 启动恢复顺序、日志 catch-up、canonical delivery、审批 fallback、绑定补偿、任务卡 actor、完整 drain |
| `src/bridge/resolver.ts` | 明确 handle 来源与有界 dispose 契约；不改变现有 session 公共语义 |
| `src/bridge/reliability.ts` | 容量、TTL、旧 outbox 续发、cursor 回收和清理审计；必要时按现有职责拆小模块 |
| `scripts/feishu-smoke.mjs` | 静默 SDK logger、固定字段输出和可复核退出码 |
| `tests/*.spec.ts` | 新增上述故障窗口、重启、并发、兼容和隐私回归测试 |
| `README.md`、`docs/*.md` | 实现完成后校准能力声明、配置、验收步骤和剩余风险 |
| 发布脚本/CI | 仅 M7 新增；文件名先服从仓库既有约定，不提前制造第二套发布入口 |

## 验证方式

每阶段执行受影响的聚焦测试，并在阶段末至少执行：

- `./node_modules/.bin/vitest run`
- `./node_modules/.bin/tsc --noEmit`
- `npm run build`
- `git diff --check`
- `git status --short --branch`
- 对新增/修改文件执行凭据模式、消息正文日志和绝对路径扫描。

验证约束：

- 若包管理器尝试自动安装或改写锁文件，立即停止并报告，不把依赖变更混入可靠性修复。
- 故障注入必须验证失败前后持久状态和重启结果，不能只断言某个 mock 被调用。
- 真实飞书验收与本地测试分开记录；缺少真实平台证据时不得声称端到端完成。
- 完成声明前使用 `verification-before-completion`；M6 跨模块实现完成后再使用 `review-gate` 独立复核。

## 回滚与恢复方案

- 每个阶段保持独立、小范围 diff；阶段验收失败时只撤销本阶段实现，不触碰用户原有 README/HANDOFF/usage 改动。
- 不对现有 `feishu_bot` 做不可逆版本升级；新 delivery 数据使用独立领域，旧绑定、入站、审批和 outbox 数据保留。
- 进入阶段 2 前先只读确认本地存储位置、权限、大小和可恢复方式；涉及备份或迁移时另行说明并等待授权。
- 如果新旧版本切换发生在已接纳 delivery 期间，先停止 intake 并 drain；未完成项以持久状态恢复，不通过清空数据库解决。
- 发布阶段只在临时目录生成/安装产物；失败删除临时产物即可，不修改当前源码联调安装。远程 tag、Release、registry 发布始终需要单独确认。

## WeClaw 借鉴边界

- 借鉴 `messaging/serialized_replier.go` 的单目标串行输出模型，用于任务卡 actor。
- 借鉴 `messaging/shutdown.go` 的“先关 admission、再 drain、最后释放资源”顺序。
- 借鉴 `feishu/replier.go` 对组卡 patch 失败的可见 fallback 及其测试方法。
- 借鉴 `feishu/sdk_logger.go` 的 SDK 静默 logger 思路。
- 不照搬 WeClaw 的 host owner/lease、跨主机 handoff 和 CardKit 2.0 状态机；不复制 AGPL 代码或测试文本。

## 待决策门禁

- 阶段 0 完成后：根据 RED 证据确认阶段 1 的接口形状，再开始生产代码修改。
- 阶段 2 开始前：核实 DSH 日志补读 API 与飞书 UUID 官方约束；若需要修改 DSH 公共接口，暂停并提交独立方案。
- 阶段 6 开始前：确认正式依赖来源和发布目标；若 DSH 包尚无可安装版本，只做到可复现 tarball，不伪装成可公开发布。
- 任何一步若扩大到 DSH 核心、不可逆存储迁移或远程发布，必须先更新本计划并等待用户确认。

## M6–M7 完成标准

- 五个 P1、三个 P2 条目均有对应实现、自动化回归和实际验证记录。
- 全量测试、类型检查、构建、diff 与敏感信息检查通过。
- 真实飞书故障矩阵完成；未覆盖项明确记录，不把配置或 mock 当成实机证据。
- 文档与当前行为一致，不再过度声明。
- 正式产物无 `link:`/绝对路径，可在干净环境安装、启动并通过校验；实际发布状态与用户授权一致。

## Review（实施后填写）

- 阶段 0–4 的可靠性实现与阶段 5 文档已落地；用户已完成 `/ls` CardKit 2.0 真机体验验收，完整故障矩阵仍待实际使用逐项验证。
- 阶段 6 已生成可复核的本地预览 tarball，并完成清单、runtime closure、隔离安装、四入口和干净 DSH 配置组合门禁；真实凭据启动仍未执行，因此整体 M6–M7 尚不宣称完成。
- 本轮没有提交、推送、tag、Release 或 registry 写入；源码 Web Profile 未因打包门禁而重启。
