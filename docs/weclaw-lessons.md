# weclaw 实战经验借鉴清单

weclaw（`~/Desktop/mycode/weclaw`，AGPL-3.0）在真实飞书使用中迭代出的交互经验，
按对本项目的适用性分类。**只借交互设计与产品语义，不复制任何代码**（AGPL 边界）。
来源以 `tasks/lessons.md` 日期条目标注。

## 已吸收（M1 落地）

- **绝对路径不是命令**（2026-04-28）：`/Users/...`、`/tmp/...` 以 `/` 开头但含路径
  分隔符，必须按普通文本转发。→ `parseCommand` 首 token 含 `/` 即返回 undefined，
  含回归测试。
- **会话列表带稳定编号**（2026-04-28）：`/use <编号>` 与 `/ls` 同排序，用户不复制
  长 id。→ 已实现（`listings` 快照 + 过期编号守卫）。
- **已订阅的只读事件注册 no-op**（2026-07-08）：订阅了 `im.message.message_read_v1`
  却无 handler 时 SDK 持续报错。→ gateway dispatcher 已注册空处理器。
- **发送权限 ≠ 接收权限**（2026-07-07）：入站必须 `im:message.p2p_msg:readonly` 并
  发布版本。→ M0 已实证（99991672 排障）。
- **消息新鲜度双重判定**（`message_freshness.go`）：`created_before_run`（启动水位前）
  与 `max_age_exceeded`（超龄）分开记录原因、不记正文。→ 我们有 freshnessMs 窗口；
  启动水位维度暂未加（启动恢复扫描承担同一角色，语义见设计 §6.1）。
- **审计不记消息正文**（多条）：日志只落 id、hash、原因。→ 既定纪律。

## M2（任务卡）适用

- **立即建卡 + `思考中.....` 等待态**（2026-08-07）：任务登记即创建进度卡；首条
  **有正文的**进度（commentary/plan/文件/工具摘要）才解除等待态；命令生命周期、
  原始 stdout、patch 行**不进入**进度卡。心跳不得写"仍在执行中"类替代文案。
- **进度是快照不是增量**（2026-07-08）:同一稳定正文组件上替换当前快照，不能用
  追加式接口重复拼接；结构变化（审批/终态）才整卡重建，且不得重置用户展开选择。
- **完成态不重复文案**（2026-07-07）：卡片状态已"已完成"时正文不再写"任务已完成"；
  最终结果独立消息交付，进度卡只收敛状态。
- **进展与终态不同可靠性边界**（2026-07-19）：进展是可覆盖快照（丢了无所谓）；
  终态是不可丢交付（先持久化 outbox 再网络写入，幂等键重试）。→ 我们的
  outbound_segments 表已按此模型建；卡片终态到 M2 落地时沿用。
- **卡片容量预检用展开态正文**；超容量自动续卡。
- **终态三阶段**（2026-07-11）：claim（原子认领）→ publish（发终态）→ finish
  （移除任务），只有 claim 赢家可 publish；避免"任务已消失但回复未写完"。

## M3（审批/卡片交互）适用

- **审批卡只给发起人，回调校验点击者**（2026-07-03）：payload 携带 owner，
  非 owner 点击拒绝且不消耗幂等记录。我们是单用户白名单，但校验仍要做
  （防转发卡片被点）。
- **按钮 payload 透传会话路由键**（2026-07-03）：回调不能退化成裸用户 id 重建路由。
- **卡片"已受理" ≠ "已完成"**（2026-07-13）：回调立即收纳只能表述已受理；真实
  成功/失败由业务结果异步回写**同一张卡**（`im.message.patch`）；重复事件只返回
  toast 不再发卡。耗时操作超回调预算后用原消息 id 异步 patch，patch 失败才降级
  独立消息（2026-07-18）。
- **卡片回调的取消不能传染后台任务**（2026-08-09）：回调 context 结束不得取消
  由它启动的任务。→ 对应我们：卡片回调里发起的 followup/绑定事务不得挂在回调
  生命周期上（cordis 侧即不要把工作挂在会被 dispose 的临时 scope）。
- **审批超时不得默认拒绝**（2026-08-13）：超时只触发权威状态复核（request 还在
  就续期；已被别处处理就收敛）；我们的 α 方案 `Promise.race([feishu, web])` 天然
  满足——飞书不抢答，Web 答了卡片改"已在别处处理"。
- **普通回复不得按文本形态自动变卡**（2026-07-08）：模型回复里的"请选择 1/2/3"
  保持原文，只有显式业务入口（审批、导航、help）才发交互卡。
