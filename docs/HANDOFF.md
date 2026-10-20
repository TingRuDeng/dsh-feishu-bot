# 交接文档：M6 发布前可靠性加固

**先读**：[deploy-on-release-dsh.md](deploy-on-release-dsh.md)（**切换到正式版 DSH 的部署步骤与实测断点**）、[usage.zh.md](usage.zh.md)（部署与使用）、[design.md](design.md)（架构与决策）、[implementation.md](implementation.md)（里程碑记录）、[README.md](../README.md)（配置参考与安全边界）。

## 当前状态

**先读本文档顶部的部署交接说明**：本机目前是源码联调（`link:` 指向 `../deepseek-harness`），
切换到正式版 DSH 必须先处理依赖解析，步骤与实测断点见 [deploy-on-release-dsh.md](deploy-on-release-dsh.md)。

- **代码基线（2026-10-20）**：分支 `master`，工作树干净，**领先 `origin/master` 49 个提交**（未推送）。
  `npm run typecheck` 0 errors；`npm test` **33 个文件 / 568 通过**；`npm run build` 成功。
- **版本号陷阱**：本地 `package.json` 是 `0.1.0-rc.11`，与 npm `latest` **同号但内容不同**——
  已发布的 rc.11 打在 `2231480`（alpha.2 兼容）上，不含本轮任何卡片合并工作。
  重新发布时必须先提版本号，否则 tag 会与已有版本冲突。
- **卡片合并已完成**：提问与审批都并入任务卡，一个会话同一时刻只有一条消息。细节见下节。
- **部署**：本机 profile 已部署当前构建，`diff -rq lib <profile>/lib` 输出 IDENTICAL。
  构建产物已确认不含 `link:` 依赖。
- M0–M5 功能基线已存在；M6 可靠性阶段 0–4 已完成自动化实现，阶段 5 的文档已按当前源码校准，
  **真实飞书故障矩阵仍待执行**（见本文档末节）。
- 阶段 6 的发布链路已完整建立（Trusted Publishing OIDC、双 attestation、SBOM、
  Draft → npm `latest` → Prerelease）。**当前唯一 `latest` 是 `0.1.0-rc.11`，落后 49 个提交。**

## 既有体验能力

### 体验

- `/ls` 默认返回“工作空间 → 真实会话标题”的 CardKit 2.0 两级卡，两级均每页 7 条且不全局截断；卡片与当前工作空间编号快照由 `listingTtlMs` 控制，默认 5 分钟。归档会话不列出，也不能通过点击或完整 id 绕过。
- 终态结果走 CardKit 2.0 绿色结果卡，固定完成提示与助手正文均使用 `body.elements` 下的原生 `markdown` 组件，并按完整 create-message envelope 的 24 KiB 软上限分段；插件不解析 Markdown 或转换 HTML，渲染能力以飞书语法子集为准而非完整 CommonMark。只有飞书明确拒绝卡片形态时才降级为同段纯文本。
- 本地绝对路径 Markdown 链接在分段前改写为可读代码样式，HTTP(S) 链接保持不变。
- chat 保持绑定期间，每条 Web/飞书直接用户消息只创建一张飞书运行任务卡；同一任务后续的 subagent report/settled continuation turn 只 patch 原卡，任务级 settled 才定格。卡片仅保留一个“思考中……”尾标，终态统一移除；reducer 拒绝旧 sequence，同 callId 原位更新，成功标识为 `✅`。失败卡只显示白名单内的稳定错误码、中文原因和重试次数，不复制 provider 原始错误消息；未知错误码统一显示“未知错误”。
- `/ls` 导航动作快速返回 toast，标题加载、进入/返回/翻页和绑定在 chat FIFO 中更新原卡；单会话工作空间直接绑定，多会话按标题选择，完成后原卡定格成功/失败。文本 `/use` 保留为当前工作空间编号和卡片拒绝时的兼容兜底。

## M6 自动化已交付

