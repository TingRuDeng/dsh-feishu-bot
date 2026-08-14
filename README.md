# dsh-feishu-bot

Feishu (Lark) private-chat frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): drive, monitor, and approve local agents from Feishu, sharing live and cold sessions with the Web GUI in the same process.

Status: M0–M5 code and documentation are complete; live Feishu acceptance remains deployment-owner work. Docs: [design](docs/design.md) · [milestone record](docs/implementation.md) · [handoff](docs/HANDOFF.md) · [M0 verification record](docs/m0-record.md) · [weclaw lessons](docs/weclaw-lessons.md).

## Commands (private chat)

- `/new [cwd]` — create a session under an allowed workspace and bind it
- `/ls` — numbered session list grouped by workspace; `/use <n>` binds by number
- `/use <sessionId|n>` — bind an existing session
- `/stop` — cancel the running turn while retaining queued follow-ups
- `/status` / `/release` / `/help`
- Plain text goes to the bound session; progress is patched into a task card and committed replies return as durable green result cards.

## Install (into an existing web profile)

```sh
dsh plugin --profile web add /path/to/dsh-feishu-bot
dsh --profile web --dump-config   # expect gateway, bridge, and invariant rows
```

Credentials: set `FEISHU_APP_ID` / `FEISHU_APP_SECRET` where the dsh credentials service reads them. No secrets in this repository.

Feishu console prerequisites (long-connection mode): subscribe the `im.message.receive_v1` event with `im:message.p2p_msg:readonly`, and for approval cards enable the `card.action.trigger` callback; publish an app version after each change.

The bundle patch is fail-closed until the deployment profile supplies `allowedOpenIds` and `allowedWorkspaces`. A configured `defaultWorkspace` is validated during bridge load and must resolve inside an allowed root.

## Model Experience

- The plugin does not inject a system prompt, model instruction, or tool schema. Provider, model, system-prompt, and tool behavior remain owned by DeepSeek Harness.
- Ordinary non-command Feishu messages enter the bound session verbatim as one user text block with `source.via = "feishu"`; the bridge does not rewrite their content.
- Approval cards pair with the existing `approval/asked` event. A winning Feishu or Web decision resolves the normal approval request, so DeepSeek Harness remains the owner of the canonical `approval/decided` audit event. Restart invalidation never fabricates a decision.

## Configuration reference

Gateway options:

| Key | Default | Purpose |
|---|---:|---|
| `appIdRef` / `appSecretRef` | bundle: `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | Credential-service references; never raw secrets |
| `sendRetryBaseMs` | `500` | Exponential retry base delay |
| `sendMaxAttempts` | `4` | Shared maximum attempts for text and card sends |
| `sendCircuitCooldownMs` | `30000` | Per-chat cooldown after the retry budget is exhausted |
| `disposeDrainTimeoutMs` | `5000` | Maximum HMR/shutdown drain time for accepted sends |

Bridge options:

| Key | Default | Purpose |
|---|---:|---|
| `allowedOpenIds` | `[]` | Users allowed to interact; empty rejects everyone |
| `allowedWorkspaces` | `[]` | Canonical roots visible to `/ls`, `/use`, and `/new`; empty authorizes none |
| `defaultWorkspace` | unset | Default `/new` cwd; `~` is supported and load fails if the resolved directory is outside the allowed roots |
| `freshnessMs` | `600000` | Maximum age of a newly delivered Feishu event |
| `listingTtlMs` | `300000` | Lifetime of the latest numbered `/ls` snapshot |
| `cardThrottleMs` | `1000` | Minimum interval between non-terminal task-card patches |
| `recoveryTtlMs` | `86400000` | Maximum age of interrupted inbound work eligible for restart recovery |
| `inboundRetentionMs` / `inboundMaxRecords` | `604800000` / `50000` | Terminal inbound retention and soft capacity; recoverable rows are protected |
| `outboundRetentionMs` / `outboundMaxRecords` | `604800000` / `10000` | Terminal outbox retention and soft capacity |
| `outboundPendingTtlMs` | `86400000` | Age at which an unsent segment is abandoned and its body cleared |
| `maintenanceIntervalMs` | `86400000` | Retention sweep interval; `0` disables the periodic timer while startup cleanup still runs |
| `agentProvider` / `agentModel` | `deepseek` / `deepseek-chat` | Model route used for sessions created or cold-resumed by the bridge |
| `webUrl` | `http://127.0.0.1:3080` | Web GUI link placed on approval cards |

Result-card segmentation uses a fixed 24 KiB soft limit over the complete Feishu create-message envelope; it is intentionally not a deployment setting.

## Reliability and audit

- Inbound events and commands are durable and idempotent. Startup reconciles interrupted work, invalidates dangling bindings, abandons expired pending output, and resumes valid pending output in deterministic order.
- Text and card creates share one FIFO and retry/circuit budget per chat. HMR stops intake first, closes the long connection, and drains already accepted sends up to the configured deadline.
- The invariant companion rejects an active binding whose session is absent from both live and persisted session stores.
- `feishu-audit` events contain action names, enum outcomes, counters, and stable hashes of identifiers. They contain no message/command body, credential, or full filesystem path. Transport errors are reduced to error class and safe code; the SDK logger redacts request/response `data` fields and the response-body copy appended by `formatErrors`.

## Verified DeepSeek Harness baseline

Verified on 2026-08-14 against a clean local `../deepseek-harness` checkout: package version `0.1.0-rc.5`, Git commit `47f943859bef60e4160492346772ded9b24f765a`, branch `master`, using Node `v26.5.1`. This records the source actually used for build and test; it is not a claim about the current remote head.

## Data exposure model

Binding a chat uploads that session's conversation to Feishu **by design**: assistant replies — including any source code, file contents, command output, or secrets the model chooses to print — are sent to ByteDance-operated Feishu servers, and command replies include absolute local paths and session ids. Task and approval cards additionally send the workspace basename, task/tool status, tool name, approval reason, and available token-usage facts; tool arguments are not placed on approval cards. There is no outbound content filter; absolute local Markdown links receive only a presentation rewrite (`[label](/path)` → ``label（`/path`）``), and the path itself is still uploaded. The trust boundary is **who may bind**, enforced fail-closed by `allowedOpenIds` (empty rejects everyone) and `allowedWorkspaces` (`/ls`/`/use`/`/new` are all scoped to the configured roots). Do not allowlist a workspace whose sessions must not leave the machine. Note the boundary's exact meaning: `allowedWorkspaces` controls which sessions Feishu can bind, list, or create — it does not confine what a bound session's agent can read. The harness sandbox fences writes only (reads are OS-user-wide in every mode), so an agent asked to read a file outside its workspace and repeat it will, and that reply uploads like any other. Read isolation requires OS-level separation (a dedicated user account), not this plugin's configuration. Message bodies never enter the plugin's own logs or audit records (ids and hashes only), and the Feishu SDK's failure logs are routed through a redactor that strips request/response bodies.

## License

MIT. Architecture references to other community bridges are cited in the design doc; no AGPL code is copied.
