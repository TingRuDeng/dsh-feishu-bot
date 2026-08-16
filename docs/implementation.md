# dsh-feishu-bot 里程碑与验证记录

配套设计文档：[design.md](design.md)

M0–M5 记录最初功能交付；M6 记录 2026-08-15 的发布前可靠性加固。前述里程碑中的旧 outbox、软容量和“卡片失败即文本降级”描述仅是当时基线，当前行为以 M6、[design.md](design.md) 和源码为准。真实飞书故障矩阵与正式远程发布仍未完成。

## M0：扩展点与生命周期核验（强制门）

产出：核验清单逐项打钩的记录文档 + 可启动的包骨架。每项写明"核验方式 / 结论 / 对设计的影响"。

### 核验清单

| # | 事项 | 核验方式 | 阻塞 |
|---|---|---|---|
| 1 | ☑ 已核验：单 provider 确认；ask() 无 durable 事件 ⇒ 问答（含只读通知）首期彻底不做，schema 已裁剪 | 源码（M0 记录 #1） | — |
| 2 | ◐ 源码已核验：注册序决定 waterfall 序、prepend 可插队、apiproxy pending 私有不可复用 ⇒ α 定形为 "prepend + next() 并行 race"（§6.4）。**余留运行时实验**：race 行为、Web late-resolve UI 表现、同 id 双登记审计正确性；不通过降级 β（prepend + 按绑定切换通道） | 源码（M0 记录 #2）+ 组合实验 | M3（定档） |
| 3 | ◐ 源码已核验：配对输入可达、算法同构、orphan asked 属 log-only 不阻碍 load ⇒ 不补写 decided 成立。**余留运行时实验**：并行 approval 无错配实测 | 源码（M0 记录 #3）+ 组合实验 | M3 |
| 4 | ☑ 源码与组合测试已核验：spliced 事件自足可折叠、user/message 携 id；实际消息使用 `{kind:'user', via:'feishu'}`，followup 前后崩溃点均有 inbox/log 对账测试 | 源码（M0 记录 #4）+ 组合/故障注入测试 | — |
| 5 | ☑ 已定档：同构 resolver 可行——`ctx.agents.resume()` 对插件公开返回 AgentHandle，api/remotes 三工具已导出，ownership 结果类型成立（§6.6） | 源码（M0 记录 #5） | — |
| 6 | ☑ 已核验：符号全导出；web-app patch :51-60 已载 storage/storage-json/storage-domain ⇒ 直接注入 | 源码（M0 记录 #6） | — |
| 7 | ☑ 已核验：`createUserMessage({content:[{type:'text',text}], source:{kind:'plugin',plugin:'feishu-bot'}})` 类型合法；id 于返回值携带，先持久化再 followup 成立 | 源码（M0 记录 #4/#7） | — |
| 8 | ☑ 已核验：token-meter 在 base patch :281，组合必在；`measure(session)` 直用；"未知"仅覆盖 usage 缺席 | 源码（M0 记录 #8） | — |
| 9 | ☑ 已核验：`ctx.on('session/event', (session, event)=>…)` 全局可订阅；turn/start|end、step/start|end、tool/call、tool/result、assistant/message 全集确认 | 源码（M0 记录 #9） | — |
| 10 | ☑ 已核验：`persistence.list()` 返回含 cwd 的 SessionHeader[]；subagent-owned 复用已导出的 `hasApiRemoteSubagentOwner`；最近活动排序 M1 实现时在 createdAt/revision 间定 | 源码（M0 记录 #10） | — |
| 11 | ◐ 文本链路已真机验证（长连接收 `im.message.receive_v1` + 发文本，scripts/feishu-smoke.mjs；白名单以事件实测 `ou_` open_id 为准）。**余留（M3 前置）**：发卡/更新卡/`card.action.trigger` 回调/频控行为 | 真机实验 | M3 |
| 12 | ☑ 已核验：安装命令、dsh.bundle.patch 声明、层序（base → web-app → 追加 bundle → profile patch）；实机 add、四行 `--dump-config` 与 boot 冒烟均通过 | 文档（M0 记录 #12）+ 实机 | — |

### 骨架任务

- 建仓库 `~/Desktop/mycode/dsh-feishu-bot`：package.json（`dsh.bundle.patch`）、tsconfig、`cordis.patch.yml` 四行（gateway / bridge / invariants registry / invariant）、`src/gateway`、`src/bridge`、`src/invariant.ts`、vitest 骨架。
- 飞书企业自建应用建号、开权限、拿 App ID/Secret 存入 credentials。
- 白名单拿到本人 open_id。

