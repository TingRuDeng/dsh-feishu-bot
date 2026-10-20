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

import { normalizeProgressDetail, type ProgressDetail } from './display.ts'
import { RESULT_CARD_SOFT_LIMIT_BYTES } from './result-card.ts'
import { escapeLarkMarkdownLiteral } from './lark-markdown.ts'
import {
  describeToolCall,
  groupActivityLines,
  type ActivityLine,
} from './tool-activity.ts'

/** One turn's card-facing state, frozen at the terminal turn/end. */
export interface TaskCardSnapshot {
  /** The folded turn number. */
  turn: number
  /** running | completed | stopped | failed. */
  status: 'running' | 'completed' | 'stopped' | 'failed'
  /** Names of tools called but not yet resolved, in call order. Never arguments. */
  currentTools: string[]
  /**
   * One-line description of what each OPEN tool is doing, keyed by tool name
   * and derived from that call's arguments (a command, a path, a query).
   * Undefined when the call exposes nothing worth showing.
   *
   * Name-keyed, so two concurrent calls to the same tool collapse into one
   * entry. Use {@link currentToolsList} whenever per-call detail matters.
   */
  toolDetails?: Record<string, string | undefined>
  /**
   * The OPEN calls in call order, each carrying its own detail.
   *
   * A name-keyed record cannot represent two `bash` calls at once: the second
   * detail overwrote the first and the card printed one line twice. Rendering
   * reads this list, which is per-call and therefore lossless.
   */
  currentToolsList?: readonly ToolProgressEntry[]
  /** Names of the last few COMPLETED tools, oldest first (scrolling progress). */
  recentTools: string[]
  /**
   * Detail copy for {@link recentTools}, keyed by tool name.
   *
   * Name-keyed, so a task that calls one tool several times (the common case)
   * collapses every entry onto the last detail. Use
   * {@link recentToolDetailsList} for per-call detail.
   */
  recentToolDetails?: Record<string, string | undefined>
  /** The COMPLETED calls, oldest first, each carrying its own detail. */
  recentToolDetailsList?: readonly ToolProgressEntry[]
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

/** One tool call's card row: the tool's name and its one-line description. */
export interface ToolProgressEntry {
  /** Tool name as reported by the harness; never arguments. */
  name: string
  /** One-line description derived from that call's arguments, when it had one. */
  detail?: string
}

/** Build one per-call card row, omitting an absent detail. */
function toProgressEntry(name: string, detail: string | undefined): ToolProgressEntry {
  return detail === undefined ? { name } : { name, detail }
}

/**
 * The completed calls to show, per call.
 *
 * Prefers the ordered list. Falls back to the name-keyed pair only for
 * snapshots built by older callers, so nothing renders an empty progress view
 * merely because it predates the list form.
 * @param snapshot - the folded snapshot.
 * @returns one row per completed call, oldest first.
 */
function completedToolRows(snapshot: TaskCardSnapshot): readonly ToolProgressEntry[] {
  if (snapshot.recentToolDetailsList !== undefined) return snapshot.recentToolDetailsList
  return snapshot.recentTools.map((name) => toProgressEntry(name, snapshot.recentToolDetails?.[name]))
}

/**
 * The open calls to show, per call.
 * @param snapshot - the folded snapshot.
 * @returns one row per open call, in call order.
 */
function openToolRows(snapshot: TaskCardSnapshot): readonly ToolProgressEntry[] {
  if (snapshot.currentToolsList !== undefined) return snapshot.currentToolsList
  return snapshot.currentTools.map((name) => toProgressEntry(name, snapshot.toolDetails?.[name]))
}

/** The event fields the reducer reads; structurally satisfied by SessionEvent. */
export interface CardEvent {
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

/**
 * Direct human input in a bound session, as opposed to internal continuation input.
 *
 * `via` names the frontend that submitted the input, but it is NOT always set:
 * a task started in the Web GUI can arrive as a plain `kind: 'user'` message
 * with no `via` at all. Requiring it meant such tasks were never recognized —
 * the projection held no task, so binding to that session reported nothing and
 * the operator saw no progress for work that was plainly running.
 *
 * The internal kinds are therefore excluded by name instead of being excluded
 * by the absence of a marker.
 */
export function directBoundTaskMessageId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as { id?: unknown; source?: UserMessageSource }
  const source = message.source
  if (source?.kind !== 'user' || typeof message.id !== 'string') return null
  const via = source.via
  // An explicit marker from another frontend is not a task of this bridge's
  // chat unless it is one this bridge serves.
  if (via !== undefined && via !== 'feishu' && via !== 'web') return null
  return message.id
}

/** True for report/settlement messages that continue the active parent task. */
export function isInternalTaskMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const kind = (data as { source?: UserMessageSource }).source?.kind
  return kind === 'subagent-report' || kind === 'subagent-settled'
}

