/**
 * Approval channel pieces (design §6.4, plan α): the asked-event pairing
 * scan and the approval card. Pure functions; the bridge owns registration,
 * pending registry, and durable pendingCards.
 */

import { escapeLarkMarkdownLiteral } from './lark-markdown.ts'

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

/** What an approval card item presents; never tool arguments (design §6.4). */
export interface ApprovalCardSpec {
  /** Durable pending-card id; the button payload's routing key. */
  pendingId: string
  toolName: string
  reason?: string
  sessionTitle: string
  /** Web GUI base URL for the heavier-review escape hatch. */
  webUrl: string
}

/** Feishu interactive card with action buttons (msg_type `interactive`). */
export interface FeishuActionCard {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: unknown[]
}

const REASON_BYTE_BUDGET = 500

/** Lifecycle state of one approval item on a group card. */
export type ApprovalItemState = 'pending' | 'allowed' | 'rejected' | 'elsewhere' | 'withdrawn' | 'invalidated'

/** One approval question on a group card: its facts plus where it stands. */
export interface ApprovalGroupItem {
  spec: ApprovalCardSpec
  state: ApprovalItemState
}

const ITEM_STATE_COPY: Record<Exclude<ApprovalItemState, 'pending'>, string> = {
  allowed: '✅ 已允许（本次）',
  rejected: '❌ 已拒绝',
  elsewhere: '已在别处决定',
  withdrawn: '已撤回',
  invalidated: '已失效（进程重启）',
}

/** The item's facts as lark_md lines; never tool arguments. */
function itemLines(spec: ApprovalCardSpec): string {
  return [
    `**工具**：${escapeLarkMarkdownLiteral(spec.toolName)}`,
    ...spec.reason === undefined
      ? []
      : [`**原因**：${escapeLarkMarkdownLiteral(spec.reason, REASON_BYTE_BUDGET)}`],
    `**会话**：${escapeLarkMarkdownLiteral(spec.sessionTitle)}`,
  ].join('\n')
}

/**
 * Render every approval question of one chat as ONE card (weclaw: parallel
 * approvals collapse into a single scrolling card instead of stacking
 * messages). Pending items carry their own 允许/拒绝 buttons (payload:
 * pendingId + action verb — the callback needs no other routing state);
 * settled items show their outcome inline with no buttons. The header
 * counts open items while any remain and turns terminal grey once all are
 * settled. One Web GUI link serves the whole card.
 * @param items - the group's items in arrival order.
 * @returns the card JSON for msg_type `interactive` (send and patch alike).
 */
export function renderApprovalGroupCard(items: readonly ApprovalGroupItem[]): FeishuActionCard {
  const pending = items.filter(item => item.state === 'pending').length
  const header = pending > 0
    ? {
        title: {
          tag: 'plain_text' as const,
          content: items.length > 1 ? `审批请求（${pending}/${items.length} 待处理）` : '审批请求',
        },
        template: 'orange',
      }
    : { title: { tag: 'plain_text' as const, content: '审批请求 · 已处理' }, template: 'grey' }
  const elements: unknown[] = []
  items.forEach((item, index) => {
    if (index > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: itemLines(item.spec) } })
    if (item.state === 'pending') {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '允许一次' },
            type: 'primary',
            value: { pendingId: item.spec.pendingId, action: 'allow' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { pendingId: item.spec.pendingId, action: 'reject' },
          },
        ],
      })
    } else {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: ITEM_STATE_COPY[item.state] } })
    }
  })
  const webUrl = items[0]?.spec.webUrl
  if (webUrl !== undefined) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `[在 Web GUI 中查看](${webUrl})` } })
  }
  return {
    config: { wide_screen_mode: true },
    header,
    elements,
  }
}
