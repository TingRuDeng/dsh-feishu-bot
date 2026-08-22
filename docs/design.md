# dsh-feishu-bot 设计方案

通过飞书私聊指挥、监控、审批本机 DeepSeek Harness agent 的进程内插件组。与 Web GUI 同进程共享同一批会话；审批走 `approval/request` waterfall（prepend + race，与 Web 双通道竞争，§6.4）；问答保持 Web 独占（M0 已裁定飞书端不做，§6.5）。决策依据见 §11，事实依据见 §12 与 M0 核验记录。

## 1. 目标与非目标

### 1.1 目标

1. 飞书**私聊**双向对话，与 Web GUI 共享同一批会话：浏览器开的会话手机可续接，反之亦然。
2. 实时进度：任务卡展示状态、当前工具调用摘要、token 用量（可选字段，契约见 §6.3）、耗时、最终结果。
3. 远程**审批**：审批请求推送飞书，按钮放行/拒绝，与 Web 双通道竞争（方案 α：prepend + next() 并行 race；实验不通过则降级 β 按绑定切换通道，§6.4）。
4. 会话管理命令：新建、列表、绑定、释放、状态、取消。
5. 断线/重启后可恢复：绑定持久化、消息与命令不重复消费；未决审批重启后失效定格（不恢复）。

### 1.2 非目标（本期明确不做）

- 远程问答：`ask_user_question` 不接飞书（`userQuestions` 单 provider 且 ask() 无 durable 事件，连只读通知也不可实现——M0#1 裁定，§6.5）。
- 群聊（@机器人、话题）；图片/文件注入。
- 微信及其他 IM 通道（gateway/bridge 分层为其预留）。
- 公网部署、多机器人、多租户。
- 修改 deepseek-harness 主仓库任何代码（纯 out-of-tree）。
- 卡片内 diff 审阅等重 UI（给 Web GUI 链接）。
- 待决审批的跨重启恢复（需先设计 durable pending 协议，单独立项，见 §10）。

## 2. 方案选型

| 备选 | 判定 | 理由 |
|---|---|---|
| A. 外部桥 + SDK | 否 | SDK wire 未实现 server→client 请求，审批到不了远端；独立 profile 与 Web 会话隔离 |
| B. 外部桥 + ACP | 否 | 无进度流、无会话恢复、无提问转发 |
| C. **进程内 Cordis 插件 + bundle** | **采用** | `session/event` 进度、`approval/request` waterfall 审批、`ctx.sessions` 原生续接、与 Web 平级共存 |

## 3. 总体架构

```
飞书 App/手机
   │  WebSocket 长连接（官方 Node SDK 事件订阅，免公网）
   ▼
┌─ dsh web profile 进程 ─────────────────────────────────────┐
│  feishu-gateway（ctx.feishu 服务）                          │
│    连接生命周期 / 收发消息 / 卡片创建与更新 / 出站 FIFO      │
│         │ 入站事件               ▲ 出站调用                 │
│  feishu-bridge（业务桥）                                    │
│    per-chat 业务队列 → 白名单 → 状态机去重 → 命令 or inbox  │
│    session/event 订阅 → 结果卡 + 任务卡投影                 │
│    approval/request waterfall 答复者 → 审批卡               │
│    feishu_bot + feishu_bot_delivery domains                │
│      （绑定/入站/旧 outbox/待决卡 + canonical delivery/cursor）│
│    host 同构 agent resolver（cold resume + ownership fence）│
│  invariants registry → feishu-invariant                     │
│    （active binding → live/persisted session）               │
│                                                             │
│  （既有）dsh-base + dsh-web-app：agents/sessions/tools/     │
│   sandbox/approval/llm/host/client…                         │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 交付形态

- 独立仓库 `dsh-feishu-bot`（建议 `~/Desktop/mycode/dsh-feishu-bot`），npm 包形态 profile bundle：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`。
- 安装 `dsh plugin --profile web add <dir>`；组合层变更需重启 profile 进程。
- patch 插入四行：`feishu-gateway`、`feishu-bridge`、`invariants` registry、`feishu-invariant`。单包多入口，角色独立演化前不拆包。
- 锁定已验证 dsh 版本（当前 0.1.1-rc.2，官方 `master` commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）；升级须重跑 Loader 组合回归。

### 3.2 插件职责边界

| 插件 | 注入依赖 | 职责 | 明确不做 |
|---|---|---|---|
| `feishu-gateway` | credentials | `ctx.feishu` 服务：长连接、收发、卡片、出站 FIFO 与限流重试 | 任何业务语义 |
| `feishu-bridge` | feishu, agents, sessions, sessionPersistence, storageDomain（不注入 userQuestions） | 绑定、命令、入站路由、出站投影、审批答复 | 不持有飞书 SDK；不执行 shell；不解析工具参数 |
| `invariants` registry | — | 提供 `ctx.invariants`，承载包级运行时不变量 companion | 不注册产品检查；不修复状态 |
| `feishu-invariant` | invariants, feishu（installer 内需 sessions、sessionPersistence、storageDomain） | 等待 Gateway 持有的 Bridge readiness latch 后，并在后续写入时校验 active binding 指向存在 session | 不修复状态；失败即报告不变量破坏 |

### 3.3 顺序保证的三层分工

顺序保证分三层，各管各的，**互不替代**：

1. **durable admission + per-chat 业务队列（bridge）**：全局 admission 串行完成容量检查、按飞书 `message_id` 去重和 `received` 持久化；SDK 回调等待这一提交点。随后每个 chat 的异步操作链覆盖绑定读改写、resolver、`followup()` 与命令处理。同 chat 的命令与普通消息严格串行；admission 提交只表示“可恢复”，不表示业务已完成或模型已消费。
2. **per-chat 出站 FIFO（gateway）**：文本创建、卡片创建和卡片 patch 纳入确定目标的发送队列；同 chat create 重试不越序，patch 按 message id 串行。超过重试预算时该 chat 熔断并审计，不静默乱序。
3. **domain 写队列（storage-domain 自带）**：只负责 durable write 串行，不充当业务锁。

跨 chat 竞争：两个 chat 绑定同一 session 时，各自业务队列并行触达同一 agent；`followup()` 的 inbox 插入本身是安全的追加，session 级顺序由 agent inbox 语义决定，bridge 不加跨 chat 锁。

### 3.4 Gateway 接口契约

- **Id 类型**：`FeishuChatId`、`FeishuMessageId`、`FeishuCardId`、`FeishuOpenId`、`FeishuEventId` 及 bridge 自有的 `PendingCardId`、`OutboundSegmentId` 均为 `Branded<B>`（dsh-brand），不用裸 string。
- **任务卡 actor**：同一 turn 的 create、节流 patch 与 terminal patch 共用单一 actor/timer；terminal 取消迟到 running 更新。Gateway 仍会校验 patch 的 HTTP 与飞书业务码，不把“Promise resolved”当成功。
- **429/限流**：指数退避 + 每 chat 熔断冷却；冷却中新入队消息保留待发。
- **回调重复投递**：SDK 事件回调可能重复，gateway 不去重（业务去重在 bridge 状态机，§6.1）；gateway 仅保证回调按到达序派发。
- **dispose quiescence**：Bridge 先注销 admission/卡片处理器并停止 WS，在一个期限内排空 chat、card、approval、projection、maintenance 工作后关闭 storage；Gateway 再排空已接纳 create/patch。期限耗尽时写入闸门关闭，durable pending 留待重启恢复；全部注册走 `ctx.effect()` 回卷。

