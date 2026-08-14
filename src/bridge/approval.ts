/**
 * Approval channel pieces (design §6.4, plan α): the asked-event pairing
 * scan and the approval card. Pure functions; the bridge owns registration,
 * pending registry, and durable pendingCards.
 */

/** The event fields the pairing scan reads; structurally satisfied by SessionEvent. */
interface ApprovalScanEvent {
  type: string
  data: unknown
}

/**
 * Find this request's approvalId: the newest `approval/asked` that is not
 * decided, not claimed by another pending entry, and callId-symmetric with
 * the request (same callId, or both callId-less). Mirrors the upstream
 * apiproxy scan so both channels pair the same audit id for the same
 * request.
 * @param events - the request agent's session events in log order.
 * @param callId - the request's callId, when the asker had one.
 * @param claimed - approvalIds already held by pending entries (either channel's registry).
 * @returns the paired id, or undefined (caller must delegate via next()).
 */
export function pairApprovalId(
  events: readonly ApprovalScanEvent[],
  callId: string | undefined,
  claimed: ReadonlySet<string>,
): string | undefined {
  const decided = new Set<string>()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'approval/decided') {
      decided.add((event.data as { id: string }).id)
    } else if (event.type === 'approval/asked') {
      const data = event.data as { id: string; callId?: string }
      if (decided.has(data.id) || claimed.has(data.id)) continue
      if ((callId ?? null) !== (data.callId ?? null)) continue
      return data.id
    }
  }
  return undefined
}

/** What the approval card presents; never tool arguments (design §6.4). */
export interface ApprovalCardSpec {
  /** Durable pending-card id; the button payload's routing key. */
  pendingId: string
  toolName: string
  reason?: string
  sessionTitle: string
  /** Web GUI base URL for the heavier-review escape hatch. */
  webUrl: string
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
function truncateBytes(text: string, budget: number): string {
  if (Buffer.byteLength(text, 'utf8') <= budget) return text
  let out = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > budget - 3) break // reserve for the ellipsis
    out += char
    bytes += size
  }
  return `${out}…`
}

/** Feishu interactive card with action buttons (msg_type `interactive`). */
export interface FeishuActionCard {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: unknown[]
}

const REASON_BYTE_BUDGET = 500

function approvalBody(spec: ApprovalCardSpec): unknown[] {
  const lines = [
    `**工具**：${spec.toolName}`,
    ...spec.reason === undefined ? [] : [`**原因**：${truncateBytes(spec.reason, REASON_BYTE_BUDGET)}`],
    `**会话**：${spec.sessionTitle}`,
  ]
  return [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    { tag: 'div', text: { tag: 'lark_md', content: `[在 Web GUI 中查看](${spec.webUrl})` } },
  ]
}

/**
 * Render the pending approval card: facts plus 允许/拒绝 buttons whose
 * payloads carry the durable pendingId and the action verb — the callback
 * needs no other routing state.
 * @param spec - presented facts and routing key.
 * @returns the card JSON for msg_type `interactive`.
 */
export function renderApprovalCard(spec: ApprovalCardSpec): FeishuActionCard {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '审批请求' }, template: 'orange' },
    elements: [
      ...approvalBody(spec),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '允许一次' },
            type: 'primary',
            value: { pendingId: spec.pendingId, action: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { pendingId: spec.pendingId, action: 'reject' },
          },
        ],
      },
    ],
  }
}

/** Terminal states an approval card freezes into (design §6.4). */
export type ApprovalCardFrozenState =
  | 'decided-allow' | 'decided-reject' | 'elsewhere' | 'withdrawn' | 'invalidated'

const FROZEN_COPY: Record<ApprovalCardFrozenState, { title: string; template: string }> = {
  'decided-allow': { title: '已允许（本次）', template: 'green' },
  'decided-reject': { title: '已拒绝', template: 'red' },
  elsewhere: { title: '已在别处决定', template: 'grey' },
  withdrawn: { title: '已撤回', template: 'grey' },
  invalidated: { title: '已失效（进程重启）', template: 'grey' },
}

/**
 * Render the frozen replacement card: same facts, terminal header, no
 * buttons (a patched-away button cannot be clicked twice).
 * @param spec - the original card's facts.
 * @param state - which terminal the card froze into.
 * @returns the card JSON for message.patch.
 */
export function renderApprovalCardFrozen(spec: ApprovalCardSpec, state: ApprovalCardFrozenState): FeishuActionCard {
  const { title, template } = FROZEN_COPY[state]
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `审批请求 · ${title}` }, template },
    elements: approvalBody(spec),
  }
}