### 验收

- `--dump-config` 可见四行；web profile 正常启动；gateway 长连接收到消息打审计日志。
- 核验清单 12 项全部有结论；据结论修订设计文档相应小节与本计划工时。

## M1：私聊文本闭环（历史交付，实机验收并入 M6）

原始进度（55/55 测试绿，typecheck/build/纯 Node lib 导入冒烟通过；可靠性语义已由 M6 替代）：
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
- **M1 历史路径**：`assistant/message` → 24KB envelope 分段 → `outboundSegments` → FIFO；M6 已替换为 session-log catch-up + canonical delivery/cursor，并把文本 fallback 收紧为仅确定性卡片拒绝。
- Web/飞书共享同一 live/cold session（含 detached resume）；
- 不做：群聊、合并窗口、审批、问答、任务卡。

测试：

- 单元：命令解析、Markdown 转换与分段（中文/emoji 多字节边界）、状态机各态迁移与对账判定链；
- **幂等与崩溃恢复**（M0#4 结论落地）：重复 event；received 中途崩溃；messageId 已写、followup 前崩溃；followup 后、claim 前崩溃（inbox 投影对账）；已 claim 成 user/message 后崩溃；canceled splice 丢弃路径；**text 隐私规则（转入终态的写入即清除暂存文本）**；启动扫描 received/recovering 记录主动对账，且与新入站事件同队列不并发重复处理；恢复中途再崩溃的重入；
- **命令 reconciliation**（§6.2）：committed 后重投（重发结果不重执行）；`/new` target 已写、绑定已提交 ⇒ 补 committed；`/new` target 已写、绑定未提交 ⇒ 幂等补绑定；`/new` target 未写（窄窗口）⇒ interrupted + 孤儿提示；`/use` 各分支同构；`/release` 已完成判定；
- **M1 历史 outbox 测试**（§6.3）：覆盖确定性段键、多 chat 独立状态、逐段 sent、重启续发、水位与 pending 超期；M6 保留旧 pending 续发兼容，但新结果改走稳定 UUID 的 canonical delivery，不再以该旧窗口描述当前语义。
- **cwd 授权拒绝路径**（§6.7）：相对路径拒绝；`..` 越界拒绝；symlink 指向允许根外拒绝（realpath 后检查）；允许根前缀相似但不同目录（`/a/bc` vs `/a/b`）拒绝；空 `allowedWorkspaces` 全拒；defaultWorkspace 不在允许根内 load 失败；
- **资源补偿**（§6.6，按 M0#5 定档方案）：`/new` 创建成功但绑定写失败 ⇒ `created-here` dispose、无泄漏；`/use` cold resume 成功但绑定写失败 ⇒ 释放本次 handle；`ownership: 'existing'` 时绑定写失败 ⇒ 不 dispose；并发合流仅首发起者标 created-here（无双 dispose）；绑定成功但回帖失败 ⇒ 重复 event 只重发结果；（兜底方案落地时本组降级为孤儿审计断言）；
- **顺序**：同 chat 命令与普通消息交错、`/release` 与在途消息交错、`/stop` 与后续消息交错——全部经 per-chat 队列串行断言；
- Loader 真组合（仅 mock 飞书 transport）：入站文本 → session 出现 user/message → assistant 提交 → 出站投递序列；
- resolver 路径：detached resume、并发 `/use`、Web/飞书同时 resume、resume 失败不写绑定、subagent-owned 拒绝、unavailable 绑定的 `/use` 覆盖与 `/release`。

验收剧本：手机续接浏览器开的会话并对话；杀掉 agent 后 `/use` 触发 cold resume 成功。

## M2：进度与取消

**状态：代码面已完成（commit 33b78ba，84 测试绿），实机验收并入 M6。**已落地：task-card reducer（纯函数折叠，callId 精确配对，三态终态 completed/stopped/failed）、飞书卡渲染（思考中等待态/终态不重复文案，weclaw 规则）、桥内节流投影、`/stop`（cancel user + keepInbox，空闲/未绑定如实回帖）和 gateway sendCard/patchCard；任务卡竞争与终态正文路径后来由 M6 加固。