## 4. 飞书平台侧

- 企业自建应用；官方 `@larksuiteoapi/node-sdk` 长连接模式（WebSocket 事件订阅，免公网回调）。
- 权限：`im:message`（收）、`im:message:send_as_bot`（发）、卡片互动回调。
- 事件：`im.message.receive_v1`、`card.action.trigger`。
- 凭据：App ID/Secret 存 dsh credentials 服务（引用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`），patch 与仓库零明文。

## 5. 持久化：兼容域与 delivery 域

按上游 storage-domain 契约定义（`defineDomain` + `ctx.storageDomain.open(spec)`），不把 `ctx.storage` 当任意 KV。为了让已有 `feishu_bot` v1 数据原样可读，可靠性加固没有提升旧域版本，而是新增 `feishu_bot_delivery` v1：

```ts
const feishuDomainSpec = defineDomain({
  name: 'feishu-bot',
  version: 1,
  tables: {
    bindings: domainTable<FeishuChatId, ChatBinding>(chatBindingSchema),
    inboundEvents: domainTable<FeishuInboundKey, InboundEventRecord>(inboundEventSchema),
    pendingCards: domainTable<PendingCardId, PendingCard>(pendingCardSchema),
    outboundSegments: domainTable<OutboundSegmentId, OutboundSegment>(outboundSegmentSchema),
  },
})

const feishuDeliveryDomain = defineDomain({
  name: 'feishu_bot_delivery',
  version: 1,
  tables: {
    deliveries: domainTable<FeishuDeliveryId, CanonicalDelivery>(canonicalDeliverySchema),
    projectionCursors: domainTable<ProjectionCursorId, ProjectionCursor>(projectionCursorSchema),
  },
})
```

```ts
interface ChatBinding {
  sessionId: SessionId
  status: 'active' | 'unavailable'   // 生命周期见 §6.6
  boundBy: FeishuOpenId
  boundAt: number
}

/** 入站事件状态机记录（兼做去重表与崩溃恢复对账依据，见 §6.1） */
type InboundEventRecord = {
  receivedAt: number
  chatId: FeishuChatId
  senderOpenId: FeishuOpenId
  /** 新记录以 message_id 为表键；event_id 保留为审计/旧键兼容别名。 */
  eventId?: FeishuEventId
  feishuMessageId?: FeishuMessageId
} & (
  | {
      kind: 'message'
      status: 'received' | 'recovering' | 'enqueued' | 'rejected' | 'expired'
      /** bridge 生成的 DSH MessageId，followup 前持久化，对账主键 */
      messageId?: MessageId
      sessionId?: SessionId
      /**
       * 消息文本。隐私规则：仅在 received/recovering 态存在（崩溃后重建消息所需）；
       * 转入 enqueued/rejected/expired 的同一次写入中清除（文本此后只存在于
       * session log 或彻底不存在）。审计日志任何时候不记录全文。
       */
      text?: string
    }
  | {
      kind: 'command'
      status: 'received' | 'committed' | 'rejected' | 'expired'
      command: string
      commandArgsHash: string
      /** 副作用目标，产生后立即回写（如 /new 创建的 sessionId、/use 的目标 sessionId），reconciliation 依据（§6.2） */
      target?: SessionId
      /** committed 时的可重放结果（回帖文案等），重复 event 直接重发此结果 */
      result?: CommandResult
      rejectReason?: string
    }
)

/**
 * `enqueued` 的契约：该飞书 event 已被 DSH 接受且消息 durable 进入 agent inbox；
 * 是本表的终态，**不承诺模型一定消费**。后续消费（claim 成 user/message）、取消
 * 丢弃（canceled splice）、agent dispose 等由 session log 表达，不回写本表。
 */

/** 审批卡待决记录 */
interface PendingCard {
  kind: 'approval'
  pendingId: ApprovalRequestId
  chatId: FeishuChatId
  /** 卡片发送成功后回填；缺失 = 崩溃于发送前，重启扫描直接删（§6.4） */
  cardMessageId?: FeishuMessageId
  createdAt: number
}

/**
 * 出站文本段（outbox），发送幂等与重启恢复的依据（§6.3）。
 *
 * 表主键 `OutboundSegmentId` 是四元组 `chatId:sessionId:sourceEventSeq:segmentIndex`
 * 的确定性编码（非随机）——同一 assistant 事件向同一 chat 的重复投影天然命中同一
 * 记录，不重复入库；多 chat 绑定同一 session 时各 chat 各有独立记录与发送状态，
 * 互不误判"已发送"。segmentCount 由分段函数对同一输入确定性得出，不参与主键；
 * 若实现变更导致同一事件分段数改变（升级场景），以已存记录为准，不重新分段。
 */
interface OutboundSegment { // 旧 v1 outbox/dead-letter；仅供升级兼容与续发
  chatId: FeishuChatId
  sessionId: SessionId
  /** 来源 assistant/message 在 session log 中的事件序号（append-only log 内稳定；session fork 产生新 sessionId，键不冲突） */
  sourceEventSeq: number
  segmentIndex: number
  segmentCount: number
  text: string
  status: 'pending' | 'sent'
  attempts: number
  createdAt: number
}

interface CanonicalDelivery {
  chatId: FeishuChatId
  sessionId: SessionId
  sourceEventSeq: number
  /** 完整逻辑结果只持久化一次；分段在发送时确定性派生。 */
  text: string
  status: 'pending' | 'sent' | 'abandoned'
  attempts: number
  createdAt: number
}