/**
 * Argument keys worth showing as a one-line detail, most specific first.
 *
 * Mirrors the Web GUI's live tool detail so both frontends describe a call the
 * same way. `title`/`description` come first because a tool that names its own
 * work says it best; `command`/`path`/`pattern` cover the common shell and
 * filesystem calls.
 */
const TOOL_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name',
  'question', 'prompt', 'message', 'command', 'cmd', 'queries', 'query',
  'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

/** Longest detail kept on a card; longer values are truncated with an ellipsis. */
const TOOL_DETAIL_MAX_CHARS = 80

/**
 * One-line description of what a tool call is doing.
 *
 * A card that lists only tool names ("bash… edit…") tells the operator nothing
 * about the work. The call's arguments are already in the session log, so the
 * first key carrying text becomes the detail. This is deliberately a WHITELIST:
 * an unrecognized argument is never rendered, so a tool that passes a secret in
 * an unusual field cannot leak it onto a chat card.
 * @param args - the call's decoded arguments, if any.
 * @returns display copy, or undefined to let the renderer show the bare name.
 */
export function toolDetail(args: unknown): string | undefined {
  if (typeof args === 'string') {
    const parsed = args.trim()
    if (parsed === '') return undefined
    try {
      return toolDetail(JSON.parse(parsed))
    } catch {
      // A non-JSON argument string is the detail itself (e.g. a raw prompt).
      return clipDetail(parsed)
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of TOOL_DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === 'string') {
      const clipped = clipDetail(value)
      if (clipped !== undefined) return clipped
      continue
    }
    // A list of queries/patterns reads better joined than omitted; only the
    // first few entries are kept so one huge array cannot fill the card.
    if (Array.isArray(value)) {
      const parts = value.filter((entry): entry is string => typeof entry === 'string')
      if (parts.length === 0) continue
      const joined = clipDetail(parts.slice(0, 3).join('、'))
      if (joined !== undefined) return joined
    }
  }
  return undefined
}

function clipDetail(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return undefined
  if (normalized.length <= TOOL_DETAIL_MAX_CHARS) return normalized
  return `${normalized.slice(0, TOOL_DETAIL_MAX_CHARS - 1).trimEnd()}…`
}

/** Extract text blocks only from a tool result surface, never from arguments. */
function contentTexts(value: unknown): string[] {  if (!Array.isArray(value)) return []
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
  /** callId → one-line detail from that call's arguments, when it has one. */
  const openDetails = new Map<string, string>()
  /** A stable call id represents one timeline row even when progress is refreshed. */
  const seenCalls = new Set<string>()
  const RECENT_CAP = 5
  const recent: string[] = []
  const recentDetails: string[] = []

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
        const call = event.data as { callId: string; name: string; arguments?: unknown }
        if (!seenCalls.has(call.callId)) {
          seenCalls.add(call.callId)
          toolCallCount++
        }
        open.set(call.callId, call.name)
        const detail = toolDetail(call.arguments)
        if (detail === undefined) openDetails.delete(call.callId)
        else openDetails.set(call.callId, detail)
        break
      }
      case 'tool/result': {
        seen = true
        const callId = resultCallId(event.data)
        if (callId !== null) {
          const name = open.get(callId)
          if (name !== undefined) {
            recent.push(name)
            recentDetails.push(openDetails.get(callId) ?? name)
            while (recent.length > RECENT_CAP) {
              recent.shift()
              recentDetails.shift()
            }
          }
          open.delete(callId)
          openDetails.delete(callId)
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
        openDetails.clear()
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
    toolDetails: Object.fromEntries(
      [...open].map(([callId, name]) => [name, openDetails.get(callId)] as const)
        .filter(([, detail]) => detail !== undefined)),
    // Per-call rows: the name-keyed view above cannot represent two calls to
    // the same tool, so the ordered list is what the card actually renders.
    currentToolsList: [...open].map(([callId, name]) => toProgressEntry(name, openDetails.get(callId))),
    recentTools: recent,
    recentToolDetails: Object.fromEntries(
      recent.map((name, index) => [name, recentDetails[index]])),
    recentToolDetailsList: recent.map((name, index) => toProgressEntry(name, recentDetails[index])),
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
 * Event types the task fold consumes.
 *
 * Shared with the projection, where the registry drives every committed event
 * through `apply`: an event outside this set must leave the state reference
 * untouched, or every unrelated event would look like a change.
 */
export const FEISHU_TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user/message', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'tool/call', 'tool/result', 'tool/code-dispatch', 'llm/retry', 'assistant/message',
])