- 任务卡：M2 最初按 turn 折叠；阶段 6.1 已提升为绑定会话的 Web/飞书直接用户任务级折叠，同一任务的 subagent report/settled continuation 复用原卡，任务级 settled 后定格；
- token 按 M0#8 结论接入；来源缺失显示"未知"（产品契约，§6.3）；
- `/stop` = `cancel({kind:'user'}, {keepInbox: true})`，完成反馈以该 turn 终态事件为准（不用 `whenIdle()`）；
- gateway 出站队列顺序与 dispose quiescence 的测试落地。

验收剧本：跑测试任务，卡片滚动到完成；`/stop` 后排队消息仍在并于下一 turn 消费。

## M3：审批

**状态：代码面已完成（commit 15477a8，96 测试绿），实机验收并入 M6。**方案 α 落地，机制层 5 断言 + 装配级 3 剧本（点击允许全链路、越权点击不消耗、无绑定让路 fail-closed）均绿。实现要点：配对扫描与 apiproxy 同构（approval.ts 纯函数）；durable-first 三段补偿；**race 修正——链条的 fail-closed 'unavailable' 不算决定**。审批可见性与组卡 fallback 后来由 M6 加固。

前置：真实 web profile 组合中验证方案 α（prepend + next() 并行 race，§6.4；机制层 5 断言已过）——重点为 Web listener late-resolve 的 UI 表现与同 approvalId 双登记审计；不通过则定档 β（prepend + 按绑定切换通道）。问答已于 M0#1 整体裁剪，不在本里程碑。

- 审批：按定档方案实现 listener、`approval/asked` 扫描配对（M0#3 结论落地）、内存 pending registry + durable pendingCards 双层（**主键 PendingCardId；先写 record 再发卡，发送成功回填 cardMessageId**）、审批卡（toolName+reason+标题+Web 链接，无参数）、三重校验、signal 撤回定格、失败补偿分档（record 写失败 ⇒ 撤登记 next()；发卡失败 ⇒ 删 record 撤登记 next()；发卡成功后崩溃 ⇒ 重启失效扫描兜底）；
- 方案 α 附加：race 双 promise 的幂等 settle、飞书先决时 Web 卡片表现的验收记录；方案 β 附加：按绑定切换通道的文案与测试；
- 重启扫描 pendingCards：有 cardMessageId 定格失效 + 审计，无 cardMessageId 直接删；不补写 `approval/decided`；
- 测试：审批拒绝路径全覆盖（非白名单点击、过期 pendingId、重复点击、非 boundBy 点击、卡片所在 chat 已解绑）、并行 approval 配对无错配、配对歧义 `next()` 让路、**pendingCards 写失败/发卡失败/发卡后崩溃三条补偿路径**、按定档方案的双通道竞争或优先级切换。

验收剧本：越权写文件 → 手机批准 → 任务继续；（α）Web 先批 → 飞书卡片定格"已在别处决定"，或（β）绑定会话的审批只出现在飞书。

## M4：可靠性与体验（历史交付，可靠性语义已由 M6 加固）

**状态：已完成并追加 `/ls` 两级导航卡。** 已交付 `/ls` 5 分钟工作空间/会话快照、CardKit 2.0 原卡导航、按需真实标题加载、两级稳定分页、单会话直绑、多会话标题选择、归档会话过滤（含点击后和完整 id 绑定拦截），以及 24 KiB 完整 envelope 预检的绿色终态结果卡、本地路径展示改写、运行卡唯一“思考中……”尾标、旧 sequence 拒绝、同 callId 原位更新和 `✅` 成功标识。`/ls` 动作快速返回 toast，耗时 projection、patch 与绑定进入 chat FIFO；终态或导航 patch 失败发送文本回执。

该阶段建立了 per-chat FIFO、恢复扫描、旧 outbox/watermark、HMR 回卷、不变量与 `boundBy` 权限基线。其“旧分段 outbox + watermark、软容量、发送成功但 sent 未落盘可能重发”的模型已由 M6 的 canonical delivery/cursor、稳定 UUID、硬容量和有界写入闸门替代；旧表只保留升级续发兼容。

原验收剧本仍有效，但“无重复消息”应改读为可测量目标而非先验承诺：专用飞书 chat 中记录进程中止前后的消息数量、UUID 去重结果和最终状态，再决定是否满足发布门槛。

## M5：收尾（完成）