- **默认自动行为不写成必选操作**（2026-08-01）：卡片先声明默认结果与"无需操作"，
  按钮只作为改变默认的可选项。

## 有意不同（架构差异，不照搬）

- **owner/writer-lease/handoff 体系**：weclaw 跨进程协调多个外部 Host（Codex App/
  CLI/daemon），需要所有权事务。我们是**进程内插件**，agent 生命周期由 harness
  的 AgentRegistry 单一权威管理，resolver 的 ownership 语义已覆盖，无需引入。
- **暂存队列/`/guide`**：dsh `followup()` 原生支持运行中追加输入（inbox steer），
  无需 weclaw 的暂存-确认状态机。
- **union_id 白名单**（2026-07-07）：weclaw 因多机器人需要跨应用身份。我们单应用
  单用户，open_id 正确（已在 M0 论证）；**若未来加第二个机器人，此条升级为必须**。
- **`/restart` `/update` 远程管理**：v1 范围外；若做，整套教训（串行锁、进程组
  脱离、活动任务门禁、新进程确认终态）都适用。
- **会话导航自动切换**（单会话工作区自动 `/use`）：好主意，量少时低价值，
  待 M2 后按实际使用决定。

## 通用纪律（随时对照）

- **显式创建原则**（2026-07-12）：任何错误都不得隐式新建会话；`/new` 是唯一入口。
  → 我们已遵守；恢复失败只提示，不自动重建。
- **中断/取消是独立终态**（2026-07-31）：用户 `/stop` 类操作的结果不得渲染成
  "失败"。→ M2 卡片状态设计时落实三态（完成/失败/已停止）。
- **状态命令区分作用域**（2026-07-18）：当前绑定的真实状态 vs 新会话默认值必须
  分开表述，空字段用占位文案说明默认语义。
- **诊断按 TraceID 串联**（2026-07-19）：入站事件 id 即我们的关联键，已贯穿
  inbound_events/outbound_segments；日志排障时按 eventId 检索全链路。


## 追补（实机验收反馈，2026-08）

- **进度滚动进卡片**：任务卡正文滚动显示最近完成的工具（✓ 前缀，cap 5）+ 当前执行中的工具（▸ 前缀），替代早先只显示当前工具名 —— 对齐 weclaw 的"进度写在一张卡里滚动更新"体验。
- **多审批收纳**：同一 chat 的并行审批合并为一张组卡（头部 N/M 待处理计数），每项自带允许/拒绝按钮，逐项定格结果（✅/❌/已在别处决定/已撤回），全部处理完标题转灰"已处理"；下一个新审批开新卡。杜绝审批消息刷屏。
- **卡片标题用工作区名**：任务卡与审批卡的标题/会话行使用 session cwd 的 basename（如 `dsh-feishu-bot`），不再显示"第 N 轮"——轮次是内部实现细节，对用户无意义。


## 二次深读：飞书信息设计全面盘点（2026-08，weclaw 已授权随便借鉴）

本节来自对 weclaw feishu/ + messaging/ 交互层的系统重读（card.go、task_card.go、progress_render.go、task_progress_timeline.go、result_card.go、approval_panel.go、choice*.go、pending_task_controls.go、feishu_navigation_snapshot.go、deferred_card_result.go、dispatch_order.go）。作者已明确授权借鉴（weclaw 是用户本人项目）。

### A. 决定采纳（M4/M5 排期）

