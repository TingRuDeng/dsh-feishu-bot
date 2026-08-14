# dsh-feishu-bot M0 核验记录

配套：[设计](dsh-feishu-bot-design.md) · [实施计划](dsh-feishu-bot-implementation.md)
上游版本：deepseek-harness 0.1.0-rc.5（本地 checkout）。核验方式：本会话直读源码（原计划的并行子代理因平台故障弃用）。
状态：☑ 已有源码结论 ◐ 源码结论 + 待运行时实验确认 ☐ 未完成。

## 结论总表

| # | 事项 | 状态 | 结论摘要 |
|---|---|---|---|
| 1 | userQuestions + 问答可观察性 | ☑ | 单 provider 确认；**ask() 全程无 durable session 事件 ⇒ 首期不做问答通知，裁剪 question-notice** |
| 2 | approval waterfall 组合方式 | ☑ | listener 按注册序 outermost-first；**bundle 层在 web-app 之后 ⇒ bridge 注册晚于 Web ⇒ Web 不 next() 时飞书永远收不到 ⇒ 方案 α 需 prepend 注册，β 形态见详录** |
| 3 | approval id 配对与重启审计 | ◐ | 配对算法同构可行（req.agent.session.events 可达）；错配分析见详录；orphan asked 属 log-only 审计事件，load 不校验配对 ⇒ 不补写成立 |
| 4 | 入站幂等对账 | ☑ | inbox 折叠可行（spliced 事件自足）；**source 自定义 kind 运行时校验仅要求 kind 为非空 string ⇒ 兼容，但维持默认 plugin kind 决策** |
| 5 | bridge 专用 resolver | ☑ | 上游 resolver 从包导出可 import 但结果无 ownership；**`ctx.agents.resume()` 返回 AgentHandle 且对任意插件可用 ⇒ 同构实现可行（方案①成立）** |
| 6 | storage domain | ☑ | defineDomain/domainTable/descriptorOf 均导出；**web-app patch 第 59 行已载 storage-domain** ⇒ 直接注入 |
| 7 | createUserMessage 构造 | ☑ | 调用方持有 id；`{kind:'plugin', plugin:'feishu-bot'}` 类型合法（form 可省略） |
| 8 | tokenMeter | ☑ | **base patch 第 281 行已载 token-meter**；`measure(session)` 可注入直用 |
| 9 | session/event 订阅 | ☑ | 全局 `ctx.on('session/event', (session, event) => …)`（apiproxy 同款）；turn 折叠事件全集已确认 |
| 10 | /ls 数据源 | ☑ | `persistence.list()` 返回 SessionHeader[]（含 cwd）；subagent-owned 判定复用 `hasApiRemoteSubagentOwner`（已导出） |
| 11 | 飞书 SDK 真机 | ◐ | 长连接收 `im.message.receive_v1` + `im.v1.message.create` 发文本双向实测通过（scripts/feishu-smoke.mjs）；**注意用户提供的 `on_` 前缀是 union_id，事件携带的是 `ou_` 前缀 open_id，白名单以事件实测值为准**；权限集对照 weclaw 裁剪：p2p_msg:readonly + send_as_bot + im:chat（+cardkit 预开）。**余留（M3 前置）：发卡/更新卡/card.action.trigger/频控未验证** |
| 12 | bundle 安装链路 | ☑ | `dsh plugin --profile web add <dir>` 追加 bundles 列表；**层序：base → web-app → 追加 bundle → profile 自有 patch**；教程文档完整 |

## 详细记录

### 1. userQuestions 与问答可观察性

- 单 provider：`user-questions/src/index.ts:64-73` `registerProvider` 在已有 provider 时抛 `DUPLICATE_PROVIDER`。
- `ask()`（同文件 :93 起）校验 `CALLER_NOT_LIVE` / `DELEGATED_CALLER` 后直接调 provider promise，**全程无 `session.append`**（文件内 grep 无 append 调用），`SessionEventMap` 无任何 question 事件声明。
- **影响**：待答问题对旁观插件不可观察。裁定：首期不做问答通知；从设计裁剪 §6.5 通知实现、pendingCards 的 `question-notice` 分支与 `QuestionNoticeId` brand。