interface ProjectionCursor {
  /** 已物化为 canonical delivery 的最高日志序号，不代表网络已送达。 */
  sourceEventSeq: number
  updatedAt?: number // optional keeps pre-cleanup cursor rows readable
}
```

生命周期与约束：

- 两个 domain 都在 bridge apply 中打开；Bridge 的单一 lifecycle owner 在有界 drain 后依次关闭它们，避免 Cordis 并行回卷导致 sibling effect 提前关闭存储。
- domain 写串行 durable-first；bridge 不把它当同步 Map，业务并发由 §3.3 的 per-chat 队列负责。
- `inboundEvents` 新记录以 `message_id` 为主键，旧 `event_id` 键仍可命中；终态按保留期清理。达到硬容量时只先删可淘汰终态，若剩余均为 recoverable 则 admission 明确背压，让飞书重投。
- `pendingCards` 使用 `staged | visible | uncertain` 展示状态；活动审批以及 TTL 内的模糊 create 事实不因容量压力删除。达到硬容量时让路 Web/其他 answerer，不伪装已展示。
- `outboundSegments` 仅作为旧 v1 outbox/dead-letter 续发路径；新结果不再写分段集合。
- `deliveries` 先保存完整结果再推进 cursor；`pending` 超期转 `abandoned` 并清正文，终态按 retention 清理。受保护记录填满硬容量时投影背压。
- `projectionCursors` 与旧 global watermark 只在 binding 已失效且没有相关 pending delivery 时回收；活动/保护性 cursor 不为容量让路。
- 绑定规则：chat → session 多对一允许；一个 chat 同时只绑一个 session；`/release` 只解本窗口；无绑定时普通消息不隐式创建会话。

## 6. 消息流

### 6.1 入站状态机与幂等对账

**来源语义（M1 实测修订）**：人发的文本记 `source: {kind:"user", via:"feishu"}` 而非 `{kind:"plugin"}`——Web transcript 与会话活动行都以 `source.kind === "user"` 识别人类输入；plugin source 会被折叠为上下文注入行，导致 Web 里"看不到飞书发的消息"。`via` 为 merge-extensible source 上的自定义字段，保留前端来源审计。

上游事实（已核实）：`followup()` 将消息 durable 落为 `agent/inbox/spliced`（插入项携带 `UserMessage.id`）；`user/message` 要等 agent loop 在 step 边界 `claim()` 后才出现；splice 的 `outcome: 'canceled'` 标记被取消丢弃的消息。因此 **followup 成功 ≠ user/message 存在**，对账必须覆盖 inbox 投影。

```
im.message.receive_v1 回调 → await 全局 durable admission：
 1. 只接 p2p；open_id ∉ allowlist ⇒ 丢弃 + 审计（不写表）
 2. 查 inboundEvents[message_id]，并兼容查询旧 inboundEvents[event_id]：
    - 已存在 ⇒ 视为重复；committed/rejected 命令可异步重发首次 result，不重执行副作用
 3. 先清理可淘汰终态，再检查 inboundMaxRecords 硬上限：仍满 ⇒ 抛错，不 ACK
 4. stale/非文本直接写终态；其他内容以 message_id 为键写 durable received
 5. received 写成功后将业务工作放入 per-chat 队列；admission Promise 返回，SDK 才可完成回调

per-chat 队列随后执行：
 6. 命令 ⇒ 命令执行（幂等策略见 §6.2）⇒ 写 committed(result) / rejected
 7. 普通文本：
    a. 绑定校验：无绑定或 unavailable ⇒ 写 rejected，回提示
    b. resolver 取 agent（§6.6）
    c. msg = createUserMessage(...)   // bridge 此刻持有 MessageId
    d. 更新 record { messageId }      // durable，先于 followup —— 对账主键就位
    e. agent.followup(msg)
    f. 写 enqueued { sessionId }