/**
 * The serialized shape of an in-flight fold.
 *
 * This is the shared state machine behind both {@link reduceFeishuTask} (a
 * range scan) and the `feishuTask` projection (driven one committed event at a
 * time). Keeping one implementation means the two cannot drift: the projection
 * supplies the starting state and feeds events; the batch reference loops.
 *
 * Every field is JSON-serializable because a projection checkpoint runs
 * `structuredClone` over the state and re-seeds the fold through `stateSchema`.
 * The batch fold's `Map`/`Set` bookkeeping is therefore held as records and
 * arrays here.
 */
export interface FeishuTaskFoldState {
  taskMessageId: string | null
  taskStartSeq: number
  scannedThrough: number
  turn: number
  openTurn: boolean
  startedAt: number | null
  endedAt: number | null
  terminal: Exclude<TaskCardSnapshot['status'], 'running'>
  failureCode: string | null
  retryCount: number
  toolCallCount: number
  lastSequence: number
  lastTurnEndSeq: number
  lastEndedTurn: number
  /**
   * Time of the most recent `turn/start`, regardless of whether it seeded
   * `startedAt`. A projection restarting at a newer direct input needs the
   * baseline of the turn that actually opened that input, which `startedAt`
   * cannot supply once it is pinned to an older turn.
   */
  lastTurnStartTime: number | null
  lastTurnStartTurn: number
  boundedByNextTask: boolean
  openTools: Record<string, string>
  /** One-line detail per OPEN callId, harvested from its arguments. */
  openToolDetails: Record<string, string>
  seenCalls: string[]
  recentTools: string[]
  /** Detail copy aligned with {@link recentTools}, oldest first. */
  recentToolDetails: string[]
  startedChildren: string[]
  settledChildren: string[]
  resultCandidates: Record<string, { seq: number; text: string }>
  result?: { seq: number; text: string }
}

/** Fresh fold state for `fromSeq`; events before it are ignored. */
export function initFeishuTaskFoldState(fromSeq: number): FeishuTaskFoldState {
  return {
    taskMessageId: null,
    taskStartSeq: -1,
    scannedThrough: fromSeq - 1,
    turn: 0,
    openTurn: false,
    startedAt: null,
    endedAt: null,
    terminal: 'failed',
    failureCode: null,
    retryCount: 0,
    toolCallCount: 0,
    lastSequence: -1,
    lastTurnEndSeq: -1,
    lastEndedTurn: 0,
    lastTurnStartTime: null,
    lastTurnStartTurn: 0,
    boundedByNextTask: false,
    openTools: {},
    openToolDetails: {},
    seenCalls: [],
    recentTools: [],
    recentToolDetails: [],
    startedChildren: [],
    settledChildren: [],
    resultCandidates: {},
  }
}

/** One optimistically applied event, plus how it affected the task boundary. */
export interface FeishuTaskFoldStepResult {
  /** False when the event was irrelevant, out of range, or belonged to no task. */
  applied: boolean
  /** True when this event opened the fold's first task. */
  opened: boolean
  /**
   * True when this direct input bounds the previous task. A range scan stops
   * here (one card is one task); a projection restarts here instead.
   */
  boundsTask: boolean
}

