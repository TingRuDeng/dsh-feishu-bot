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

import { escapeLarkMarkdownLiteral } from './lark-markdown.ts'

/** One turn's card-facing state, frozen at the terminal turn/end. */
export interface TaskCardSnapshot {
  /** The folded turn number. */
  turn: number
  /** running | completed | stopped | failed. */
  status: 'running' | 'completed' | 'stopped' | 'failed'
  /** Names of tools called but not yet resolved, in call order. Never arguments. */
  currentTools: string[]
  /** Names of the last few COMPLETED tools, oldest first (scrolling progress). */
  recentTools: string[]
  /** Total tool calls observed in this turn. */
  toolCallCount: number
  /** turn/start → turn/end span; null while running. */
  durationMs: number | null
  /** turn/start event time (ms epoch); null when the start is outside the window. */
  startedAt: number | null
  /** Stable provider-independent failure code; never an error message. */
  failureCode: string | null
  /** Number of model retry events observed before the terminal state. */
  retryCount: number
}

/** The event fields the reducer reads; structurally satisfied by SessionEvent. */
interface CardEvent {
  seq: number
  time: number
  type: string
  data: unknown
}

/** One direct human message in a bound session and every continuation it triggered. */
export interface FeishuTaskFold {
  /** Direct DSH user-message id; stable across internal turns. */
  taskMessageId: string
  /** Sequence of the direct Web/Feishu user/message event. */
  taskStartSeq: number
  /** Last sequence currently owned by this task. */
  scannedThrough: number
  /** True only after the current turn ended and every child started here settled. */
  settled: boolean
  /** Aggregated task-card view across all owned turns. */
  snapshot: TaskCardSnapshot
  /** Latest tool-free assistant text committed by a completed owned turn. */
  result?: { seq: number; text: string }
}

/** A task result ready for one canonical Feishu delivery. */
export interface FeishuTaskResult {
  taskStartSeq: number
  sourceEventSeq: number
  text: string
}

/** Result of scanning a projection suffix without crossing an open task. */
export interface FeishuTaskResultFold {
  results: FeishuTaskResult[]
  cursorThrough: number
}

interface UserMessageSource {
  kind?: unknown
  via?: unknown
  senderSessionId?: unknown
}

/** Direct human input in a bound session, as opposed to internal continuation input. */
export function directBoundTaskMessageId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as { id?: unknown; source?: UserMessageSource }
  const via = message.source?.via
  return message.source?.kind === 'user' && (via === 'feishu' || via === 'web')
    && typeof message.id === 'string'
    ? message.id
    : null
}

/** True for report/settlement messages that continue the active parent task. */
export function isInternalTaskMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const kind = (data as { source?: UserMessageSource }).source?.kind
  return kind === 'subagent-report' || kind === 'subagent-settled'
}

/** Extract text blocks only from a tool result surface, never from arguments. */
function contentTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const texts: string[] = []
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown; content?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
    if (Array.isArray(candidate.content)) texts.push(...contentTexts(candidate.content))
  }
  return texts
}

/** Parse the stable DSH tool rendering: `started subagent <session-id>`. */
function startedSubagentIds(event: CardEvent): string[] {
  let content: unknown
  if (event.type === 'tool/code-dispatch') {
    const data = event.data as { name?: unknown; isError?: unknown; content?: unknown }
    if (data.name !== 'subagent' || data.isError === true) return []
    content = data.content
  } else if (event.type === 'tool/result') {
    const first = (event.data as { message?: { content?: unknown } }).message?.content
    content = first
  } else {
    return []
  }
  const ids: string[] = []
  for (const text of contentTexts(content)) {
    for (const match of text.matchAll(/\bstarted subagent ([A-Za-z0-9._:-]+)/gu)) {
      const id = match[1]
      if (id !== undefined) ids.push(id)
    }
  }
  return ids
}

