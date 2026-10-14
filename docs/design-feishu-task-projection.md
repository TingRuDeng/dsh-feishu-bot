# 设计说明：把飞书任务卡折叠改为 Session projection

**状态**：待评审，尚未改代码。
**目标**：消除 `src/bridge/index.ts` 中 890 / 972 / 1008 三处 `snapshotEvents()`（已是 `@deprecated`，当前靠 waiver 登记为延期迁移）。
**不改动**：749（catch-up 增量读取）、409（模型选择）、1271（审批配对）、3456（崩溃对账）—— 各自另议。

## 一、为什么这三处适合投影

改之前先验证过"能不能投影"，结论是可以，依据是三条事实：

1. **折叠是全状态推导的。** `reduceFeishuTask(events, fromSeq)` 的每个字段都逐事件往下传递（`taskMessageId` / `taskStartSeq` / `turn` / `failureCode` / `retryCount` …），没有任何"必须从头开始"的隐含假设。这满足 `apply(state, event)` 的增量要求，也满足 `init` + 重放的重建要求。

2. **"当前任务"本来就是日志推导状态。** `taskStartSeq` 不是外部输入，它来自折叠结果自身（`index.ts:981`、`1014`），只是被缓存在 `CardTracker` 里。也就是说 tracker 是**缓存**，真正的归属是"由该会话日志推导出的当前任务"——这正是 projection 的定义。

3. **现有调用形态与投影相反。** 现在是**区间扫描**：给锚点 `fromSeq` 扫到末尾，并自行发现任务边界。投影的语义是"该会话的当前状态"，没有窗口参数。所以改动本质是把"每次现算一个窗口"变成"持续维护一个当前值"。

## 二、硬约束（来自 DSH 源码，不是推测）

| 约束 | 来源 | 影响 |
|---|---|---|
| 状态必须可 JSON 序列化 | `checkpoint()` 用 `structuredClone(cell.state)`（`session-projection/src/index.ts:404`） | **`Map`/`Set` 不能进 state** |
| 状态会被持久行播种 | `stateSchema.parse(row.val)`（`:463`、`:522`） | state 必须能通过 zod schema 往返 |
| 无关键必须返回**同一引用** | `ProjectionDefinition.apply` 文档（`:63-71`） | 不相关事件必须 `return state`，否则每事件都触发下游 |
| 语义变化必须递增 `stateVersion` | 同上（`:86-92`） | 改动折叠逻辑时旧 checkpoint 行必须失效 |
| `stateOf` 未注册时返回 `undefined` | `:320-327` | 可做可选注册，但要显式处理缺失 |
| 与单元无关的事件必须零开销 | README「主动驱动逐事件触达每个单元」 | 需按 `event.type` 预过滤 |

## 三、必须解决的第一个问题：`Map`/`Set` 无法进 state

现有折叠内部用了 5 个非序列化容器（`task-card.ts:320-325`）：

```ts
const openTools = new Map<string, string>()        // callId → tool name
const seenCalls = new Set<string>()                // 去重计数
const startedChildren = new Set<string>()          // 子代理启动
const settledChildren = new Set<string>()          // 子代理 settled
const resultCandidates = new Map<number, { seq: number; text: string }>()
```

投影 state 里**不能**保留这些类型，否则 `checkpoint()` 直接抛。两种处理方式：

- **(a) 换成普通对象 / 数组**：`openTools` → `Record<string,string>`，`seenCalls`/`startedChildren`/`settledChildren` → `string[]`。
  - 风险：`seenCalls` 与子代理集合会**无界增长**（长会话里每个 callId 都留存），而它们只用于"是否已见过"和"是否全部 settled"。这会显著放大 checkpoint 体积。
- **(b) 只投影渲染所需的**：state 只保留 `TaskCardSnapshot` + `taskMessageId` + `taskStartSeq` + `settled` + `result`，即**对外可观察的那部分**；去重集合改为"不持久化的推导细节"。
  - 但 `apply` 必须是无副作用的纯函数，不能偷偷在 state 外存东西，所以真正的解法是**重新表述**这些集合，使它们不需要无界历史。

这一项需要设计决策，是我认为**最需要你确认的一点**：
`toolCallCount` 依赖 `seenCalls` 做去重计数，`settled` 依赖 `startedChildren ⊆ settledChildren`。若要保持语义完全等价，就必须保留这两个集合（有界化方案见 §5）；若能接受语义微调，可改成计数器。

## 四、拟议的 state 形状