```

这里的 ACK 提交点只承诺 `received` 已可恢复。业务队列、模型消费和终态回复均可能晚于回调完成；因此文档不使用“回调结束即处理完成”或端到端 exactly-once 表述。

**崩溃恢复对账**：Bridge 在注册 admission、启动长连接之前主动扫描全部 `received/recovering` 记录（飞书重连不保证历史事件重发，不能把恢复寄托在重复投递上）；逐条置 `recovering` 后按 chat 排入业务队列执行对账。重复 `message_id` 在 admission 处只命中既有记录并返回，不会再执行副作用。超过恢复期限（默认 24h）的记录直接写 rejected('interrupted') + 审计，不重投。

| record 状态 | 判定 | 动作 |
|---|---|---|
| 无 `messageId` | 未走到 6c，无副作用 | 用 record.text 重建消息重新走 6b–6f |
| 有 `messageId`，session log 中存在该 id 的 `user/message` | 已被 claim 消费 | 补写 enqueued |
| 有 `messageId`，inbox 投影（折叠 `agent/inbox/spliced`）中仍含该 id | 已入队待 claim | 补写 enqueued（不重投） |
| 有 `messageId`，splice 显示该 id 被 `outcome: 'canceled'` 移除 | 用户取消丢弃 | 写 rejected，回帖告知该消息已随取消丢弃 |
| 有 `messageId`，三处均无 | 6e 未提交 | 用 record.text + 新 id 重走 6c–6f |

对账判定链穷尽 6c–6f 之间每个崩溃点；自动化中的“同一恢复键不重复入队”断言以此为准，而非仅查 `user/message`。`recovering` 是恢复程序的占用标记：恢复中途再崩溃，下次启动扫描将 `recovering` 视同 `received` 重新对账（对账本身幂等，重入安全）。

消息来源标记：**`{kind:'user', via:'feishu'}`**——人类输入在 Web transcript 中保持用户消息语义，`via` 记录前端来源；event↔message 关联仍由 `InboundEventRecord.messageId` 持久化，不扩展新的 source kind。

**首期不做合并窗口与 `..`/`!!` 约定**：每条消息独立 `followup()`（next-turn 语义：turn 进行中排队至下一 turn，空闲即开新 turn）。不用 `steer()`/`inject()`。合并属体验优化，需先解决其 durable 与模型可见性设计（§10）。

**组合实验补充（M1 门禁实验结论）**：live driver 的 claim 快于 cancel 落地，"cancel 丢弃排队消息"的 canceled-splice 是窄竞态路径；主导顺序为 claim → abort 于 `user/message` 前、无 canceled splice，恢复 verdict 为 refollowup。**已知语义**：cancel 与 bridge 崩溃在同一窗口时，恢复可能重投一条用户已 cancel 的消息（日志无法区分"从未投递"与"claim 后中止"；消息未被模型消费过，重投不产生重复消费）。

### 6.2 命令集与命令幂等

| 命令 | 行为 | 权限（§7.2） |
|---|---|---|
| `/new [cwd]` | 新建会话并绑定本窗口；cwd 缺省用 `defaultWorkspace`，两者皆缺则拒绝；cwd 范围授权见 §6.7 | allowlist + §6.7 |
| `/ls` | 建立工作空间/会话快照并发送两级可点击分页卡片（范围见 §6.6） | allowlist |
| `/use <序号或短id>` | resolver 成功后绑定（事务顺序见 §6.6）；作为卡片的文本兜底 | allowlist；抢占 active 绑定需 boundBy |
| `/status` | 绑定、cwd、模型/档位、agent 状态 | allowlist |
| `/stop` | `agent.cancel({kind:'user'}, {keepInbox: true})`：中止当前 turn，**保留已排队输入**（帮助文本注明） | boundBy |
| `/release` | 解绑本窗口；对未绑定 chat 回"当前无绑定"视为成功 | boundBy |
| `/help` | 帮助 | allowlist |

命令幂等策略（配合 §6.1 状态机）：

- **重复 event（committed 后重投）**：通常重发 `record.result` 中存储的首次结果——`/new` 返回首次创建的 sessionId、`/use` 返回同一绑定、`/release` 返回同一确认；不重执行副作用。`/ls` 正常卡片路径把空结果提交为去重标记，重复 event 不再建卡或补发文本；建卡使用入站 message id 派生的稳定 delivery identity。
- **崩溃中断（received 后、committed 前崩溃）按副作用可识别性分两类恢复**：
  - **副作用可识别 ⇒ reconciliation，不直接标 rejected**。命令在副作用产生后立即把目标回写 record（`target` 字段，§5）：
    - `/new`：record 有 `target` 且该 session 存在、本 chat 绑定已指向它 ⇒ 副作用已完成，补写 committed 并回帖首次结果；session 存在但绑定未提交 ⇒ 完成绑定提交后补写 committed（绑定提交幂等：同值覆盖写）；session 不存在 ⇒ 无副作用，安全重执行。
    - `/use`：record 有 `target` 且绑定已指向它 ⇒ 补写 committed；绑定未变 ⇒ 重走 resolver→绑定（resolver 并发去重使重复 resume 安全）。
    - `/release`：当前绑定已不存在 ⇒ 已完成，补写 committed；仍存在 ⇒ 重执行解绑（幂等）。
  - **副作用不可识别（record 无 `target`，崩溃于目标回写前）**：`/new` 此窗口内 session 可能已创建但无从关联 ⇒ 标 rejected('interrupted')，回帖提示核实（孤儿 session 由 `/ls` 可见，用户可 `/use` 认领）。该窗口按实现收窄到"创建调用与 target 回写之间"，无法为零——**验收表述相应为：系统不自动重放中断命令；reconciliation 覆盖 target 已落盘的中断；仅目标回写前的窄窗口可能残留需人工核实的孤儿副作用**。
- 天然幂等命令（`/ls` `/status` `/help`）不改变 Harness 会话；其中 `/ls` 会建立进程内临时交互快照，中断或重启后用户重发即可。
- `/stop` 重复执行安全（对已中止 turn 的再次 cancel 是 no-op，不影响后续新 turn）。
- 命令回帖先于 committed 写入发出时可能"回帖成功但记录丢失"，reconciliation 补写 committed 后重发回帖——用户至多多收一条相同回帖，不产生副作用。

### 6.3 出站投影

**数据暴露立场（安全评审 2026-08 确认为设计行为）**：绑定即授权上传——assistant 回复发往飞书服务器（含模型输出的代码/文件内容/命令结果），命令回帖含本机绝对路径与会话 id；任务/审批卡还会上送工作区 basename、任务/工具状态、工具名、审批 reason 与可用 token 事实（审批卡不放工具参数）。不做出站内容过滤；本地绝对路径 Markdown 链接只做展示改写（`[label](/path)` → ``label（`/path`）``），路径本身仍会上传。信任边界在**谁能绑定**（allowedOpenIds fail-closed）与**哪些会话可见**（allowedWorkspaces 约束 /ls、/use、/new 三个入口）。部署者不得把"不可离机"的工作区加入白名单。**边界精确含义**：allowedWorkspaces 约束的是飞书侧"哪些会话可绑定/列出/新建"，不约束绑定后 agent 的读取面——上游沙箱只围栏写入（fs-sandbox "every mode permits reading"；Seatbelt `(allow default)`+`(deny file-write*)`），任何会话都能读本 OS 用户可读的一切文件并在回复中复述。读隔离须靠独立 OS 用户，非本插件配置可达。桥自身日志与审计只落 id/hash，SDK 失败日志经脱敏 logger 剥离 config.data/response.data 以及 `formatErrors` 追加的重复响应体。

1. **终态结果卡（canonical delivery + cursor）**：chat 保持绑定期间，投递由飞书或 Web 直接用户消息开启、且已经收口的任务结果；`/release` 后停止该 chat 的同步。不投未提交流式 delta、含 `tool-call` 的过程说明或每个 subagent continuation turn 的阶段文本。启动与实时通知走同一 `catchUpProjection(chat, session)`：
   - 从 `(chat, session)` cursor 后补读日志；`source.kind=user` 且 `source.via=feishu|web` 的直接 `user/message` 稳定 seq 作为任务和 delivery key，后续 `subagent-report`、`subagent-settled` 与 continuation turn 折叠到该任务。当前 turn 已终止且任务启动的直接子代理均 settled 后，只保留最新合格 completed 文本，先写一条完整 canonical delivery，再把 cursor 推进到整个任务已扫描的末尾。两步之间崩溃只会命中同一任务 key，不会把内部 turn 物化成多条回复；cursor 只表示“已物化”，不表示网络已送达；
   - 发送时才做本地绝对路径展示改写与确定性分段：按完整 create-message envelope 的 UTF-8 JSON 字节数使用 24 KiB 软上限，整行优先，超长单行按 Unicode 码点二分；每段渲染 CardKit 2.0 绿色结果卡（标题 `工作区名 · 最终结果 · i/N`），固定完成提示和助手正文均使用 `body.elements` 下的原生 `markdown` 组件。改写后的助手正文直接交给飞书，不在插件内解析 Markdown 或转换 HTML；渲染能力以飞书支持的 Markdown 语法子集为准，不承诺完整 CommonMark；
   - 每个 create 的逻辑 identity 为 `deliveryId + stage + segmentIndex`，Gateway 将其 SHA-256 截取为稳定 32 位十六进制 `uuid`。同一形态的即时重试和进程重启复用相同 UUID；
   - HTTP/业务码明确成功后 delivery 才写 `sent` 并清正文。确定性卡片内容/能力拒绝可切到不同 stage 的文本 fallback；429/可重试网络错误复用原形态，timeout、断连、5xx 等模糊结果也只重试原形态/UUID，不跨形态发送；
   - 启动先排入旧 `outboundSegments` pending，用旧 watermark 初始化新 cursor，再把 canonical pending 和 session-log catch-up 依次排入同 chat FIFO。网络发送可在插件 ready 后继续，避免挂起的外部请求导致激活超时；新入站仍不会超过同 chat 的已排队恢复工作。平台对 UUID 的实际去重窗口与迟到完成行为仍需专用飞书 chat 实测，因此这里只承诺稳定 identity 和可恢复状态机，不声明端到端 exactly-once。
2. **任务卡**：绑定会话中每条 Web/飞书直接用户消息一张，展示跨内部 turn 聚合后的状态 / 当前工具 / token / 耗时。
   - **状态与当前工具**：从 `session/event` 以纯函数折叠 `tool/call`、`tool/result`、subagent 生命周期与 turn 边界事件重建；"当前工具"只显示已 call 未 result 的调用。同一任务的 report/settled 续跑只 patch 原 message ID；下一条 Web/飞书直接用户消息才创建新卡。折叠函数输入为事件序列，可从 log 重放（进程重启后旧卡定格，不重建；卡片更新不经 outbox——非终态展示可丢弃）。
   - **token 字段**：来源 `ctx.tokenMeter.measure(session)`——M0 已确认 token-meter 在 base 层组合中必在（base patch :281），直接注入。**provider 未上报 usage 时显示"未知"，不显示估算值**；计数口径随 tokenMeter，在卡片注明。token 缺失不构成功能缺陷。
   - 同一飞书任务的 create、节流 patch、内部 turn terminal patch 进入单一 actor；仅保留一个 timer。只有任务级 settled 才冻结 actor，内部 turn 的 error/completed 不能新建卡或提前冻结。渲染只消费 `session/event`，不写 session log；进度卡失败不影响 canonical 终态正文。

### 6.4 审批

已由源码确认的上游事实：

- `approval/request` 是 **waterfall**：listener 返回 outcome 即 claim 本请求，调用 `next()` 才交给后续 listener——**串行 claim-or-delegate，不是广播**。一个 listener 挂起等待用户点击期间，后续 listener 不会启动。
- `ApprovalRequest` 只携带 `agent/toolName/callId/reason/signal`，不含 `ApprovalRequestId`；id 由 `ApprovalService.request()` 生成后落 `approval/asked`。
- Web apiproxy 的 listener 通过扫描 session 事件（最新、未决、未被本地 pending 占用、callId 对称匹配）配对 `approvalId`，随后登记 pending 并**挂起等待远端回答，不调用 `next()`**——它 claim 了整个请求。

M0 源码核验补充的事实：waterfall listener 按**注册顺序** outermost-first 组合（vendored Cordis events.ts），`ctx.on(name, fn, {prepend: true})` 可插到最前；bundle 层序使 bridge 默认注册晚于 apiproxy——不 prepend 则 Web claim 后飞书永远收不到。apiproxy 的 pendingApprovals/muxQueues 为闭包私有，不可复用。scope 过滤只约束带 scope tag 的 listener ctx，bridge 在普通 ctx 上注册即收到所有 agent 的请求。

**首期语义按两档设计，运行时实验（M0 实验项）定档：**

- **方案 α（目标）：prepend 注册 + `next()` 并行 race。** bridge 以 `prepend: true` 成为最外层 listener。有绑定 chat 时：配对 approvalId → 发飞书卡 → `const web = next()`（请求继续交给 Web listener，其照常挂起等 Web 客户端）→ 返回 `Promise.race([feishuAnswer, web])`。任一通道先决即为 waterfall 结果；败者 promise 悬置无害（Web 侧 late resolve 是 no-op——apiproxy settle 有幂等守卫；飞书侧晚点击落在已 settle 的 registry 上，卡片定格"已在别处决定"）。无绑定 chat ⇒ 直接 `next()`。待实验确认：飞书先决时 Web UI 卡片的定格表现（若 Web 卡片停留待决态直到刷新，记录为已知 UI 瑕疵或降级 β）；同一请求 bridge 与 Web 各自配对同一 approvalId 的双登记在审计上的正确性（decided 只由 service 写一次，预期无放大）。
- **方案 β（降级保底）：prepend + 按绑定切换通道。** bridge 仍 prepend；有绑定 chat 的请求只由飞书处理（不调 `next()`，Web 收不到该请求），无绑定 ⇒ `next()` 交 Web。同一请求同一时刻只有一个通道呈现 UI；文案如实描述"该会话审批走飞书"。

以下流程按通道无关部分描述（α/β 共用）：

```
bridge listener 收到 approval/request
 → 无绑定该 req.agent.session 的 active chat ⇒ 直接 next()
 → 配对 approvalId：与 apiproxy 同构扫描（最新、未决、未被占用、callId 对称匹配；
   无 asked 事件或歧义 ⇒ next() 保守让路）
 → 串行预留 approvalMaxRecords 容量；无法安全腾位时记录背压并 next()
 → 提交顺序（先 durable 后暴露，避免把不可恢复卡当成有效审批）：
   1. 内存 pending registry 登记 approvalId → { resolve, chatId }
   2. durable 写 pendingCards(presentation='staged')
   3. 加入该 chat 的审批组卡；若既有组卡 patch 失败，撤销本 item 并改发独立卡
   4. create 成功后回填 cardMessageId + presentation='visible'，此后才进入等待态
   失败补偿：
   - 步骤 2 失败 ⇒ 撤内存登记，next()（用户从未见到飞书卡，无补偿负担）
   - 组卡 patch 失败 ⇒ 组卡恢复到本 item 加入前的可见状态，再尝试独立卡
   - create 确定失败 ⇒ 删除 record、撤登记、next()
   - create 结果模糊 ⇒ 写 presentation='uncertain'、撤登记并 next()；不等待身份未知的卡片按钮
   - cardMessageId 回填失败 ⇒ 当前进程立即把已创建 item 定格失效、清理 record 并 next()
 → 审批卡内容：toolName + reason 截断 500 字节 + 会话标题 + Web GUI 链接；
   不解析、不展示 tool/call 参数
 → 飞书用户点击 允许/拒绝：
   校验 权限（§7.2）∧ 内存 registry 中该 approvalId 仍 pending ∧ 回调 chatId/messageId
   与原审批卡一致 ∧ 该 chat 当前仍 active 绑定原 session；通过 ⇒ resolve，卡片定格
 → req.signal abort（asker 撤回）⇒ 卡片定格"已撤回"，清 registry 与 record
