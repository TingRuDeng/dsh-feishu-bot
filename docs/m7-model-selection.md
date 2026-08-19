# M7 架构方案：模型选择与推理强度

状态：**M7.0、M7.2、M7.3 已实现（2026-08-18），M7.1 仍为方案**。本文同时记录已验证事实与后续设计，
实现进度以 [implementation.md](implementation.md) 的 M7 小节为准。

参考 weclaw 的交互语义（模型/档位切换、状态作用域分离、导航快照），**只借产品语义，
不复制代码**（AGPL 边界，同 [weclaw-lessons.md](weclaw-lessons.md) 纪律）。

---

## 1. 目标与非目标

### 1.1 目标

1. 飞书侧可查看并切换**当前绑定会话**的 provider / model / reasoning effort。
2. `/new` 创建的会话真实继承 Harness 的默认选择，**包含 reasoning effort**。
3. `/status` 分别表述"当前会话实际值"与"新会话默认值"，不混为一谈。

### 1.2 非目标

- 不做**部署级默认值**的飞书侧修改。改 `agentDefaultModel` 的持久默认属于 Web GUI
  职责；飞书只改**本会话**选择。理由见 §6.3。
- 不做 provider 凭据配置、模型能力探测 UI、成本估算。
- 不做跨会话批量切换。
- 不把模型选择写入 `feishu_bot` 持久域——见 §4.3 的生命周期裁定。

---

## 2. 前置事实：当前实现丢弃 reasoningEffort

这是本方案的**起因**，也是 M7.0 必须先于一切功能落地的原因。

`AgentOptions`（`@deepseek-ai/dsh-agent` `runtime-types.ts`）的字段集是：

```
provider?: string
model?: string
maxTokens?: number
```

而 `ctx.agentDefaultModel.currentSelection()` 返回的是 `ModelSelection`：

```
provider: string
model: string
reasoningEffort?: ReasoningEffortId
```

桥当前把后者直接当作前者传给 `ctx.agents.create()`：

```ts
const agentOptions = (): AgentOptions => configuredProvider === undefined
  ? defaultModel.currentSelection()          // 含 reasoningEffort
  : { provider: configuredProvider, model: configuredModel! }
```

TypeScript 结构化子类型允许多余字段通过（对象字面量以外不触发 excess property check），
所以**不报错**；但 `agents.create()` 不消费 `reasoningEffort`，该字段被静默丢弃。

**后果**：用户在 Web GUI 设置的推理强度，对飞书 `/new` 创建的会话不生效。这是既有
缺陷，不是新功能缺口。

**真正的生效机制**是 `installModelSelection(agentCtx, ref)`
（`@deepseek-ai/dsh-agent` `model-selection.ts`），它在 Agent 作用域注册两个 waterfall：

| 事件 | 作用 |
|---|---|
| `system-prompt/assemble` | 快照 `ref.current` 到 `ref.assembled`，并把 provider/model 注入模板变量 |
| `agent/request` | 用 `ref.assembled` 覆写 `LlmCallConfig` 的 provider/model/reasoningEffort；同时**显式剥离继承的 effort**——ref 未选档位时请求回落该 model 的 provider 默认档，而不是沿用上游传入的值 |

**谁调用 `installModelSelection`，谁就拥有该 Agent 的模型选择权。** 所以飞书要做模型
切换，正确路径是持有一个 `ModelSelectionRef` 并调用它，而不是往 `AgentOptions` 塞字段。

---

## 3. 数据来源

全部能力 Harness 已提供，M7 不需要新增上游 API。

| 用途 | API | 返回 |
|---|---|---|
| provider 列表 | `ctx.llm.listConfigurableProviders()` | `LlmConfigurableProvider[]` |
| 模型列表 | `ctx.llm.listModels(provider)` | `LlmModelInfo[]`（id / name / description） |
| 该 route 的可选档位 | `ctx.llm.resolveModelInfo(provider, model, signal?)` | `LlmResolvedModelInfo.reasoning?`（`efforts[]` + `defaultEffort?`） |
| 当前默认选择 | `ctx.agentDefaultModel.currentSelection()` | `ModelSelection` |

