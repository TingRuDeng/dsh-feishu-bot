/**
 * Task-card reducer (design §6.3): fold one turn's session events into an
 * immutable card snapshot. Pure over the event list — replayable from the
 * durable log, no clock, no I/O; rendering and throttling live elsewhere.
 *
 * Terminal mapping is three-valued (docs/weclaw-lessons.md, 2026-07-31):
 * `aborted` is 'stopped' (a user decision, not a malfunction), `completed`
 * is 'completed', and every other {@link TurnEndReason} kind — error,
 * blocked, max-tokens, and future merge-extensible variants — degrades to
 * 'failed' (the documented default arm).
 */

/** One turn's card-facing state, frozen at the terminal turn/end. */
export interface TaskCardSnapshot {
  /** The folded turn number. */
  turn: number
  /** running | completed | stopped | failed. */
  status: 'running' | 'completed' | 'stopped' | 'failed'
  /** Names of tools called but not yet resolved, in call order. Never arguments. */
  currentTools: string[]
  /** Total tool calls observed in this turn. */
  toolCallCount: number
  /** turn/start → turn/end span; null while running. */
  durationMs: number | null
  /** turn/start event time (ms epoch); null when the start is outside the window. */
  startedAt: number | null
}

/** The event fields the reducer reads; structurally satisfied by SessionEvent. */
interface CardEvent {
  seq: number
  time: number
  type: string
  data: unknown
}

/** tool/result's pairing id, read from its ToolResultBlock; null when absent. */
function resultCallId(data: unknown): string | null {
  const message = (data as { message?: { content?: unknown } }).message
  const first = Array.isArray(message?.content) ? message.content[0] as unknown : undefined
  const id = (first as { toolCallId?: unknown } | undefined)?.toolCallId
  return typeof id === 'string' ? id : null
}

/**
 * Fold one turn's events into a card snapshot.
 * @param events - session events in seq order (the whole log or any window).
 * @param turn - the turn number to fold.
 * @returns the snapshot, or undefined when the turn has no events in the window.
 */
export function reduceTaskCard(events: readonly CardEvent[], turn: number): TaskCardSnapshot | undefined {
  let seen = false
  let status: TaskCardSnapshot['status'] = 'running'
  let startedAt: number | null = null
  let durationMs: number | null = null
  let toolCallCount = 0
  /** callId → tool name, insertion-ordered (Map preserves call order). */
  const open = new Map<string, string>()

  for (const event of events) {
    const data = event.data as { turn?: number }
    if (data?.turn !== turn) continue
    if (status !== 'running') continue // terminal folded: the card is frozen
    switch (event.type) {
      case 'turn/start':
        seen = true
        startedAt = event.time
        break
      case 'step/start':
      case 'step/end':
        seen = true
        break
      case 'tool/call': {
        seen = true
        const call = event.data as { callId: string; name: string }
        toolCallCount++
        open.set(call.callId, call.name)
        break
      }
      case 'tool/result': {
        seen = true
        const callId = resultCallId(event.data)
        if (callId !== null) open.delete(callId)
        break
      }
      case 'turn/end': {
        seen = true
        const reason = (event.data as { reason?: { kind?: string } }).reason
        switch (reason?.kind) {
          case 'completed': status = 'completed'; break
          case 'aborted': status = 'stopped'; break
          // Merge-extensible TurnEndReason: error, blocked, max-tokens, and
          // any future kind all present as a failure terminal.
          default: status = 'failed'
        }
        durationMs = startedAt === null ? null : event.time - startedAt
        open.clear()
        break
      }
      default:
        // Other session events (assistant/*, user/*, request/*) do not
        // change card state; they still mark the turn as observed.
        seen = true
    }
  }

  if (!seen) return undefined
  return {
    turn,
    status,
    currentTools: [...open.values()],
    toolCallCount,
    durationMs,
    startedAt,
  }
}

/** Feishu interactive-card payload (msg_type `interactive` content). */
export interface FeishuCard {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: { tag: 'div'; text: { tag: 'lark_md'; content: string } }[]
}

/** Duration as `X分Y秒` / `Y秒`; stable for card reproduction. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

/** Status → header copy and Feishu header color template. */
const STATUS_HEADER = {
  running: { title: '执行中', template: 'blue' },
  completed: { title: '已完成', template: 'green' },
  stopped: { title: '已停止', template: 'grey' },
  failed: { title: '任务失败', template: 'red' },
} as const

/** Card-facing token facts (design §6.3): count shown only when provider-anchored. */
export interface TokenInfo {
  /** Current request-and-response pressure from tokenMeter. */
  totalTokens: number
  /** True when the baseline is provider usage; false for heuristic estimates. */
  anchored: boolean
}

/**
 * Render one snapshot as a Feishu interactive card.
 *
 * Body rules (docs/weclaw-lessons.md): while running with no tool activity
 * the body is exactly one `思考中.....` hint; tool activity replaces it with
 * the current tool names and the running call count; a terminal card never
 * repeats the header state in the body — it keeps only the factual summary
 * (tool count, duration). The token line (design §6.3) shows the count only
 * for provider-anchored measurements, `未知` for estimates, and nothing when
 * no measurement was taken.
 * @param snapshot - the reduced turn state.
 * @param tokens - optional tokenMeter facts for the session.
 * @returns the card JSON for msg_type `interactive`.
 */
export function renderTaskCard(snapshot: TaskCardSnapshot, tokens?: TokenInfo): FeishuCard {
  const { title, template } = STATUS_HEADER[snapshot.status]
  const lines: string[] = []
  if (snapshot.status === 'running') {
    if (snapshot.currentTools.length === 0 && snapshot.toolCallCount === 0) {
      lines.push('思考中.....')
    } else {
      if (snapshot.currentTools.length > 0) {
        lines.push(`当前工具：${snapshot.currentTools.join('、')}`)
      }
      lines.push(`已调用工具 ${snapshot.toolCallCount} 次`)
    }
  } else {
    if (snapshot.toolCallCount > 0) lines.push(`共调用工具 ${snapshot.toolCallCount} 次`)
    if (snapshot.durationMs !== null) lines.push(`耗时 ${formatDuration(snapshot.durationMs)}`)
    if (lines.length === 0) lines.push('（无工具调用）')
  }
  if (tokens !== undefined) {
    lines.push(tokens.anchored ? `token 用量：${tokens.totalTokens}` : 'token 用量：未知（provider 未上报）')
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `第 ${snapshot.turn} 轮 · ${title}` }, template },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
  }
}