```

**重启语义（首期）**：启动扫描 `pendingCards`。只有带 `cardMessageId` 的 visible 卡可被 patch 为“进程重启已失效”；staged/uncertain 无可靠 message id 时只按安全拒绝事实清理，绝不宣称卡片可用。所有记录随后删除并审计。**不向 session 补写任何 `approval/decided`**——审计对归 `ApprovalService.request()` 生命周期所有，进程消亡产生的未配对 `approval/asked` 属 crash-tail，由上游 session 修复/重放机制处置；bridge 补写既无法归还旧 promise，也可能违反 turn-enclosure。卡片失效 ≠ approval 已决。

### 6.5 问答（首期不做，M0#1 已裁定）

**不注册** `userQuestions` provider（单 provider 约束，Web apiproxy 已注册）。M0 核验确认：`ask()` 全程不落任何 durable session 事件，待答问题对旁观插件**不可观察**——只读通知也无从实现，首期彻底不做（含原 pendingCards 的 question-notice 分支，已裁剪）。模型提问时飞书用户无感知；`/status` 帮助文本注明"模型提问需在 Web GUI 作答"。

后续若要飞书作答：路由 provider（自身为唯一注册者，按 `request.agent` 绑定关系路由 Web/飞书子 provider，处理 `CALLER_NOT_LIVE`/`DELEGATED_CALLER` 约束），须与 Web provider 注册方式协调，单独立项。

### 6.6 会话解析、列表与绑定生命周期

- **agent 获取经 bridge 专用 resolver（M0#5 已定档：同构实现）**。上游 `createApiRemoteAgentResolver` 结果仅 `{agent}|{error}`、不暴露 handle/ownership，不满足补偿需求；但 `ctx.agents.resume()` 返回含 dispose 的 AgentHandle 且对插件公开，`inspectApiRemoteSession`/`hasApiRemoteSubagentOwner` 均已从 api/remotes 导出。bridge resolver 按 agent-lookup 源码同构实现（live fence → cold resume → inspect 返回后的当前 ownership 复查 → setup commit 前 fence → 并发去重 Map），显式返回 `{ agent, ownership: 'existing' | 'created-here', dispose?: () => Promise<void> }`；并发合流共享同一 resume promise，仅首发起者标 `created-here` 并持有 handle（其余 `existing`，杜绝双 dispose）。最终同 id 的发布碰撞仍由 Harness 的 SessionStore/AgentRegistry 仲裁，resolver fence 只负责 fail-fast 和避免错误恢复。三个上游工具直接复用，最小自有代码面约为 agentFor 骨架。
- **`/ls` 范围与两级快照**：只列 `allowedWorkspaces` 允许根之下且未归档的会话（归档集合以 Harness `workspaceRegistry` 为准），排除 subagent-owned 与无 cwd 会话。当前 SessionHeader 没有 updatedAt，因此候选按 `createdAt` 降序后按规范化 cwd 聚合，不再全局截断 20 条；首层只冻结工作空间与轻量 session header，不读取 title。进入工作空间后才从 live `sessionProjections` 或 cold `sessionProjectionCache.coldSnapshot()` 读取该组 title 并冻结；缺失或失败显示“未命名会话”。同 basename 工作空间使用快照内序号去歧义，卡片不上传父目录或完整 cwd。
- **`/ls` 导航与动作校验**：工作空间与会话两级均每页最多 7 项，使用 CardKit 2.0 标题按钮并在原卡完成进入、返回和翻页；单会话工作空间直接绑定。随机 144-bit token 绑定 chat、发起人、原卡 message id、固定分组/顺序与 `listingTtlMs`。按钮 payload 只含 kind/action/token/level/page/workspaceIndex/index，不含 cwd 或 session id。动作先快速返回 toast，再进入既有 chat FIFO 执行 projection、patch 或绑定；异步 patch 失败发送可见文本回执。选择前重新校验 allowlist、来源 chat/message、操作者、token/TTL、active binding 的 `boundBy`、workspace 与归档状态。选择与文本 `/use` 共用同一绑定事务；完成后原卡定格绿色/红色，终态 patch 失败改发文本回执。双击、旧卡与转发卡均拒绝。
- **`/ls` 投递形态与编号**：建卡使用稳定 delivery identity。只有确定性卡片能力/内容拒绝才发送最多 20 条的命名编号文本列表；timeout、断连和 5xx 等模糊失败保留原形态，不跨形态补发。模糊失败拿不到原卡 message id，无法证明点击来自原卡，故任何迟到卡片点击都 fail-closed 并要求重发 `/ls`。正常卡片路径的 `/use <编号>` 仅引用当前已打开工作空间的稳定会话顺序，返回首层即清空；`/use` 在解析后再次校验归档状态，完整 id 也不能绕过。进程重启后内存快照失效，须重发 `/ls`。
- **绑定事务顺序与资源补偿**：`/use` 与 `/new` 共用 binding switch helper：先 resolver/创建，准备目标 projection cursor，再提交 `active` binding。helper 记录旧 binding、candidate after-image 与 handle 来源；任一步失败都进入同一补偿边界：
  - `ownership: 'created-here'`：失败 ⇒ 在独立 `bindingCleanupTimeoutMs` 内调用本次 handle 的 `dispose()`；超时留下固定字段审计，但不覆盖主失败原因。`/new` 已把 sessionId 记入 command record（§6.2），失败回帖据此给出 id 供核实。
  - `ownership: 'existing'`（Web 或其他 chat 已在使用）：绑定写失败 ⇒ **绝不 dispose**，仅回帖错误。
  - 若 binding 写可能已生效，只有当前值仍等于本次 candidate after-image 才恢复旧 binding；发现后续操作已写入更新值时不回滚，避免覆盖并发新状态。为目标新建的 cursor 也只在安全条件下补偿。
  - 绑定写成功但回帖失败：命令已 committed，重复 event 走 §6.2 重发结果路径。
- **`unavailable` 状态只产生于重启恢复**：启动校验发现绑定的 session 不存在或装载持续失败 ⇒ 标记 `unavailable` 并通知。其生命周期：
  - 普通消息 ⇒ rejected + 提示 `/use` 或 `/release`；
  - 任何 allowlist 用户可 `/use` 覆盖（unavailable 不受 boundBy 抢占保护）；
  - boundBy 可 `/release`；
  - `/use` 成功提交新 active 绑定时自动清除。

### 6.7 工作目录授权（`/new [cwd]` 的范围限制）

远程指定 cwd 等于远程划定 agent 的文件操作疆界，必须有显式授权范围，"白名单 + 私聊"不构成目录授权：

- 配置 `allowedWorkspaces: string[]`（见 §8）：`/new` 的 cwd（显式给出或取 `defaultWorkspace`）必须位于其中某根目录之下，否则拒绝并回帖允许范围。`defaultWorkspace` 必须自身位于 `allowedWorkspaces` 内（load 时校验，fail loud）。
- 路径判定规则：
  - 仅接受**绝对路径**；相对路径直接拒绝（消除对"当前目录"的任何依赖）；
  - 判定前做规范化 + **symlink 解析**（`realpath`；目标不存在时解析已存在的最深祖先）——祖先目录包含检查在解析后的真实路径上进行，`..` 与 symlink 均无法越出允许根；
  - 允许根自身在配置加载时同样 realpath 化；
  - `allowedWorkspaces` 为空 ⇒ `/new` 一律拒绝（fail-closed，与白名单同则）。
- `/use` 不受此限制（绑定既有会话不改变其 cwd），但 `/ls` 只列允许根之下的会话，允许范围外的既有会话需在 Web GUI 操作——飞书端的可见性与可创建性同疆界。

## 7. 安全模型

### 7.1 红线（不可协商）

1. 飞书消息只进会话流（`followup` 用户消息）；任何路径不得直接执行 shell、写文件、改配置。
2. 审批校验链：权限（§7.2）+ 内存 registry pending + 回调 chat/message 与原卡一致 + chat 仍绑定原 session；缺一即拒并审计。
3. 白名单 fail-closed：空名单拒绝一切；无自动授权逻辑。
4. 凭据只经 credentials 服务；日志脱敏；审计记录入站元数据（不含正文全文）、命令、审批决定。
5. 沙箱与权限档位不因飞书通道放宽；审批卡只是 answerer 换面，policy 不变。
6. 审批卡不携带工具参数（§6.4）；reason 截断；正文不进审计日志。
7. `/new` 的 cwd 必须落在 `allowedWorkspaces` 允许根内（realpath 化祖先检查，§6.7）；空配置拒绝一切 `/new`——远程通道不得扩大 agent 文件疆界。

### 7.2 权限矩阵

| 操作 | 需 allowlist | 需本 chat 有 active 绑定 | 需操作者 = boundBy |
|---|---|---|---|
| `/ls` `/status` `/help` | 是 | 否 | 否 |
| `/new` | 是 | 否 | 否 |
| `/use`（空闲或 unavailable chat） | 是 | 否 | 否 |
| `/use`（抢占 active 绑定） | 是 | — | 是，否则要求先 `/release` |
| 普通消息 | 是 | 是 | 否（同 chat 内 allowlist 用户共享输入权） |
| `/stop` `/release` | 是 | 是 | 是 |
| 审批点击 | 是 | 是 | 是 |

- 首期主场景为单人私聊，矩阵按最严格档：破坏性操作（stop/release/审批/抢占）一律 boundBy 本人；跨 chat 转发或伪造 messageId 的卡片点击因原卡上下文校验失效。
- allowlist 用户 ≠ 可控制所有已绑会话：控制权按 chat 绑定 + boundBy 收窄。

## 8. 配置面

| 键 | 默认 | 说明 |
|---|---|---|
| `appIdRef` / `appSecretRef` | bundle: `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | credentials 引用；schema 必填，bundle patch 提供引用名 |
| `allowedOpenIds` | `[]` | 白名单（空=拒绝所有） |
| `allowedWorkspaces` | `[]` | `/new` cwd 允许根（realpath 化祖先检查，§6.7）；空=拒绝一切 `/new` |
| `defaultWorkspace` | — | `/new` 默认 cwd；支持 `~`；须位于 allowedWorkspaces 内（load 校验）；缺省时 `/new` 要求显式 cwd |
| `freshnessMs` | 600000 | 入站时效 |
| `listingTtlMs` | 300000 | `/ls` 卡片与编号快照有效期；过期后要求重新 `/ls` |
| `cardThrottleMs` | 1000 | 卡片节流 |
| `sendRetryBaseMs` / `sendMaxAttempts` | 500 / 4 | 文本与卡片创建共享的指数退避基数和最大尝试次数 |
| `sendCircuitCooldownMs` / Gateway `disposeDrainTimeoutMs` | 30000 / 5000 | 单 chat 熔断冷却与 Gateway create/patch 关闭排空上限 |
| `recoveryTtlMs` | 86400000 | received/recovering 入站项可恢复期限 |
| `bindingCleanupTimeoutMs` / Bridge `disposeDrainTimeoutMs` | 5000 / 5000 | binding 创建者补偿超时与 Bridge 全工作 drain 上限 |
| `inboundRetentionMs` / `inboundMaxRecords` | 604800000 / 50000 | 终态入站保留期与硬容量；可恢复行不因容量被删 |
| `outboundRetentionMs` / `outboundMaxRecords` | 604800000 / 10000 | 旧 outbox/dead-letter 终态保留期与硬容量 |
| `outboundPendingTtlMs` | 86400000 | 旧 pending 段超期后 abandoned 并清正文 |
| `deliveryRetentionMs` / `deliveryMaxRecords` | 604800000 / 10000 | canonical delivery 终态保留期与硬容量 |
| `deliveryPendingTtlMs` | 86400000 | canonical pending 超期后 abandoned 并清正文 |
| `approvalPendingTtlMs` / `approvalMaxRecords` | 86400000 / 1000 | 非活动审批恢复事实 TTL 与硬容量；活动/新鲜模糊项受保护 |
| `projectionCursorRetentionMs` / `projectionCursorMaxRecords` | 604800000 / 10000 | 无绑定 cursor 保留期与硬容量；活动/待发保护项受保护 |
| `maintenanceIntervalMs` | 86400000 | 清理周期；0 仅关闭周期 timer，启动清理仍执行 |
| `agentProvider` / `agentModel` | — | 可选成对覆盖；省略时 `/new` 与 cold resume 跟随 Harness 当前 `agent-default-model` |
| `webUrl` | http://127.0.0.1:3080 | 审批卡 Web GUI 链接 |

