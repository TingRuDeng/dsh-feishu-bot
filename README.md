# dsh-feishu-bot

Feishu (Lark) private-chat frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): drive, monitor, and approve local agents from Feishu, sharing live and cold sessions with the Web GUI in the same process.

Status: M0 skeleton. Design and milestone plan currently live in the author's harness checkout (`dsh-feishu-bot-design.md`, `dsh-feishu-bot-implementation.md`, `dsh-feishu-bot-m0-record.md`); they move here before M1 completes.

## Install (into an existing web profile)

```sh
dsh plugin --profile web add /path/to/dsh-feishu-bot
dsh --profile web --dump-config   # expect a "# == dsh-feishu-bot" layer with two rows
```

Credentials: set `FEISHU_APP_ID` / `FEISHU_APP_SECRET` where the dsh credentials service reads them. No secrets in this repository.

Verified against deepseek-harness 0.1.0-rc.5.

## License

MIT. Architecture references to other community bridges are cited in the design doc; no AGPL code is copied.