- **启动与入站提交点**：Bridge 先完成两个 domain 的本地对账/维护，并把旧 outbox、canonical delivery 和 session-log catch-up 按 chat FIFO 排入后，再注册 Promise admission 并启动 WS。恢复网络 I/O 不阻塞插件激活，但同 chat 新工作排在其后。SDK callback 等待以 `message_id` 为键的 durable `received`；业务处理随后进入 per-chat 队列。
- **终态恢复**：session log 是权威来源；绑定会话中 Web/飞书直接用户入站锚定任务，含 tool-call 的 commentary 和内部 continuation 文本不独立投影，全部子代理 settled 后只物化一个最新终态结果。完整 canonical delivery 先持久化，再把 `(chat, session)` cursor 推进到任务末尾。稳定 32-hex UUID 按 delivery/stage/segment 派生并跨重试/重启复用。
- **错误语义**：create/patch 同时检查 HTTP 与飞书业务码；permanent/retryable/ambiguous 分档。只有确定性卡片拒绝可切文本，timeout/断连/5xx 不跨形态。
- **审批与绑定**：审批只有 card ID durable 回填为 `visible` 后才等待；组卡 patch 失败改发独立卡，模糊 create 留 `uncertain` 恢复事实并让路。binding switch 以所有权、after-image 与独立超时补偿。
- **卡片与关闭**：任务卡 create/patch/terminal 共用 actor/timer；Bridge 先停 admission/intake，再有界 drain 全部已接纳工作并关闭 storage 写入；Gateway 另行 drain create/patch。
- **容量与隐私**：inbound、旧 outbox/dead-letter、canonical delivery、approval、cursor 均为硬容量；受保护事实不被强制淘汰，耗尽时明确背压。EventDispatcher/smoke 静默，Client/WS 递归脱敏。
- **兼容**：旧 `feishu_bot` v1、旧 cursor 与 pending segment 继续可读/续发；新 canonical 数据位于 `feishu_bot_delivery` v1，无不可逆迁移。

## 文档与审计

- README 的 Model Experience 明确：插件不注入提示词或工具 schema；普通非命令用户消息逐字进入 session；审批复用 Harness 的 `approval/asked` / `approval/decided` 所有权，重启失效不伪造决定。
- README 和 design 已列 gateway / bridge 当前配置项、默认值、固定 24 KiB 限制、启动顺序、提交点、恢复/容量语义和 `defaultWorkspace` 授权校验。
- `feishu-audit` 覆盖入站、命令、binding、delivery、approval、熔断、drain 与清理；日志只保留枚举、计数与标识哈希，不写消息/命令正文、凭据或完整路径。
- transport error 只记录 error class/code/status；Client/WS logger 递归移除正文，EventDispatcher 与 smoke logger 完全静默。
- 当前 DSH 兼容与发布基线（2026-08-31）：官方 `master` 版本 `0.1.2-alpha.2`，commit `0a53fb55bea101816fa226bb964ae2bed71c343b`；本地源码联调与正式 workflow 使用同一干净 checkout。

## 关键实现文件

- `src/bridge/index.ts`：durable admission、命令、审批、canonical projection、任务卡 actor、恢复、审计与 HMR drain。
- `src/bridge/domain.ts`：旧 `feishu_bot` v1 与独立 `feishu_bot_delivery` v1 schema。
- `src/bridge/reliability.ts`：TTL、硬容量、cursor/watermark 回收、悬空 binding 和恢复排序纯函数。
- `src/bridge/task-card.ts`：任务卡事件折叠。
- `src/gateway/index.ts`：可控长连接、Promise admission、稳定 UUID、错误分类、FIFO 与 create/patch drain。
- `src/audit.ts`：稳定标识哈希与安全错误摘要。
- `src/invariant.ts`：binding/session 不变量 companion。
- `cordis.patch.yml`：gateway、bridge、invariants registry 与 invariant companion 的 Bundle 组合。
- `scripts/release-preview.mjs` / `scripts/release-sbom.mjs` / `scripts/release-queue.mjs`：单一 preview/formal 门禁、唯一 pack、产物 descriptor、tarball-bound CycloneDX SBOM 与正式 RC run-number 队列。
- `.github/workflows/release-preview.yml` / `.github/workflows/release.yml`：只读 PR 预览与受信 RC tag 的 GitHub Prerelease/npm `latest` 同产物发布链路；后者的任何真实 run 都属于远程发布授权范围。
- `tests/release-workflow.spec.ts`：job 顺序/权限、Action pin、单 tarball、bootstrap/OIDC、双 provenance、release ID 与失败语义的 mutation 合同。
- `docs/usage.zh.md`：飞书后台、凭据、白名单、启动、命令与排障指南。
- `tasks/todo.md`：本轮范围、验收项和最终验证记录。

## 阶段 5：真实飞书故障验收欠账

必须使用专用测试 chat，自动化通过不能替代。只记录测试时间、错误 code/status、hash 标识、消息数量和最终状态；不得粘贴真实正文、凭据、完整 open_id/chat_id/message_id 或本机绝对路径。