结果卡容量采用固定的 24KB 软上限（完整 create-message envelope），作为飞书协议安全余量，不暴露为部署配置。

## 9. 可靠性

- 重连：SDK 断线重连由 SDK 管理；业务层以 `message_id` 去重并用 freshness 防旧消息回灌。
- **启动恢复扫描**（主动，不依赖飞书重投；本地对账与排队完成前 WS 不启动，已排队网络 I/O 不阻塞 ready）：
  1. `pendingCards` 失效扫描（§6.4 重启语义）；
  2. 绑定表校验（session 不存在/装载失败转 unavailable 并通知）；
  3. `received`/`recovering` 入站对账与 `received + target` 命令 reconciliation；
  4. 执行 TTL/容量维护；
  5. 排入旧 `outboundSegments` pending，从旧 watermark 初始化新 projection cursor；
  6. 按序将 canonical pending 和已绑定会话的 session-log catch-up 排入 per-chat FIFO；
  7. 注册 Promise-returning admission/card handler，最后显式 `startIntake()`。
- 重启恢复边界（可恢复 vs 只能失效）：
  - **可恢复**：绑定表、入站状态机（对账 + reconciliation）、旧 outbox 待发段、canonical delivery 与 projection cursor。
  - **只能失效**：未决审批卡、问答通知卡（定格 + 清记录 + 审计）；进行中任务卡（旧卡定格，不重建）。
