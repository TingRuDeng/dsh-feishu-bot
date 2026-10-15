# 749 设计说明：增量 catch-up 的读取路径

> **结论先行**：初版方案（live 会话也改走持久化分页）**经实测证伪并已推翻**。
> 最终实现只把**冷路径**改为有界分页读取，**live 路径保留内存读取**（改为有界窗口）。
> waiver 由 7 降到 **1**，剩这一处有充分技术理由。以下是证据链。

## 一、这一处到底是什么

`catchUpProjection(chatId, sessionId)`（`index.ts:838`）是**投递**的收敛路径：启动恢复、
以及每次 `turn/end` 触发。它要回答：

> 从这个聊天**上次确认投递到的位置**开始，还有哪些已 settled 的任务结果**没投出去**？

数据流：

```
projectionCursors[chatId#sessionId].sourceEventSeq   ← 持久化游标（"已投递到此"）
        ↓ +1 得到 fromSeq
sessionEventsFrom(sessionId, fromSeq)                ← 本次改动点
        ↓
foldFeishuTaskResults(events, fromSeq)               ← 折出 [fromSeq, ∞) 内的 settled 结果
        ↓
materializeDelivery → deliverCanonical → advanceProjectionCursor
```

## 二、为什么投影模板不适用

前四处的消费方要的是**"当前状态"**，投影在 head 上维护一份即可。749 不同：

1. **要的是历史窗口，不是当前状态。** 游标可能远落后于日志（只有"结果落盘**且**发送
   成功"后才推进）。head 上的投影只保留**最新**任务，会把较早的 settled 结果静默丢掉。
2. **游标是投递语义，不是日志语义。** 投影的 `apply` 由 committed event 驱动，不知道
   "发没发出去"，而 749 的边界恰好由投递确认决定。

DSH note 对这类消费方有明文：

> Historical content presented on demand uses **explicit asynchronous pagination and
> progressive loading**, with each read limited to the requested window.

## 三、被证伪的初版方案（重要）

**初版设想**：live 会话也改走持久化分页读取，从而彻底删掉 `snapshotEvents()`，waiver 清零。

**实测证伪**，共三条证据：

### 3.1 live 事件在 flush 前对持久化**不可见**

探针（live 会话 append 到 `seq`=2，再用**新的 read handle** 读）：

```
LIVE_SEQ=2  PERSISTED_COUNT=0  PERSISTED_LAST=undefined
```

原因在 `session-persistence-jsonl/src/storage.ts:536`：live 事件经 `enqueueLive()`
进入**内存 buffer**，由批量定时器才落盘。

### 3.2 `flush` 屏障可行，但不该走这条路

```
AFTER_FLUSH  LIVE_SEQ=2  PERSISTED_COUNT=2  PERSISTED_LAST=turn/end
```

### 3.3 决定性的一条：**没有 writer 的 live 会话会静默丢结果**

```
BARE seq=1 snapshot=1
FLUSH threw=no
READ_ERR=SessionPersistenceNotFoundError: session "bare-1" not found
```

即：`flush` 对没有持久化 writer 的会话**静默成功**（no-op），随后读取**抛错**。
初版实现会因此把"会话未持久化"变成投递路径上的未处理拒绝，**或**（若读取返回空）
**静默丢弃结果**。这是真正的健壮性回归，由 `tests/bridge.spec.ts` 的

> `collapses one Feishu task with subagent continuation turns into one task card and one final result`

捕获：该夹具直接向**裸 store session** append（生产中不会出现——生产一律
`ctx.agents.create`，见 `index.ts:2835`，会安装 writer），恰好暴露了这条假设。

**结论**：交付路径**不能依赖持久化成功**。live 会话必须读内存。

## 四、最终实现

```ts
if (live !== undefined) {
  // 有界窗口：fromSeq → 当前 head。读的是运行时已持有的状态，不是任意历史回溯。
  return live.snapshotEvents(fromSeq, live.seq)   // waiver 保留（见 §六）
}
return readSessionEventsFrom(open, sessionId, fromSeq)   // 有界分页
```

**冷路径**（`src/bridge/session-read.ts`，新增）：`open(id,'read')` + 循环
`read(offset, 256)`，遇短页/空页终止。**这比原来更好**：原实现 `handle.read(fromSeq)`
是**无界**读——实测在 800 条日志上 `read(100)` 一次返回 700 条。现在按 256 分页。

**live 路径**：保留内存读取，仅把无界的 `snapshotEvents()` + `filter` 改为
**有界窗口** `snapshotEvents(fromSeq, live.seq)`。语义等价（原 filter 等价于尾部切片），
且不再申请任意历史回溯。

## 五、验收

- `tests/session-read.spec.ts`（新增 8 例，全绿）：跨页全量、`fromSeq` 各边界、
  **整页对齐**、空日志、read 抛错时仍 close、短页只读一次、页大小整数倍时正确终止、
  **页尾任务经真实 fold 校验**。
- **变异测试证实载荷**：去掉短页早退 → 1 例失败；跳过首页 → 5 例失败；
  **单页读取 → 3 例失败（含 fold 接缝那一例）**。
- 桥接层 restart 恢复（`restart catches up a terminal assistant message…`、
  `restart resumes a canonical delivery written before its projection cursor advanced`）
  在冷路径改动后**仍全绿**，证明存储分页与既有恢复语义一致。
- 全量：`tsc --noEmit` 0 错误；`tsdown` exit 0（13 files, 296.47 kB）；
  `vitest run` **31 files / 496 passed**。

## 六、诚实说明（局限与未竟）

1. **waiver 保留 1 处，不是 0。** 位置：`index.ts:803` 的 live 窗口读取。
   理由是 §3.3 的实测：换成持久化读取会让没有 writer 的会话丢结果。这是**技术约束**，
   不是偷懒。若 DSH 后续提供非废弃的 live 尾部读取 API，此处可清零。
2. **分页的"载荷性"证据落在 fold 层，而非桥接层。** 我先尝试构造桥接层的
   "长日志必须翻页"用例，两次都未能让它失败在单页变异下：第一次测试实际走的是 live
   分支；第二次（`/use` + `bridgeFiber.dispose` + 真实 turn 填充，日志确为 1052 条）
   仍然通过——原因是**填充轮次在桥接器离线前就被 live 折叠并物化投递了**，重启只是
   重放持久化投递行，并未翻页读日志（我用分支/游标埋点确认了这一点）。

   最终把该性质固定在**投递折叠的接缝**上：`session-read.spec.ts` 新增一例，用真实
   agent 跑出 1042 条日志、末尾放决定性任务，断言**分页读出的窗口折出的 `results`
   与内存快照折出的完全相同**，且包含末尾结果。该用例在"单页"变异下**确实失败**
   （`…(247)` vs `…(1042)`），因此是载荷性的。

   桥接层另保留一条**重启长日志**用例（覆盖端到端，但**不**隔离分页，测试名与注释
   已如实说明这一点）。
3. **749 的真实失败模式**（真实飞书故障矩阵）仍需你人工验收。
