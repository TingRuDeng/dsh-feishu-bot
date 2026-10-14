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

2. **`user-approval` 的 `undefined.session`** 已证实为下游症状而非独立缺陷：测试用 `ctx.agents.get(...)` 拿不到 agent（因为 `/new` 死锁使其从未发布），修复后自然消失，无需单独处理。

3. 真实飞书故障矩阵仍待人工验收，自动化通过不能替代。

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
