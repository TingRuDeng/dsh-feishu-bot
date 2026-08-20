# dsh-feishu-bot

Feishu (Lark) private-chat frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): drive, monitor, and approve local agents from Feishu, sharing live and cold sessions with the Web GUI in the same process.

Status: M0–M7 product work and the M6 reliability implementation are covered by automated tests. The stage-6 preview gate builds a self-contained `@tingrudeng/dsh-feishu-bot@0.1.0-rc.9` tarball (Cordis remains a host peer), audits its manifest/files, emits a tarball-bound CycloneDX SBOM, installs outside the checkout, imports all four entry points, and composes in a clean DSH profile. The rc.8 release successfully proved the tag-only OIDC workflow, monotonic npm `latest`, remote-tag-to-commit checks, GitHub/npm provenance verification, and single-tarball GitHub Prerelease plus npm publication. rc.9 adds S4 Markdown escaping unification and M7.0–M7.3 model/effort selection; it remains a local candidate until the preview package passes real Feishu acceptance. Source `link:` dependencies remain intentionally available for local debugging and are removed from the packed manifest. Docs: [中文使用指南](docs/usage.zh.md) · [design](docs/design.md) · [milestone record](docs/implementation.md) · [handoff](docs/HANDOFF.md) · [M0 verification record](docs/m0-record.md) · [weclaw lessons](docs/weclaw-lessons.md).

## Commands (private chat)

- `/new [cwd]` — create a session under an allowed workspace and bind it
- `/ls` — two-level card of unarchived sessions: choose a workspace, then tap a real session title to bind
- `/use <sessionId|n>` — bind an existing session; retained as the text fallback for `/ls`
- `/stop` — cancel the running turn while retaining queued follow-ups
- `/status` / `/effort <id>` / `/model` / `/release` / `/help`
- Plain text goes to the bound session. While a Feishu chat remains bound, each direct human task started from either Feishu or Web owns one task card and one task-wide durable result in Feishu; `/release` stops that synchronization. Subagent continuation turns patch the original card instead of creating new messages, and tool-calling commentary is not projected as a result. Failed task cards show an allowlisted stable error code and retry count, never an arbitrary provider error message.

## Install (into an existing web profile)

For Feishu-console setup, credentials, allowlists, startup, commands, and troubleshooting, see the [中文使用指南](docs/usage.zh.md).

```sh
dsh plugin --profile web add /path/to/dsh-feishu-bot
dsh --profile web --dump-config   # expect gateway, bridge, registry, and invariant rows
```

For a prebuilt local preview, run `pnpm release:preview` from a clean checkout. The single release gate runs frozen install, tests, typecheck, build, tarball/manifest audit, SBOM generation, isolated install, four-entry import, clean-profile composition, and checksum generation. Install the resulting `artifacts/tingrudeng-dsh-feishu-bot-0.1.0-rc.9.tgz` with `dsh plugin --profile web add /absolute/path/to/the.tgz`; verify `artifacts/SHA256SUMS`, and inspect the matching `.cdx.json` plus `release.json` descriptor when provenance matters. This does not publish a tag, GitHub Release, or registry package. Registry installs use the sole supported channel, `@tingrudeng/dsh-feishu-bot@latest`.

Profiles that still contain the old unscoped source package must remove it before installing the scoped RC; DSH reconciles bundles by package name and will not replace it automatically:

```sh
dsh plugin --profile web remove dsh-feishu-bot
dsh plugin --profile web add @tingrudeng/dsh-feishu-bot@latest
```

