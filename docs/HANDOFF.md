# 交接文档：M4–M5 收口

**先读**：[design.md](design.md)（架构与决策）、[implementation.md](implementation.md)（里程碑记录）、[README.md](../README.md)（部署、配置与安全边界）。

## 当前状态

- M0–M3 代码面已完成，飞书实机验收仍由用户统一执行。
- M4 体验与可靠性已在当前工作树完成；M5 README、配置参考、审计脱敏和 DSH 版本证据已完成。
- 全量门禁及 diff/敏感信息复核已通过；当前只剩提交、推送与远端 SHA 证明。不要重启用户正在运行的 `dsh web`。

## M4 已交付

### 体验

- `/ls` 编号快照由 `listingTtlMs` 控制，默认 5 分钟；过期编号必须重新 `/ls`。
- 终态结果走绿色结果卡，按完整 create-message envelope 的 24 KiB 软上限分段；建卡失败降级为同段纯文本。
- 本地绝对路径 Markdown 链接在分段前改写为可读代码样式，HTTP(S) 链接保持不变。
- 运行任务卡仅保留一个“思考中……”尾标，终态统一移除；reducer 拒绝旧 sequence，同 callId 原位更新，成功标识为 `✅`。
- 当前只有同步审批按钮，没有耗时导航按钮消费者；“受理/完成两段式 + 命令结果回写原卡”不创建无入口实现。

### 可靠性

- 启动恢复顺序：pending 审批卡失效 → active binding 校验 → 入站/命令 reconciliation → TTL/容量维护 → pending outbox 续发。
- 超恢复 TTL 的入站记录转拒绝并清正文；outbox 发送尝试持久化，超期 pending 转 `abandoned` 并清正文。
- 终态 inbound/outbound 按 TTL 和软容量清理；持久化 `(chat, session)` watermark 防止 sent 行清理后被重复投影。
- gateway 文本与卡片共用 per-chat FIFO、重试预算与熔断；dispose 先停 intake/WS，再有界排空已接收发送。
- bridge dispose 后不再接收入站或 session/approval 事件，并释放 timer、listener 和 storage domain。
- bridge 仅在启动恢复全部完成后提供 `feishuBridgeReady`；`dsh-feishu-bot/invariant` 依赖该 marker，再对启动快照和后续 domain 变更验证 active binding 指向 live/persisted session。
- stop、release、active binding 替换和审批决定均只允许该 chat 的 `boundBy` 本人；审批点击还必须匹配原卡的 chatId/messageId 和原 session。

## M5 已交付

- README 的 Model Experience 明确：插件不注入提示词或工具 schema；普通非命令用户消息逐字进入 session；审批复用 Harness 的 `approval/asked` / `approval/decided` 所有权，重启失效不伪造决定。
- README 和 design 已列 gateway / bridge 全配置项、默认值、固定 24 KiB 限制和启动时 `defaultWorkspace` 授权校验。
- `feishu-audit` 覆盖入站、命令、binding、outbox、审批、熔断和清理；日志只保留枚举、计数与标识哈希，不写消息/命令正文、凭据或完整路径。
- transport error 只记录 error class/code；Feishu SDK logger 会递归移除 `data` 字段正文及 `formatErrors` 追加的重复响应体。
- 本地 DSH 核验基线（2026-08-14）：clean `../deepseek-harness`，版本 `0.1.0-rc.5`，commit `47f943859bef60e4160492346772ded9b24f765a`，Node `v26.5.1`。

## 关键实现文件

- `src/bridge/index.ts`：业务队列、命令、审批、恢复、outbox、审计、HMR。
- `src/bridge/reliability.ts`：TTL、容量、水位、悬空 binding 和恢复排序纯函数。
- `src/bridge/task-card.ts`：任务卡事件折叠。
- `src/gateway/index.ts`：长连接、FIFO、重试/熔断与 drain。
- `src/audit.ts`：稳定标识哈希与安全错误摘要。
- `src/invariant.ts`：binding/session 不变量 companion。
- `tasks/todo.md`：本轮范围、验收项和最终验证记录。

## 飞书实机验收欠账

由用户重启现有 `dsh web` 后执行，自动化通过不能替代：

1. 任务卡从唯一“思考中……”尾标滚动到绿色已完成；`/stop` 定格“已停止”且排队消息下轮继续。
2. 最终结果卡分段、卡片发送失败时的纯文本降级、重启后的 pending outbox 续发。
3. 飞书审批允许/拒绝、Web 先决/飞书先决 race、并行审批组卡、非 boundBy 越权拒绝。
4. 进程重启后 binding 保留、悬空 binding 变 unavailable、旧审批卡失效、新消息无重复。

前置：飞书后台已订阅并发布 `im.message.receive_v1` 与 `card.action.trigger`。若点击没有 `feishu-audit action=card-click-received`，先核对飞书后台事件发布状态。

## 不要踩的边界

- `unavailable` 是审批 waterfall 的“无人回答”，不是决定；飞书卡仍有效时必须继续等待。
- 重启卡失效绝不补写 `approval/decided`；canonical decision 由 Harness 的 ApprovalService 产生。
- 进度卡可丢，终态正文必须走 durable outbox。
- `allowedWorkspaces` 只限制哪些 session 可由飞书列出/绑定/新建，不限制 agent 的读取面；读隔离依赖独立 OS 用户。
- 不重启用户的 `dsh web`，不在日志、文档或提交中写凭据。

## 最终门禁

2026-08-14 已执行并回填 `tasks/todo.md`：typecheck 通过，16 个测试文件 140/140 通过，build 通过且四个导出入口均可导入。提交后仍须执行远端 SHA 复核。

```sh
npm run typecheck
npm test
npm run build
git diff --check
git status --short --branch
git ls-remote origin refs/heads/master
```
