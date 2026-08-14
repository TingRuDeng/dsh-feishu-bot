/**
 * The feishu-bridge plugin (design §6): chat↔session bindings, commands,
 * the inbound idempotent state machine with startup reconciliation, and the
 * outbound projection with per-chat FIFO delivery.
 *
 * Ordering: all inbound work for one chat runs on that chat's serial queue —
 * startup recovery enqueues onto the same queues, so recovered and fresh
 * events cannot interleave. Approval answering and M4 recovery share the
 * same durable binding and queue boundaries.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { FeishuInboundMessage } from '../gateway/index.ts'
import { auditHash, safeErrorFact } from '../audit.ts'
// Declaration-merge imports: storage-domain contributes ctx.storageDomain,
// session-persistence contributes ctx.sessionPersistence.
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  feishuBotDomain, outboundSegmentId,
  type ChatBinding, type FeishuChatId, type FeishuEventId, type FeishuOpenId,
  type InboundCommand, type InboundEvent, type InboundMessage, type OutboundSegment,
  type OutboundSegmentId, type SessionIdString,
} from './domain.ts'
import { parseCommand } from './commands.ts'
import { authorizeCwd, buildWorkspaceFilter, validateDefaultWorkspace } from './workspace.ts'
import { createBridgeAgentResolver, type ResolveResult } from './resolver.ts'
import { reconcileMessage } from './inbound.ts'
import { reduceTaskCard, renderTaskCard, type TokenInfo } from './task-card.ts'
import { renderResultCard, segmentResultCards } from './result-card.ts'
import {
  danglingActiveBindings, isAtOrBelowWatermark, isRecoveryExpired,
  planRetention, sortPendingOutbox, watermarkKey,
} from './reliability.ts'
import { pairApprovalId, renderApprovalGroupCard, type ApprovalCardSpec, type ApprovalItemState } from './approval.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Marker service published only after bridge startup recovery has settled. */
export interface FeishuBridgeReady {
  readonly domainName: 'feishu_bot'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishuBridgeReady: FeishuBridgeReady
  }
}

/** Bridge configuration; every deployment-varying choice is a field here. */
export interface Config {
  /** Feishu open_ids allowed to interact; empty rejects everyone (fail-closed). */
  allowedOpenIds: string[]
  /** Workspace roots `/new` may create sessions under; empty rejects all `/new`. */
  allowedWorkspaces: string[]
  /** Default cwd for `/new`; must live under an allowed root. */
  defaultWorkspace?: string
  /** Inbound event freshness window in milliseconds. */
  freshnessMs: number
  /** Lifetime of the most recent `/ls` ordinal snapshot per chat. */
  listingTtlMs: number
  /** Minimum interval between task-card updates in milliseconds (M2). */
  cardThrottleMs: number
  /** Maximum age of received/recovering work eligible for restart recovery. */
  recoveryTtlMs: number
  /** Retention period for terminal inbound rows. */
  inboundRetentionMs: number
  /** Soft capacity for inbound rows; recoverable rows are never evicted. */
  inboundMaxRecords: number
  /** Retention period for terminal outbound rows. */
  outboundRetentionMs: number
  /** Maximum age of an unsent outbound segment before abandonment. */
  outboundPendingTtlMs: number
  /** Soft capacity for outbound rows; fresh pending rows are never evicted. */
  outboundMaxRecords: number
  /** Interval between retention sweeps. */
  maintenanceIntervalMs: number
  /** LLM provider for sessions the bridge resumes or creates. */
  agentProvider: string
  /** LLM model for sessions the bridge resumes or creates. */
  agentModel: string
  /** Web GUI base URL shown on approval cards. */
  webUrl: string
}

export const Config: z<Config> = z.object({
  allowedOpenIds: z.array(z.string()).default([]),
  allowedWorkspaces: z.array(z.string()).default([]),
  defaultWorkspace: z.string(),
  freshnessMs: z.natural().default(600_000),
  listingTtlMs: z.natural().default(300_000),
  cardThrottleMs: z.natural().default(1_000),
  recoveryTtlMs: z.natural().default(86_400_000),
  inboundRetentionMs: z.natural().default(604_800_000),
  inboundMaxRecords: z.natural().default(50_000),
  outboundRetentionMs: z.natural().default(604_800_000),
  outboundPendingTtlMs: z.natural().default(86_400_000),
  outboundMaxRecords: z.natural().default(10_000),
  maintenanceIntervalMs: z.natural().default(86_400_000),
  agentProvider: z.string().default('deepseek'),
  agentModel: z.string().default('deepseek-chat'),
  webUrl: z.string().default('http://127.0.0.1:3080'),
})

export const name = 'feishu-bridge'
export const inject = ['feishu', 'agents', 'sessions', 'sessionPersistence', 'storageDomain']

type Tables = {
  bindings: Awaited<ReturnType<Context['storageDomain']['open']>> extends infer D
    ? D extends { table: (name: string) => infer T } ? T : never : never
}

