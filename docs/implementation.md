# dsh-feishu-bot 实施计划

配套设计文档：[design.md](design.md)
M0 为强制前置核验门，未清零不进 M1。工时不做精确承诺：M0 完成后按核验结果修订各阶段估计。

## M0：扩展点与生命周期核验（强制门）

产出：核验清单逐项打钩的记录文档 + 可启动的包骨架。每项写明"核验方式 / 结论 / 对设计的影响"。

### 核验清单

| # | 事项 | 核验方式 | 阻塞 |
|---|---|---|---|
| 1 | ☑ 已核验：单 provider 确认；ask() 无 durable 事件 ⇒ 问答（含只读通知）首期彻底不做，schema 已裁剪 | 源码（M0 记录 #1） | — |
| 2 | ◐ 源码已核验：注册序决定 waterfall 序、prepend 可插队、apiproxy pending 私有不可复用 ⇒ α 定形为 "prepend + next() 并行 race"（§6.4）。**余留运行时实验**：race 行为、Web late-resolve UI 表现、同 id 双登记审计正确性；不通过降级 β（prepend + 按绑定切换通道） | 源码（M0 记录 #2）+ 组合实验 | M3（定档） |
| 3 | ◐ 源码已核验：配对输入可达、算法同构、orphan asked 属 log-only 不阻碍 load ⇒ 不补写 decided 成立。**余留运行时实验**：并行 approval 无错配实测 | 源码（M0 记录 #3）+ 组合实验 | M3 |
| 4 | ◐ 源码已核验：spliced 事件自足可折叠、user/message 携 id、source 校验仅要求 kind 非空（维持默认 plugin kind）。**余留运行时实验**：followup 后 claim 前中断的恢复对账实测 | 源码（M0 记录 #4）+ 崩溃恢复实验 | M1 |
| 5 | ☑ 已定档：同构 resolver 可行——`ctx.agents.resume()` 对插件公开返回 AgentHandle，api/remotes 三工具已导出，ownership 结果类型成立（§6.6） | 源码（M0 记录 #5） | — |
| 6 | ☑ 已核验：符号全导出；web-app patch :51-60 已载 storage/storage-json/storage-domain ⇒ 直接注入 | 源码（M0 记录 #6） | — |
| 7 | ☑ 已核验：`createUserMessage({content:[{type:'text',text}], source:{kind:'plugin',plugin:'feishu-bot'}})` 类型合法；id 于返回值携带，先持久化再 followup 成立 | 源码（M0 记录 #4/#7） | — |
| 8 | ☑ 已核验：token-meter 在 base patch :281，组合必在；`measure(session)` 直用；"未知"仅覆盖 usage 缺席 | 源码（M0 记录 #8） | — |
| 9 | ☑ 已核验：`ctx.on('session/event', (session, event)=>…)` 全局可订阅；turn/start|end、step/start|end、tool/call、tool/result、assistant/message 全集确认 | 源码（M0 记录 #9） | — |
| 10 | ☑ 已核验：`persistence.list()` 返回含 cwd 的 SessionHeader[]；subagent-owned 复用已导出的 `hasApiRemoteSubagentOwner`；最近活动排序 M1 实现时在 createdAt/revision 间定 | 源码（M0 记录 #10） | — |
| 11 | ◐ 文本链路已真机验证（长连接收 `im.message.receive_v1` + 发文本，scripts/feishu-smoke.mjs；白名单以事件实测 `ou_` open_id 为准）。**余留（M3 前置）**：发卡/更新卡/`card.action.trigger` 回调/频控行为 | 真机实验 | M3 |
| 12 | ◐ 源码/文档已核验：安装命令、dsh.bundle.patch 声明、层序（base → web-app → 追加 bundle → profile patch）。**余留**：实机 add + dump-config + boot 冒烟 | 文档（M0 记录 #12）+ 实机 | 全部 |

### 骨架任务

- 建仓库 `~/Desktop/mycode/dsh-feishu-bot`：package.json（`dsh.bundle.patch`）、tsconfig、`cordis.patch.yml` 两行、`src/gateway`（空服务注册 `ctx.feishu`）、`src/bridge`（空 apply）、`src/invariant.ts`、vitest 骨架。
- 飞书企业自建应用建号、开权限、拿 App ID/Secret 存入 credentials。
- 白名单拿到本人 open_id。

