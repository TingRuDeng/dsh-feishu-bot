# 切换到正式版 DSH 的部署交接

**背景**：当前这台机器上，`dsh-feishu-bot` 是**源码联调**方式跑起来的——插件的依赖用 `link:` 指向 `../deepseek-harness/packages/...`。一旦停掉源码启动、改装正式版 DSH，这条链路会断。

本文只讲**怎么让插件在正式版 DSH 上继续工作**。架构与用法见 [design.md](design.md)、[usage.zh.md](usage.zh.md)。

## 一、会断在哪里（实测，不是推断）

### 1. 插件里 `@deepseek-ai/*` 的解析路径指向源码 checkout

实测（在 profile 的插件目录下解析）：

```
@deepseek-ai/dsh-agent          -> /Users/…/deepseek-harness/packages/core/agent/lib/index.js
@deepseek-ai/dsh-user-questions -> /Users/…/deepseek-harness/packages/interaction/user-questions/lib/index.js
@deepseek-ai/cordis             -> /Users/…/deepseek-harness/vendor/cordis/lib/index.js
```

`~/.dsh/profiles/web/node_modules/@deepseek-ai/` 是**空目录**，所以解析是沿着目录树往上走、落到源码 checkout 的。源码启动一停，这些 import 就找不到。

根因：本地构建把 `@deepseek-ai/*` 当作**外部依赖**（不内联），而正式版 `@deepseek-ai/dsh` 并不把它们列为 dependencies——它自己打包进去了。清单里只有：

```
@deepseek-ai/cordis: ~4.0.5        ← 只有这一个
@deepseek-ai/dsh-agent: （不在依赖里）
@deepseek-ai/dsh-llm:   （不在依赖里）
@deepseek-ai/dsh-user-questions: （不在依赖里）
```

### 2. 已发布的 npm 包比当前源码落后 49 个提交

```
$ git log --oneline v0.1.0-rc.11..master | wc -l
49
```

`v0.1.0-rc.11`（npm `latest`）打在 `2231480 fix(bridge): align with DSH alpha.2` 上，
而版本号本身最后一次改动更早（`ff89fdc fix(compat): align Feishu bridge with DSH alpha.1`）。
实测该 tarball 里：

| 本轮能力 | 已发布 rc.11 |
|---|---|
| `renderDecisionOnlyCard`（审批并入任务卡） | ✗ 0 处 |
| `writeCardNow` | ✗ 0 处 |
| `cardDecisions` | ✗ 0 处 |
| `questionId`（多问题分批回答） | ✗ 0 处 |
| `pendingQuestionElements` | ✗ 0 处 |

**所以「直接 `dsh plugin add @tingrudeng/dsh-feishu-bot`」拿到的是 49 个提交之前的版本**，本轮所有卡片合并工作都不在里面。

### 3. 已发布 tarball 的依赖形态是干净的

这一条是好消息，说明打包链路本身没问题：

```json
{ "dependencies": {}, "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" } }
```

没有 `link:`，`@deepseek-ai/*` 在构建时被内联。**问题不在打包，在于当前源码构建是「外部引用」形态、以及没有发布新版本。**

## 二、推荐做法：先把当前源码发一个正式版本，再让正式版 DSH 装它

正式版 DSH 只认 npm 上的包，所以必须先把当前源码发布出去。

```sh
cd /Users/dengtingru/Desktop/mycode/dsh/dsh-feishu-bot

# 1. 先确认门禁全绿（改动后必须重跑）
npm run typecheck      # 期望 0 errors
npm test               # 期望 33 文件 / 568 通过
npm run build          # tsdown

# 2. 提版本号（当前 0.1.0-rc.11，需高于 npm latest）
#    编辑 package.json 的 version，例如 0.1.0-rc.12

# 3. 打 tag 走正式发布 workflow（见 docs/HANDOFF.md 的发布链路）
#    release.yml 只接受 tag 触发，且 tag 必须严格高于当前 latest
git tag v0.1.0-rc.12
git push origin master --follow-tags
```