/** A model message is a result candidate only when it no longer requests tools. */
function assistantResult(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  if (content.some(block =>
    typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool-call')) return null
  const text = content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
  return text === '' ? null : text
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
  let failureCode: string | null = null
  let retryCount = 0
  let toolCallCount = 0
  let lastSequence = -1
  /** callId → tool name, insertion-ordered (Map preserves call order). */
  const open = new Map<string, string>()
  /** A stable call id represents one timeline row even when progress is refreshed. */
  const seenCalls = new Set<string>()
  const RECENT_CAP = 5
  const recent: string[] = []

  for (const event of events) {
    const data = event.data as { turn?: number }
    if (data?.turn !== turn) continue
    if (event.seq <= lastSequence) continue
    lastSequence = event.seq
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
        if (!seenCalls.has(call.callId)) {
          seenCalls.add(call.callId)
          toolCallCount++
        }
        open.set(call.callId, call.name)
        break
      }
      case 'tool/result': {
        seen = true
        const callId = resultCallId(event.data)
        if (callId !== null) {
          const name = open.get(callId)
          if (name !== undefined) {
            recent.push(name)
            if (recent.length > RECENT_CAP) recent.shift()
          }
          open.delete(callId)
        }
        break
      }
      case 'llm/retry': {
        seen = true
        retryCount++
        const code = (event.data as { failure?: { code?: unknown } }).failure?.code
        if (typeof code === 'string') failureCode = code
        break
      }
      case 'turn/end': {
        seen = true
        const reason = (event.data as {
          reason?: { kind?: string; error?: { code?: unknown } }
        }).reason
        switch (reason?.kind) {
          case 'completed': status = 'completed'; break
          case 'aborted': status = 'stopped'; break
          case 'error': {
            status = 'failed'
            const code = reason.error?.code
            if (typeof code === 'string') failureCode = code
            break
          }
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
    recentTools: recent,
    toolCallCount,
    durationMs,
    startedAt,
    failureCode,
    retryCount,
  }
}

/** Map one terminal reason onto the deliberately small card status surface. */
function terminalStatus(data: unknown): {
  status: Exclude<TaskCardSnapshot['status'], 'running'>
  failureCode: string | null
} {
  const reason = (data as {
    reason?: { kind?: string; error?: { code?: unknown } }
  }).reason
  if (reason?.kind === 'completed') return { status: 'completed', failureCode: null }
  if (reason?.kind === 'aborted') return { status: 'stopped', failureCode: null }
  const code = reason?.kind === 'error' ? reason.error?.code : undefined
  return {
    status: 'failed',
    failureCode: typeof code === 'string' ? code : null,
  }
}

/** Sender id carried by an internal subagent lifecycle message. */
function internalSenderId(data: unknown, kind: string): string | null {
  if (typeof data !== 'object' || data === null) return null
  const source = (data as { source?: UserMessageSource }).source
  return source?.kind === kind && typeof source.senderSessionId === 'string'
    ? source.senderSessionId
    : null
}

/**
 * Fold one direct Web/Feishu input and all of its internal continuation turns.
 * The fold stops before the next direct human input, so a human follow-up
 * always starts a new task even when an old child never reports settlement.
 */
export function reduceFeishuTask(
  events: readonly CardEvent[], fromSeq: number,
): FeishuTaskFold | undefined {
  let taskMessageId: string | null = null
  let taskStartSeq = -1
  let scannedThrough = fromSeq - 1
  let turn = 0
  let openTurn = false
  let startedAt: number | null = null
  let endedAt: number | null = null
  let terminal: Exclude<TaskCardSnapshot['status'], 'running'> = 'failed'
  let failureCode: string | null = null
  let retryCount = 0
  let toolCallCount = 0
  let lastSequence = -1
  let lastTurnEndSeq = -1
  let lastEndedTurn = 0
  let boundedByNextTask = false
  const openTools = new Map<string, string>()
  const seenCalls = new Set<string>()
  const recentTools: string[] = []
  const startedChildren = new Set<string>()
  const settledChildren = new Set<string>()
  const resultCandidates = new Map<number, { seq: number; text: string }>()
  let result: { seq: number; text: string } | undefined

  for (const event of events) {
    if (event.seq < fromSeq || event.seq <= lastSequence) continue
    lastSequence = event.seq

    if (event.type === 'user/message') {
      const directId = directBoundTaskMessageId(event.data)
      if (directId !== null) {
        if (taskMessageId !== null) {
          boundedByNextTask = true
          // turn/start precedes user/message, so the first event of the next
          // human task may already have been tentatively observed. Roll the
          // ownership boundary back to this task's last terminal event.
          if (lastTurnEndSeq >= taskStartSeq) {
            scannedThrough = lastTurnEndSeq
            turn = lastEndedTurn
          }
          openTurn = false
          break
        }
        taskMessageId = directId
        taskStartSeq = event.seq
        // A direct user/message is emitted inside an active turn. This also
        // covers projection windows that begin after the preceding turn/start.
        openTurn = true
      }
    }

    // Events before the direct user message may include its turn/start and
    // are retained only for the duration baseline. They never form a task.
    if (taskMessageId === null) {
      if (event.type === 'turn/start') {
        const eventTurn = (event.data as { turn?: unknown }).turn
        if (typeof eventTurn === 'number') turn = eventTurn
        startedAt = event.time
      }
      continue
    }

    scannedThrough = event.seq
    const eventTurn = (event.data as { turn?: unknown }).turn
    if (typeof eventTurn === 'number') turn = eventTurn

    switch (event.type) {
      case 'turn/start':
        openTurn = true
        if (startedAt === null) startedAt = event.time
        break
      case 'tool/call': {
        const call = event.data as { callId?: unknown; name?: unknown }
        if (typeof call.callId !== 'string' || typeof call.name !== 'string') break
        if (!seenCalls.has(call.callId)) {
          seenCalls.add(call.callId)
          toolCallCount++
        }
        openTools.set(call.callId, call.name)
        break
      }
      case 'tool/result': {
        for (const id of startedSubagentIds(event)) startedChildren.add(id)
        const callId = resultCallId(event.data)
        if (callId !== null) {
          const name = openTools.get(callId)
          if (name !== undefined) {
            recentTools.push(name)
            if (recentTools.length > 5) recentTools.shift()
          }
          openTools.delete(callId)
        }
        break
      }
      case 'tool/code-dispatch':
        for (const id of startedSubagentIds(event)) startedChildren.add(id)
        break
      case 'llm/retry': {
        retryCount++
        const code = (event.data as { failure?: { code?: unknown } }).failure?.code
        if (typeof code === 'string') failureCode = code
        break
      }
      case 'user/message': {
        const childId = internalSenderId(event.data, 'subagent-settled')
        if (childId !== null) settledChildren.add(childId)
        break
      }
      case 'assistant/message': {
        const text = assistantResult(event.data)
        if (text !== null) resultCandidates.set(turn, { seq: event.seq, text })
        break
      }
      case 'turn/end': {
        const mapped = terminalStatus(event.data)
        terminal = mapped.status
        failureCode = mapped.failureCode ?? failureCode
        openTurn = false
        endedAt = event.time
        lastTurnEndSeq = event.seq
        lastEndedTurn = turn
        openTools.clear()
        if (mapped.status === 'completed') {
          const candidate = resultCandidates.get(turn)
          if (candidate !== undefined) result = candidate
        }
        break
      }
    }
  }

  if (taskMessageId === null) return undefined
  const childrenSettled = [...startedChildren].every(id => settledChildren.has(id))
  const settled = boundedByNextTask || (!openTurn && childrenSettled)
  const status: TaskCardSnapshot['status'] = settled ? terminal : 'running'
  return {
    taskMessageId,
    taskStartSeq,
    scannedThrough,
    settled,
    snapshot: {
      turn,
      status,
      currentTools: [...openTools.values()],
      recentTools,
      toolCallCount,
      durationMs: settled && startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
      startedAt,
      failureCode,
      retryCount,
    },
    result,
  }
}

/**
 * Project only settled direct human tasks from a bound session. An open task keeps the cursor
 * immediately before its direct input so restart can deterministically
 * rebuild the same task-wide result from the durable session log.
 */
export function foldFeishuTaskResults(
  events: readonly CardEvent[], fromSeq: number,
): FeishuTaskResultFold {
  const ordered = events
    .filter(event => event.seq >= fromSeq)
    .sort((left, right) => left.seq - right.seq)
  const results: FeishuTaskResult[] = []
  let cursorThrough = fromSeq - 1
  let index = 0

  while (index < ordered.length) {
    const event = ordered[index]!
    if (event.type !== 'user/message' || directBoundTaskMessageId(event.data) === null) {
      cursorThrough = event.seq
      index++
      continue
    }

    const fold = reduceFeishuTask(ordered, event.seq)
    if (fold === undefined) {
      cursorThrough = event.seq
      index++
      continue
    }
    if (!fold.settled) break
    if (fold.result !== undefined) {
      results.push({
        taskStartSeq: fold.taskStartSeq,
        sourceEventSeq: fold.scannedThrough,
        text: fold.result.text,
      })
    }
    cursorThrough = fold.scannedThrough
    while (index < ordered.length && ordered[index]!.seq <= fold.scannedThrough) index++
  }

  return { results, cursorThrough }
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

/** Error codes safe to surface to end users. Unknown codes remain private. */
const FAILURE_LABELS: Readonly<Record<string, string>> = {
  EMPTY_RESPONSE: '模型未返回内容',
  RATE_LIMIT: '请求过于频繁',
  SERVER: '模型服务异常',
  SERVICE_UNAVAILABLE: '模型服务暂不可用',
  TIMEOUT: '模型请求超时',
  TRANSPORT: '模型连接异常',
  STREAM_CLOSED: '模型连接意外关闭',
  CONTEXT_WINDOW_EXCEEDED: '会话上下文过长',
  QUOTA: '模型额度不足',
  NO_ADAPTER: '模型适配器不可用',
  UNKNOWN_MODEL: '未找到指定模型',
  INVALID_REQUEST: '模型请求无效',
  AUTH: '模型认证失败',
  INVALID_CREDENTIAL: '模型凭据无效',
  MISSING_CREDENTIAL: '缺少模型凭据',
}

/** Render a diagnostic without ever copying an arbitrary provider string. */
function formatFailure(snapshot: TaskCardSnapshot): string {
  const code = snapshot.failureCode
  const isAllowed = code !== null && Object.prototype.hasOwnProperty.call(FAILURE_LABELS, code)
  const label = isAllowed ? FAILURE_LABELS[code] : '未知错误'
  const details: string[] = []
  if (isAllowed) details.push(code)
  if (snapshot.retryCount > 0) details.push(`已重试 ${snapshot.retryCount} 次`)
  return `失败原因：${label}${details.length > 0 ? `（${details.join('，')}）` : ''}`
}

const ACTIVE_THINKING_INDICATOR = '思考中.....'

/** Append the active marker once, preserving snapshot-style idempotence. */
function appendActiveThinkingIndicator(body: string): string {
  return body.endsWith(ACTIVE_THINKING_INDICATOR)
    ? body
    : `${body}${body.length > 0 ? '\n' : ''}${ACTIVE_THINKING_INDICATOR}`
}

/** Terminal cards must never retain a running-state marker. */
function trimActiveThinkingIndicator(body: string): string {
  if (!body.endsWith(ACTIVE_THINKING_INDICATOR)) return body
  return body.slice(0, -ACTIVE_THINKING_INDICATOR.length).replace(/\n$/, '')
}

/** Card-facing token facts (design §6.3): count shown only when provider-anchored. */
export interface TokenInfo {
  /** Current request-and-response pressure from tokenMeter. */
  totalTokens: number
  /** True when the baseline is provider usage; false for heuristic estimates. */
  anchored: boolean
}

/** Card presentation context beyond the snapshot itself. */
export interface TaskCardContext {
  /** Card title (the session's workspace basename); falls back to 任务. */
  title?: string
}

/**
 * Render one snapshot as a Feishu interactive card.
 *
 * Body rules (docs/weclaw-lessons.md): while running with no tool activity
 * the body is exactly one `思考中.....` hint; tool activity is rendered as
 * a scrolling progress view — the last few completed tools (✅-prefixed)
 * above the currently running ones — plus the call count, and the active
 * hint remains as an idempotent tail marker; a terminal card
 * never repeats the header state in the body — it keeps only the factual
 * summary (tool count, duration). The token line (design §6.3) shows the
 * count only for provider-anchored measurements, `未知` for estimates, and
 * nothing when no measurement was taken. The header is the workspace name
 * with the status; turn numbers are internal and never rendered.
 * @param snapshot - the reduced turn state.
 * @param tokens - optional tokenMeter facts for the session.
 * @param context - optional presentation context (workspace title).
 * @returns the card JSON for msg_type `interactive`.
 */
export function renderTaskCard(snapshot: TaskCardSnapshot, tokens?: TokenInfo, context?: TaskCardContext): FeishuCard {
  const { title, template } = STATUS_HEADER[snapshot.status]
  const lines: string[] = []
  if (snapshot.status === 'running') {
    if (snapshot.currentTools.length > 0 || snapshot.toolCallCount > 0) {
      for (const name of snapshot.recentTools) lines.push(`✅ ${escapeLarkMarkdownLiteral(name)}`)
      for (const name of snapshot.currentTools) lines.push(`▸ ${escapeLarkMarkdownLiteral(name)} …`)
      lines.push(`已调用工具 ${snapshot.toolCallCount} 次`)
    }
  } else {
    if (snapshot.status === 'failed') lines.push(formatFailure(snapshot))
    if (snapshot.toolCallCount > 0) lines.push(`共调用工具 ${snapshot.toolCallCount} 次`)
    if (snapshot.durationMs !== null) lines.push(`耗时 ${formatDuration(snapshot.durationMs)}`)
    if (lines.length === 0) lines.push('（无工具调用）')
  }
  if (tokens !== undefined) {
    lines.push(tokens.anchored ? `token 用量：${tokens.totalTokens}` : 'token 用量：未知（provider 未上报）')
  }
  const body = snapshot.status === 'running'
    ? appendActiveThinkingIndicator(lines.join('\n'))
    : trimActiveThinkingIndicator(lines.join('\n'))
  const name = context?.title ?? '任务'
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${name} · ${title}` }, template },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  }
}