### 验收

- `--dump-config` 可见两行；web profile 正常启动；gateway 长连接收到消息打审计日志。
- 核验清单 12 项全部有结论；据结论修订设计文档相应小节与本计划工时。

## M1：私聊文本闭环（代码面已完成，待实机验收）

进度（55/55 测试绿，typecheck/build/纯 Node lib 导入冒烟通过）：
- ☑ 四表 domain（名称约束 `[a-z][a-z0-9_]*`：`feishu_bot` / `inbound_events` 等）
- ☑ 崩溃对账门禁实验（layer1 判定表 7 + layer2 真组合 5；含"claim 快于 cancel"组合发现）
- ☑ 同构 resolver（ownership + 并发去重单一 dispose 权，6 组合测试）
- ☑ cwd 授权（fail-closed、realpath、段级包含、symlink 逃逸，9 测试）
- ☑ 命令解析 + 六命令实现；入站状态机（白名单/去重/新鲜度/非文本）；启动恢复扫描（同 per-chat 队列）
- ☑ 出站投影（assistant/message → 确定性分段 → sent 水位）
- ☑ gateway 真 SDK（长连接、每 chat FIFO、指数退避）
- ☐ **实机验收剧本**：重启 `dsh web` 后手机续接 Web 会话对话（用户约定 M1 功能齐后一起重启——现在就绪）

组合层教训（已计入 M0 记录风格）：inject 不得列 `logger`（列了插件永远不 mount）；assistant/message 负载在 `data.message.content`；KvTable 写 API 是 `put`。

范围：

- allowlist（fail-closed）；私聊 binding（storage domain **四表**落地，含绑定"先 resolve 后提交"事务顺序与 unavailable 生命周期）；
- per-chat 业务队列（§3.3：入站事件完整生命周期串行）；
- `/new` `/ls` `/use` `/status` `/release` `/help`（含 §6.2 命令幂等：committed 结果重发、target 回写、中断 reconciliation）；
- **cwd 目录授权（§6.7）**：`allowedWorkspaces` realpath 化祖先检查、空配置 fail-closed、defaultWorkspace 归属校验（load 时 fail loud）；
- 普通文本 → 状态机去重与对账（§6.1）→ resolver → `followup()`；
- `assistant/message` → 分段 → **outbox（`outboundSegments`，确定性四元组主键）** → FIFO 发送与 sent 落盘（§6.3）；
- Web/飞书共享同一 live/cold session（含 detached resume）；
- 不做：群聊、合并窗口、审批、问答、任务卡。

测试：

- 单元：命令解析、Markdown 转换与分段（中文/emoji 多字节边界）、状态机各态迁移与对账判定链；
- **幂等与崩溃恢复**（M0#4 结论落地）：重复 event；received 中途崩溃；messageId 已写、followup 前崩溃；followup 后、claim 前崩溃（inbox 投影对账）；已 claim 成 user/message 后崩溃；canceled splice 丢弃路径；**text 隐私规则（转入终态的写入即清除暂存文本）**；启动扫描 received/recovering 记录主动对账，且与新入站事件同队列不并发重复处理；恢复中途再崩溃的重入；
- **命令 reconciliation**（§6.2）：committed 后重投（重发结果不重执行）；`/new` target 已写、绑定已提交 ⇒ 补 committed；`/new` target 已写、绑定未提交 ⇒ 幂等补绑定；`/new` target 未写（窄窗口）⇒ interrupted + 孤儿提示；`/use` 各分支同构；`/release` 已完成判定；
- **outbox**（§6.3）：确定性主键去重（同一 assistant 事件对同一 chat 重复投影不重复入库）；**多 chat 绑定同一 session 各自独立发送状态（第二个 chat 不被误判已发送）**；逐段 sent 落盘；失败退避与熔断段保持 pending；重启续发排序正确；"发送成功、sent 未落盘"窗口重发一次的已知限制以测试固化文档化；**sent 清理水位与重复投影判定一致（清理后不重新入库重发）**；pending 超期放弃 + 审计；
- **cwd 授权拒绝路径**（§6.7）：相对路径拒绝；`..` 越界拒绝；symlink 指向允许根外拒绝（realpath 后检查）；允许根前缀相似但不同目录（`/a/bc` vs `/a/b`）拒绝；空 `allowedWorkspaces` 全拒；defaultWorkspace 不在允许根内 load 失败；
- **资源补偿**（§6.6，按 M0#5 定档方案）：`/new` 创建成功但绑定写失败 ⇒ `created-here` dispose、无泄漏；`/use` cold resume 成功但绑定写失败 ⇒ 释放本次 handle；`ownership: 'existing'` 时绑定写失败 ⇒ 不 dispose；并发合流仅首发起者标 created-here（无双 dispose）；绑定成功但回帖失败 ⇒ 重复 event 只重发结果；（兜底方案落地时本组降级为孤儿审计断言）；
- **顺序**：同 chat 命令与普通消息交错、`/release` 与在途消息交错、`/stop` 与后续消息交错——全部经 per-chat 队列串行断言；
- Loader 真组合（仅 mock 飞书 transport）：入站文本 → session 出现 user/message → assistant 提交 → 出站投递序列；
- resolver 路径：detached resume、并发 `/use`、Web/飞书同时 resume、resume 失败不写绑定、subagent-owned 拒绝、unavailable 绑定的 `/use` 覆盖与 `/release`。