/**
 * Mount the bridge.
 * @param ctx - plugin context with the injected services.
 * @param config - validated bridge configuration.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  return mount(ctx, config).catch((error: unknown) => {
    ctx.logger.error('feishu-bridge mount failed: %s', safeErrorFact(error))
    throw error
  })
}

async function mount(ctx: Context, config: Config): Promise<void> {
  await validateDefaultWorkspace(config.defaultWorkspace, config.allowedWorkspaces)
  const domain = await ctx.storageDomain.open(feishuBotDomain)
  ctx.effect(() => () => domain.close(), 'feishuBridge.domainClose')
  const bindings = domain.table('bindings')
  const inboundEvents = domain.table('inbound_events')
  const outboundSegments = domain.table('outbound_segments')
  const pendingCards = domain.table('pending_cards')
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'feishuBridge.intakeClose')

  const agentOptions = (): AgentOptions =>
    ({ provider: config.agentProvider, model: config.agentModel })
  const resolve = createBridgeAgentResolver(ctx, agentOptions)

  /** Recorded cwd of a session: live header first, then persisted header. */
  const sessionCwd = async (sessionId: string): Promise<string | undefined> => {
    for (const session of ctx.sessions.list()) {
      if (String(session.id) === sessionId) return session.header.cwd
    }
    const header = (await ctx.sessionPersistence.list())
      .find(h => String(h.id) === sessionId)
    return header?.cwd
  }

  /** Current live and persisted session identities, without loading agents. */
  const knownSessionIds = async (): Promise<Set<string>> => new Set([
    ...ctx.sessions.list().map(session => String(session.id)),
    ...(await ctx.sessionPersistence.list()).map(header => String(header.id)),
  ])

  /** Last /ls numbering per chat: ordered session ids plus snapshot time. */
  const listings = new Map<string, { ordered: string[]; at: number }>()

  /** Serial work queue per chat; recovery and fresh events share it. */
  const chatTails = new Map<string, Promise<void>>()
  const enqueueChatWork = (chatId: string, work: () => Promise<void>): Promise<void> => {
    if (disposed) return Promise.resolve()
    const tail = chatTails.get(chatId) ?? Promise.resolve()
    const next = tail.then(work, work)
    chatTails.set(chatId, next.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge chat %s work failed: %s', auditHash(chatId), safeErrorFact(error))
    }))
    return next
  }

  /** Serialize global watermark replacements so parallel chats cannot lose updates. */
  let watermarkTail = Promise.resolve()
  const advanceWatermark = (chatId: string, sessionId: string, sequence: number): Promise<void> => {
    const next = watermarkTail.then(async () => {
      const current = domain.global.get()
      const watermarks = current.watermarks as Record<string, number>
      const key = watermarkKey(chatId, sessionId)
      if (sequence <= (watermarks[key] ?? -1)) return
      await domain.global.set({ watermarks: { ...watermarks, [key]: sequence } })
    })
    watermarkTail = next.catch((error: unknown) => {
      ctx.logger.error('feishu-bridge watermark advance failed: %s', safeErrorFact(error))
    })
    return next
  }

  /** Deliver one already-durable segment; failure leaves it pending for restart. */
  const deliverOutboundSegment = async (
    key: OutboundSegmentId, initial: OutboundSegment,
  ): Promise<boolean> => {
    const current = outboundSegments.get(key) ?? initial
    if (current.status !== 'pending') return true
    const attempted: OutboundSegment = { ...current, attempts: current.attempts + 1 }
    await outboundSegments.put(key, attempted)
    const cwd = await sessionCwd(attempted.sessionId)
    const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? String(attempted.sessionId)
    const card = renderResultCard(
      workspaceName, attempted.text, attempted.segmentIndex + 1, attempted.segmentCount,
    )
    try {
      try {
        await ctx.feishu.sendCard(attempted.chatId, card)
      } catch (error: unknown) {
        ctx.logger.warn('feishu-bridge result card send failed; using text fallback: %s', safeErrorFact(error))
        await ctx.feishu.sendText(attempted.chatId, attempted.text)
      }
      await outboundSegments.put(key, { ...attempted, status: 'sent', text: '' })
      ctx.logger.info('feishu-audit action=outbox-sent chat=%s session=%s seq=%d segment=%d attempts=%d',
        auditHash(attempted.chatId), auditHash(attempted.sessionId), attempted.sourceEventSeq,
        attempted.segmentIndex, attempted.attempts)
      return true
    } catch (error: unknown) {
      ctx.logger.error('feishu-audit action=outbox-pending chat=%s session=%s seq=%d segment=%d attempts=%d error=%s',
        auditHash(attempted.chatId), auditHash(attempted.sessionId), attempted.sourceEventSeq,
        attempted.segmentIndex, attempted.attempts, safeErrorFact(error))
      return false
    }
  }

  /** Outbound: project one assistant message into durable result-card segments. */
  const projectAndSend = async (
    chatId: FeishuChatId, sessionId: SessionIdString, sourceEventSeq: number, text: string,
  ): Promise<void> => {
    if (isAtOrBelowWatermark(domain.global.get().watermarks, chatId, sessionId, sourceEventSeq)) return
    const cwd = await sessionCwd(sessionId)
    const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? String(sessionId)
    const segments = segmentResultCards(chatId, workspaceName, text)
    const durable: [OutboundSegmentId, OutboundSegment][] = []
    // Materialize the complete event before the first network send. A crash
    // can therefore never persist only the leading segments of a result.
    for (const [index, segment] of segments.entries()) {
      const key = outboundSegmentId(chatId, sessionId, sourceEventSeq, index)
      let row = outboundSegments.get(key)
      if (row === undefined) {
        row = {
          chatId, sessionId, sourceEventSeq,
          segmentIndex: index, segmentCount: segments.length,
          text: segment.text, status: 'pending', attempts: 0, createdAt: Date.now(),
        }
        await outboundSegments.put(key, row)
      }
      durable.push([key, row])
    }
    let complete = true
    for (const [key, row] of durable) complete = await deliverOutboundSegment(key, row) && complete
    if (complete) await advanceWatermark(chatId, sessionId, sourceEventSeq)
  }

  /** Live projection: assistant/message events of bound sessions → chat. */
  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (event.type !== 'assistant/message') return
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active' || (binding.sessionId as string) !== (session.id as string)) continue
      const text = extractAssistantText(event.data as { message?: { content?: unknown } })
      if (text === '') continue
      void enqueueChatWork(chatId, () =>
        projectAndSend(chatId as FeishuChatId, binding.sessionId, event.seq, text))
    }
  })

  /**
   * Task cards: one card per (chat, session, turn), throttled patches while
   * running, terminal state frozen. Card state is process-local and
   * droppable (design §6.3: a restart never rebuilds an old card).
   */
  interface CardTracker {
    turn: number
    messageId: string | undefined
    /** Send in flight or pending throttle timer. */
    updating: boolean
    /** A change arrived during the throttle window; re-render at expiry. */
    dirty: boolean
    lastPatchAt: number
    frozen: boolean
  }
  const cards = new Map<string, CardTracker>() // key: chatId
  const CARD_EVENT_TYPES = new Set(['turn/start', 'tool/call', 'tool/result', 'turn/end'])

  const pushCard = (chatId: string, sessionId: SessionIdString, tracker: CardTracker): void => {
    const session = ctx.sessions.list().find(s => String(s.id) === (sessionId as string))
    if (session === undefined) return
    const snapshot = reduceTaskCard(session.events, tracker.turn)
    if (snapshot === undefined) return
    // tokenMeter is present in the web profile but deliberately NOT in
    // inject: ctx.get() degrades to no token line when the service is
    // absent instead of parking the whole plugin (design §6.3: token
    // absence is not a defect).
    const meter = ctx.get('tokenMeter') as { measure?: (s: unknown) => { totalTokens: number; baseline: { kind: string } } } | undefined
    let tokens: TokenInfo | undefined
    try {
      const measured = meter?.measure?.(session)
      if (measured !== undefined) {
        tokens = { totalTokens: measured.totalTokens, anchored: measured.baseline.kind === 'usage' }
      }
    } catch { /* measurement failure degrades to no token line; card facts stay valid */ }
    const cwd = session.header.cwd
    const title = cwd === undefined ? undefined : cwd.split('/').filter(Boolean).at(-1)
    const card = renderTaskCard(snapshot, tokens, title === undefined ? undefined : { title })
    tracker.updating = true
    void (async () => {
      try {
        if (tracker.messageId === undefined) {
          tracker.messageId = await ctx.feishu.sendCard(chatId, card)
        } else {
          await ctx.feishu.patchCard(tracker.messageId, card)
        }
        tracker.lastPatchAt = Date.now()
        if (snapshot.status !== 'running') tracker.frozen = true
      } catch (error: unknown) {
        // Progress cards are droppable; log and move on (terminal text
        // replies travel the reliable outbox path, not the card).
        ctx.logger.warn('feishu-bridge card update failed for %s: %s', auditHash(chatId), safeErrorFact(error))
      } finally {
        tracker.updating = false
        if (tracker.dirty && !tracker.frozen) {
          tracker.dirty = false
          scheduleCard(chatId, sessionId, tracker)
        }
      }
    })()
  }

  const scheduleCard = (chatId: string, sessionId: SessionIdString, tracker: CardTracker): void => {
    if (tracker.updating || tracker.frozen) { tracker.dirty = true; return }
    const wait = Math.max(0, config.cardThrottleMs - (Date.now() - tracker.lastPatchAt))
    tracker.updating = true
    const timer = setTimeout(() => {
      if (disposed) return
      tracker.updating = false
      pushCard(chatId, sessionId, tracker)
    }, wait)
    ctx.effect(() => () => clearTimeout(timer), 'feishuBridge.cardTimer')
  }

  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (!CARD_EVENT_TYPES.has(event.type)) return
    const turn = (event.data as { turn?: number }).turn
    if (turn === undefined) return
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active' || (binding.sessionId as string) !== (session.id as string)) continue
      let tracker = cards.get(chatId)
      if (event.type === 'turn/start' || tracker === undefined || tracker.turn !== turn) {
        // New turn (or first observation): a fresh card; the old one stays frozen.
        tracker = { turn, messageId: undefined, updating: false, dirty: false, lastPatchAt: 0, frozen: false }
        cards.set(chatId, tracker)
      }
      if (event.type === 'turn/end') {
        // Terminal renders bypass the throttle: freeze the card now.
        tracker.dirty = false
        pushCard(chatId, binding.sessionId, tracker)
      } else {
        scheduleCard(chatId, binding.sessionId, tracker)
      }
    }
  })

  const reply = (chatId: string, text: string): void => {
    void ctx.feishu.sendText(chatId, text).catch((error: unknown) => {
      ctx.logger.error('feishu-bridge reply to %s failed: %s', auditHash(chatId), safeErrorFact(error))
    })
  }

  /**
   * Approval channel (design §6.4, plan α: prepend + next() parallel race).
   *
   * In-memory pending registry: pendingId → resolver facts. Durable
   * pendingCards mirrors it for the restart sweep only; decisions always
   * route through this registry.
   */
  interface PendingApproval {
    approvalId: string
    chatId: string
    sessionId: string
    spec: ApprovalCardSpec
    resolve: (outcome: ApprovalOutcome) => void
    settled: boolean
  }
  const pendingApprovals = new Map<string, PendingApproval>()

  /**
   * Per-chat approval group: every live approval question of a chat rides
   * ONE card (weclaw: parallel approvals collapse instead of stacking).
   * Settled items stay on the card with their outcome; once no pending
   * item remains the group leaves this map, so the next question starts a
   * fresh card. `chain` serializes send/patch per group (send must precede
   * every patch; renders are derived from current state, last write wins).
   */
  interface ApprovalGroup {
    chatId: string
    messageId?: string
    items: Map<string, { spec: ApprovalCardSpec; state: ApprovalItemState }>
    chain: Promise<void>
  }
  const approvalGroups = new Map<string, ApprovalGroup>()
  /** pendingId -> its group, surviving group rotation (for late settles). */
  const groupOf = new Map<string, ApprovalGroup>()

  /** approvalIds held by this channel; feeds the pairing scan's claimed set. */
  const claimedApprovalIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const entry of pendingApprovals.values()) ids.add(entry.approvalId)
    return ids
  }

  const pushGroup = (group: ApprovalGroup): Promise<void> => {
    group.chain = group.chain.then(async () => {
      const card = renderApprovalGroupCard([...group.items.values()])
      if (group.messageId === undefined) {
        group.messageId = await ctx.feishu.sendCard(group.chatId, card)
      } else {
        await ctx.feishu.patchCard(group.messageId, card)
      }
    }).catch((error: unknown) => {
      ctx.logger.warn('feishu-bridge approval card update failed: %s', safeErrorFact(error))
    })
    return group.chain
  }

  /** Flip one item's state, rotate the group out when nothing stays pending, re-render. */
  const settleItem = (pendingId: string, state: Exclude<ApprovalItemState, 'pending'>): void => {
    const group = groupOf.get(pendingId)
    if (group === undefined) return
    const item = group.items.get(pendingId)
    if (item === undefined || item.state !== 'pending') return
    item.state = state
    groupOf.delete(pendingId)
    const anyPending = [...group.items.values()].some(i => i.state === 'pending')
    if (!anyPending && approvalGroups.get(group.chatId) === group) approvalGroups.delete(group.chatId)
    void pushGroup(group)
  }

  ctx.on('approval/request', async (req, next) => {
    // Only requests for sessions bound to some active chat concern Feishu.
    let boundChatId: string | undefined
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status === 'active' && (binding.sessionId as string) === String(req.agent.session.id)) {
        boundChatId = chatId
        break
      }
    }
    if (boundChatId === undefined) return next()
    const approvalId = pairApprovalId(req.agent.session.events, req.callId as string | undefined, claimedApprovalIds())
    // No pairable asked event (or ambiguity): conservatively step aside.
    if (approvalId === undefined) return next()

    const pendingId = `pc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const cwd = req.agent.session.header.cwd
    const spec: ApprovalCardSpec = {
      pendingId,
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
      sessionTitle: cwd?.split('/').filter(Boolean).at(-1) ?? String(req.agent.session.id),
      webUrl: config.webUrl,
    }
    let entry: PendingApproval
    const feishuAnswer = new Promise<ApprovalOutcome>((resolvePromise) => {
      entry = {
        approvalId, chatId: boundChatId, sessionId: String(req.agent.session.id), spec, settled: false,
        resolve: (outcome) => {
          if (entry.settled) return
          entry.settled = true
          pendingApprovals.delete(pendingId)
          void pendingCards.delete(pendingId as never).catch(() => undefined)
          resolvePromise(outcome)
        },
      }
    })
    pendingApprovals.set(pendingId, entry!)

    // Durable-first (compensation ladder, design §6.4): record → card →
    // backfill. A failure at any rung unwinds and delegates via next().
    try {
      await pendingCards.put(pendingId as never, {
        kind: 'approval', pendingId, chatId: boundChatId, approvalId,
        toolName: req.toolName,
        ...req.reason === undefined ? {} : { reason: req.reason },
        sessionTitle: spec.sessionTitle, createdAt: Date.now(),
      } as never)
    } catch (error: unknown) {
      pendingApprovals.delete(pendingId)
      ctx.logger.error('feishu-bridge approval record write failed: %s', safeErrorFact(error))
      ctx.logger.warn('feishu-audit action=approval-delegated pending=%s approval=%s chat=%s reason=record-write',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
      return next()
    }
    // Join the chat's live group, or open a fresh card.
    let group = approvalGroups.get(boundChatId)
    if (group === undefined) {
      group = { chatId: boundChatId, items: new Map(), chain: Promise.resolve() }
      approvalGroups.set(boundChatId, group)
    }
    group.items.set(pendingId, { spec, state: 'pending' })
    groupOf.set(pendingId, group)
    await pushGroup(group)
    if (group.messageId === undefined) {
      // Send failed: unwind this item and delegate.
      group.items.delete(pendingId)
      groupOf.delete(pendingId)
      if (group.items.size === 0 && approvalGroups.get(boundChatId) === group) approvalGroups.delete(boundChatId)
      pendingApprovals.delete(pendingId)
      void pendingCards.delete(pendingId as never).catch(() => undefined)
      ctx.logger.warn('feishu-audit action=approval-delegated pending=%s approval=%s chat=%s reason=card-send',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
      return next()
    }
    try {
      await pendingCards.update(pendingId as never, { cardMessageId: group.messageId } as never)
    } catch { /* backfill miss only widens the restart sweep's invalidation to this card */ }
    ctx.logger.info('feishu-audit action=approval-presented pending=%s approval=%s chat=%s session=%s',
      auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId),
      auditHash(String(req.agent.session.id)))

    // Withdrawal: the asker aborted — settle the item and release without deciding.
    const onAbort = (): void => {
      const live = pendingApprovals.get(pendingId)
      if (live === undefined || live.settled) return
      live.settled = true
      pendingApprovals.delete(pendingId)
      void pendingCards.delete(pendingId as never).catch(() => undefined)
      settleItem(pendingId, 'withdrawn')
      ctx.logger.info('feishu-audit action=approval-withdrawn pending=%s approval=%s chat=%s',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    // Plan α: delegate immediately; both channels stay live; the first REAL
    // decision wins. The chain's fail-closed 'unavailable' (no other
    // answerer) is NOT a decision — the Feishu card is live, so this channel
    // keeps waiting instead of losing to an empty chain (weclaw: absence of
    // an answer never defaults the outcome).
    const web = next()
    const webDecision = web.then((outcome): Promise<ApprovalOutcome> | ApprovalOutcome => {
      if (outcome === 'unavailable') return new Promise<ApprovalOutcome>(() => {})
      // Web decided first: mark our item decided-elsewhere.
      const live = pendingApprovals.get(pendingId)
      if (live !== undefined && !live.settled) {
        live.settled = true
        pendingApprovals.delete(pendingId)
        void pendingCards.delete(pendingId as never).catch(() => undefined)
        req.signal?.removeEventListener('abort', onAbort)
        settleItem(pendingId, 'elsewhere')
        ctx.logger.info('feishu-audit action=approval-decided-elsewhere pending=%s approval=%s chat=%s outcome=%s',
          auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId), outcome)
      }
      return outcome
    }, (): Promise<ApprovalOutcome> => new Promise<ApprovalOutcome>(() => {}))
    return Promise.race([feishuAnswer, webDecision])
  }, { prepend: true })

  /** Card button clicks: validate, resolve the pending entry, update the group card. */
  ctx.feishu.handleCardActions(async (action) => {
    // Feishu delivers button values as an object OR as a JSON string
    // depending on client/schema version; accept both. An unrecognized
    // payload gets a visible toast — silent {} looked like a dead button
    // in live acceptance.
    let raw = action.value
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { raw = undefined }
    }
    const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? raw as { pendingId?: string; action?: string }
      : undefined
    const pendingId = value?.pendingId
    const verb = value?.action
    if (pendingId === undefined || (verb !== 'allow' && verb !== 'reject')) {
      ctx.logger.warn('feishu-bridge: unrecognized card click payload (type=%s, keyCount=%d)',
        raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        value === undefined ? 0 : Object.keys(value).length)
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s message=%s reason=payload',
        auditHash(action.operatorOpenId), auditHash(action.messageId))
      return { toast: '无法识别的按钮数据，请查看日志' }
    }
    // Permission: allowlist member (§7.2). Empty operator id fails closed.
    if (!config.allowedOpenIds.includes(action.operatorOpenId)) {
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s message=%s pending=%s reason=allowlist',
        auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '你没有权限操作此审批' }
    }
    const entry = pendingApprovals.get(pendingId)
    if (entry === undefined || entry.settled) {
      ctx.logger.info('feishu-audit action=approval-click-rejected operator=%s message=%s pending=%s reason=not-pending',
        auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '该审批已失效或已在别处决定' }
    }
    const sourceCardMessageId = groupOf.get(pendingId)?.messageId
    if (action.chatId !== entry.chatId || sourceCardMessageId === undefined
      || action.messageId !== sourceCardMessageId) {
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s chat=%s message=%s pending=%s reason=card-context',
        auditHash(action.operatorOpenId), auditHash(action.chatId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '该按钮不属于当前审批卡' }
    }
    // The card's chat must still hold an active binding for the session.
    const binding = bindings.get(entry.chatId as FeishuChatId)
    if (binding === undefined || binding.status !== 'active') {
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s message=%s pending=%s reason=binding-inactive',
        auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '该会话已解绑，审批按钮已失效' }
    }
    if (binding.sessionId !== entry.sessionId) {
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s message=%s pending=%s reason=binding-changed',
        auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '该会话绑定已变更，审批按钮已失效' }
    }
    if (binding.boundBy !== action.operatorOpenId) {
      ctx.logger.warn('feishu-audit action=approval-click-rejected operator=%s message=%s pending=%s reason=not-binder',
        auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId))
      return { toast: '只有当前会话的绑定者可以处理审批' }
    }
    const outcome: ApprovalOutcome = verb === 'allow' ? 'allowed-once' : 'rejected'
    entry.resolve(outcome)
    settleItem(pendingId, verb === 'allow' ? 'allowed' : 'rejected')
    ctx.logger.info('feishu-audit action=approval-click-decided operator=%s message=%s pending=%s approval=%s outcome=%s',
      auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId),
      auditHash(entry.approvalId), outcome)
    return { toast: verb === 'allow' ? '已允许（本次）' : '已拒绝' }
  })

  /** Route one deduplicated, authorized text message to the bound session. */
  const routeMessage = async (eventId: FeishuEventId, record: InboundMessage): Promise<void> => {
    const binding = bindings.get(record.chatId)
    if (binding === undefined || binding.status !== 'active') {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding' })
      ctx.logger.warn('feishu-audit action=inbound-rejected event=%s chat=%s sender=%s reason=no-binding',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId))
      reply(record.chatId, '当前没有绑定的会话。用 /ls 查看、/use <id> 绑定，或 /new 新建。')
      return
    }
    const resolved: ResolveResult = await resolve(binding.sessionId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: resolved.error.code })
      ctx.logger.warn('feishu-audit action=inbound-rejected event=%s chat=%s sender=%s reason=%s',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), resolved.error.code)
      reply(record.chatId, `会话不可用（${resolved.error.code}）。用 /release 解绑后重新 /use 或 /new。`)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: record.text ?? '' }],
      // The Feishu human IS the user: Web transcripts and activity rows key
      // on kind 'user'; `via` keeps the frontend provenance durable.
      source: { kind: 'user', via: 'feishu' } as never,
    })
    // Durable commit point BEFORE followup (crash window covered by recovery).
    await inboundEvents.put(eventId, {
      ...record,
      target: binding.sessionId,
      messageId: message.id as never,
    })
    resolved.agent.followup(message)
    await inboundEvents.put(eventId, {
      ...record,
      status: 'enqueued', text: undefined,
      target: binding.sessionId, messageId: message.id as never,
    })
    ctx.logger.info('feishu-audit action=inbound-enqueued event=%s chat=%s sender=%s session=%s',
      auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), auditHash(binding.sessionId))
  }

  const handleCommand = async (eventId: FeishuEventId, record: InboundCommand, text: string): Promise<void> => {
    const command = parseCommand(text)
    if (command === undefined) return
    const chatId = record.chatId
    let current = record
    const stageTarget = async (target: SessionIdString): Promise<void> => {
      current = { ...current, target }
      await inboundEvents.put(eventId, current)
    }
    const commit = async (result: string): Promise<void> => {
      current = { ...current, status: 'committed', result, reason: undefined }
      await inboundEvents.put(eventId, current)
      ctx.logger.info('feishu-audit action=command-committed event=%s chat=%s sender=%s command=%s',
        auditHash(eventId), auditHash(chatId), auditHash(record.senderOpenId), record.command)
      reply(chatId, result)
    }
    switch (command.kind) {
      case 'help':
        await commit([
          '可用命令：',
          '/new [cwd] — 新建会话并绑定（cwd 须在允许的工作区内）',
          '/ls — 列出可绑定的会话',
          '/use <sessionId|编号> — 绑定既有会话（编号来自 /ls）',
          '/status — 当前绑定状态',
          '/stop — 停止当前任务（排队消息保留）',
          '/release — 解绑当前会话',
          '普通文本会作为消息发给绑定的会话。',
        ].join('\n'))
        return
      case 'ls': {
        // Persisted headers plus live-only sessions (an empty just-created
        // session has no persistence artifact yet — upstream contract),
        // scoped to allowedWorkspaces (design §6.6): sessions outside the
        // roots are neither listed nor numbered.
        const inWorkspace = await buildWorkspaceFilter(config.allowedWorkspaces)
        const allPersisted = await ctx.sessionPersistence.list()
        const persisted: typeof allPersisted = []
        for (const header of allPersisted) {
          if (header.origin !== 'subagent' && await inWorkspace(header.cwd)) persisted.push(header)
        }
        const seen = new Set(persisted.map(h => String(h.id)))
        const live: typeof allPersisted = []
        for (const session of ctx.sessions.list()) {
          if (!seen.has(String(session.id)) && session.header.origin !== 'subagent'
            && await inWorkspace(session.header.cwd)) live.push(session.header)
        }
        const headers = [...live, ...persisted]
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 20)
        if (headers.length === 0) {
          listings.delete(chatId)
          await commit('没有可绑定的会话。用 /new 新建。')
          return
        }
        // Group by workspace directory; number across groups so /use <n> works.
        const groups = new Map<string, typeof headers>()
        for (const header of headers) {
          const list = groups.get(header.cwd!) ?? []
          list.push(header)
          groups.set(header.cwd!, list)
        }
        const ordered: string[] = []
        const lines: string[] = []
        for (const [cwd, group] of groups) {
          lines.push(`📁 ${cwd}`)
          for (const header of group) {
            ordered.push(String(header.id))
            const short = String(header.id).length > 24
              ? `${String(header.id).slice(0, 21)}…` : String(header.id)
            const when = header.createdAt === undefined
              ? '' : `  ${new Date(header.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
            lines.push(`  [${ordered.length}] ${short}${when}`)
          }
        }
        listings.set(chatId, { ordered, at: Date.now() })
        lines.push('回复 /use <编号> 绑定。')
        await commit(lines.join('\n'))
        return
      }
      case 'status': {
        const binding = bindings.get(chatId)
        await commit(binding === undefined
          ? '未绑定会话。'
          : `绑定：${binding.sessionId}（${binding.status}），由 ${binding.boundBy} 于 ${new Date(binding.boundAt).toLocaleString()} 绑定。模型提问需在 Web GUI 作答。`)
        return
      }
      case 'release': {
        const binding = bindings.get(chatId)
        if (binding === undefined) { await commit('当前没有绑定。'); return }
        if (binding.boundBy !== record.senderOpenId) {
          await commit('只有当前会话的绑定者可以解绑。')
          return
        }
        await stageTarget(binding.sessionId)
        await bindings.delete(chatId)
        cards.delete(chatId)
        ctx.logger.info('feishu-audit action=binding-released chat=%s session=%s sender=%s',
          auditHash(chatId), auditHash(binding.sessionId), auditHash(record.senderOpenId))
        await commit(`已解绑 ${binding.sessionId}。会话仍在运行，可随时 /use 重新绑定。`)
        return
      }
      case 'stop': {
        const binding = bindings.get(chatId)
        if (binding === undefined || binding.status !== 'active') {
          await commit('当前没有绑定的会话。')
          return
        }
        if (binding.boundBy !== record.senderOpenId) {
          await commit('只有当前会话的绑定者可以停止任务。')
          return
        }
        const agent = ctx.agents.get(binding.sessionId as unknown as SessionId)
        if (agent === undefined || agent.status !== 'running') {
          await commit('会话当前没有在执行任务。')
          return
        }
        await stageTarget(binding.sessionId)
        // keepInbox: queued messages survive for the next turn (design M2).
        // The completion answer is the turn/end terminal the card listener
        // renders as 已停止 — not whenIdle(), which a queued followup defers.
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        await commit('已请求停止当前任务。结果以任务卡状态为准；排队中的消息会在下一轮继续。')
        return
      }
      case 'use': {
        const currentBinding = bindings.get(chatId)
        if (currentBinding?.status === 'active' && currentBinding.boundBy !== record.senderOpenId) {
          await commit('只有当前会话的绑定者可以替换 active 绑定；请先由绑定者 /release。')
          return
        }
        let targetId = command.sessionId
        if (/^\d+$/u.test(targetId)) {
          const listing = listings.get(chatId)
          const picked = listing === undefined || Date.now() - listing.at > config.listingTtlMs
            ? undefined
            : listing.ordered[Number(targetId) - 1]
          if (picked === undefined) {
            await commit('编号无效或列表已过期。请先发送 /ls 获取最新编号。')
            return
          }
          targetId = picked
        }
        // Workspace gate BEFORE resolving: a session outside the allowed
        // roots is not bindable even by full id (design §6.6).
        const inWorkspace = await buildWorkspaceFilter(config.allowedWorkspaces)
        if (!await inWorkspace(await sessionCwd(targetId))) {
          await commit('无法绑定：该会话不在允许的工作区内。')
          return
        }
        const target = targetId as unknown as SessionId
        const resolved = await resolve(target)
        if ('error' in resolved) { await commit(`无法绑定：${resolved.error.code}`); return }
        await stageTarget(targetId as SessionIdString)
        const binding: ChatBinding = {
          sessionId: targetId as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        await bindings.put(chatId, binding)
        ctx.logger.info('feishu-audit action=binding-%s chat=%s session=%s sender=%s',
          currentBinding === undefined ? 'created' : 'replaced', auditHash(chatId),
          auditHash(binding.sessionId), auditHash(record.senderOpenId))
        await commit(`已绑定 ${targetId}。直接发消息即可对话。`)
        return
      }
      case 'new': {
        const cwdInput = command.cwd ?? config.defaultWorkspace
        if (cwdInput === undefined) { await commit('未配置默认工作区，且未提供 cwd。'); return }
        const authorized = await authorizeCwd(
          command.cwd === undefined ? cwdInput : command.cwd, config.allowedWorkspaces)
        if (!authorized.ok) { await commit(`目录不可用：${authorized.reason}`); return }
        const sessionId = `feishu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as unknown as SessionId
        await stageTarget(sessionId as unknown as SessionIdString)
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: authorized.realpath },
          agentOptions: agentOptions(),
        })
        const binding: ChatBinding = {
          sessionId: sessionId as unknown as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        await ctx.sessions.flush(handle.agent.session)
        await bindings.put(chatId, binding)
        ctx.logger.info('feishu-audit action=binding-created chat=%s session=%s sender=%s',
          auditHash(chatId), auditHash(binding.sessionId), auditHash(record.senderOpenId))
        await commit(`已创建并绑定会话 ${String(sessionId)}（cwd: ${authorized.realpath}）。`)
        return
      }
      case 'invalid':
        await commit(`命令 /${command.name} 参数不正确（${command.problem}）。发送 /help 查看用法。`)
        return
      case 'unknown':
        await commit(`未知命令 /${command.name}。发送 /help 查看可用命令。`)
        return
    }
  }

  /** Inbound entry: allowlist → dedup → freshness → command/message. */
  ctx.on('feishu/message', (message: FeishuInboundMessage) => {
    void enqueueChatWork(message.chatId, async () => {
      if (message.chatType !== 'p2p') {
        ctx.logger.info('feishu-audit action=inbound-ignored event=%s chat=%s sender=%s reason=chat-type',
          auditHash(message.eventId), auditHash(message.chatId), auditHash(message.senderOpenId))
        return
      }
      if (!config.allowedOpenIds.includes(message.senderOpenId)) {
        ctx.logger.warn('feishu-audit action=inbound-rejected event=%s chat=%s sender=%s reason=allowlist',
          auditHash(message.eventId), auditHash(message.chatId), auditHash(message.senderOpenId))
        return
      }
      const eventId = message.eventId as FeishuEventId
      const existing = inboundEvents.get(eventId)
      if (existing !== undefined) {
        ctx.logger.info('feishu-audit action=inbound-duplicate event=%s chat=%s sender=%s kind=%s status=%s',
          auditHash(eventId), auditHash(message.chatId), auditHash(message.senderOpenId),
          existing.kind, existing.status)
        // Commands persist their first result so an at-least-once Feishu
        // delivery receives the same answer without repeating side effects.
        if (existing.kind === 'command' && existing.status === 'committed' && existing.result !== undefined) {
          reply(existing.chatId, existing.result)
        }
        return
      }
      if (Date.now() - message.createTimeMs > config.freshnessMs) {
        await inboundEvents.put(eventId, {
          kind: 'message',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'expired', reason: 'stale',
        })
        ctx.logger.warn('feishu-audit action=inbound-expired event=%s chat=%s sender=%s',
          auditHash(eventId), auditHash(message.chatId), auditHash(message.senderOpenId))
        return
      }
      if (message.text === undefined) {
        await inboundEvents.put(eventId, {
          kind: 'message', chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'rejected', reason: 'unsupported-content',
        })
        ctx.logger.info('feishu-audit action=inbound-rejected event=%s chat=%s sender=%s reason=unsupported-content',
          auditHash(eventId), auditHash(message.chatId), auditHash(message.senderOpenId))
        reply(message.chatId, '暂不支持非文本消息。')
        return
      }
      const command = parseCommand(message.text)
      if (command !== undefined) {
        const record: InboundCommand = {
          kind: 'command',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'received',
          command: command.kind,
          commandArgsHash: auditHash(message.text),
        }
        await inboundEvents.put(eventId, record)
        ctx.logger.info('feishu-audit action=command-received event=%s chat=%s sender=%s command=%s args=%s',
          auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId),
          record.command, record.commandArgsHash)
        await handleCommand(eventId, record, message.text)
        return
      }
      const record: InboundMessage = {
        kind: 'message',
        chatId: message.chatId as FeishuChatId,
        senderOpenId: message.senderOpenId as FeishuOpenId,
        receivedAt: Date.now(), status: 'received',
        text: message.text,
      }
      await inboundEvents.put(eventId, record)
      ctx.logger.info('feishu-audit action=inbound-received event=%s chat=%s sender=%s',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId))
      await routeMessage(eventId, record)
    })
  })

  await sweepPendingCards()
  await validateBindings()
  await recoverInterrupted()
  await runMaintenance()
  await recoverOutbox()
  if (config.maintenanceIntervalMs > 0) {
    const timer = setInterval(() => {
      void runMaintenance().catch((error: unknown) => {
        ctx.logger.error('feishu-bridge maintenance failed: %s', safeErrorFact(error))
      })
    }, config.maintenanceIntervalMs)
    ctx.effect(() => () => clearInterval(timer), 'feishuBridge.maintenanceTimer')
  }
  ctx.logger.info('feishu-bridge mounted: %d user(s), %d workspace root(s), %d binding(s)',
    config.allowedOpenIds.length, config.allowedWorkspaces.length, bindings.size)
  ctx.provide('feishuBridgeReady', { domainName: 'feishu_bot' })

  /** Active bindings must point at a session visible to the live/persisted store. */
  async function validateBindings(): Promise<void> {
    const known = await knownSessionIds()
    for (const chatId of danglingActiveBindings(bindings.entries(), known)) {
      const binding = bindings.get(chatId)
      if (binding === undefined || binding.status !== 'active') continue
      await bindings.put(chatId, { ...binding, status: 'unavailable' })
      ctx.logger.warn('feishu-audit action=binding-invalidated chat=%s session=%s',
        auditHash(chatId), auditHash(binding.sessionId))
      reply(chatId, '此前绑定的会话已不存在，绑定已标记为不可用。请 /release 后重新 /use 或 /new。')
    }
  }

  /** Apply TTL/capacity rules; content is cleared before abandonment. */
  async function runMaintenance(): Promise<void> {
    const plan = planRetention(inboundEvents.entries(), outboundSegments.entries(), Date.now(), config)
    for (const key of plan.outboundAbandon) {
      const typedKey = key as OutboundSegmentId
      const row = outboundSegments.get(typedKey)
      if (row === undefined || row.status !== 'pending') continue
      await outboundSegments.put(typedKey, { ...row, status: 'abandoned', text: '' })
      ctx.logger.warn('feishu-audit action=outbox-abandoned chat=%s session=%s seq=%d segment=%d attempts=%d',
        auditHash(row.chatId), auditHash(row.sessionId), row.sourceEventSeq, row.segmentIndex, row.attempts)
    }
    for (const key of plan.inboundDelete) await inboundEvents.delete(key as FeishuEventId)
    for (const key of plan.outboundDelete) await outboundSegments.delete(key as OutboundSegmentId)
    if (plan.inboundDelete.length + plan.outboundDelete.length > 0) {
      ctx.logger.info('feishu-audit action=retention-sweep inboundDeleted=%d outboundDeleted=%d',
        plan.inboundDelete.length, plan.outboundDelete.length)
    }
  }

  /** Restart delivery of non-expired pending segments in deterministic FIFO order. */
  async function recoverOutbox(): Promise<void> {
    const groups = new Map<string, [OutboundSegmentId, OutboundSegment][]>()
    for (const [key, row] of sortPendingOutbox(outboundSegments.entries())) {
      const groupKey = JSON.stringify([row.chatId, row.sessionId, row.sourceEventSeq])
      const group = groups.get(groupKey) ?? []
      group.push([key, row])
      groups.set(groupKey, group)
    }
    const jobs: Promise<void>[] = []
    for (const group of groups.values()) {
      const first = group[0]
      if (first === undefined) continue
      const row = first[1]
      jobs.push(enqueueChatWork(row.chatId, async () => {
        for (const [key, pending] of group) await deliverOutboundSegment(key, pending)
        const eventRows = [...outboundSegments.entries()]
          .map(([, candidate]) => candidate)
          .filter(candidate => candidate.chatId === row.chatId
            && candidate.sessionId === row.sessionId
            && candidate.sourceEventSeq === row.sourceEventSeq)
        if (eventRows.length === row.segmentCount && eventRows.every(candidate => candidate.status !== 'pending')) {
          await advanceWatermark(row.chatId, row.sessionId, row.sourceEventSeq)
        }
      }))
    }
    await Promise.all(jobs)
  }

  /**
   * Restart sweep (design §6.4): every persisted pending approval card is
   * from a dead process. Records sharing one cardMessageId were items of
   * one GROUP card — patch each message once with all its items
   * invalidated (per-record patches would overwrite each other). Records
   * without a messageId (crashed before exposure) are just deleted. Never
   * write approval/decided — card invalidation is not a decision.
   */
  async function sweepPendingCards(): Promise<void> {
    const byMessage = new Map<string, ApprovalCardSpec[]>()
    for (const [key, record] of pendingCards.entries()) {
      if (record.cardMessageId !== undefined) {
        const spec: ApprovalCardSpec = {
          pendingId: record.pendingId, toolName: record.toolName,
          ...record.reason === undefined ? {} : { reason: record.reason },
          sessionTitle: record.sessionTitle, webUrl: config.webUrl,
        }
        const specs = byMessage.get(record.cardMessageId as string) ?? []
        specs.push(spec)
        byMessage.set(record.cardMessageId as string, specs)
        ctx.logger.info('feishu-audit action=approval-invalidated pending=%s chat=%s',
          auditHash(record.pendingId), auditHash(record.chatId))
      }
      await pendingCards.delete(key)
    }
    for (const [messageId, specs] of byMessage) {
      void ctx.feishu.patchCard(messageId, renderApprovalGroupCard(specs.map(spec => ({ spec, state: 'invalidated' }))))
        .catch((error: unknown) => {
          ctx.logger.warn('feishu-bridge stale approval card freeze failed: %s', safeErrorFact(error))
        })
    }
  }

  /** Startup reconciliation (design §6.1/§6.2) on the same per-chat queues. */
  async function recoverInterrupted(): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const [eventId, record] of inboundEvents.entries()) {
      if (record.kind === 'message' && (record.status === 'received' || record.status === 'recovering')) {
        jobs.push(enqueueChatWork(record.chatId, () => recoverMessage(eventId, record)))
      } else if (record.kind === 'command' && record.status === 'received') {
        jobs.push(enqueueChatWork(record.chatId, () => recoverCommand(eventId, record)))
      }
    }
    await Promise.all(jobs)
  }

  /** Reconcile only side effects that are provable from durable target state. */
  async function recoverCommand(eventId: FeishuEventId, record: InboundCommand): Promise<void> {
    const reject = async (reason: string, message: string): Promise<void> => {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', reason })
      ctx.logger.warn('feishu-audit action=command-recovery-rejected event=%s chat=%s sender=%s command=%s reason=%s',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), record.command, reason)
      reply(record.chatId, message)
    }
    const commit = async (result: string): Promise<void> => {
      await inboundEvents.put(eventId, { ...record, status: 'committed', result, reason: undefined })
      ctx.logger.info('feishu-audit action=command-recovered event=%s chat=%s sender=%s command=%s',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), record.command)
      reply(record.chatId, result)
    }

    if (isRecoveryExpired(record.receivedAt, Date.now(), config.recoveryTtlMs)) {
      await reject('interrupted', `重启前的 /${record.command} 已超过恢复期限，未继续执行，请重发。`)
      return
    }
    const target = record.target
    switch (record.command) {
      case 'new':
      case 'use': {
        if (target === undefined) {
          await reject('interrupted-no-target', `重启前的 /${record.command} 在产生副作用前中断，请重发。`)
          return
        }
        const known = await knownSessionIds()
        if (!known.has(target)) {
          await reject('interrupted-target-missing', `重启前的 /${record.command} 未留下可用会话，请重发。`)
          return
        }
        const binding = bindings.get(record.chatId)
        if (binding !== undefined && binding.status === 'active' && binding.sessionId !== target) {
          await reject('interrupted-binding-changed', `重启恢复未覆盖当前新绑定；请用 /status 核实。`)
          return
        }
        if (binding === undefined || binding.status !== 'active') {
          await bindings.put(record.chatId, {
            sessionId: target, status: 'active', boundBy: record.senderOpenId, boundAt: Date.now(),
          })
          ctx.logger.info('feishu-audit action=binding-recovered chat=%s session=%s sender=%s command=%s',
            auditHash(record.chatId), auditHash(target), auditHash(record.senderOpenId), record.command)
        }
        await commit(record.command === 'new'
          ? `重启恢复：已创建并绑定会话 ${target}。`
          : `重启恢复：已绑定 ${target}。`)
        return
      }
      case 'release': {
        const binding = bindings.get(record.chatId)
        if (binding === undefined) {
          await commit('重启恢复：解绑已完成。')
          return
        }
        if (target !== undefined && binding.sessionId === target) {
          await bindings.delete(record.chatId)
          cards.delete(record.chatId)
          ctx.logger.info('feishu-audit action=binding-release-recovered chat=%s session=%s sender=%s',
            auditHash(record.chatId), auditHash(target), auditHash(record.senderOpenId))
          await commit(`重启恢复：已解绑 ${target}。`)
          return
        }
        await reject('interrupted-binding-changed', '重启恢复未覆盖当前新绑定；请用 /status 核实。')
        return
      }
      case 'stop':
        await reject('interrupted-effect-unknown', '重启前的 /stop 可能已生效，请用 /status 核实当前会话。')
        return
      default:
        // These commands have no durable target and cannot be reproduced
        // from the hash-only argument audit row. Asking for a resend is the
        // only truthful recovery behavior.
        await reject('interrupted-no-replay-data', `重启前的 /${record.command} 未完成，请重发。`)
    }
  }

  async function recoverMessage(eventId: FeishuEventId, record: InboundMessage): Promise<void> {
    if (isRecoveryExpired(record.receivedAt, Date.now(), config.recoveryTtlMs)) {
      await inboundEvents.put(eventId, {
        ...record, status: 'rejected', text: undefined, reason: 'interrupted',
      })
      ctx.logger.warn('feishu-audit action=inbound-recovery-expired event=%s chat=%s',
        auditHash(eventId), auditHash(record.chatId))
      reply(record.chatId, '重启前有一条消息已超过恢复期限，未重新投递。')
      return
    }
    await inboundEvents.put(eventId, { ...record, status: 'recovering' })
    ctx.logger.info('feishu-audit action=inbound-recovery-started event=%s chat=%s sender=%s',
      auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId))
    const binding = bindings.get(record.chatId)
    const targetId = record.target ?? binding?.sessionId
    if (targetId === undefined) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding-at-recovery' })
      ctx.logger.warn('feishu-audit action=inbound-recovery-rejected event=%s chat=%s sender=%s reason=no-binding',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId))
      return
    }
    const resolved = await resolve(targetId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: `recovery-${resolved.error.code}` })
      ctx.logger.warn('feishu-audit action=inbound-recovery-rejected event=%s chat=%s sender=%s reason=%s',
        auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), resolved.error.code)
      reply(record.chatId, `重启前有一条消息未能送达（${resolved.error.code}）。`)
      return
    }
    const verdict = reconcileMessage(record, resolved.agent.session.events)
    switch (verdict.action) {
      case 'enqueued':
        await inboundEvents.put(eventId, { ...record, status: 'enqueued', text: undefined, target: targetId })
        ctx.logger.info('feishu-audit action=inbound-recovered event=%s chat=%s sender=%s session=%s via=existing',
          auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), auditHash(targetId))
        return
      case 'rejected':
        await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, target: targetId, reason: verdict.via })
        ctx.logger.warn('feishu-audit action=inbound-recovery-rejected event=%s chat=%s sender=%s reason=%s',
          auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), verdict.via)
        reply(record.chatId, '重启前有一条消息随任务取消被丢弃。')
        return
      case 'reroute':
      case 'refollowup': {
        if (record.text === undefined) {
          await inboundEvents.put(eventId, { ...record, status: 'rejected', target: targetId, reason: 'text-cleared-cannot-redeliver' })
          ctx.logger.warn('feishu-audit action=inbound-recovery-rejected event=%s chat=%s sender=%s reason=text-cleared',
            auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId))
          return
        }
        const message = createUserMessage({
          content: [{ type: 'text', text: record.text }],
          source: { kind: 'user', via: 'feishu' } as never,
        })
        await inboundEvents.put(eventId, { ...record, target: targetId, messageId: message.id as never })
        resolved.agent.followup(message)
        await inboundEvents.put(eventId, {
          ...record, status: 'enqueued', text: undefined, target: targetId, messageId: message.id as never,
        })
        ctx.logger.info('feishu-audit action=inbound-recovered event=%s chat=%s sender=%s session=%s via=%s',
          auditHash(eventId), auditHash(record.chatId), auditHash(record.senderOpenId), auditHash(targetId), verdict.action)
        return
      }
    }
  }
}

/** Extract concatenated text blocks from an assistant/message event payload. */
function extractAssistantText(data: { message?: { content?: unknown } }): string {
  const content = data.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}