- 发送：每 chat FIFO + 稳定 UUID + permanent/retryable/ambiguous 分类 + 退避重试 + 熔断（§3.4）。
- dispose：先停止 admission/card handler 和 intake；在 Bridge deadline 内 drain chat/card/approval/projection/maintenance，再关闭写入和两个 domain。Gateway 单独 drain create/patch；任一 deadline 超时都可观察，不能把超时当成功。
- 容量：TTL/retention 先清安全终态；recoverable/active/pending/protective 集合不可淘汰，硬上限耗尽时显式背压。

## 10. 后续扩展路径（不在本期）

- 问答路由 provider（§6.5）。
- 消息合并窗口 + `..`/`!!`（需回答：合并前原始消息是否逐条落 log、后缀是否模型可见——按"model-visible ⟺ logged"单独设计）。
- 群聊（mention 解析、thread/chatId 关系、移群清理、群内权限与脱敏分档）。
- 图片注入 attachment；卡片深化（diff 摘要、会话选择卡）。
- **模型选择与推理强度**（`/model`、`/effort`、`/status` 作用域分离）：方案见
  [M7 架构方案](m7-model-selection.md)。其中"`AgentOptions` 不含 `reasoningEffort`
  导致 `currentSelection()` 的档位被静默丢弃"是**当前已存在的缺陷**，非新功能缺口。
- 待决审批跨重启恢复（durable pending 协议：恢复点、id 绑定、tool call 可重放性、防 id 复用）。
- 多通道：gateway 抽象换钉钉/Telegram，bridge 依赖改通道注册表。
- 微信：待接受 iLink 风险后接入。

## 11. 决策记录