```ts
/** 与单元无关的事件返回同一引用；字段全部可 JSON 往返。 */
interface FeishuTaskState {
  /** 当前任务；null 表示该会话尚无直接用户任务。 */
  task: {
    taskMessageId: string
    taskStartSeq: number
    scannedThrough: number
    settled: boolean
    snapshot: TaskCardSnapshot
    result?: { seq: number; text: string }
    /** 以下为折叠内部记账，需可序列化（见 §5）。 */
    openTools: Record<string, string>
    seenCalls: string[]
    startedChildren: string[]
    settledChildren: string[]
    resultCandidates: Record<string, { seq: number; text: string }>
  } | null
}
```

注册方式（host-only，不暴露给客户端）：
```ts
ctx.sessionProjections.register({ key: 'feishuTask', stateVersion: 1, stateSchema, init, apply })
```
`init` 返回 `{ task: null }`；`apply` 对 `CARD_EVENT_TYPES` 之外的事件**立即返回同一引用**。

## 五、两个待定设计点

### 5.1 无界增长怎么处理

**已定：(a) 保留集合、语义完全等价。**

`seenCalls` / `startedChildren` / `settledChildren` 在本任务结束后即可整体丢弃——因为新任务会重置折叠（`user/message` 直接消息触发边界滚动）。所以它们**只在一个任务的生命周期内有界**，不是全会话无界。这一点让方案 (a) 可行，代价是任务内的数组仍可能较大（长任务大量工具调用）。

被否的 (b)：`toolCallCount` 改计数器（去掉 `seenCalls`，接受同一 callId 重复计数），子代理用计数（去掉两个集合）。**否掉的理由**：卡片渲染是线上路径，逐字段等价是唯一能挡住语义漂移的护栏；`seenCalls` 随任务重置，省下的状态有限，却要放弃这层护栏。另外 `settled` 判定需要子集关系（`startedChildren ⊆ settledChildren`）而非计数相等，计数方案本身就不等价。

### 5.2 谁来读、何时读

现在 890 处是在卡片 actor 里读取并折叠。改造后：

- 读：`ctx.sessionProjections.stateOf(session, 'feishuTask')`（同步、O(1)、无日志扫描）
- 触发：现有 `ctx.on('session/event', ...)` 已经存在（`index.ts:1004`），可继续作为"何时刷新卡片"的信号，但**不再需要它去读日志**

需要注意：注册表本身也订阅 `session/event` 并驱动每个单元，所以"单元状态已更新"与"桥接层收到事件"是同一 tick 内的两条独立路径。卡片 actor 目前是异步的（有 timer/throttle），读到的是最新状态，这一点与现在读 `snapshotEvents()` 一致。

## 六、兼容性与回退

- **旧 checkpoint 行**：新 key 没有历史行，`restore` 会从 `0` 全量重折，正确。
- **`stateVersion` 语义**：若 §5.1 选择改语义，`stateVersion` 仍从 1 开始即可（该 key 此前不存在）。
- **未注册时**：`stateOf` 返回 `undefined`。桥接层 `inject` 已含 `sessionProjections`（`index.ts:183`），且 238 行已在缺失时抛错，因此不是可选路径，可直接依赖。
- **回退**：本次改动集中在 `src/bridge/task-card.ts`（新增纯函数）与 `src/bridge/index.ts` 的 890/972/1008，保留 `reduceFeishuTask` 不动（它仍是 `init` 重建与测试的基准），可随时回退。

## 七、验证计划

1. **纯函数层**：给 `apply` 写单测，断言
   - 无关事件返回**同一引用**（`toBe`）
   - 逐事件 `apply` 的结果与 `reduceFeishuTask(全量日志, 锚点)` **逐字段相等**（这是等价性的核心断言）
   - state 通过 `structuredClone` 不抛（保证可 checkpoint）
2. **装配层**：现有 `tests/bridge.spec.ts` 的 142 例覆盖任务卡投影、终态、重启恢复；改造后必须全绿。
3. **回归重点**：`restart catches up a terminal assistant message committed while the bridge was offline`、`adopts an already-running Web task`、`/use seeds the projection cursor`——这三例最贴近本次语义。
4. **真机**：卡片实际刷新行为（唯一能验收的人是你）。

## 八、工作量与风险

- 改动量：`task-card.ts` 新增 ~120 行状态化折叠；`index.ts` 改 3 处读取点 + 注册单元。
- 主要风险：**等价性**。`apply` 逐事件结果必须与原区间扫描完全一致，否则会出现"卡片偶尔不更新/状态错位"，而这类症状测试不一定拦得住——所以第 1 项的"逐字段相等"断言是本次的核心防线，必须先写它、先让它失败，再实现。
- 次要风险：state 体积（见 §5.1）。

## 九、需要你确认

1. §5.1 选 **(a) 保留集合、语义完全等价**（state 较大）还是 **(b) 改计数器、语义微调**？
2. 是否接受"先写等价性断言（红）→ 再实现（绿）"的顺序？

两点确认后我再动代码。