1. **重复事件**：让同一 `message_id` 出现平台重投，确认只形成一次副作用和一个最终逻辑结果；记录收到的事件数与最终消息数。
2. **启动期消息**：在 Profile 启动/恢复窗口发送消息，确认 WS 仅在本地恢复编排完成后接流量；恢复发送可继续在队列中运行，callback 不会在 durable `received` 前结束。
3. **进程中止 + 重启补投**：分别在 delivery 物化前、create 调用中和网络成功后中止；重启后确认 canonical pending 收敛，记录 UUID 去重与最终消息数量。
4. **create timeout/断连**：确认模糊失败不切换文本形态，并复用同一 UUID；观察是否有平台迟到完成。
5. **patch 失败**：验证任务卡不会被迟到 running 覆盖；真实非零业务码必须可观察，不能当成功。
6. **审批 fallback**：制造审批组卡 patch 失败，确认本 item 从组卡撤销并出现独立卡；只有 visible 卡才让 agent 等待。
7. **Web/飞书 race**：两端分别先决，确认只产生一个 canonical decision；另一端定格/失效表现如实记录。
8. **HMR drain**：运行任务期间 reload，确认 intake 先停、已接纳工作在期限内完成或留下可恢复 pending，且没有 domain close 后写入。

基础体验同时复核：任务卡只出现一个“思考中……”尾标；`/stop` 在同一卡定格“已停止”且队列保留；`/ls` 显示真实会话名称、可原卡翻页和点击绑定，不显示归档会话，超过 5 分钟或重启后的旧卡失效；binding/旧审批卡的重启状态符合文档。

前置：飞书后台已订阅并发布 `im.message.receive_v1` 与 `card.action.trigger`，测试 chat 不承载真实业务内容。若点击没有 `feishu-audit action=card-click-received`，先核对飞书后台事件发布状态。

## 卡片合并（已完成）

上报问题：授权申请与提问各自发一条顶层卡片，每来一条就把进度卡往上顶，几条之后进度就看不见了。

两张卡都并入任务卡，一个会话同一时刻只有一条消息。核心是**一个 chat 一份卡片状态、一个写入者**：任务 actor 是唯一写卡的人，审批与提问只是把这张卡标记为脏，不再各自持有一个消息 id。

### 提问（第一步）

- 提问按钮本来就只按 `pendingId` 路由、不校验消息 id，搬进任务卡不需要改点击分发。
- 一次请求可以带多个问题，因此按钮必须携带 `questionId`：此前点击只带请求 id，处理时写死 `questions[0]`，答第二个问题会被记到第一个头上。
- 一次点击**不能**结算整个请求。答案按问题累积，只有每个问题都有答案时才 `settleQuestion`；在此之前卡片保持打开并重绘。
- 文字回复的目标要同时看「点选」和「已有文字答案」，只看点选会让无选项的问题反复被覆盖。
- 选中态对所有题型都成立（此前只在 `multiSelect` 下生效，单选题每个按钮都是 primary，重绘后像素完全一致，看起来像没反应）；并且**结算前必须先画一次**，否则单选题永远看不到自己选中的高亮。

### 审批（第二步）

- `group.messageId` 直接取任务卡的消息 id，点击校验因此照常通过——但**只有写成功才算数**。
- 审批点击**确实**校验消息 id（`groupOf.get(pendingId)?.messageId` 必须等于 `action.messageId`）。当一个审批在自己的卡上写失败、退回到独立卡时，必须同时把 `groupOf` 重新指向新的 group，否则回退卡自己的按钮会被判成「该按钮不属于当前审批卡」。这一条有变异测试保护。
- 写失败**不能**留在共享卡上：按钮点不动，人只会看到死按钮。失败项退回独立卡，且共享卡的历史版本里不得出现它。
- `renderCard` 是唯一渲染入口。当任务进度读不到（session 已销毁、或 tracker 属于更早的任务）时**不能直接返回**：进度读不到不代表决策读不到，此时只渲染决策，把按钮清掉。否则 dispose 之后卡片会留着永远不会更新的死按钮——这正是「已失效」曾经出不来的原因。
- 一块卡的重绘必须**当场完成**，不能走节流的 actor：准入要据此判断这一项是否可见，而 actor 的 `finally` 会再启动一轮，await 它并不能保证这次写入已经落地。

### 不再是问题的旧顾虑

- `tracker.frozen` 与审批寿命无关：`decisionKeys` 非空时 frozen 的 tracker 仍可写，`settleItem` 每次都会把决策键重新标脏。
- `settleItem` 把 group 移入 `settledApprovalGroups` 不再矛盾：已结算的 group 仍然参与渲染（`已允许`／`已撤回` 的痕迹要留下），只是不再欠决定。

## 待清理（可选，不影响功能）

