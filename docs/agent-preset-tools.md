# 缺陷记录：飞书会话拿不到工具（`/new` 只有 `working_directory`）

> **结论先行**：属实，且是**插件缺陷**，不是权限问题。
> 根因：**工具只通过 agent preset 挂载**，而 bridge 从未挂载 preset。
> 两个创建路径（`/new` 与冷 resume）都已修复并补测试；501 测试通过。

## 一、现象

用户在飞书执行 `/new` 后，新会话里的 agent 只能切换目录，不能读文件、不能执行命令：

```
用户：为什么执行/new后绑定的 cwd 是/Users/dengtingru/Desktop/mycode？
agent：我没有 shell、文件读取或搜索工具，所以无法去 DSH 源码里查找……
```

对比**同一个** DSH、**同一个** profile：

| 会话 | 工具数 | 来源 |
|---|---|---|
| Web GUI 创建 | **31** | 用户当前会话 |
| 飞书 `/new` 创建 | **1** | `feishu-mv9c63bx-jdmj9y` |

## 二、证据链

日志里的 `request/header` 记录的是**真正发给模型的工具清单**，这是最直接的证据：

```
飞书 /new：  tools = [working_directory]                      ← 1 个
Web GUI：    tools = [bash, read, write, edit, glob, ...]     ← 31 个
```

**排除项**（都实测过）：

1. **不是权限**：该会话的权限事件为 `permission/preset=workspace-write`、
   `sandbox/mode=workspace-write`、`approval/policy=ask` —— 可以读写工作区。
2. **不是启动时序**：用户 17:14 与 17:28 各建一次，**两次都只有 1 个工具**。
3. **不是配置缺插件**：`--dump-config` 显示 `tool-bash`、`tool-fs`、`tool-fs-search`
   等全部在装配列表内；只有无关的 `smart-approval` 警告。
4. **不是 bridge 的显式限制**：`src/` 里对 `ctx.tools` / `restrict` / allow-deny
   **零引用**。

## 三、根因

**工具不在 profile 层直接生效，而是由 agent preset 挂载。**

- Web GUI 的创建路径 `packages/api/session-controller/src/agent.ts` 的
  `composeAgent()` 里有一句关键的：
  ```ts
  await presets.mount(agentCtx, resolvedId)
  ```
- preset 定义在 `packages/bundle/web-app/presets/standard.patch.yml`，
  里面明确列着 `tool-bash` / `tool-fs` / `tool-fs-search` / `tool-jobs` …
- 而 **bridge 里 grep `preset` 是空的** —— 它用 `ctx.agents.create()` 直接建会话，
  只拿到 base 层的 `working_directory`。

registry 的默认值是 `standard`（`config.default: standard`），所以修法就是照
session-controller 的方式挂载同一个 preset。

## 四、修复

新增 `src/bridge/resolver.ts` 的 `mountDefaultAgentPreset(ctx, agentCtx)`：

- 用 `ctx.get('agentPresets')` **可选**获取 registry —— 该能力是**可选**的
  （`web-app` bundle 挂它，headless 组合可以不挂）。**没有它时降级为不挂 preset，
  而不是让插件加载失败**，并在 `/new` 打一条 info 日志说明。
- 先 `resolve(undefined)` 取默认 preset，再 `mount(agentCtx, id)`。

两个创建路径都接上：

| 路径 | 位置 |
|---|---|
| 冷 resume | `resolver.ts` 的 `fencedSetup`（改为一律返回 setup） |
| `/new` 创建 | `index.ts:2854` 的 `ctx.agents.create({ setup })` |

挂载放在 **setup 最前面**，因为后续的 `modelSelections.install` 可能依赖工具已就位。

## 五、测试（TDD + 变异验证）

先写红测试，确认失败原因正确，再实现：

1. `tests/resolver.spec.ts` —— 挂**真实的** preset registry 与一个声明真实工具插件的
   preset，断言 bridge resolve 出的 agent 能看到 `todo_write`。
2. `tests/resolver.spec.ts` **控制组** —— 手动 mount 同一个 preset 必须加上该工具。
   没有这条，绿的测试不构成证据（夹具可能本身就是坏的）。
3. `tests/bridge.spec.ts` —— 端到端 `/new`，断言创建出的会话拥有 preset 的工具面。

**变异验证**（证明断言是承重的）：

| 变异 | 结果 |
|---|---|
| 关掉 `/new` 的挂载 | `expected [] to include 'todo_write'` —— 正是用户看到的空工具面 |
| 关掉 resolver 的挂载 | `expected false to be true` |

两处断言都会在修复移除后失败。

## 六、为什么原来的 498 个测试没发现

`tests/bridge.spec.ts` 的夹具**没有挂 preset registry**，与真实 profile 的装配不同。
所以「会话是否有工具」这件事在测试里根本没有被测到 —— 这正是补第 3 条端到端测试的原因。

## 七、遗留边界（诚实说明）

- **仅验证到「工具面被挂载」**。工具**实际可用**还取决于各自的服务依赖
  （`tool-bash` 需要 `shell`、`tool-fs` 需要 `fs`）；真实 profile 里这些都在，
  但需要用户重启后在飞书实测确认。
- 测试夹具里的 preset 只声明**一个**工具（`tool-todo`，依赖最少：只有
  `tools` + `sessionProjections`）。真实 `standard` preset 声明的 20+ 个插件
  未在测试中逐个验证。
- `/new` 目前**固定挂默认 preset**，暂不支持让用户指定其它 preset。