新增注入依赖：`llm`。`agentDefaultModel` 已在 `inject` 中。

**catalog 是 advisory 的**（`LlmModelInfo` 文档明示"catalog membership is advisory, not
request validation"）。因此列表为空**不等于**该 route 不可用；卡片必须允许"列表拿不到
时仍显示当前值"，不能把空 catalog 渲染成"无可用模型"。

`reasoning` 是 `LlmResolvedModelInfo` 的**可选**字段：适配器未暴露档位时整个字段缺席。
UI 必须区分三种情形——有 `efforts`、`reasoning` 缺席（该模型不支持档位选择）、
`resolveModelInfo` 抛错（元数据不可达）。三者文案不同，不得合并为"无可用档位"。

`resolveModelInfo` 会对适配器返回值做校验并可能抛 `LlmError`（如 `INVALID_MODEL_INFO`），
且接受 `AbortSignal`。卡片路径应传入 signal，使其纳入 dispose drain。

---

## 4. 架构设计

### 4.1 选择权归属

每个由飞书绑定的会话，桥持有一个 `ModelSelectionRef`：

```
Map<SessionIdString, ModelSelectionRef>
```

安装时机分两类：

- **`/new`**：在 `agents.create()` 的 `setup` 回调内调用 `installModelSelection`，
  与 M6 的 ownership 补偿同一位置（Agent 作用域可用、尚未发布）。disposer 挂 `agentCtx.effect`。
- **`/use` 冷恢复**：resolver 恢复出 Agent 后同样安装。

**已在 Web 侧运行的 Agent（`ownership: 'existing'`）不安装。** 理由见 §6.1。

### 4.2 切换生效时机

`installModelSelection` 的契约是：`current` 的改动在**下一个进入 prompt assembly 的
step** 生效；当前 step 使用 `assembled` 快照。

因此：

- 运行中切换**不会撕裂**当前请求（安全）。
- 运行中切换**不会立刻改变**正在跑的这一轮（需向用户明示）。

**卡片与回帖文案必须写"下一轮生效"**。weclaw 的教训是：用户看不到即时变化就会反复
点击，产生无意义的重复操作和困惑（对应 lessons.md "卡片已受理 ≠ 已完成"同一类问题）。

### 4.3 不持久化选择

模型选择**只存在于进程内**，随 Agent 生命周期消亡。重启后会话回落到
`agentDefaultModel` 当前值。

理由：

1. 与 §6.3 既有立场一致——任务卡状态是"进程内、可丢弃"的，重启不重建旧卡。模型选择
   属同一档：它是交互态，不是交付事实。
2. 持久化会引入新的对账问题：绑定表里的 sessionId 与选择表的一致性、会话在 Web 侧被
   改模型后的冲突、TTL 与容量。这些成本不匹配收益。
3. Web GUI 已经是模型选择的权威 UI。飞书是**远程遥控**，不是第二个配置中心。

**代价**（必须写进帮助与 `/status`）：重启后临时切换丢失。这是明示的设计选择。

---

## 5. 命令与交互

### 5.1 命令集增量

| 命令 | 行为 | 权限 |
|---|---|---|
| `/model` | 打开三层选择卡（provider → model → effort） | allowlist + boundBy |
| `/effort <id>` | 只改档位，不动模型；非法值回显该 route 合法集合 | allowlist + boundBy |
| `/status` | 增加"当前会话"与"新会话默认"两组 provider/model/effort | allowlist（不变） |

### 5.2 权限裁定

`/model` 与 `/effort` 改变模型行为与调用成本，属**破坏性操作**，按 §7.2 矩阵归入
`boundBy` 档，与 `/stop` `/release` 同级。allowlist 内的非绑定者不得切换。