- README 已补 Model Experience：不注入提示词/工具 schema；普通非命令用户消息逐字入会话；审批沿用既有 `approval/asked` / `approval/decided` 审计所有权；
- README 与设计文档已按当前 schema 列出 gateway / bridge 配置键、默认值、可靠性参数、数据暴露边界和实机验收边界；
- `feishu-audit` 覆盖入站、命令、binding、outbox、审批与保留清理，原始标识统一稳定哈希，错误只留 class/code，SDK `data` 字段及 `formatErrors` 重复响应体脱敏；
- DSH 基线已记录：本地 clean checkout `0.1.0-rc.5`，commit `47f943859bef60e4160492346772ded9b24f765a`（2026-08-14）；
- 自动化验证与最终提交证据见 [HANDOFF.md](HANDOFF.md)；飞书实机仍由部署者重启现有 `dsh web` 后执行。

## M6：发布前可靠性加固（自动化完成，实机待验）

本阶段以 [tasks/todo.md](../tasks/todo.md) 中的五个 P1、三个 P2 为门槛，参考 WeClaw 的故障模型和关闭顺序独立实现；没有复制 AGPL 代码。

- **启动/ACK**：Gateway 构造与 WS 启动拆分；Bridge 打开两个 domain，完成本地对账/维护并把恢复发送按 chat FIFO 排队后，注册 Promise admission 再启动 intake。排队的网络 I/O 不阻塞 ready，同 chat 新工作仍排在其后。入站以飞书 `message_id` 为主键，`event_id` 仅作别名；SDK 回调等待 durable `received`，业务继续异步进入 per-chat 队列。
- **终态投影/发送**：新增 `feishu_bot_delivery` v1；session log 是权威来源，阶段 6.1 以绑定会话中 `via=feishu|web` 的直接用户 `user/message` 锚定任务，过滤含 `tool-call` 的过程文本并等待直接子代理 settled，只物化一份最新合格终态结果；`/release` 移除 binding 后不再投影。完整 canonical delivery 先落盘再推进到任务末尾 cursor。分段在发送时确定性派生，`deliveryId + stage + segmentIndex` 生成稳定 32-hex UUID。错误区分 permanent/retryable/ambiguous；只有确定性卡片拒绝允许文本 fallback，create/patch 均校验业务码。
- **审批/绑定**：审批使用 `staged | visible | uncertain`；组卡 patch 失败撤销未展示 item 并发送独立卡，只有 card ID 成功回填后才等待。`/use`、`/new` 共用 binding switch，按 `existing | created-here` 所有权、after-image 条件和独立 cleanup timeout 补偿。
- **卡片/关闭**：绑定会话中每条 Web/飞书直接用户消息拥有一个任务卡 actor 与 timer；内部 continuation turn 只更新原卡，任务级 settled 才拒绝迟到 running 更新。Bridge 先停 admission/intake，再有界排空 chat/card/approval/projection/maintenance；超时后关闭存储写入，durable pending 由重启恢复。Gateway 的 create/patch 也纳入关闭 drain。
- **容量/隐私**：inbound、旧 outbox/dead-letter、canonical delivery、approval、cursor 都有 TTL/retention 与硬容量；recoverable/active/pending/protective 事实不为容量压力删除。EventDispatcher 与 smoke logger 静默，Client/WS 递归脱敏，自有审计只留固定字段和 hash。
- **兼容**：旧 `feishu_bot` v1、旧 cursor 和 pending segment 可读/可续发；新 delivery 使用独立 v1 domain，未做不可逆迁移。

2026-08-15 阶段 6.1 rc.4 最终自动化证据：19 个测试文件、229/229；`tsc --noEmit`、普通 build、release build、`git diff --check`、tarball manifest/路径审计、隔离安装、四入口与干净 DSH Profile smoke 均通过。该证据覆盖本地状态机、故障注入、绑定会话的 Web/飞书单任务卡片/结果收口与 `/ls` 两级 CardKit 交互契约，不替代飞书平台的实际 ACK、UUID 去重、迟到完成、业务错误码和 Web/飞书 UI race。

同日用户在重启后的真实飞书客户端确认 `/ls` 两级 CardKit 验收通过，包括工作空间选择、真实标题选择、返回/分页和单会话直绑。该用户验收关闭 `/ls` 交互门禁，不扩展为重复事件、断连、进程中止、审批 fallback 或 HMR 故障矩阵证据。