/**
 * Fold one committed event into `state`, mutating it in place.
 *
 * The batch reference mutates through this same function, so a projection and
 * a range scan share one definition of the boundary rules. Callers own the
 * `seq` range decision: `FeishuTaskFoldState.lastSequence` enforces monotonic
 * progress, but the caller decides which events to offer at all.
 * @param state - fold state to advance.
 * @param event - the next event in seq order.
 * @param fromSeq - inclusive lower bound; earlier events are ignored.
 * @returns how the event was classified.
 */
export function foldFeishuTaskStep(
  state: FeishuTaskFoldState, event: CardEvent, fromSeq: number = 0,
): FeishuTaskFoldStepResult {
  if (event.seq < fromSeq || event.seq <= state.lastSequence) {
    return { applied: false, opened: false, boundsTask: false }
  }

  // Only events the fold actually consumes advance the watermark. A projection
  // drives every committed event through here, so advancing on irrelevant
  // events would make the state (and its reference) change for no reason.
  if (!FEISHU_TASK_EVENT_TYPES.has(event.type)) {
    return { applied: false, opened: false, boundsTask: false }
  }
  state.lastSequence = event.seq

  if (event.type === 'user/message') {
    const directId = directBoundTaskMessageId(event.data)
    if (directId !== null) {
      if (state.taskMessageId !== null) {
        state.boundedByNextTask = true
        // turn/start precedes user/message, so the first event of the next
        // human task may already have been tentatively observed. Roll the
        // ownership boundary back to this task's last terminal event.
        if (state.lastTurnEndSeq >= state.taskStartSeq) {
          state.scannedThrough = state.lastTurnEndSeq
          state.turn = state.lastEndedTurn
        }
        state.openTurn = false
        return { applied: true, opened: false, boundsTask: true }
      }
      state.taskMessageId = directId
      state.taskStartSeq = event.seq
      // A direct user/message is emitted inside an active turn. This also
      // covers projection windows that begin after the preceding turn/start.
      state.openTurn = true
      state.scannedThrough = event.seq
      return { applied: true, opened: true, boundsTask: false }
    }
  }

  // Events before the direct user message may include its turn/start and
  // are retained only for the duration baseline. They never form a task, but
  // they do mutate the state, so they must not report "not applied": a caller
  // that discards an unapplied result would lose the duration baseline.
  if (state.taskMessageId === null) {
    if (event.type === 'turn/start') {
      const eventTurn = (event.data as { turn?: unknown }).turn
      if (typeof eventTurn === 'number') state.turn = eventTurn
      state.startedAt = event.time
      state.lastTurnStartTime = event.time
      state.lastTurnStartTurn = state.turn
      return { applied: true, opened: false, boundsTask: false }
    }
    return { applied: false, opened: false, boundsTask: false }
  }

  applyFeishuTaskEvent(state, event)
  return { applied: true, opened: false, boundsTask: false }
}