理由：同 chat 内 allowlist 用户共享**输入权**（发消息），但不共享**控制权**（停止、
解绑、审批、改模型）。这是既有矩阵的一致延伸，不是新规则。

### 5.3 三层卡片复用 `/ls` 骨架

`/model` 的导航结构与 `/ls` 同构，**必须复用同一套校验**：

- 随机 token + `listingTtlMs` 过期
- `operatorOpenId` 比对
- `messageId` 与原卡一致
- `presentation`: `staged | visible | uncertain | text` 四态
- patch 失败降级独立卡，create 模糊不重发第二张

**不得**为 `/model` 新写一套卡片状态机。任何绕过上述校验的新卡片入口，都是在审批之外
开第二个未加固面。

### 5.4 effort 的 per-route 合法性

`efforts` 是**每个 provider/model route 独有**的，不是全局常量。例如 deepseek 适配器
只接受 `off` / `high` / `max`，非法值在 `serialize.ts` 抛错。

因此切换 model 时**必须重新校验 effort**：

```
新 route 的 efforts 包含当前 effort  ⇒ 保留
否则该 route 有 defaultEffort        ⇒ 回落到 defaultEffort，告知用户
否则                                  ⇒ 清空 effort（用 provider 默认），告知用户
```

静默丢弃或静默保留非法值都不可接受：前者用户以为设置生效，后者下一轮请求直接失败。

---

## 6. 边界与风险

### 6.1 与 Web GUI 的并发写

同一 Agent 的 `ModelSelectionRef` 若被 Web 和飞书**同时安装两次**，两个
`agent/request` listener 按注册序组成 waterfall：Cordis 的 waterfall 是
outermost-first（`shift()` 从队头取），而 `installModelSelection` 的 listener 是
先 `await next()` 再覆写——因此**先注册者赢**，后安装的 ref 会被静默压过。

**运行时实验（M7.0，2026-08-18）已确认**（脚本
[`scripts/m7-web-selection-experiment.mjs`](../scripts/m7-web-selection-experiment.mjs)，
真实 Cordis/AgentRegistry/AgentLoop 运行时 + api-proxy `selectionFor` 语义逐字回放）：

- Web 端**会**对任何被其触碰的 live Agent 惰性安装 ref（`models`/`selectModel` RPC
  走共享的 agent registry，飞书创建的 Agent 也在内；Web GUI 打开会话时 composer 模型
  座 mount 即触发 `models` RPC）。
- 但飞书在 agent setup（发布前）先装，Web 只能在发布后触碰——**先注册者总是飞书**。
  所以对飞书创建的 Agent，飞书侧的切换持续生效；Web GUI 在该会话上改模型会**静默无效**
  （Web 显示已选，下一轮仍以飞书的值发出）。双安装的后果不是随机胜负，而是偏向
  原始创建者，代价是后安装者的 UI 说谎。

**裁定**（维持不变，理由随实验强化）：飞书只对**自己创建或冷恢复**的 Agent 安装
selection ref（`ownership: 'created-here'`）。对 `ownership: 'existing'` 的 Agent：

- `/model` `/effort` 拒绝，回帖说明"该会话由 Web 端持有模型选择权，请在 Web 端切换"。
- `/status` 仍显示 `agentDefaultModel` 默认值，并标注"当前会话实际值以 Web 端为准"。

这与 §6.6 的 resolver ownership 语义一致：**谁创建谁拥有**，不跨前端抢占。注意
冷恢复的归属延伸：**谁冷恢复谁安装**——飞书 `/use` 冷恢复 Web 创建的会话后，飞书
ref 是先注册者，之后 Web GUI 触碰该会话时其惰性安装会输给飞书（反之 Web 冷恢复后
飞书不安装，Web 独有）。对双方都是"最后恢复方持有选择权"。

