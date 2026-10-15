# DSH alpha.2 兼容迁移记录

**基线**：HEAD `2231480`（`fix(bridge): align with DSH alpha.2`），插件真身改动全部未提交。
**状态**：`tsc --noEmit` 0 error、`tsdown` exit 0、`vitest run` **26 files / 426 passed**。
**验证时间**：2026-10-14。

## 一、启动日志与现象

插件完全无法加载，启动日志出现：

```
patch: entry "feishu-bridge" not found
```

## 二、根因：先排除假象

初始约 41 个报错里**大部分是假象**，不是真实破坏：`cordis` 与 `schemastery` 各自解析到**两份不同实例**，使 DSH 的 `declare module` 类型合并整体失效，于是所有 `ctx.*` 服务与事件看起来都"不存在"。

修复：把这两个包收敛到单一实例后重跑，才暴露出下面五类**真实**破坏。

> ⚠️ `pnpm install` 会覆盖软链，需要重新建立。

## 三、五类真实破坏

| # | 破坏 | 处理 |
|---|---|---|
| 1 | `@deepseek-ai/dsh-invariants` 包被删除（v0.2.0-rc.2 移除 `ctx.invariants` registry） | `src/invariant.ts` 自持校验并以 `BindingInvariantError` 从插件启动抛错；`cordis.patch.yml` 删掉 `invariants` 行、`package.json` 删掉依赖 |
| 2 | `Session.events` 属性移除 | 全部改为 `session.snapshotEvents()`（**见第四节技术债**） |
| 3 | persistence API 重构 | `list()` 返回 snapshot（`session.header.id` / `session.header.cwd`）；`inspect()` → `open(id,'read')` + `handle.read()`；`readFrom()` → `open()` + `read(fromSeq)`；`list(signal)` → `list({ signal })` |
| 4 | `AgentSetup` 签名变更 | `setup(agentCtx)` → `setup(agentCtx, agent)`；`agentCtx.agent?.session` → `agent.session` |
| 5 | `kind:'plugin'` 退出 | 测试 `source: { kind:'plugin', plugin:'feishu-bot' }` → `{ kind:'user' }` |

## 四、两项容易漏掉的行为变更

### 4.1 会话落盘归属已从 `SessionStore.flush()` 移到 AgentLoop

这是本轮**最关键的发现**，也是 77 个测试失败的真正原因。

- `session-persistence-jsonl` 的 flush 监听器以 `this.writers.get(session.id)` 为键（`storage.ts:541`）
- `writers` **仅**由 `persistence.open(id, 'write')` 填充（`storage.ts:484`）
- 而它**只**在 `agent-loop/src/index.ts:879` 被调用

因此对 `ctx.sessions.create()` 造出的会话调用 `ctx.sessions.flush()` 是**静默 no-op**：不报错，也不落盘。

实测：

```
sessions.create() + flush()      → list() 返回 0 条   ← 静默失败
persistence.create() + flush()   → list() 返回 1 条
```

**正确做法**：通过 `ctx.agents.create({ sessionId, agentOptions, seed, meta })` 建会话，AgentLoop 会持有写句柄并在发布时物化（`createAgent` 自行 flush unstored suffix）。

### 4.2 `setup` 内**不能**调用 `sessionPersistence.create()`

`src/bridge/index.ts` 的 `/new` 曾在 `setup` 回调里调用 `ctx.sessionPersistence.create(header)`。但此时 AgentLoop **已持有该 id 的写句柄**，`create()` 检测到 id 已被占用即抛 `SessionAlreadyExistsError`，导致 `/new` 在 `setup` 里**永久挂起**：

- 单个 `/new` 卡死 → 该 chat 的 FIFO 队列后续工作全部阻塞
- 表现成 75 个测试超时（`STACK_TRACE_ERROR` / `no card yet` 掩盖了真实错误）

**修复**：删除该调用。AgentLoop 已负责物化，桥接层无需也不应重复注册。

> 排查提示：批量运行时 vitest 只显示 `Test timed out`；**单独跑一个用例**才能看到真实错误。

## 五、验证证据

| 项目 | 状态 |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ exit 0，0 error |
| `npm run build` (`tsdown`) | ✅ exit 0，13 files / 276.55 kB |
| `npm test` (`vitest run`) | ✅ **26 files / 426 passed** |

修复前后对比：

```
修复前：2 files failed / 24 passed； 78 failed / 348 passed
修复后：26 files passed；           426 passed / 426
```