### 2. approval waterfall 组合方式（方案定档）

- waterfall 实现：`vendor/cordis/src/events.ts:224-243`——`dispatch()` 返回 `this._hooks[name]` 过滤后的数组，listener **按数组序 outermost-first** 组合；`register()`（:254-260）默认 `push`，`options.prepend` 时 `unshift`。**即：注册顺序决定 waterfall 顺序，且 `ctx.on(name, fn, {prepend: true})` 可插队到最前。**
- scope 过滤：`core/scope/src/index.ts:170-185` `scopeTarget` 的 filter 只约束**带 scope tag 的 listener ctx**（`scopeOf(ctx) === undefined ⇒ true`）——bridge 在普通（无 scope tag）ctx 上 `ctx.on('approval/request')` 即可收到**所有** agent 的请求。
- 层序（详见 #12）：追加 bundle 的插件行在 web-app 之后加载 ⇒ bridge 默认注册**晚于** apiproxy ⇒ Web listener 先执行且 claim 后不 `next()` ⇒ **飞书默认永远收不到**。
- **方案 α 修正形态（源码支持，待运行时实验确认）**：bridge 用 **`prepend: true` 注册**成为最外层 listener。收到请求后：有绑定 chat ⇒ 发飞书卡，同时 `const webPromise = next()`（把请求继续交给 Web listener——它照常挂起等 Web 客户端）⇒ `Promise.race([feishuAnswer, webPromise])`——**任一先决即为结果**；飞书先决时 Web 侧 pending 成为孤悬 promise（其 settle 只写 broadcast，late resolve 是 no-op，见 api-proxy.ts:1468-1471 注释），需实验确认 Web UI 卡片能否收到"已在别处决定"的定格信号（若不能，Web 卡片会停留在待决态直到刷新——记录为 α 的已知 UI 瑕疵或降级 β）。无绑定 chat ⇒ 直接 `next()`。
  - 关键：race 中 `next()` 已被调用，waterfall 语义下 bridge 必须**返回**某个 outcome——返回 race 胜者即可；败者 promise 悬置无害（各自 settle 幂等）。
  - **修正设计 §6.4**：α 不再是"协调 listener 复用 Web pending 机制"（apiproxy 的 pendingApprovals/muxQueues 均为闭包私有，不可复用），而是"prepend + next() 并行 race"——不改主仓库即可实现。
- **β 保底**：α 的 race 若有不可解问题（如双 settle 竞态破坏审计），退为 prepend + 无绑定即 next()、有绑定则只由飞书处理（不调 next()，Web 收不到该请求）——按 chat 绑定切换通道而非并行。
- **影响**：§6.4 两档方案表述更新；M0 运行时实验聚焦 race 行为与 Web 侧 late-resolve 表现。

### 3. approval id 配对与重启审计

- 配对输入 `req.agent.session.events` 可达：`ApprovalRequest.agent` 是 `Agent`（runtime-types），`agent.session.events` 是公开投影。
- Web 配对算法（api-proxy.ts:1422-1457）：倒序扫 `approval/asked`，跳过已 decided、已被**本地** pending 占用的 id，callId 对称匹配。
- 错配分析：waterfall 串行 ⇒ 同一请求只有一个 listener 处理。bridge（prepend）与 Web 的 pending 表互不可见，但**每个请求由固定一条链处理**，两表登记的是不同请求的 id；并行 asks 场景下 callId 对称匹配保证各自取到自己 call 的 id（api-proxy.ts:1448-1452 注释："neither shape can steal the other's audit id"）。方案 α 下 bridge 在 next() 前配对、Web 在其 listener 内再配对同一请求——**两者对同一请求各自扫描可能取到同一 id（正确）或不同 id（错配）**：bridge 先登记会让 Web 的 claimed 集合不含 bridge 的占用 ⇒ Web 仍会取同一 id（它只排除自己表内的）⇒ 同 id 双登记，settle 时各自幂等，审计 decided 只由 service 写一次——**无错配放大，但需运行时实验确认**。
- orphan asked：`approval/asked`/`approval/decided` 是 log-only 审计事件（user-approval/src/index.ts:34-58 声明注释），session load 的校验（core/session/src/index.ts:243-249）只查 llm 消息事件的 shape，**不校验 asked/decided 配对** ⇒ 重启遗留 orphan asked 不会阻碍 load/resume；bridge 不补写 decided 的设计成立。