Maintainers: `.github/workflows/release.yml` accepts only matching RC tag pushes. It does not use GitHub's lossy one-pending native concurrency group: after the protected `npm-release` environment admits a job, the job uses `actions: read` to wait for every lower workflow `run_number` to finish. It then rejects a candidate that is not strictly newer than the registry's current RC `latest`; workflow reruns are rejected, so a failed immutable release attempt requires a new, higher RC tag. GitHub hides Draft Releases from a `contents: read` job token, so `publish_npm` has job-level `contents: write` to reverify the Draft immediately before the irreversible npm publication. GitHub Actions cannot scope that permission to one step: the SHA-pinned checkout uses the token without persisting it, `GH_TOKEN` is explicitly passed only to the queue and Draft/tag reverify steps, and workflow contract tests reject GitHub write methods, release mutation commands, dist-tag writes, and Git pushes from this job. Approve runs oldest first, or explicitly cancel an abandoned older run before admitting a later one. Before every new RC tag, recheck that the protected environment, the no-update/no-delete `v*-rc.*` tag rule, Action SHA pinning, and Immutable Releases remain enabled; the workflow rechecks the peeled tag commit at each publication boundary but repository policy closes the remaining tag check/write window. The npm version endpoint and root packument are both retried through the same no-store boundary until provenance and `latest` are visible. The draft asset GET check and the PATCH that makes a prerelease public are not one atomic GitHub API operation, so unrelated `contents: write` actors must not mutate the draft during finalize; a post-PATCH mismatch fails the workflow but can leave a bad prerelease briefly visible or immutable. rc.7 completed the one-time bootstrap publish. Bootstrap is now permanently rejected because the package exists; configure the Trusted Publisher for this exact workflow/environment, remove the bootstrap secret/SHA, revoke its token, and set `NPM_AUTH_MODE=oidc` before creating rc.8. These are remote state changes and require separate authorization; the workflow file alone does not perform them.

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
| `listingTtlMs` | `300000` | Lifetime of the latest `/ls` card and ordinal snapshot |
| `cardThrottleMs` | `1000` | Minimum interval between non-terminal task-card patches |
| `progressDetail` | `summary` | Feishu task-card detail: `concise` hides duration/token facts, `summary` shows duration but hides token usage, `full` shows both |
| `recoveryTtlMs` | `86400000` | Maximum age of interrupted inbound work eligible for restart recovery |
| `bindingCleanupTimeoutMs` | `5000` | Independent timeout for disposing a newly-created session after a failed binding switch |
| `disposeDrainTimeoutMs` | `5000` | Bridge deadline for admitted chat/card/approval/projection work before storage is closed |
| `inboundRetentionMs` / `inboundMaxRecords` | `604800000` / `50000` | Terminal inbound retention and hard capacity; protected recoverable rows cause backpressure instead of eviction |
| `outboundRetentionMs` / `outboundMaxRecords` | `604800000` / `10000` | Legacy outbox/dead-letter retention and hard capacity |
| `outboundPendingTtlMs` | `86400000` | Age at which a legacy unsent segment is abandoned and its body cleared |
| `deliveryRetentionMs` / `deliveryMaxRecords` | `604800000` / `10000` | Canonical result-delivery retention and hard capacity |
| `deliveryPendingTtlMs` | `86400000` | Age at which an unsent canonical result is abandoned and its body cleared |
| `approvalPendingTtlMs` / `approvalMaxRecords` | `86400000` / `1000` | Inactive approval recovery-fact TTL and hard capacity; active/fresh ambiguous rows are protected |
| `projectionCursorRetentionMs` / `projectionCursorMaxRecords` | `604800000` / `10000` | Unbound cursor retention and hard capacity; active or pending-delivery cursors are protected |
| `maintenanceIntervalMs` | `86400000` | Retention sweep interval; `0` disables the periodic timer while startup cleanup still runs |
| `agentProvider` / `agentModel` | unset | Optional paired override; when omitted, new and cold-resumed sessions follow Harness `agent-default-model` |
| `webUrl` | `http://127.0.0.1:3080` | Web GUI link placed on approval cards |

Result-card segmentation uses a fixed 24 KiB soft limit over the complete Feishu create-message envelope; it is intentionally not a deployment setting.

## Reliability and audit

