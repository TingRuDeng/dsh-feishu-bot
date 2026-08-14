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

Verified against deepseek-harness 0.1.0-rc.5.

## License

MIT. Architecture references to other community bridges are cited in the design doc; no AGPL code is copied.
