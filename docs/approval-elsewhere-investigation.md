# 排查记录：飞书审批"已在别处决定"与卡住

> **结论**：分两个独立问题。
> 1. **文案误导**（已修 `57d3012`）：所有已结算的审批都答"已在别处决定"，
>    即使根本没有人做过决定。
> 2. **审批被撤回的机制**（本次查清）：**取消该回合**会中止工具调用的 signal，
>    桥随即撤回审批。点击已撤回的卡片才会看到那句误导文案。

## 一、现象

用户报告：

> 我没在 web 点授权，一直都是飞书点授权，但飞书经常有授权申请提示
> "已在别的地方授权"，我没点，导致飞书一直卡在这，最后只能去 web 点授权。

关键点：**用户从未在 Web 做决定**，飞书却说"已在别处授权"。

## 二、问题 1：一句把两种情形混为一谈的文案

`src/bridge/index.ts` 的点击分支（两处）：

```ts
if (entry === undefined || entry.settled) {
  return { toast: '该审批已失效或已在别处决定' }
}
```

该分支的真实含义只是「这项审批已不在等待队列」。它把两件不同的事写成一句：

| 真实终态 | 应当说明 | 旧文案 |
|---|---|---|
| `elsewhere`（Web 先决定） | 已在别处决定 | 已在别处决定 ✅ |
| `withdrawn`（工具调用结束） | 已撤回 | 已在别处决定 ❌ |
| `invalidated`（进程重启） | 已失效 | 已在别处决定 ❌ |

于是用户跑去 Web 找一个**根本不存在的决定**。

**修复**：`settledItemToast(pendingId)` 读出该项的真实终态（先查活跃分组，
再查已结算分组），复用卡片自己的 `ITEM_STATE_COPY`，保证 toast 与卡片一致。

## 三、问题 2：审批为什么会被撤回

审批的 signal 来自工具调用：`packages/core/tools/src/index.ts` 把
`exec.signal` 传给 `approval.request`，而该 signal 属于 **Agent 的回合 phase**
（`packages/core/agent-loop/src/agent.ts`：每个 phase 一个 `AbortController`）。

```
工具调用 → approval.request({ signal: exec.signal })
                    ↓
        Agent 的 phase.abort.signal
                    ↓
        agent.cancel() → phase.abort.abort(cause)
                    ↓
        桥的 onAbort → finishApproval(..., 'withdrawn')
```

**谁调用 `cancel()`**：

| 来源 | 位置 | 说明 |
|---|---|---|
| 飞书 `/stop` | bridge `index.ts` `/stop` 分支 | 用户显式要求 |
| Web GUI 停止按钮 | `packages/api/session-controller/src/commands.ts` 的 `cancel()` | `agent.cancel({kind:'user'}, {keepInbox:true})` |
| 会话切换 / 重绑 | 桥的绑定检查 | 旧卡片答"该会话绑定已变更" |

所以：**在该回合还在等审批时取消它**（Web 点停止、或飞书 `/stop`）→
审批被撤回 → 之后再点那张卡会看到问题 1 的误导文案。

## 四、已排除的候选（实测）

| 候选 | 结论 |
|---|---|
| 第二条飞书消息打断审批 | ❌ 实测不打断，signal 仍有效，点击成功 |
| 审批容量上限 | ❌ 默认 `approvalMaxRecords: 1000`，未触及 |
| 工具调用超时 | ❌ 未声明预算的工具没有 deadline |
| 双前端都注册 answerer | ✅ 属实，但只在 **Web 先决定**时产生 `elsewhere`，与本报告不同 |

## 五、验证

| 项 | 结果 |
|---|---|
| 撤回后点击的文案 | ✅ `已撤回`（变异回旧文案则测试红） |
| Web 先决定仍有 `已在别处决定` | ✅ 未误伤 |
| 取消回合 → 工具调用 `cancelled` + 卡片 `已撤回` | ✅ 新测试覆盖 |
| 全量 | **505 通过** / typecheck 干净 / oxlint 0 error |

## 六、观察记录（踩过的坑）

- `settleItem` 把撤回态发布为分组的**最终折叠卡**（标题 `审批 · 已收纳`）。
- `feishu.cards` 存根**保留每一次卡片版本**，所以旧的 `审批请求` 快照仍在
  列表里且**看起来按钮还活着**。判断实时状态要看**最后一张** `审批` 卡。

这两点让同一断言写错了两次，记录以免重复。

## 七、仍未知 / 未修

- **没有修"审批会被撤回"本身**：取消回合就该撤回等待中的审批，这是正确行为；
  本次只修"把撤回说成别处决定"。
- 用户报的"飞书一直卡在这"里，**哪一次是取消导致的**未能确证——需要现场日志。
  飞书桥的审计行（`action=approval-withdrawn` / `approval-click-rejected`）
  目前只走 logger，不落盘，所以事后无法取证。**这是可改进项**。
- 若绑定变更发生在审批等待期间，旧卡片答"该会话绑定已变更，审批按钮已失效"
  （与本次文案问题不同，属另一条路径，行为合理但同样会让人卡住）。

## 八、审批审计已落盘（`29d1925`）

第七节列出的"事后无法取证"已修复：每次审批结算都会写一行到
**`approval_audit`** 表（`feishu_bot_delivery` 域）。

### 字段

| 字段 | 含义 |
|---|---|
| `action` | 终态：`withdrawn` / `invalidated` / `elsewhere` / `allowed` / `rejected` / `click-rejected` |
| `cause` | **为什么**：`signal-abort`（回合被取消）/ `disposed` / `decided-elsewhere` / `decided` / `card-id-write` / `not-pending` |
| `toolName` / `chatId` / `sessionId` / `approvalId` / `createdAt` | 定位信息 |

关键点：**`cause` 能区分"有人真的在别处决定了"和"工具调用自己没了"** —— 这正是
本次排查花了很长时间才靠读源码推断出来的结论。

### 怎么查

存储是纯 JSON，直接读：

```bash
python3 -c "
import json
d = json.load(open('$HOME/.dsh/storages/feishu_bot_delivery.json'))
rows = d['tables'].get('approval_audit', {})
for key, row in sorted(rows.items(), key=lambda kv: kv[1].get('createdAt', 0)):
    print(row['action'], row['cause'], row.get('toolName'), row['createdAt'])
"
```

或直接 grep：

```bash
grep -o '\"cause\":\"[a-z-]*\"' ~/.dsh/storages/feishu_bot_delivery.json | sort | uniq -c
```

### 保留策略

独立于审批本身：默认 **30 天 / 10000 行**（`approvalAuditRetentionMs`、
`approvalAuditMaxRecords`）。先按时间过期，再对**已过期**的行按最旧优先裁剪；
若上限在保留未过期行的前提下无法满足，报告 backpressure 而非删除记录 ——
与既有 planner 一致，不会为了凑数毁掉证据。

### 升级安全性

新表加在**既有的 v1** 域里，**没有**升 version —— 线上
`feishu_bot_delivery` 是 v1 且只有两张表，升 version 会让所有已部署的
存储单元无法打开。新增表直接以空表出现，`tests/domain-compat.spec.ts`
用真实的旧版落盘 fixture 覆盖了这条升级路径。

### 仍未做

- 审计只覆盖**审批**生命周期，其余 ~59 种 `feishu-audit` 动作仍只走 logger。
- 没有查询 UI/CLI：目前靠读 JSON（如上）。