1. **终态答复卡片化 + 30KB 容量预检分片**（result_card.go，M4 已落地）：最终结果用绿头卡而非纯文本，标题 `工作区名 · 最终结果 · i/N`；发送前本地构造完整 create-message envelope 测 JSON 尺寸（软上限 24KB），按行分片、超长行二分切割；卡片失败降级纯文本，durable outbox 不变。
2. **本地路径链接改写**（result_card.go rewriteFeishuLocalMarkdownLinks，M4 已落地）：`[label](/local/path)` 在飞书里是死链接，正则改写成 ``label（`/local/path`）`` 代码样式；网页链接保持不变，路径内反引号替换为 `ˋ`，避免破坏代码片段。
3. **思考中指示器追加/剥离规范**（progress_render.go append/trimActiveThinkingIndicator）：运行中卡片正文尾部统一追加"思考中"指示器，进入终态时统一剥离——幂等操作（HasSuffix 判重）。我们目前是整体替换正文，可借鉴其"终态绝不残留进行时指示"的收口。
4. **进度时间线 reducer 的三条规则**（task_view_reducer.go + task_progress_timeline.go）：①旧 sequence 拒绝（防乱序回写）；②终态后进展拒绝（closed 即冻结）；③同 ID 进度原地更新而非追加（工具重试/plan 更新不刷屏）。我们的 reduceTaskCard 已有 ②，①③ 值得补——尤其未来接入 plan/todo 进度时。
5. **卡片受理≠完成两段式**（choice_status_card.go）：按钮点击先受理（蓝色"已受理：X / 正在处理中"），业务完成后再补终态 patch（绿色"已完成"）。我们审批点击是同步 resolve、可以一步到位；但 M4 计划的会话切换按钮（耗时操作）必须用这个两段式。
6. **命令结果回写原卡**（deferred_card_result.go）：卡片按钮触发的命令，结果 patch 回原卡而非另发消息；原卡不可更新时显式降级为普通消息（绝不吞结果）。M4 导航卡片直接照抄该策略。
7. **列表快照 + 翻页**（feishu_navigation_snapshot.go + feishu_choice_pagination.go）：/ls 结果存 5 分钟 TTL 快照（token 定位），翻页/按编号选择时用快照顺序，不重查目录——消除"列表刷新导致编号漂移选错会话"这一真实事故类。我们 /use <编号> 现在就有这个隐患（两次 /ls 之间会话列表可能变化），M4 必修。
8. **软上限预检而非事后重试**（result_card.go + stream.go feishuCardJSONSoftLimitBytes）：所有卡片 patch 前本地测尺寸，超限先裁剪（preview 模式）再发送，不靠飞书 400 报错兜底。

### B. 已对齐（本轮或更早已实现，记录出处）

- 任务卡状态机 thinking/streaming/done/error/stopped + 颜色模板（card.go statusTemplate）——我们的 STATUS_HEADER 同构，含 stopped=grey。
- 未知状态收敛 normalizeCardStatus——我们的 merge-extensible 默认 failed 分支同旨。
- 审批收纳面板 approval_panel（多审批一张卡逐项按钮）——本轮 renderApprovalGroupCard 已实现。
- 时间线 ✅/❌/○/• 状态标记（taskProgressMarker）——我们的 ✓/▸ 同旨（飞书 lark_md 下 emoji 更醒目，可考虑换成 ✅）。
- 点击后按钮消失/卡片定格（buildChoiceHandledCard）——我们的组卡 settled 项内联定格。
- 卡片创建失败降级普通消息（renderCardCreationFallback）——我们的 next() 让路 + 文本回执同旨。
- SDK 日志脱敏（sdk_logger.go）——我们的 redactingSdkLogger 已做。
- 消息新鲜度窗口（message_freshness.go）——我们的 freshnessMs 已做。
- 同窗口顺序派发（dispatch_order.go）——我们的 per-chat FIFO 队列已做。

### C. 明确不抄（记录理由，防止将来误判为遗漏）

- **CardKit 2.0 streaming_mode + element_id 级流式更新**（cardkit.go）：需要 cardkit 实体卡 API（card.id 体系）而非 message patch；我们 v1 的 1s 节流整卡 patch 体验已可接受，流式字级更新是大依赖小收益，v2 再议。
- **暂存消息控制卡**（pending_task_controls.go：运行中来新消息 → 弹"作为引导发送/撤回/停止"三按钮卡）：依赖 guide（运行中注入指令）能力，dsh agent 的 inbox 语义是排队到下轮，没有 guide 对应物；weclaw 为此建了 token+revision+fingerprint 三重过期校验，复杂度高。保持我们"排队 + /stop"的简单模型。
- **折叠/展开完整进度按钮**（task_progress_control.go + 卡内 expand/collapse 回调）：依赖 CardKit 2.0 局部更新；我们时间线 cap 5 条已控制了卡片长度，暂不需要。
- **/help 分级按钮卡**（feishu_help.go）：我们命令只有 8 个，一屏文本足够；weclaw 是双 agent 多层命令才需要分级导航。
- **审批 8 种状态精细区分**（choice.go approvalStatus* ：expired/archived/auto_approved_yolo/resolved_in_app/turn_terminal/state_unknown...）：weclaw 对接 Codex 外部审批生命周期才需要；我们 5 态（pending/allowed/rejected/elsewhere/withdrawn/invalidated）与 dsh ApprovalOutcome 闭集一一对应，够用且不失真。
- **群镜像去重**（mirror_dedup.go）：v1 无群聊。