/** Fold one event already proven to belong to the open task. */
function applyFeishuTaskEvent(state: FeishuTaskFoldState, event: CardEvent): void {
  const taskMessageId = state.taskMessageId
  const taskStartSeq = state.taskStartSeq
  let scannedThrough = state.scannedThrough
  let turn = state.turn
  let openTurn = state.openTurn
  let startedAt = state.startedAt
  let endedAt = state.endedAt
  let terminal = state.terminal
  let failureCode = state.failureCode
  let retryCount = state.retryCount
  let toolCallCount = state.toolCallCount
  let lastTurnEndSeq = state.lastTurnEndSeq
  let lastEndedTurn = state.lastEndedTurn
  let lastTurnStartTime = state.lastTurnStartTime
  let lastTurnStartTurn = state.lastTurnStartTurn
  const openTools = new Map(Object.entries(state.openTools))
  const openToolDetails = new Map(Object.entries(state.openToolDetails))
  const seenCalls = new Set(state.seenCalls)
  const recentTools = [...state.recentTools]
  const recentToolDetails = [...state.recentToolDetails]
  const startedChildren = new Set(state.startedChildren)
  const settledChildren = new Set(state.settledChildren)
  const resultCandidates = new Map(
    Object.entries(state.resultCandidates).map(([key, value]) => [Number(key), value] as const))
  let result = state.result

  {
    scannedThrough = event.seq
    const eventTurn = (event.data as { turn?: unknown }).turn
    if (typeof eventTurn === 'number') turn = eventTurn

    switch (event.type) {
      case 'turn/start':
        openTurn = true
        if (startedAt === null) startedAt = event.time
        lastTurnStartTime = event.time
        lastTurnStartTurn = turn
        break
      case 'tool/call': {
        const call = event.data as { callId?: unknown; name?: unknown; arguments?: unknown }
        if (typeof call.callId !== 'string' || typeof call.name !== 'string') break
        if (!seenCalls.has(call.callId)) {
          seenCalls.add(call.callId)
          toolCallCount++
        }
        openTools.set(call.callId, call.name)
        // Keep the detail beside the call so a card refresh mid-call shows what
        // is running, and a finished call can carry it into the recent list.
        const detail = toolDetail(call.arguments)
        if (detail === undefined) openToolDetails.delete(call.callId)
        else openToolDetails.set(call.callId, detail)
        break
      }
      case 'tool/result': {
        for (const id of startedSubagentIds(event)) startedChildren.add(id)
        const callId = resultCallId(event.data)
        if (callId !== null) {
          const name = openTools.get(callId)
          if (name !== undefined) {
            recentTools.push(name)
            recentToolDetails.push(openToolDetails.get(callId) ?? name)
            while (recentTools.length > 5) {
              recentTools.shift()
              recentToolDetails.shift()
            }
          }
          openTools.delete(callId)
          openToolDetails.delete(callId)
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
        openToolDetails.clear()
        if (mapped.status === 'completed') {
          const candidate = resultCandidates.get(turn)
          if (candidate !== undefined) result = candidate
        }
        break
      }
    }
  }

  state.taskMessageId = taskMessageId
  state.taskStartSeq = taskStartSeq
  state.scannedThrough = scannedThrough
  state.turn = turn
  state.openTurn = openTurn
  state.startedAt = startedAt
  state.endedAt = endedAt
  state.terminal = terminal
  state.failureCode = failureCode
  state.retryCount = retryCount
  state.toolCallCount = toolCallCount
  state.lastTurnEndSeq = lastTurnEndSeq
  state.lastEndedTurn = lastEndedTurn
  state.lastTurnStartTime = lastTurnStartTime
  state.lastTurnStartTurn = lastTurnStartTurn
  state.openTools = Object.fromEntries(openTools)
  state.openToolDetails = Object.fromEntries(openToolDetails)
  state.seenCalls = [...seenCalls]
  state.recentTools = recentTools
  state.recentToolDetails = recentToolDetails
  state.startedChildren = [...startedChildren]
  state.settledChildren = [...settledChildren]
  state.resultCandidates = Object.fromEntries(
    [...resultCandidates].map(([key, value]) => [String(key), value]))
  state.result = result
}

/**
 * Materialize the observable fold from a finished fold state.
 * @param state - a state that has observed at least one direct input.
 * @returns the task fold, or undefined when no direct input was seen.
 */
export function feishuTaskFoldFromState(state: FeishuTaskFoldState): FeishuTaskFold | undefined {
  const {
    taskMessageId, taskStartSeq, scannedThrough, turn, openTurn, startedAt, endedAt,
    terminal, failureCode, retryCount, toolCallCount, boundedByNextTask, openTools, result,
  } = state
  if (taskMessageId === null) return undefined
  const settledChildren = new Set(state.settledChildren)
  const childrenSettled = state.startedChildren.every(id => settledChildren.has(id))
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
      currentTools: Object.values(openTools),
      toolDetails: Object.fromEntries(
        Object.entries(openTools)
          .map(([callId, name]) => [name, state.openToolDetails[callId]] as const)
          .filter(([, detail]) => detail !== undefined)),
      // Per-call rows: two calls to one tool name stay distinguishable.
      currentToolsList: Object.entries(openTools)
        .map(([callId, name]) => toProgressEntry(name, state.openToolDetails[callId])),
      recentTools: state.recentTools,
      recentToolDetails: Object.fromEntries(
        state.recentTools.map((name, index) => [name, state.recentToolDetails[index]])),
      recentToolDetailsList: state.recentTools
        .map((name, index) => toProgressEntry(name, state.recentToolDetails[index])),
      toolCallCount,
      durationMs: settled && startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
      startedAt,
      failureCode,
      retryCount,
    },
    ...(result === undefined ? {} : { result }),
  }
}