验收剧本：手机续接浏览器开的会话并对话；杀掉 agent 后 `/use` 触发 cold resume 成功。

## M2：进度与取消

**状态：代码面已完成（commit 33b78ba，84 测试绿），待实机验收。**已落地：task-card reducer（纯函数折叠，callId 精确配对，三态终态 completed/stopped/failed）、飞书卡渲染（思考中等待态/终态不重复文案，weclaw 规则）、桥内节流投影（cardThrottleMs 合并，turn/end 直发定格，patch 失败即弃——进度可丢，正文走 outbox）、/stop（cancel user + keepInbox，空闲/未绑定如实回帖）、gateway sendCard/patchCard。token 字段暂缓：tokenMeter 注入留待实机验证后接入（占位注记）。

- 任务卡：`session/event` 纯函数折叠 turn 状态（状态/当前工具/token/耗时）；节流合并 patch；turn 终态定格；
- token 按 M0#8 结论接入；来源缺失显示"未知"（产品契约，§6.3）；
- `/stop` = `cancel({kind:'user'}, {keepInbox: true})`，完成反馈以该 turn 终态事件为准（不用 `whenIdle()`）；
- gateway 出站队列顺序与 dispose quiescence 的测试落地。

验收剧本：跑测试任务，卡片滚动到完成；`/stop` 后排队消息仍在并于下一 turn 消费。

## M3：审批

**状态：代码面已完成（commit 15477a8，96 测试绿），待实机验收。**方案 α 落地，机制层 5 断言 + 装配级 3 剧本（点击允许全链路、越权点击不消耗、无绑定让路 fail-closed）均绿。实现要点：配对扫描与 apiproxy 同构（approval.ts 纯函数）；durable-first 三段补偿全做；**race 修正——链条的 fail-closed 'unavailable' 不算决定**，空链条时飞书卡保持有效（装配测试暴露，α 语义比设计稿更精确）；重启扫描 freeze+delete、绝不补写 approval/decided。待实机验证项保持：Web UI 先决/后决时卡片表现、同 approvalId 双登记审计。

前置：真实 web profile 组合中验证方案 α（prepend + next() 并行 race，§6.4；机制层 5 断言已过）——重点为 Web listener late-resolve 的 UI 表现与同 approvalId 双登记审计；不通过则定档 β（prepend + 按绑定切换通道）。问答已于 M0#1 整体裁剪，不在本里程碑。

- 审批：按定档方案实现 listener、`approval/asked` 扫描配对（M0#3 结论落地）、内存 pending registry + durable pendingCards 双层（**主键 PendingCardId；先写 record 再发卡，发送成功回填 cardMessageId**）、审批卡（toolName+reason+标题+Web 链接，无参数）、三重校验、signal 撤回定格、失败补偿分档（record 写失败 ⇒ 撤登记 next()；发卡失败 ⇒ 删 record 撤登记 next()；发卡成功后崩溃 ⇒ 重启失效扫描兜底）；
- 方案 α 附加：race 双 promise 的幂等 settle、飞书先决时 Web 卡片表现的验收记录；方案 β 附加：按绑定切换通道的文案与测试；
- 重启扫描 pendingCards：有 cardMessageId 定格失效 + 审计，无 cardMessageId 直接删；不补写 `approval/decided`；
- 测试：审批拒绝路径全覆盖（非白名单点击、过期 pendingId、重复点击、非 boundBy 点击、卡片所在 chat 已解绑）、并行 approval 配对无错配、配对歧义 `next()` 让路、**pendingCards 写失败/发卡失败/发卡后崩溃三条补偿路径**、按定档方案的双通道竞争或优先级切换。