- Gateway construction does not start the long connection. The bridge first opens both storage domains, completes local reconciliation/retention, and queues legacy output, canonical output, and session-log catch-up in per-chat FIFO order. It then registers a Promise-returning admission handler and starts intake. Queued recovery I/O may continue after readiness, so one hung Feishu request cannot block plugin activation; fresh work for the same chat remains ordered behind recovery.
- An inbound SDK callback completes only after a `received` row keyed by Feishu `message_id` is durable. `event_id` remains a legacy/audit alias. Business handling then proceeds asynchronously in the per-chat queue; this is an admission commit point, not a claim that the model has already consumed the message.
- Committed assistant results are re-read from the session log. The bridge writes one complete canonical delivery before advancing its `(chat, session)` cursor, derives deterministic segments at send time, and reuses a stable 32-hex Feishu `uuid` for each logical shape. A cursor means “durably materialized”, not “delivered”.
- Transport failures are classified as permanent, retryable, or ambiguous. Only a definite card-shape rejection may fall back to text; timeout, disconnect, and 5xx-class ambiguity keep the original shape and UUID. Platform-side UUID deduplication still requires real Feishu acceptance before an exactly-once claim can be made.
- Text/card create and card patch operations are serialized and drained. HMR stops admission and intake, drains admitted chat/card/approval/projection work up to the configured deadlines, then closes storage. If the bridge deadline expires, writes are fenced; durable pending work remains for restart recovery.
- Retention limits are hard ceilings. Terminal rows are evicted first; live approvals, recoverable inbound rows, pending deliveries, and active/protective cursors are not sacrificed to satisfy capacity, so admission can fail with explicit backpressure.
- The invariant companion rejects an active binding whose session is absent from both live and persisted session stores.
- `feishu-audit` events contain action names, enum outcomes, counters, and stable hashes of identifiers. They contain no message/command body, credential, or full filesystem path. Transport errors are reduced to error class and safe code; Client/WS logs are recursively redacted and EventDispatcher logs are fully silent.

## Verified DeepSeek Harness baseline

Verified on 2026-08-14 against a clean local `../deepseek-harness` checkout: package version `0.1.0-rc.5`, Git commit `47f943859bef60e4160492346772ded9b24f765a`, branch `master`, using Node `v26.5.1`. This records the source actually used for build and test; it is not a claim about the current remote head.

## Data exposure model

Binding a chat uploads that session's conversation to Feishu **by design**: assistant replies — including any source code, file contents, command output, or secrets the model chooses to print — are sent to ByteDance-operated Feishu servers. The first `/ls` card sends workspace basenames and session counts; entering one workspace then sends that workspace's session titles. It does not send full workspace paths or session ids in card payloads. Other command replies may include absolute local paths and full session ids. Task and approval cards additionally send the workspace basename, task/tool status, tool name, approval reason, and available token-usage facts; tool arguments are not placed on approval cards. There is no outbound content filter; absolute local Markdown links receive only a presentation rewrite (`[label](/path)` → ``label（`/path`）``), and the path itself is still uploaded. The trust boundary is **who may bind**, enforced fail-closed by `allowedOpenIds` (empty rejects everyone) and `allowedWorkspaces` (`/ls`/`/use`/`/new` are all scoped to the configured roots). Do not allowlist a workspace whose sessions must not leave the machine. Note the boundary's exact meaning: `allowedWorkspaces` controls which sessions Feishu can bind, list, or create — it does not confine what a bound session's agent can read. The harness sandbox fences writes only (reads are OS-user-wide in every mode), so an agent asked to read a file outside its workspace and repeat it will, and that reply uploads like any other. Read isolation requires OS-level separation (a dedicated user account), not this plugin's configuration. Message bodies never enter the plugin's own logs or audit records (ids and hashes only); Client/WS SDK failures pass through a recursive redactor, while the event dispatcher is silent so arbitrary inbound payloads cannot be printed.

## License

MIT. Architecture references to other community bridges are cited in the design doc; no AGPL code is copied.