另有一处与 §9-2 相关的交互：若未来"恢复默认"把飞书 ref 的 `current` 清为
`undefined`，`installModelSelection` 的 request listener 会原样放行内层结果——此时
已安装的 Web ref（或请求头快照）的值会浮出。设计"恢复默认"入口时必须把它当作
主动移交选择权处理，而不是简单的值清空。

### 6.2 catalog 与实际路由不一致

`listModels()` 是 advisory 的。用户可能选中一个 catalog 里有、但凭据未配置或已下线的
模型，错误在**下一轮请求**才暴露，且表现为 LLM 调用失败而非命令失败。

缓解：切换成功的回帖必须表述为"已选择，下一轮生效"，**不得**表述为"已验证可用"。
真实可用性由下一轮请求证明。

### 6.3 卡片渲染的注入面

`/model` 卡片会渲染 provider / model / effort 的 `name` 与 `description`——这些是
**适配器提供的外部数据**，直接进 `lark_md`。

当前仓库内 `escapeLarkMarkdown` 只存在于 `session-list-card.ts`，审批卡、结果卡、
任务卡均未转义（见 [HANDOFF.md](HANDOFF.md) 安全项 S4）。

**M7.1 的前置条件**：转义函数提到共享模块，四个渲染器统一使用。否则 `/model` 会复制
同一缺陷，把已知问题的暴露面再扩大一处。

### 6.4 与 `agentProvider` / `agentModel` 配置的关系

配置面（§8）已有可选的成对覆盖 `agentProvider` / `agentModel`。当二者被显式配置时，
桥**不读** `agentDefaultModel`。

M7 的裁定：**配置覆盖是部署级下限，不是锁**。用户仍可用 `/model` 在会话内切换；
`/status` 的"新会话默认"显示配置值并标注来源为部署配置。

若部署方需要硬锁定模型，那是独立需求（配置项 `allowModelSwitch: false`），不在 M7 范围。

---

## 7. 分期与验收

顺序按**依赖**与**风险暴露成本**排列，不按功能大小。

### M7.0 修复 effort 静默丢弃（前置，非功能）—— ✅ 已实现（2026-08-18）

不修这个，后续所有 effort 功能都建在坏地基上。

- 在 `/new` 的 setup 回调与 `/use` 冷恢复路径安装 `ModelSelectionRef`。
- 用 `currentSelection()` 的完整三元组初始化。
- 运行时实验确认 §6.1 的 Web 并发写行为（结论见 §6.1 与 §9）。

**验收**：飞书 `/new` 创建的会话，其首次 `agent/request` 的 `LlmCallConfig.reasoningEffort`
等于 `agentDefaultModel` 当前值。有回归测试（`tests/bridge.spec.ts` M7.0 组：`/new` 继承、
`/use` 冷恢复继承、live Web-owned Agent 经 `/use` 绑定不安装三条）。

### M7.3 `/status` 展示（只读）—— ✅ 已实现（2026-08-18）

M7.3 已将桥内模型选择按 `sessionId` 注册为 `Map<SessionId, ModelSelectionRef>`：

- `/new` 与 `/use` 冷恢复在 Agent setup 作用域安装 ref；live `existing` Agent 不安装、不修改。
- Agent scope dispose 时同时卸载 waterfall 并删除 map 条目，避免历史会话泄漏。
- `/status` 保留绑定信息，并分别报告当前会话实际值与新会话默认值，覆盖未绑定、桥持有、live Web-owned existing、冷/未激活四类情形。
- 每组值显示 provider/model/effort；effort 通过 `resolveModelInfo` 解析名称。元数据缺失时显示原始 id，解析失败时显示原始 id 并标注“元数据不可用”。
- 默认值标明来源（Web GUI 设置或部署配置）；冷恢复说明会采用新会话默认。模型选择仍只在进程内生效，重启后回落默认。

回归覆盖：`tests/bridge.spec.ts` 的 M7.3 status 组，以及 `tests/model-selection.spec.ts` 的注册、按 session 隔离和 dispose 清理。全量验证见实现文档。