### 4. 入站幂等对账

- `agent/inbox/spliced`（core/agent/src/types.ts:19-34）：payload 含 `target/start/removedCount/inserted/outcome`，**自足可折叠**——从空列表按序重放 splice 即得当前 inbox；`outcome: 'canceled'` 标记取消丢弃，被移除消息 = 重放至前一事件的列表中 `[start, start+removedCount)` 区间（内容可推出，含 MessageId）。
- `user/message` 事件 data 即 `UserMessage`（core/session/src/types.ts:264）含 `id` ⇒ "已 claim"判定 = 倒扫 user/message 匹配 id。
- source 运行时校验（core/session/src/index.ts:320-325）：user/message 的 source 仅要求 `kind` 为非空 string——**自定义 kind 'feishu' 通过 load 校验**；但设计维持"默认 plugin kind"决策（关联已在表内，无须扩大 durable 面）。
- `createUserMessage`（llm/src/message.ts:192）：`createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'feishu-bot' } })`——ContextFormed 的 `form?: never` 分支允许省略 form，类型合法；id 由 `createMessage` 内 `randomUUID()` 生成后返回值携带 ⇒ bridge 先 create 再持久化 id 再 followup 的顺序成立。

### 5. bridge 专用 resolver

- 上游导出面（api/remotes/src/index.ts:17-29）：`createApiRemoteAgentResolver`、`hasApiRemoteSubagentOwner`、`inspectApiRemoteSession`、错误类型**全部导出**，out-of-tree 可 import。
- 但结果类型 `ApiRemoteAgentResult = {agent} | {error}` 无 ownership/handle（agent-lookup.ts:121-199 通读确认：`handle.agent` 在 :167 被拆掉，handle 丢弃）。
- **同构可行**：`ctx.agents.resume(options)`（core/agent/src/index.ts:424）返回 **AgentHandle**（含 dispose），是 AgentRegistry 公开方法，任意注入 `agents` 的插件可调；cold resume 所需的 `inspectApiRemoteSession`（persistence list+inspect 与 cwd 校验）已导出可复用；fence 复用 `hasApiRemoteSubagentOwner`；并发去重按上游 `resumes: Map<SessionId, Promise>` 模式同构——**首发起者创建 promise 时标 `created-here` 并持有 handle，合流者拿 `existing`**，自然满足"仅首发起者可 dispose"。
- **定档：方案①（同构 + ownership 结果）成立**，最小拷贝面 ≈ agentFor 函数骨架（~60 行），复用三个导出工具。§6.6 保持现文本。

### 6. storage domain

- 导出（storage-domain/src/index.ts:19-27）：`defineDomain`/`domainTable`/`descriptorOf`/`DomainError` 及类型。
- **web profile 已加载**：web-app/cordis.patch.yml:51-60 载有 `storage`、`storage-json`（root: dshHomePath('storages')）、`storage-domain` 三行 ⇒ bridge `inject: ['storageDomain']` 即可。
- close 绑定 dispose 惯用法参考 session-projection-cache（open 后 `ctx.effect` 注册 close 回卷）。

### 7. createUserMessage —— 并入 #4。

### 8. tokenMeter

- base patch :281 已载 `token-meter`；服务 `ctx.tokenMeter`（token-meter/src/index.ts:67-70 Context 声明），`measure(session, requestHeader?)` 返回不可变测量（:116）。
- fallback 无须实现：token-meter 在组合中必在。usage 口径：`assistant/message` 事件 data 携带 `usage`（core/session/src/types.ts:267-272，adapter 未报则缺席）——卡片"未知"分支仅覆盖 provider 未上报。