/**
 * Fold one direct Web/Feishu input and all of its internal continuation turns.
 * The fold stops before the next direct human input, so a human follow-up
 * always starts a new task even when an old child never reports settlement.
 */
export function reduceFeishuTask(
  events: readonly CardEvent[], fromSeq: number,
): FeishuTaskFold | undefined {
  const state = initFeishuTaskFoldState(fromSeq)
  for (const event of events) {
    const step = foldFeishuTaskStep(state, event, fromSeq)
    // A newer direct input bounds this task: the batch reference stops so the
    // caller sees exactly one task. The projection restarts instead.
    if (step.boundsTask) break
  }
  return feishuTaskFoldFromState(state)
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

/**
 * Feishu interactive-card payload (msg_type `interactive` content).
 *
 * `elements` is deliberately `unknown[]` rather than a narrow div shape: a task
 * card carries an interactive block (an action row, an hr) whenever a pending
 * decision belongs to it.
 */
export interface FeishuCard {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: unknown[]
}

/** Duration as `X分Y秒` / `Y秒`; stable for card reproduction. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

/**
 * Feishu's documented ceiling for one create-message payload, mirrored from the
 * result-card path so both card families agree on the same number.
 */
export const TASK_CARD_MAX_BYTES = RESULT_CARD_SOFT_LIMIT_BYTES

/**
 * Drop progress rows until the rendered card fits Feishu's ceiling.
 *
 * A card over the ceiling makes `patchCard` reject, and the card actor then
 * freezes the tracker — so the chat's progress card stops updating for the rest
 * of the task, silently and permanently. Trimming is strictly better than that:
 * the newest rows survive (they describe what is happening RIGHT NOW) and one
 * final row states how much was withheld.
 *
 * Trimming works on whole lines so no Markdown construct is cut in half. The
 * disclosure row is reserved for before any line is measured, so the trim
 * always terminates.
 * @param lines - body rows, oldest first, excluding the thinking tail.
 * @param render - builds the complete card from a body string, for measuring.
 * @param maxBytes - ceiling for the whole serialized card.
 * @returns the lines to render, possibly with a trailing disclosure row.
 */
function trimBodyToCeiling(
  lines: readonly string[], render: (body: string) => object, maxBytes: number,
): string[] {
  const fits = (body: string): boolean =>
    Buffer.byteLength(JSON.stringify(render(body)), 'utf8') <= maxBytes
  if (fits(lines.join('\n'))) return [...lines]
  // Measure with a pessimistic disclosure row so the real one cannot overflow.
  let kept = lines.length
  let hidden = 0
  while (kept > 0) {
    kept -= 1
    hidden = lines.length - kept
    const candidate = [...lines.slice(0, kept), `还有 ${hidden} 条进度未显示`]
    if (fits(candidate.join('\n'))) return candidate
  }
  return [`还有 ${lines.length} 条进度未显示`]
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
  /** Presentation tier: summary hides token usage, full includes it. */
  progressDetail?: ProgressDetail | string
  /**
   * True when this card was recovered from the durable log after a restart
   * rather than streamed live. It says so on the card, because a resumed card
   * is otherwise indistinguishable from one this process has been updating all
   * along — the operator cannot tell whether the history is complete.
   */
  resumed?: boolean
  /**
   * Interactive elements belonging to the same task, appended below the
   * progress body.
   *
   * A pending question is answered with buttons, and those buttons used to be
   * sent as a card of their own. Every such card pushed the progress card
   * further up the chat, so a few of them buried the very thing the operator
   * was watching. They belong on the card of the task that is waiting for them.
   */
  interactive?: readonly unknown[]
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
  const detail = normalizeProgressDetail(context?.progressDetail)
  const lines: string[] = []
  // A recovered card is incomplete by nature: it knows only what the log holds,
  // not whether the task has moved on since. Saying so prevents the operator
  // from mistaking a resumed card for a live one.
  if (context?.resumed === true) lines.push('🔄 已从重启前的记录恢复，下方为当时进度')
  if (snapshot.status === 'running') {
    if (snapshot.currentTools.length > 0 || snapshot.toolCallCount > 0) {
      // Describe what the agent is DOING, in the Web GUI's own vocabulary.
      // A raw argument fragment ("src/bridge/index.ts") never says whether the
      // file is being read, written, or edited, and a bare tool name ("bash")
      // says nothing at all. Each call is classified into an activity and
      // rendered as an activity phrase plus, when the call exposes one, the
      // subject it acts on.
      const completedLines: ActivityLine[] = completedToolRows(snapshot).map(entry =>
        describeToolCall(entry.name, entry.detail, 'done'))
      const openLines: ActivityLine[] = openToolRows(snapshot).map(entry =>
        describeToolCall(entry.name, entry.detail, 'running'))
      // Repetition collapses into a count: reading five files is one row, the
      // same way the Web GUI summarizes a step rather than listing every call.
      // Distinct subjects are all kept, so two different commands never
      // collapse into one row that hides the other.
      for (const group of groupActivityLines(completedLines)) {
        const label = group.count > 1 ? `${group.verb} ${group.count} 个` : group.verb
        const subjects = detail === 'concise' ? [] : group.subjects
        lines.push(`✅ ${escapeLarkMarkdownLiteral(label)}${
          subjects.length === 0 ? '' : ` · ${subjects.map(subject =>
            escapeLarkMarkdownLiteral(subject)).join('、')}`}`)
      }
      // Open calls are never grouped: each one is *currently* happening, and
      // "正在读取文件 3 个" would hide that several things run at once.
      for (const line of openLines) {
        lines.push(`▸ ${escapeLarkMarkdownLiteral(line.verb)}${
          detail === 'concise' || line.subject === undefined
            ? ''
            : ` · ${escapeLarkMarkdownLiteral(line.subject)}`} …`)
      }
      if (detail !== 'concise') lines.push(`已调用工具 ${snapshot.toolCallCount} 次`)
    }
  } else {
    if (snapshot.status === 'failed') lines.push(formatFailure(snapshot))
    // Name the work that was done (or was in flight) by activity, so a failure
    // says WHAT failed rather than only that something did.
    if (snapshot.toolCallCount > 0 && detail !== 'concise') {
      const done = groupActivityLines(completedToolRows(snapshot).map(entry =>
        describeToolCall(entry.name, entry.detail, 'done')))
      const summary = done.map(group => group.count > 1
        ? `${group.verb} ${group.count} 个`
        : group.verb).join('，')
      lines.push(summary === '' ? `共调用工具 ${snapshot.toolCallCount} 次` : `${summary}（共 ${snapshot.toolCallCount} 次）`)
    } else if (snapshot.toolCallCount > 0) {
      lines.push(`共调用工具 ${snapshot.toolCallCount} 次`)
    }
    if (detail !== 'concise' && snapshot.durationMs !== null) lines.push(`耗时 ${formatDuration(snapshot.durationMs)}`)
    if (lines.length === 0) lines.push('（无工具调用）')
  }
  if (detail === 'full' && tokens !== undefined) {
    lines.push(tokens.anchored ? `token 用量：${tokens.totalTokens}` : 'token 用量：未知（provider 未上报）')
  }
  const hasProgress = snapshot.currentTools.length > 0 || snapshot.toolCallCount > 0
  const titleText = snapshot.status === 'running' && !hasProgress ? '思考中.....' : title
  const name = context?.title ?? '任务'
  const assemble = (body: string): object => {
    const elements: unknown[] = body === ''
      ? []
      : [{ tag: 'div', text: { tag: 'lark_md', content: body } }]
    // A separator only earns its place when there is progress to separate from.
    if (context?.interactive !== undefined && context.interactive.length > 0) {
      if (elements.length > 0) elements.push({ tag: 'hr' })
      elements.push(...context.interactive)
    }
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `${name} · ${titleText}` }, template },
      elements,
    }
  }
  const finish = (rows: readonly string[]): string => snapshot.status === 'running'
    ? hasProgress ? appendActiveThinkingIndicator(rows.join('\n')) : ''
    : trimActiveThinkingIndicator(rows.join('\n'))
  // Measure the complete card, not just the body: the ceiling applies to the
  // create-message payload Feishu receives, and every wrapper field counts.
  const rows = trimBodyToCeiling(lines, body => assemble(finish(body.split('\n'))), TASK_CARD_MAX_BYTES)
  return assemble(finish(rows)) as FeishuCard
}