本轮实际改动：
- `src/bridge/index.ts`：删除 `setup` 内导致死锁的 `sessionPersistence.create()`
- `tests/bridge.spec.ts`：6 处冷会话种子改用 `agents.create`；4 处 `session.events` → `snapshotEvents()`；2 处 `list()` 读取旧字段改为 `session.header.*`
- `tests/crash-reconcile.spec.ts`：D/E 两例改用 `agents.create`；1 处 `session.events` → `snapshotEvents()`

## 六、待办与技术债

1. **`snapshotEvents()` 不是终局形态。** DSH 源码对 `snapshotEvents` / `eventAt` / `ownEvents` 全部标注 `@deprecated`，原文 *"new calls are prohibited"*，指向 Agent Note `2026-09-09-deprecate-synchronous-session-event-reads`。当前运行时仍保留完整日志、行为正确，且 DSH 的 lint 白名单只约束自身仓库、不约束外部插件，所以**能跑**；但架构取向是改用 **projection**。这属于设计层重构，不是机械替换。

   该决策记录同时要求：非测试文件的调用必须带 **line-scoped `typescript/no-deprecated` waiver** 标注为"延期迁移"。`src/bridge/index.ts` 的 **7 处**已全部按 DSH 的写法补齐：

   ```ts
   // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
   ```

   7 处对应 5 类关注点，因此**不是同类改写**：

   | 行 | 关注点 | projection 化难度 | 现状 |
   |---|---|---|---|
   | 409 | 倒序扫描 `request/header` 取模型选择 | 中，可注册投影单元 | **已迁移** |
   | 749 | 按 `fromSeq` 增量 catch-up | **高**，需要分页历史读取而非投影 | 冷路径**已迁移**；live 尾部保留 1 处 waiver |
   | 890 | 任务卡 `reduceFeishuTask` 折叠 | 中，可注册投影单元 | **已迁移** |
   | 972 / 1008 | 直接消息锚定与 `turn/start` 查找 | 中 | **已迁移** |
   | 1271 | `pairApprovalId` 配对 `asked` 事件 | 中 | **已迁移** |
   | 3456 | 崩溃对账 `reconcileMessage` | 中 | **已迁移** |

   `feishuTask` 投影单元（`src/bridge/task-projection.ts`）承接了 890 / 972 / 1008
   三处：任务折叠本就是日志派生状态（`taskStartSeq` 由折叠自身算出，tracker 只是
   缓存），因此归投影所有是语义上的正位，而非权宜。waiver 由 7 处降为 **1 处**（仅剩 749 的 live 尾部读取，理由见下）。

   749 的结论与本表其他行不同，单独记录在
   [`design-incremental-catchup-read.md`](design-incremental-catchup-read.md)：它需要的是
   **历史窗口**而非当前状态，投影会把游标落后期间欠投的 settled 结果静默丢掉。数据
   证据还推翻了一个更激进的做法——live 会话改走持久化读取会让**没有 writer 的会话
   静默丢结果**（`flush` 静默 no-op，随后读取抛 `SessionPersistenceNotFoundError`），
   该回归由 `tests/bridge.spec.ts` 的任务折叠用例捕获。因此 live 路径保留内存读取，
   只把冷路径改为有界分页（这也修掉了原实现 `read(fromSeq)` 的**无界**读）。

   新增 `tests/session-read.spec.ts`（8 例）锁定分页边界与"页尾任务必须能折进投递
   结果"，变异测试证实载荷（去掉短页早退 → 1 例失败；跳过首页 → 5 例失败；
   单页读取 → 3 例失败）。桥接层另有一条重启长日志用例，但它**不**隔离分页
   （填充轮次在重启前已被物化投递），已在测试名与注释中如实标注。

   `feishuReconciliation` 投影单元（`src/bridge/reconcile-projection.ts`）承接了
   3456：五行恢复表所需的事实全部来自日志。上游已有 `inbox` 投影持有 pending
   列表，但它**不记录被 canceled splice 丢弃过的 id**——而那正是第 4 行。所以这里
   把三个事实折在同一个单元里，而不是让一个判定跨两个 key，precedence 也因此
   显式可读：consumed > pending > discarded。

   `feishuModelSelection` 投影单元（`src/bridge/model-selection-projection.ts`）
   承接了 409：会话当前选择是日志派生的——最新一条 `request/header` 记录了上次请求
   实际使用的 provider/model/effort。状态用 `seen` 显式区分三种情形，因为**参考
   实现不回退**：
   - 从未记录过 `request/header` → 回退到桥接层内存选择 ref；
   - 最新 header 畸形 → 权威的"无选择"，**不会**回退到更早的有效 header；
   - 有有效选择。
   用裸 `ModelSelection | undefined` 会把前两种情形合并，因此必须有 `seen`。

   `feishuApprovalPairing` 投影单元（`src/bridge/approval-projection.ts`）承接了
   1271：配对输入是日志派生状态。`claimed`（已被其它 pending 条目占用的
   approvalId）**刻意保留为调用方参数**——它是内存注册表状态，不是日志派生的，
   投影不该也不能拥有它。

   `pairApprovalId` 保留在 `approval.ts` 中作为**参考实现（oracle）**，供等价性
   与差分测试使用；生产路径已不再调用它。

   等价性由**结构**保证而非两份实现互相校对：折叠体被抽成
   `foldFeishuTaskStep`，批量 `reduceFeishuTask` 与投影 `apply` 共用同一状态机。
   `tests/task-projection.spec.ts` 仍逐字段比对两者，作为回归护栏。

   三个只有实测才会暴露的坑，均已修并留测试：
   - 折叠对**不相干事件**也推进 `lastSequence`，导致投影状态引用每次都变——
     违反 registry 的 `Object.is` 零工作门（已改为仅消费 `FEISHU_TASK_EVENT_TYPES`）；
   - 首个直接输入**之前**的 `turn/start` 会写 `startedAt` 却报 `applied: false`，
     调用方一旦丢弃就丢失 `durationMs` 基线（已如实回报）；
   - 新任务重启时 `startedAt` 被钉在旧 turn 上（`if (startedAt === null)`），
     与批量折叠锚定在新输入处的取值不同（已记录最近 `turn/start` 以重建基线）。