验收剧本：越权写文件 → 手机批准 → 任务继续；（α）Web 先批 → 飞书卡片定格"已在别处决定"，或（β）绑定会话的审批只出现在飞书。

## M4：可靠性

- 断线重连 + 状态机防回灌；发送重试/熔断/顺序保证；
- 启动恢复扫描全链路落地（设计 §9 四步：pendingCards 失效、绑定校验、received/recovering 对账与命令 reconciliation、outbox pending 段续发）；
- inboundEvents / outboundSegments TTL 与容量清理；received 超恢复期限转 rejected('interrupted')，pending 段超期放弃 + 审计；
- HMR 处置测试：dispose 后 WS 关闭、waterfall 监听注销、domain closed、无残留 timer；
- invariant companion：bindings 表中每个 active 绑定的 sessionId 存在于 session 存储。

验收剧本：任务运行中杀进程重启——绑定在、无重复消息；命令副作用不重复（reconciliation 覆盖 target 已落盘的中断；仅 target 回写前窄窗口可能残留孤儿 session，回帖提示核实）；未发文本段续发（"发送成功、sent 未落盘"窗口内的段允许重发一次）；旧审批卡定格失效；新消息正常入队。

## M5：收尾

- README（含 Model Experience 章节：本插件不注入提示词/工具 schema；用户消息逐字入会话；审批决定走既有 approval 审计事件）；
- 审计日志完善；配置文档；已验证 dsh 版本记录。

## 全局测试策略

| 层 | 内容 |
|---|---|
| 单元 | 命令解析、分段收敛、状态机与对账判定链、卡片折叠纯函数 |
| 幂等/崩溃 | §6.1 对账链各崩溃点、命令幂等各支路（M1 清单为准） |
| Loader 真组合 | test-only cordis.yml 全组合 boot，仅 mock 飞书 SDK transport |
| 拒绝路径 | 审批校验各失败支路、并行配对错配、白名单、权限矩阵各"否"格 |
| HMR | fiber dispose 全量回卷断言 |
| invariant | bindings ↔ session 存在性关系 |
| 真机 | 每里程碑一条验收剧本 |

## 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 上游 rc API 漂移 | 高 | 锁版本；升级重跑 Loader 回归；README 记录已验证版本 |
| 方案 α（prepend + race）运行时实验不通过 | 中 | β 保底可用（prepend + 按绑定切换通道），产品文案如实描述 |
| `approval/asked` 扫描配对在并行场景错配 | 中 | M0#3 早决；歧义保守 `next()`；错配路径测试全覆盖 |
| inbox 投影对账实现复杂度（M0#4） | 中 | 对账链判定表驱动实现 + 崩溃点逐一测试；不可行则降级为"重启后 received 态一律人工核实"（同命令中断语义） |
| resolver 复用不可行或缺"本次新建"所有权标记（M0#5） | 中 | 已确认上游接口不含所有权，方案定档为同构实现 + ownership 结果类型；同构不可行落兜底（放弃自动 dispose，孤儿交 Host 生命周期，记已知限制），不阻塞 M1 |
| 飞书卡片频控 | 低 | 节流+熔断；极端降级纯文本里程碑消息 |

## 已定决策（2026-08，M0 前）

1. **开源发布**；许可证 MIT（宽松证建议的默认选择，发布前可改）。红线不变：只参考 AGPL 项目（dsh-lark-bot）架构，不抄其代码。
2. **不做**任务完成主动通知；维持"绑定即关注"语义（真需要再按 M4 后关注列表机制立项）。
3. `allowedWorkspaces = ['~/Desktop/mycode']`，`defaultWorkspace = '~/Desktop/mycode'`（§6.7 授权根与默认 cwd 同一目录）。