- **进程内插件而非 SDK/ACP 桥**：审批与进度只有进程内全通；dsh 架构中前端即插件，飞书网关与 Web 前端平级。
- **审批多前端不假设并行**：`approval/request` waterfall 是串行 claim-or-delegate；Web listener claim 后挂起等待且不 `next()`，追加第二个 listener 的效果由注册顺序决定。"先答先得"只能由单一协调 listener 主动实现（方案 α），实现不了就固定优先级（方案 β），落点由 M0 实验决定。
- **问答只读**：`userQuestions` 是单 provider——不对称是上游现状，方案顺应而非绕过。
- **飞书 `message_id` 是 admission 去重键，DSH MessageId 是恢复对账键**：同一飞书消息即使带不同 `event_id` 重投，也只形成一个 inbound record；`event_id` 仅作审计别名和旧数据兼容。`followup()` 成功只保证消息 durable 进入 inbox（`agent/inbox/spliced`），`user/message` 要等 loop claim；恢复链继续以预先持久化的 DSH MessageId 检查 inbox、user/message 与 canceled splice。启动主动扫描 `received/recovering`，不能等待平台重投。
- **enqueued 是接受终态，不是执行承诺**：消息进入 inbox 后的消费/丢弃由 session log 表达，不回写入站表——两套账各记各的，避免双写一致性问题。
- **命令中断按副作用可识别性分档恢复**：target 已落盘的中断走 reconciliation（据 record 判定副作用是否完成，补写或安全重执行）；target 回写前的窄窗口无法与创建调用构成单一事务，标 interrupted 交人工核实——自动重放在该窗口必然冒重复副作用风险，诚实收窄优于虚假承诺。
- **终态结果经 session-log cursor + canonical delivery**：实时 `session/event` 只是 catch-up 触发器，session log 才是权威来源；先以确定性 key 持久化完整 delivery，再推进 cursor。分段与 32-hex UUID 从 delivery identity 确定性派生，同一形态跨即时重试/重启复用；不确定失败不跨形态 fallback。旧 `outboundSegments` 只保留升级续发能力。平台去重窗口仍待实机验证，所以不把内部确定性提升为端到端 exactly-once 承诺。
- **审批配对靠扫描 `approval/asked`**：`ApprovalRequest` 不携带 id 是上游现状，与 apiproxy 同构配对（含 callId 对称匹配与 pending 占用排除）；点击有效性以内存 pending registry 为准，durable 记录只服务重启失效。
- **审批只有 durable visible 才可等待**：pendingCards 主键用 bridge 自有 `PendingCardId`；先写 staged，再发送/patch，成功回填 cardMessageId 后转 visible。组卡 patch 失败改发独立卡；模糊 create 记 uncertain 后让路，card id 回填失败立即失效并让路，避免 agent 无限等待不可确认卡片。
- **重启不恢复待决审批、不补写审计对**：approval 待决态活在 promise 链里；未配对 asked 属 crash-tail，归上游修复机制，bridge 补写可能违反 turn-enclosure。
- **绑定先 resolve 后提交、补偿按 resolver 返回的所有权**：消除"绑定成功但运行通道不可用"的长期中间态。上游 resolver 结果不含 AgentHandle 也不区分命中/新建——补偿依赖 bridge 专用 resolver 显式返回 `ownership` + `dispose`（M0#5 定档；不可行则兜底放弃自动 dispose、孤儿交 Host 生命周期，记已知限制）。unavailable 只作为重启恢复的降级标记存在，带明确生命周期。
- **消息 source 保持人类输入语义**：使用 `{kind:'user', via:'feishu'}`，让 Web transcript 与会话活动行正常显示用户消息；event↔message 关联仍由 InboundEventRecord 持久化。
- **顺序三层分工**：gateway 回调串行只覆盖派发，业务顺序由 per-chat 业务队列保证，domain 写队列不是业务锁（§3.3）。
- **resolver 语义同构、接口自建**：`createApiRemoteAgentResolver` 的公开结果类型（`{agent}|{error}`）满足不了所有权传递，直接复用不可行；按其源码同构实现以保持 resume/ownership 规则一致，接口面向 bridge 补偿需求设计（§6.6）。
- **`/new` cwd 走显式目录授权**：远程指定 cwd 即远程划定 agent 文件疆界；`allowedWorkspaces` realpath 化祖先检查 + 空配置 fail-closed（§6.7），Host 的绝对路径校验只是格式检查、不是授权。
- **不上卡工具参数**：approval seam 的最小信息面（toolName/reason）即安全默认；完整上下文属于 Web GUI。
- **token 字段可选**：来源不存在显示"未知"，不估算——产品契约而非实现妥协。

## 12. 事实状态标注

- **已由源码确认**（详录见 [M0 核验记录](m0-record.md)）：`userQuestions` 单 provider 且 ask() 无 durable 事件（问答首期彻底不做）；waterfall 按注册序 outermost-first、`prepend: true` 可插队、scope 过滤不拦普通 ctx 的全局监听；bundle 层序 base → web-app → 追加 bundle → profile patch（bridge 默认注册晚于 Web）；apiproxy pending 机制闭包私有不可复用；`ApprovalRequest` 不含 id、配对算法（callId 对称匹配）、orphan asked 不阻碍 load；`followup()` → inbox splice（事件自足可折叠）、`user/message` 待 claim、canceled splice；user/message source 校验仅要求 kind 非空 string；`Agent.cancel()` 默认清 inbox 与 Web 的 `keepInbox: true`；`AgentHandle.dispose()` 创建者所有权、`ctx.agents.resume()` 对插件公开返回 handle；api/remotes 工具函数导出面；storage-domain 与 token-meter 均已在 web profile 组合中加载；`session/event` 全局订阅可用、turn 折叠事件全集；`persistence.list()` 返回含 cwd 的 SessionHeader[]；`createUserMessage` 调用方持有 id；bundle 安装链路与 `--dump-config` 验证方式。
- **已由自动化/本地运行确认**：Gateway 延迟启动和 Promise admission；同 `message_id`/不同 `event_id` 去重；followup 崩溃点对账；cursor/delivery 双写窗口；稳定 UUID、错误分类与 patch 业务码；审批组 patch fallback、visible/uncertain 状态；binding after-image 补偿；绑定会话的 Web/飞书任务级卡片/结果折叠；`/ls` 两级 CardKit 导航、按需真实标题、稳定分页/返回、同名工作空间、超过 20 条不截断、单会话直绑及卡片身份校验；有界 drain、硬容量和无正文日志。阶段 6.1 最终证据以当前 release gate 为准。
- **M7 已由运行时实验确认（2026-08-18，M7.0）**：Web 端对任何被其触碰的 live Agent
  惰性安装 `ModelSelectionRef`（api-proxy `selectionFor`，共享 agent registry，飞书创建的
  Agent 也在内；Web GUI 打开会话时 composer 模型座 mount 即触发 `models` RPC）；waterfall
  **先注册者赢**（Cordis `shift()` 从队头取 + `installModelSelection` 先 `next()` 后覆写），
  因此飞书在 agent setup 先装后始终赢——Web 端在飞书会话上的模型切换静默无效；冷恢复
  归属为"谁冷恢复谁安装"。证据：`scripts/m7-web-selection-experiment.mjs`（注册序隔离、
  飞书建-Web 触碰、Web 独有对照三场景），详见 [M7 架构方案](m7-model-selection.md) §6.1/§9。
- **M7.3 `/status` 与注册表已由源码/自动化确认（2026-08-18）**：桥按 `sessionId` 保存 `ModelSelectionRef`，只为 `/new` 创建或冷恢复的 Agent 安装；Agent dispose 同时卸载 listener 并删除条目，live `existing` 不抢占 Web 所有权。`/status` 区分未绑定、桥持有、live Web-owned、冷/未激活，分别显示当前实际值与新会话默认的 provider/model/effort；effort 名由 `resolveModelInfo` 解析，失败回显原始 id并标记元数据不可用。证据为 `tests/bridge.spec.ts`、`tests/model-selection.spec.ts`，全量 23 文件/372 测试通过，typecheck 通过。
- **S4 转义统一与 M7.1/M7.2 已由自动化确认（2026-08-18）**：共享 `lark-markdown.ts` 的转义覆盖审批卡、任务卡、会话列表卡、结果卡 header 与全部文本回显路径（`/status` `/effort` `/ls` fallback `/unknown` `/new`），对抗输入回归通过；`/effort` 与 `/model` 三层卡沿用同一四类所有权判定（无绑定/非 boundBy/live Web-owned/冷不隐式恢复），换 model 走 `revalidateEffort` 三分支，全流程点击后下一轮 `agent/request` 实际携带新三元组。证据为 `tests/bridge.spec.ts` S4/M7.1/M7.2 组、`tests/model-card.spec.ts`、`tests/model-selection.spec.ts`。
- **M7 仍待真实部署确认**：真实 provider 的 `listModels` catalog 内容与 `resolveModelInfo` 的 `reasoning` 暴露情况。须实机确认。
- **仍待真实飞书确认**：平台重复事件与 UUID 去重时间窗；启动期消息和进程中止后的实际重投；timeout/断连的迟到 create；真实非零 patch 业务码；组卡 patch 失败后的独立审批卡；Web/飞书 race 的 UI 表现；HMR drain 与重启补投的最终消息数量。缺少这些证据前不声明端到端 exactly-once 或“完全可靠”。
