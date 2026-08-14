# dsh-feishu-bot

Feishu (Lark) private-chat frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): drive, monitor, and approve local agents from Feishu, sharing live and cold sessions with the Web GUI in the same process.

Status: M1 code-complete (60 tests), pending live acceptance. Docs: [design](docs/design.md) · [milestone plan](docs/implementation.md) · [M0 verification record](docs/m0-record.md) · [weclaw lessons](docs/weclaw-lessons.md).

## Commands (private chat)

- `/new [cwd]` — create a session under an allowed workspace and bind it
- `/ls` — numbered session list grouped by workspace; `/use <n>` binds by number
- `/use <sessionId|n>` — bind an existing session
- `/status` / `/release` / `/help`
- Plain text goes to the bound session; replies come back segmented.

## Install (into an existing web profile)

```sh
dsh plugin --profile web add /path/to/dsh-feishu-bot
dsh --profile web --dump-config   # expect a "# == dsh-feishu-bot" layer with two rows
```

Credentials: set `FEISHU_APP_ID` / `FEISHU_APP_SECRET` where the dsh credentials service reads them. No secrets in this repository.

Feishu console prerequisites (long-connection mode): subscribe the `im.message.receive_v1` event with `im:message.p2p_msg:readonly`, and for approval cards enable the `card.action.trigger` callback; publish an app version after each change.

Verified against deepseek-harness 0.1.0-rc.5.

## Data exposure model

Binding a chat uploads that session's conversation to Feishu **by design**: assistant replies — including any source code, file contents, command output, or secrets the model chooses to print — are sent verbatim to Tencent/ByteDance-operated Feishu servers, and command replies include absolute local paths and session ids. There is no outbound content filter; the trust boundary is **who may bind**, enforced fail-closed by `allowedOpenIds` (empty rejects everyone) and `allowedWorkspaces` (`/ls`/`/use`/`/new` are all scoped to the configured roots). Do not allowlist a workspace whose sessions must not leave the machine. Note the boundary's exact meaning: `allowedWorkspaces` controls which sessions Feishu can bind, list, or create — it does not confine what a bound session's agent can read. The harness sandbox fences writes only (reads are OS-user-wide in every mode), so an agent asked to read a file outside its workspace and repeat it will, and that reply uploads like any other. Read isolation requires OS-level separation (a dedicated user account), not this plugin's configuration. Message bodies never enter the plugin's own logs or audit records (ids and hashes only), and the Feishu SDK's failure logs are routed through a redactor that strips request/response bodies.

## License

MIT. Architecture references to other community bridges are cited in the design doc; no AGPL code is copied.