- `git stash drop stash@{0}`：该 stash 是第一步审批合并失败尝试的残留，已被后续提交取代。
- `docs/step2-approval-merge-wip.patch`：同一次失败尝试的存档，仅作历史记录。
- 磁盘上 7 个空白 session（用户明确表示暂不清理）。

## 不要踩的边界

- `unavailable` 是审批 waterfall 的“无人回答”，不是决定；飞书卡仍有效时必须继续等待。
- 重启卡失效绝不补写 `approval/decided`；canonical decision 由 Harness 的 ApprovalService 产生。
- 进度卡可丢，终态正文必须走 canonical delivery；旧 outbox 只作升级续发。
- `allowedWorkspaces` 只限制哪些 session 可由飞书列出/绑定/新建，不限制 agent 的读取面；读隔离依赖独立 OS 用户。
- 不重启用户的 `dsh web`，不在日志、文档或提交中写凭据。

## 当前自动化门禁

2026-08-15 `/ls` 阶段检查点证据：`npm test` 为 18 个测试文件、212/212；typecheck、build 均 exit 0，build 生成 16 个 ESM/声明文件，`git diff --check` exit 0。`/ls` 两级导航覆盖工作空间聚合、按需真实标题、同名去歧义、原卡返回/分页、超过 20 条不截断、单会话直绑和 fail-closed 安全回归；详细差异与凭据扫描记录在 `tasks/todo.md`。Web Profile 当时重启到新构建，PID 52357 监听 `127.0.0.1:3080`，宿主 HTTP GET 成功且观察期未见 Loader/invariant 错误；用户随后确认真实飞书 CardKit 2.0 工作空间选择、标题选择、返回/分页和单会话直绑验收通过。重复事件、断连、进程中止、审批 fallback 与 HMR 等完整故障矩阵仍待执行。

```sh
npm run typecheck
npm test
npm run build
git diff --check
git status --short --branch
```

阶段 6 本地预览证据（2026-08-15）：`node scripts/release-preview.mjs --allow-dirty --use-existing-deps` exit 0；19 个测试文件、220/220；release bundle 16 个文件；隔离 npm 安装只新增 tarball 与 Cordis peer 闭包，四个 export 均可导入；一次性 DSH web Profile 成功安装并在 `--dump-config` 中包含 `feishu-gateway`、`feishu-bridge`、`invariants`、`feishu-invariant`。产物 `0.1.0-rc.1` 为 397,732 bytes，SHA-256 为 `78230c5c8db2874bf9c5084e04b4bbd36531822f9d40f44db5e25f21a46739b6`，因 dirty source 明确不可发布。真实 web Profile 随后从源码 `link:` 切换为该 tarball，新 PID 80763 监听 `127.0.0.1:3080`，根页面 HTTP 200，30 秒观察期无启动错误；真实飞书消息与故障矩阵仍待用户逐项验收，远程发布仍需单独确认。

阶段 6.1 初版预览证据（2026-08-15）：release gate 为 19 个测试文件、228/228，产物 `0.1.0-rc.3`。用户随后实测发现 active binding 下 Web 发起的任务未同步飞书；根因是任务起点错误地只接受 `via=feishu`，因此 rc.3 不再作为当前验收版本。

阶段 6.1 回归修复预览证据（2026-08-15）：rc.4 release gate 为 19 个测试文件、229/229，typecheck、release build、manifest/本机路径审计、隔离安装、四入口与干净 DSH Profile smoke 全部通过。新增纯函数与 Bridge 集成双层测试，绑定会话中 Web 任务必须产生一张飞书任务卡和一个结果 delivery；再次过滤 `via=web` 会直接失败。产物 `0.1.0-rc.4` 为 399,883 bytes，SHA-256 `ff6b3ad6ca8d88c970cb2738da8da4eb380a4cc3cae6f520b3e73c2a48edff93`，dirty source 因而 `publishable: false`。真实 web Profile 的 manifest、lockfile spec 与实际 `node_modules/dsh-feishu-bot/package.json` 均为 rc.4，PID 23932 监听 `127.0.0.1:3080`，主机 HTTP 200。安装时供应链检查被同 Profile 的 `dsh-smart-approval@0.1.0-rc.5` minimumReleaseAge 拦截；未放宽策略，包文件已落盘后只校准了 feishu-bot manifest 路径。pnpm `.modules.yaml` 仍保留 rc.3 快照，故 `dsh plugin list` 暂显示 rc.3；待 smart-approval 满足 minimumReleaseAge 后重新执行正常安装即可收敛该元数据，不影响当前 DSH 从实际 rc.4 包目录启动。未创建 tag、未上传 Release、未发布 registry。