### M7.2 `/effort <id>` —— ✅ 已实现（2026-08-18）

只改档位，不动 provider/model。实现要点（与 `/status` 同一套四类所有权判定）：

- 无绑定拒绝；非 `boundBy` 拒绝（§5.2 权限矩阵，与 `/stop` `/release` 同级）。
- live Web-owned `existing` 拒绝，提示在 Web 端切换；冷/未激活会话拒绝且**不隐式恢复**，
  提示先发消息恢复会话。
- 以当前选择的 provider/model（`current` 为空时回落新会话默认 route）解析合法档位集合：
  非法 id 回显合法集合；`reasoning` 缺席（该模型无档位选择）拒绝；`resolveModelInfo` 抛错时
  **不修改** ref 并明示元数据不可用。
- 合法切换写入 `ref.current.reasoningEffort`，回帖必含"下一轮生效"（§4.2）并附带重启丢失提示。

**验收**：合法值生效并提示"下一轮生效"（回归断言下一轮 `agent/request` 实际携带新档位）；
非法值回显该 route 合法集合且选择不变；无绑定/非 boundBy/`existing`/冷会话四条拒绝路径；
元数据不可用与无档位路由不修改选择。测试见 `tests/bridge.spec.ts` M7.2 组与
`tests/commands.spec.ts` 的 `/effort` 解析。

### M7.1 `/model` 三层卡片

最大的一项，放最后。前置：S4 转义统一（§6.3）。

**验收**：三层导航、返回、分页、token/TTL/operator/messageId 校验、patch 失败降级、
换 model 后 effort 重校验（§5.4 三分支全覆盖）。

---

## 8. 测试策略

沿用既有分层（见 implementation.md"全局测试策略"）：

| 层 | 覆盖 |
|---|---|
| 纯函数 | effort 重校验三分支；`/status` 文案组装；卡片渲染快照 |
| 装配 | selection ref 安装/卸载；切换后 `agent/request` 配置正确；`existing` 拒绝路径 |
| 故障注入 | `listModels` 抛错/返回空；切换时会话被 `/release`；切换与 dispose 竞态 |
| 对抗输入 | provider/model/effort 的 name/description 含 `[]()`、反引号、`<>`、换行 |

**不可用 mock 证明的**：真实 provider 的 catalog 内容、真实 effort 在 DeepSeek 侧的行为
差异。这些与 §12 既有的"仍待真实飞书确认"同级，需实机验收。

---

## 9. 未决问题

1. **~~Web 是否对所有 Agent 安装 selection ref~~**（§6.1）——**已确认（M7.0 运行时
   实验，2026-08-18）**：会，对任何被触碰的 live Agent 惰性安装（含飞书创建的）；
   但因 waterfall 先注册者赢、飞书在 setup 先装，冲突时飞书胜出，Web 端在该会话上
   的切换静默无效。证据：`scripts/m7-web-selection-experiment.mjs` 三个场景（注册序
   隔离、飞书建-Web 触碰、Web 独有对照）+ Cordis waterfall 源码 + api-proxy
   `selectionFor` 调用点。**残余风险**：实验的 Web 侧是 api-proxy 语义的逐字回放而
   非真实 GUI 点击；GUI 打开会话触发 `models` RPC 为静态证据（`ModelSelect.tsx`
   mount-load）。真实 GUI 复核留待实机。
2. **`/model` 是否需要"恢复默认"入口**——即清空会话选择、回落 `agentDefaultModel`。
   倾向做，但等 M7.3 的实际使用反馈。注意 §6.1 末尾的移交语义：清空不是中性操作，
   会让已安装的 Web ref（或请求头快照）浮出，须按主动移交设计。
3. **任务卡 header 是否显示 effort**——weclaw 教训是标题信息密度过高降低可读性
   （lessons.md 追补节已把"第 N 轮"移除换成工作区名）。倾向不加，或只在非默认档位时加。