2. **`user-approval` 的 `undefined.session`** 已证实为下游症状而非独立缺陷：测试用 `ctx.agents.get(...)` 拿不到 agent（因为 `/new` 死锁使其从未发布），修复后自然消失，无需单独处理。

3. **waiver 未能在本机得到正向验证。** 已确认 DSH 的 `no-deprecated` 规则仅在自身 `.oxlintrc.json` 中启用，且测试白名单按**精确源文件路径**（`packages/core/session/src/index.ts`）放行这三个方法。本机用 `oxlint` 直接跑该规则时，即使对本地 `@deprecated` 符号也不报错（type-aware 规则未生效），因此**无法证明 waiver 被消费**。注释按 DSH 原文格式书写，但真实门禁效果待在有 type-aware lint 的环境确认。同理，**已迁移的 6 处无 waiver 是否被门禁认可，也只能在该环境确认**——本地能证明的仅是调用点已消失。

4. 真实飞书故障矩阵仍待人工验收，自动化通过不能替代。投影化后卡片刷新由
   registry 驱动，`tests` 覆盖折叠等价与装配，但**真实飞书的卡片刷新时序只能由你验收**。

5. **崩溃对账的验证强度高于其他几处：它对照的是磁盘上的真实日志。**
   `tests/crash-reconcile.spec.ts` 一直是"真跑一遍 → 崩掉 → 从磁盘重挂 → 断言"，
   本轮把断言升级为**同时**跑批量参考实现与投影单元，要求两者对同一份真实持久化
   日志给出相同判定。变异测试确认这不是空转：故意丢弃 `user/message` 消费记录后，
   A / B / E 三个真实日志用例连同单元用例一起失败。这是自动化能做到的、最接近
   真实崩溃恢复的证据。

6. **差分模糊测试抓到了手写用例漏掉的语义偏差。** 审批配对的参考实现是
   **位置性**语义：它从日志尾部反扫，每个 `asked` 只与扫描中已见的（即日志中更靠
   后的）`decided` 比较。因此一条 decision 只压制它**之前**的同 id ask，对**之后**
   的 ask 无效。手写的 14 个等价用例全部通过，但 2000 组随机日志的差分测试立刻
   报出 402 处不一致，先后纠正了两个错误模型（只删一个重复项 → 误压制后续 ask）。
   第一版实现"看起来完全正确"——这是本轮唯一靠随机化才暴露的问题。

## 七、新会话快速启动

工作目录设为插件真身，避免反复弹授权：

```sh
cd /Users/dengtingru/Desktop/mycode/dsh/dsh-feishu-bot
npm run typecheck
npm test
npm run build
```

关键参考：
- `src/bridge/index.ts` — 业务语义、`/new` 与 `/use` 绑定、任务卡 actor
- `src/invariant.ts` — 自持 binding 校验（已脱离 `ctx.invariants`）
- `src/bridge/resolver.ts` — 冷会话 resume 与 setup 补偿
- `deepseek-harness/packages/session/session-persistence-jsonl/src/storage.ts:484,541` — 写句柄与 flush 订阅的键
- `deepseek-harness/packages/core/agent-loop/src/index.ts:879` — 唯一的 `open(id,'write')` 调用点