### 9. session/event 订阅

- 全局事件：`ctx.on('session/event', (session: Session, event: SessionEvent) => …)`（apiproxy 同款用法 api-proxy.ts:1350、3475）；回调携带 session（有 id）与事件本体 ⇒ per-session 过滤自便。
- turn 折叠事件全集（core/session/src/types.ts）：`turn/start {turn}`、`turn/end {turn, reason}`、`step/start|end {turn, step}`、`tool/call {turn, step, callId, name, arguments}`、`tool/result {…}`、`assistant/message`（含 usage）。

### 10. /ls 数据源

- `ctx.sessionPersistence.list()`（session-persistence/src/index.ts:228）返回 `SessionHeader[]`——含 `id/createdAt/cwd/parentSession/origin`；cwd 过滤直接可做。
- 最近活动排序：header 无 updatedAt；apiproxy 用 `sessionListUpdatedAt`（api-proxy.ts:530）从投影 metadata 折叠——bridge 首期可降级用 `createdAt` 排序或复用 listWithRevisions 的 revision 变化，M1 实现时定（不阻塞）。
- subagent-owned：`hasApiRemoteSubagentOwner(ctx, {header}, agent?)`（agent-lookup.ts:62-72）——`origin === 'subagent'` 或 live 父子关系；已导出。

### 12. bundle 安装链路

- 安装：`dsh plugin --profile web add <dir-or-package>`（docs/user/develop/basic/publish.md:77-97）——pnpm link + 追加 `dsh.profile.bundles`；包需声明 `dsh.bundle.patch`。
- **层序（publish.md:113-121）**：base → web-app → **追加 bundle（按添加序）** → profile 自有 cordis.patch.yml → home 层 → --patch overlay。⇒ feishu bundle 的插件在 web-app 全部行之后 mount ⇒ approval listener 注册晚于 apiproxy（#2 的 prepend 依据）。
- 验证：`dsh --profile web --dump-config` 显示 `# == dsh-feishu-bot` 层。
- 骨架 package.json 要点：`dsh.bundle.patch: ./cordis.patch.yml`；bare plugin name 须出现在 bundle 包 `dependencies`（resolver manifest 约束）；本地目录 add 走 link 安装。

## 运行时实验（源码核验后执行）

- ◐ 组合链路：骨架包 typecheck/build 通过；`pnpm dsh plugin --profile web add` 成功、`--dump-config` 出现 `# == dsh-feishu-bot` 层与两行插件（M0#12 实机验证过）。**余留：重启 `dsh web` 后确认两插件 mount 日志**（待与用户约定重启时机）
- ☑ approval race 机制实验（方案 α）：骨架仓库 `tests/waterfall-race.spec.ts` 在 npm cordis 4.0.1（与 vendored 同版）上 5/5 断言通过——注册序 = waterfall 序（outermost-first）；`prepend: true` 后注册者插到最外层；claim 不调 next() 即否决后链；**α 核心：prepend + next() 并行 race，飞书先决时挂起的 Web promise 不影响结果、late resolve 无效果；飞书静默时 Web 决议正常胜出**。余留到 M3 实机验证：真 apiproxy listener 的 late-resolve UI 表现、同 id 双登记审计
- ☐ followup 后 claim 前中断的恢复对账实验
- ☑ 飞书 SDK 长连接收发实验（scripts/feishu-smoke.mjs，双向通过；详见结论总表 #11）

## 对设计文档的修订指令（本记录的输出）

1. §6.5 / §5：裁剪问答通知（question-notice 分支、QuestionNoticeId）——#1 结论。
2. §6.4：方案 α 改写为 "prepend 注册 + next() 并行 race"；β 改写为 "prepend + 按绑定切换通道"；删除"协调 listener 复用 Web pending 机制"的表述——#2 结论。
3. §6.6：resolver 定档方案①（同构 + ownership），删除候选②③的待定表述、保留兜底提及——#5 结论。
4. §6.3：token 来源定为 tokenMeter（组合必在），"未知"仅覆盖 usage 缺席——#8 结论。
5. §12 事实状态标注同步。
