# M4–M5 完成清单

## 目标

完成 `docs/HANDOFF.md` 与 `docs/implementation.md` 中尚未交付的 M4 体验/可靠性要求，并完成 M5 文档、审计日志、配置说明和 DSH 版本证据。

## 范围

- M4 剩余任务卡 UX、时间线归并和导航卡适用性审计。
- M4 启动恢复、绑定校验、outbox 续发/清理、HMR 释放和状态不变量。
- M5 README、审计事件、配置参考和 DSH 版本记录。
- 不重启用户正在运行的 `dsh web`；飞书实机验收由用户执行并回传结果。

## 验收标准

- 运行中任务卡仅保留一个“思考中……”尾标，终态卡不含该尾标。
- 时间线拒绝旧序号事件，同一调用 ID 原位更新，成功图标使用 `✅`。
- 启动时能使悬空绑定失效、拒绝超龄入站恢复项、续发有效 pending outbox，并按 TTL/容量清理终态数据。
- dispose 后不再接收入站/领域事件，定时器、监听器和领域存储均释放；活跃绑定始终指向存在的 session。
- README 准确描述 Model Experience、配置项、审计边界和经核实的 DSH 版本。
- 受影响测试、类型检查、全量测试和最终 diff 审查通过。

## 实施步骤

### M4 体验

- [x] 用 RED 测试定义“思考中……”尾标的幂等追加与终态移除。
- [x] 用 RED 测试定义旧序号拒绝、同 ID 原位更新及 `✅` 图标，再完成实现。
- [x] 核对“命令结果回写原卡 + accepted/completed 两阶段”是否存在实际消费者；当前仅审批卡按钮且同步决定，无耗时导航按钮，故本期无适用入口，不制造无入口功能。

### M4 可靠性

- [x] 启动恢复：pending 卡失效、绑定 session 校验、入站恢复、outbox pending 续发。
- [x] 恢复时拒绝超过 TTL 的 `received/recovering` 入站项并留下无正文审计记录。
- [x] outbox 记录发送尝试，超龄 pending 转 abandoned；终态记录按 TTL 和容量清理。
- [x] 以持久化 watermark 阻止已清理 sent 记录被重复投影。
- [x] dispose 关闭入站、监听器、定时器和领域存储，并验证可控发送队列收敛。
- [x] 增加并执行“活跃绑定必须指向存在 session”的不变量检查。

### M5

- [x] 补齐安全审计事件，确保日志不包含消息正文、命令正文、凭据和完整路径。
- [x] 更新 README 的 Model Experience、当前状态和验收边界。
- [x] 补齐配置参考、默认值和可靠性参数说明。
- [x] 记录本地链接 DSH 的版本与源码提交证据。

### 验证与交付

- [x] 执行聚焦测试、类型检查和全量测试。
- [x] 复核实际 diff、敏感信息和未跟踪文件。
- [x] 提交并推送，使用远端 SHA 复核。
- [x] 记录飞书实机验收待用户执行的明确步骤与结果边界。

## 验证方式

- `npm test -- --runInBand`（以仓库实际脚本为准）
- `npm run typecheck`（以仓库实际脚本为准）
- `git diff --check`
- `git status --short --branch`
- `git ls-remote origin refs/heads/master`

## Review

- RED→GREEN 覆盖任务卡时间线、workspace symlink 逃逸、审批跨 chat/伪造卡片、SDK `formatErrors` 重复响应体、非文本事件去重等边界。
- `npm run typecheck`：通过（exit 0）。
- `npm test`：16 个测试文件、140/140 通过（exit 0）。
- `npm run build`：通过，生成 17 个 ESM/声明文件；四个导出入口均可导入。
- `git diff --check`、敏感凭据模式和原始错误正文日志扫描：无输出；未跟踪文件均为本任务新增实现、测试或清单。
- 主交付提交 `893d93db734d1b3e748b29ea1e57dd2a0bd18d9f` 已推送至 `origin/master`，首次 `git ls-remote` 返回同一 SHA。
- 剩余风险：未重启用户的 `dsh web`，飞书真实长连接、结果卡降级、重启续发及 Web/飞书审批 race 仍须按 `docs/HANDOFF.md` 实机验收。