发布链路本身已有完整自动化（Trusted Publishing OIDC、双 attestation、SBOM、Draft → npm `latest` → Prerelease），**不要手工 `npm publish`**。

发布完成后再在正式版 DSH 上安装：

```sh
dsh plugin add @tingrudeng/dsh-feishu-bot@0.1.0-rc.12
```

## 三、如果暂时不想发布：把依赖就地补齐

可以不改包，直接把缺的依赖放进 profile，让解析不再依赖源码 checkout：

插件构建产物里 import 的 `@deepseek-ai/*` 共 5 个，把它们的**精确版本**装进 profile：

```sh
cd ~/.dsh/profiles/web
pnpm add @deepseek-ai/dsh-agent@0.2.1-rc.2 \
         @deepseek-ai/dsh-llm@0.2.1-rc.2 \
         @deepseek-ai/dsh-storage-domain@0.2.1-rc.2 \
         @deepseek-ai/dsh-user-questions@0.2.1-rc.2 \
         @deepseek-ai/cordis@^4.0.5
```

这 6 个版本都已确认在 npm 上可取。**注意必须写精确版本**：这些包的 `latest`
标签远低于插件构建时的版本（例如 `@deepseek-ai/dsh-llm` 的 latest 是 `0.0.1-rc.1`，
而插件用的是 `0.2.1-rc.2`），不写版本会装错。

**这条路的代价要清楚**：装进 profile 的 SDK 版本必须与正式版 DSH 内部打包的那份**版本一致**，否则会出现同一进程里两套 SDK 实例（symbol/`instanceof`/service registry 都可能对不上）。优先走第二节。

## 四、升级后必须核对

1. `dsh plugin list` 显示的版本号是新发布的那个，不是 rc.11。
2. profile 的 `package.json` 里依赖是**版本号**（`0.1.0-rc.12`），不再是 `file:/Users/…`。
3. 重新解析一次，确认不再指向源码：

```sh
node -e "
const {createRequire}=require('module');
const r=createRequire(process.env.HOME+'/.dsh/profiles/web/node_modules/@tingrudeng/dsh-feishu-bot/lib/index.js');
for (const m of ['@deepseek-ai/dsh-agent','@deepseek-ai/dsh-user-questions','@deepseek-ai/cordis'])
  { try { console.log(m,'->',r.resolve(m)); } catch(e) { console.log(m,'-> ✗',e.code); } }
"
```

期望：路径不再落在 `deepseek-harness/` 下面。

4. 飞书侧实测（自动化不能替代）：
   - 绑定会话里发一条消息，任务卡出现且只有一个「思考中……」尾标。
   - 触发一次授权申请：**审批画在任务卡里**，不再另发一条、不把进度顶走。
   - 触发一次提问：各选项点选后按钮变色；多问题可以逐个回答。
   - 重启 DSH 后，旧卡显示「已失效」，不留死按钮。

## 五、当前源码状态（交接基线）

- 分支 `master`，工作树干净，**领先 `origin/master` 49 个提交**（未推送）。
- `npm run typecheck` 0 errors；`npm test` **33 文件 / 568 通过**；`npm run build` 成功。
- 本机 profile 已部署当前构建，`diff -rq lib <profile>/lib` 输出 IDENTICAL。
- 版本 `0.1.0-rc.11`（**与 npm 上同号但内容不同**，见第一节第 2 点——这是最容易踩的坑）。

### 已知遗留

- `git stash` 里有一条 `stash@{0}: On master: approval-merge-wip`，是第一步审批合并失败尝试的残留，**已被后续提交取代，可丢**：`git stash drop stash@{0}`。
- `docs/step2-approval-merge-wip.patch` 同样是那次失败尝试的存档，仅作历史记录，不再需要。
- `smart-approval` 的配置告警、`file:` → `link:` 安装方式转换：用户明确表示暂不处理。
- 磁盘上有 7 个空白 session，用户暂不清理。
- 真实飞书故障矩阵（重复事件、断连、进程中止、审批 fallback、HMR drain）仍是欠账，见 [HANDOFF.md](HANDOFF.md) 阶段 5。
