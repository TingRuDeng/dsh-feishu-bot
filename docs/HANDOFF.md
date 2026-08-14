# 交接文档：M4 进行中

**先读**：[design.md](design.md)（架构与决策）、[implementation.md](implementation.md)（里程碑状态）、[weclaw-lessons.md](weclaw-lessons.md)（交互设计参考清单，尤其"二次深读"一节——M4 的需求来源）。

## 状态快照

- 本轮接手基线：`1363093`（`docs: M4 handoff for successor session`）。
- M0–M3 + 三项 UX 改进（进度滚动、审批组卡、工作区名标题）代码面全部完成。
- M4 第一项 `/ls` 快照 TTL 已按 TDD 实现；回归测试只伪造 `Date`（全量 fake timers 会冻结 `drain()` 的真实 `setTimeout`，别改回去）。

## M4 第一项已完成：/ls 快照 TTL

隐患：`/use <编号>` 从进程内 `listings` 快照解析，但快照永不过期——陈年列表的编号会静默绑定错会话（weclaw 用 5 分钟 TTL 消除了这一事故类，见 lessons "二次深读 A#7"）。

已落地：

1. `src/bridge/index.ts` 里 `const listings = new Map<string, string[]>()` 改为 `Map<string, { ordered: string[]; at: number }>`。
2. `/ls` 写入时记 `at: Date.now()`；`case 'use'` 的数字分支在取编号前检查 `Date.now() - entry.at > config.listingTtlMs` → 走已有的"编号无效或列表已过期"回复分支（文案已存在，无需新增）。
3. 新 Config 字段 `listingTtlMs: z.natural().default(300_000)`（部署可变项必须进 Config，不许硬编码——上游 AGENTS.md 约定）。
4. 回归测试覆盖快照超过 5 分钟后拒绝编号绑定；交付门禁为 `pnpm vitest run` + `pnpm run typecheck` + `pnpm run build`。

## M4 剩余排期（顺序已与用户确认；规格全在 lessons 二次深读 A 节）

2. **终态答复卡片化 + 容量预检分片**（A#1+A#8）：最终结果绿头卡，标题"工作区名 · 最终结果 · i/N"；发送前本地构造完整 create-message envelope 测 JSON 尺寸（24KB 软上限），按行分片、超长行二分切。替换现在 projectAndSend 的纯文本路径时**必须保留 outbound_segments 的持久化投递语义**（卡片发送失败降级纯文本，绝不吞结果）。
3. **本地路径链接改写**（A#2）：`[label](/local/path)` → label（`/path`）代码样式，发卡前统一改写。
4. **"思考中"指示器纪律**（A#3）：运行中正文尾部幂等追加、终态统一剥离。
5. **时间线 reducer 补两规则**（A#4）：旧 sequence 拒绝；同 ID 进度原地更新不追加。
6. **命令结果回写原卡 + 受理/完成两段式**（A#5+A#6）：留给未来的耗时按钮（会话切换导航卡），当前无急迫消费者，可顺延 M5。
7. 微调：时间线 ✓ 可换 ✅（weclaw 用 ✅/❌/○/•，lark_md 下更醒目）。

## 验收欠账（全部实机，最后和用户一起做）

用户重启 `dsh web` 后逐项验：
1. 任务卡：思考中 → ✓ 滚动进度 → 绿色已完成（标题=工作区名，无"第 N 轮"）；
2. `/stop`：卡片定格灰色"已停止"，排队消息下轮继续；
3. **审批点击**（上轮实机失败已修，commit `32908a7`：飞书按钮 value 可能是 JSON 字符串，已兼容 + 不可识别载荷回 toast + gateway 收点击必打 info 日志）：飞书点"允许一次"→ toast → 组卡该项定格 ✅ → 任务继续；
4. 双通道 race：Web 先批 → 飞书卡该项转"已在别处决定"；反向验飞书先批时 Web 的表现（α 方案待验项，表现如何都记录）;
5. 并行审批收纳：两个并行审批合并一张卡（2/2 待处理），逐项决定，全处理完转灰;
6. 越权：他人点按钮 → "你没有权限操作此审批"。

前置：飞书后台已配 `card.action.trigger` 回调订阅（用户已操作过一次，若仍无 `feishu-gateway: card action received` 日志则回查后台发布状态）。

## 关键事实速查（血泪坑，别再踩）

- **审批 race 语义**：委托链的 fail-closed `'unavailable'` **不是决定**——空链条时飞书卡必须保持有效等待（bridge 里 webDecision 的 never-resolve 分支就是干这个的）。
- **配对扫描**与上游 apiproxy 同构（`src/bridge/approval.ts` pairApprovalId）：最新、未决、未被占用、callId 对称；歧义即 `next()` 让路。
- **重启扫描**：pendingCards 逐 messageId 聚组一次 patch（逐条 patch 互相覆盖）；绝不补写 `approval/decided`。
- **进度卡可丢**（无 outbox）；终态文本走 outbound_segments 可靠通道。卡片状态进程内，重启不重建旧卡。
- 组卡 send/patch 按 chat 串行（ApprovalGroup.chain）；全部 settled 后组退休，下个审批开新卡。
- `agent.status !== 'running'` 判空闲（`ctx.agents.get` 空闲时也返回实例）。
- tokenMeter 走 `ctx.get()` 不进 inject（缺服务优雅降级）。
- 上游插件 `inject` 不得含 `'logger'`；storage 表名 `/^[a-z][a-z0-9_]*$/`；KvTable 是 put/update/delete。
- 测试：`pnpm vitest run`；装配测试超时给 `{ timeout: 20_000 }`；MockAdapter 的 `'hang'` 脚本用于挂起 turn。
- git 身份已配 repo 级（JimDeng891 <dengm891@yeah.net>），直接 commit 即可。
- **不要重启用户的 dsh web**；验收重启由用户执行。
- weclaw（~/Desktop/mycode/weclaw）是用户本人项目，已明确授权随便借鉴（含代码）。

## 长期议题（M5+，无急迫）

- α 方案 Web late-resolve UI 表现实录（验收时顺带）。
- 读隔离边界已文档化（README "Data exposure model"）：沙箱只围栏写，读靠 OS 用户隔离，插件不做出站过滤。
- CardKit 2.0 流式、暂存消息控制卡、展开/收起等 6 项明确不抄（理由在 lessons C 节）。