阶段 6.5 已补齐无本机 `link:` 的唯一正式 tarball、CycloneDX 1.7 SBOM、GitHub build/SBOM attestation、npm provenance 和 GitHub Prerelease/npm `next` 同产物发布链路；构建、attestation、GitHub draft、npm publish 与 Release finalize 分权且 fail closed。workflow 不使用会替换 pending run 的原生 concurrency；受保护 Environment 放行后按 `run_number` 等待全部更早 workflow 完成，并在 npm publish 前要求候选 RC 严格高于当前 `next`，同时拒绝 rerun 绕序。npm provenance 除 SLSA statement 自述外还用 Sigstore 证书约束 repository、signer workflow、source ref/SHA 与 hosted runner；远端 tag 在 draft 前后、npm 前和 finalize 前都会 peel 到 commit 并与 `GITHUB_SHA` 比对。阶段 6.5 结束时的证据仅为本地 preview 与 workflow 合同验证；后续真实运行事实记录在阶段 6.6。

剩余发布竞态：GitHub REST API 不能把 draft asset 的最终 GET 校验与 `draft: false` PATCH 合成一个条件事务；其他 `contents: write` 主体若恰在该窗口改写 asset，后置校验会让 workflow 失败，但异常 Prerelease 可能已经短暂公开或被 Immutable Releases 锁定。每次发布都应限制 finalize 窗口内的写主体，并把任何 post-PATCH mismatch 当作事故，不把该 Release 或 npm RC 视为验收通过。

阶段 6.5 结束时的本地证据：22 个测试文件、339/339；typecheck、release build、唯一 pack、CycloneDX 1.7 SBOM、隔离安装、四入口和干净 DSH Profile smoke 均通过，标准 build、YAML、26 个 workflow shell、actionlint 与 `git diff --check` 也通过。发布聚焦测试为 85/85，修复后独立 targeted review 未发现新的 P1/P2。不可发布 rc.5 为 650,211 bytes，SHA-256 `a718bdb9222f6ac3556d3d7076dd5c0a46aa20ea3d98fa7d1ee32589384a54dc`；`sourceClean: false`、`dshConfigSmoke: true`、`publishable: false`。这是 rc.5 远程尝试前的历史本地证据。

2026-08-16 阶段 6.6 远程事实：Action SHA enforcement、RC tag rules、Immutable Releases 和受保护的 `npm-release` Environment 已启用。rc.5 run `31949610430` 完成 build 与 attestation，并创建包含六个附件的 Draft Release `371332167`；随后因 GitHub 的 tag endpoint 不暴露未发布 Draft 而在 `stage_draft` 失败，npm package 未创建。rc.5 的 run、tag 与 Draft 作为审计事实保留，不重跑、不移动、不删除、不复用。rc.6 将 Draft 定位改为从分页 Release 列表精确、fail-closed 选择唯一 tag。

待完成：rc.6 的双渠道下载、摘要和 provenance 身份验收；首包成功后的 bootstrap 凭据撤销、Trusted Publisher 切换及新 RC 纯 OIDC 验证；以及专用飞书 chat 故障矩阵（重复事件、启动期消息、进程中止、重启补投、create timeout、patch 失败、审批 fallback、HMR drain）。未完成前不声明远程发布完成或端到端 exactly-once。

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
| 平台 UUID 去重窗口/迟到 create 未实测 | 高 | 专用 chat 做 timeout、断连、进程中止与重启计数；模糊失败不跨形态 fallback |
| 方案 α 的 Web/飞书真实 UI race 未验收 | 中 | 真实审批双端先后决定；`unavailable` 不算决定，失败可让路 Web |
| 真实组卡 patch 错误码与独立卡 fallback 未验收 | 中 | 故障注入已绿；实机记录 code、数量与最终可见状态，不保存正文/完整 ID |
| 硬容量背压在部署默认值下缺长时运行证据 | 中 | 运维监控 `retention-backpressure` / `*-backpressure` 固定审计事件，先压测再发布 |
| 飞书卡片频控 | 低 | 任务卡节流、per-target 串行、重试/熔断；终态使用 durable delivery |

## 已定决策（2026-08，M0 前）

1. **开源发布**；许可证 MIT（宽松证建议的默认选择，发布前可改）。红线不变：只参考 AGPL 项目（dsh-lark-bot）架构，不抄其代码。
2. **不做**任务完成主动通知；维持"绑定即关注"语义（真需要再按 M4 后关注列表机制立项）。
3. `allowedWorkspaces = ['~/Desktop/mycode']`，`defaultWorkspace = '~/Desktop/mycode'`（§6.7 授权根与默认 cwd 同一目录）。
