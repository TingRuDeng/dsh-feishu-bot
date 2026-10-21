# 排查记录：飞书结算后 Web 端提示不关闭

> **结论**：这是 DSH 上游的缺口，飞书插件无法干净修复。已按「收窄影响」处理
> （`48b6215`），等待上游修复后再同步调整。

## 一、现象

在飞书里回答提问或处理审批之后，Web GUI 的提示窗口仍然留着，不会自动消失。

连带后果：**后续的审批申请在 Web 端看不见**。用户最初把它报告成两个独立问题。

## 二、真正的原因链

三个机制叠加，缺一不成：

### 1. waterfall 输掉的一方不会被通知

`approval/request` 与 `user-questions/request` 都是 waterfall
（`packages/api/remotes/src/remote-events.ts`）。桥以 `prepend` 参与，先
`next()` 让 Web 端也拿到请求，再 `Promise.race` 自己的通道：

```ts
const web = next()
return Promise.race([feishuAnswer, web])
```

飞书先答完，race 立即返回。但 `web` 那份仍然挂起——没有任何人告诉它"这个
请求已经解决了"。

### 2. Web 的卡片挂在那个 promise 上

`packages/client/ui-approval/src/client/index.ts`：

```ts
try {
  return await pending.result        // 永远等不到
} finally {
  remove()                            // 永远不执行
}
```

`PendingQuestion` 同理。两边的 `PendingXxx.delegate()` 没有跨进程的外部
resolve 入口。

### 3. 每个会话只显示一个待处理交互

`packages/client/ui-session/src/client/index.ts:471-478`：

```ts
const precedence = domain.precedence(interaction)
if (previous === undefined || precedence >= previous.precedence) {
  next.set(interaction.sessionId, { interaction, precedence })
}
```

取值：提问 `1`（plan-review 为 `2`），审批 `0`。**提问永远压过审批。**

所以链条是：提问窗口不关 → precedence 1 占住位置 → 审批（0）排不上 → 用户
看到"Web 端看不到审批"。

## 三、为什么不改 `req.signal`

桥能拿到的唯一通知手段是 `req.signal`，但它由 `exec.signal` 提供——整个工具
调用的生命周期信号（`packages/interaction/tool-ask-user/src/index.ts:108`）。
abort 它等于宣告工具调用被取消，会影响 agent 循环的判定。已实测确认不可用。

## 四、当前处理：只让两侧不一致可见

`48b6215` 在飞书侧的确认提示里写明另一侧需要自行关闭：

- 提问作答 / 跳过 → `已在飞书…；Web 端若仍显示该提问，切换会话或刷新页面即可消失`
- 审批决策 → `已允许（本次）；Web 端若仍显示，切换会话或刷新页面即可消失`

这不消除症状，只是不再让它看起来像没生效。

## 五、上游修复方向

需要给两个 waterfall 增加「已在别处决定」的广播，让各 Client 的 pending 能被
外部 resolve。可行做法之一：Host 侧在结算时广播 `user-questions/settled` /
`approval/settled`，Client 收到后调用对应 `PendingXxx.delegate()`。

改动点在 `deepseek-harness` 仓库，影响所有前端与所有会话，需单独授权。
上游修复后，本插件的 `48b6215` 提示文案应同步去掉。
