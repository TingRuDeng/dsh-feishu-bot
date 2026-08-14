/**
 * The feishu-bridge plugin (design §6): chat↔session bindings, commands,
 * the inbound idempotent state machine with startup reconciliation, and the
 * outbound projection with per-chat FIFO delivery.
 *
 * Ordering: all inbound work for one chat runs on that chat's serial queue —
 * startup recovery enqueues onto the same queues, so recovered and fresh
 * events cannot interleave. Approval answering (M3) is not here yet.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { FeishuInboundMessage } from '../gateway/index.ts'
// Declaration-merge imports: storage-domain contributes ctx.storageDomain,
// session-persistence contributes ctx.sessionPersistence.
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  feishuBotDomain, outboundSegmentId,
  type ChatBinding, type FeishuChatId, type FeishuEventId, type FeishuOpenId,
  type InboundEvent, type InboundMessage, type SessionIdString,
} from './domain.ts'
import { parseCommand } from './commands.ts'
import { authorizeCwd, buildWorkspaceFilter } from './workspace.ts'
import { createBridgeAgentResolver, type ResolveResult } from './resolver.ts'
import { reconcileMessage } from './inbound.ts'
import { segmentText } from './outbound.ts'
import { reduceTaskCard, renderTaskCard, type TokenInfo } from './task-card.ts'
import { pairApprovalId, renderApprovalCard, renderApprovalCardFrozen, type ApprovalCardSpec } from './approval.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'

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
  /** Minimum interval between task-card updates in milliseconds (M2). */
  cardThrottleMs: number
  /** Per-segment character budget for outbound text. */
  segmentMaxChars: number
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
  cardThrottleMs: z.natural().default(1_000),
  segmentMaxChars: z.natural().default(2_000),
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
export function apply(ctx: Context, config: Config): void {
  // Service-like async init inside a plain plugin: hold work until ready.
  void mount(ctx, config).catch((error: unknown) => {
    ctx.logger.error('feishu-bridge mount failed: %s', String(error))
    throw error
  })
}

async function mount(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(feishuBotDomain)
  ctx.effect(() => () => domain.close(), 'feishuBridge.domainClose')
  const bindings = domain.table('bindings')
  const inboundEvents = domain.table('inbound_events')
  const outboundSegments = domain.table('outbound_segments')
  const pendingCards = domain.table('pending_cards')

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

  /** Last /ls numbering per chat: ordinal → sessionId (process-local). */
  const listings = new Map<string, string[]>()

  /** Serial work queue per chat; recovery and fresh events share it. */
  const chatTails = new Map<string, Promise<void>>()
  const enqueueChatWork = (chatId: string, work: () => Promise<void>): Promise<void> => {
    const tail = chatTails.get(chatId) ?? Promise.resolve()
    const next = tail.then(work, work)
    chatTails.set(chatId, next.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge chat %s work failed: %s', chatId, String(error))
    }))
    return next
  }

  /** Outbound: project one assistant message into durable segments, then send. */
  const projectAndSend = async (
    chatId: FeishuChatId, sessionId: SessionIdString, sourceEventSeq: number, text: string,
  ): Promise<void> => {
    const segments = segmentText(text, config.segmentMaxChars)
    for (const [index, segment] of segments.entries()) {
      const key = outboundSegmentId(chatId, sessionId, sourceEventSeq, index)
      if (outboundSegments.get(key)?.status === 'sent') continue
      await outboundSegments.put(key, {
        chatId, sessionId, sourceEventSeq,
        segmentIndex: index, segmentCount: segments.length,
        text: segment, status: 'pending', createdAt: Date.now(),
      })
      await ctx.feishu.sendText(chatId, segment)
      const row = outboundSegments.get(key)
      if (row !== undefined) await outboundSegments.put(key, { ...row, status: 'sent', text: '' })
    }
  }

  /** Live projection: assistant/message events of bound sessions → chat. */
  ctx.on('session/event', (session, event) => {
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
    const card = renderTaskCard(snapshot, tokens)
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
        ctx.logger.warn('feishu-bridge card update failed for %s: %s', chatId, String(error))
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
      tracker.updating = false
      pushCard(chatId, sessionId, tracker)
    }, wait)
    ctx.effect(() => () => clearTimeout(timer), 'feishuBridge.cardTimer')
  }

  ctx.on('session/event', (session, event) => {
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
      ctx.logger.error('feishu-bridge reply to %s failed: %s', chatId, String(error))
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
    spec: ApprovalCardSpec
    resolve: (outcome: ApprovalOutcome) => void
    settled: boolean
    cardMessageId?: string
  }
  const pendingApprovals = new Map<string, PendingApproval>()

  /** approvalIds held by this channel; feeds the pairing scan's claimed set. */
  const claimedApprovalIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const entry of pendingApprovals.values()) ids.add(entry.approvalId)
    return ids
  }

  const freezeCard = (entry: PendingApproval, state: Parameters<typeof renderApprovalCardFrozen>[1]): void => {
    if (entry.cardMessageId === undefined) return
    void ctx.feishu.patchCard(entry.cardMessageId, renderApprovalCardFrozen(entry.spec, state))
      .catch((error: unknown) => {
        ctx.logger.warn('feishu-bridge approval card freeze failed: %s', String(error))
      })
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
    const spec: ApprovalCardSpec = {
      pendingId,
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
      sessionTitle: String(req.agent.session.id),
      webUrl: config.webUrl,
    }
    let entry: PendingApproval
    const feishuAnswer = new Promise<ApprovalOutcome>((resolvePromise) => {
      entry = {
        approvalId, chatId: boundChatId, spec, settled: false,
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
      ctx.logger.error('feishu-bridge approval record write failed: %s', String(error))
      return next()
    }
    let cardMessageId: string
    try {
      cardMessageId = await ctx.feishu.sendCard(boundChatId, renderApprovalCard(spec))
    } catch (error: unknown) {
      pendingApprovals.delete(pendingId)
      void pendingCards.delete(pendingId as never).catch(() => undefined)
      ctx.logger.error('feishu-bridge approval card send failed: %s', String(error))
      return next()
    }
    entry!.cardMessageId = cardMessageId
    try {
      await pendingCards.update(pendingId as never, { cardMessageId } as never)
    } catch { /* backfill miss only widens the restart sweep's invalidation to this card */ }

    // Withdrawal: the asker aborted — freeze and release without deciding.
    const onAbort = (): void => {
      const live = pendingApprovals.get(pendingId)
      if (live === undefined || live.settled) return
      live.settled = true
      pendingApprovals.delete(pendingId)
      void pendingCards.delete(pendingId as never).catch(() => undefined)
      freezeCard(live, 'withdrawn')
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
      // Web decided first: freeze our card.
      const live = pendingApprovals.get(pendingId)
      if (live !== undefined && !live.settled) {
        live.settled = true
        pendingApprovals.delete(pendingId)
        void pendingCards.delete(pendingId as never).catch(() => undefined)
        req.signal?.removeEventListener('abort', onAbort)
        freezeCard(live, 'elsewhere')
      }
      return outcome
    }, (): Promise<ApprovalOutcome> => new Promise<ApprovalOutcome>(() => {}))
    return Promise.race([feishuAnswer, webDecision])
  }, { prepend: true })

  /** Card button clicks: validate, resolve the pending entry, freeze the card. */
  ctx.feishu.handleCardActions(async (action) => {
    const value = action.value as { pendingId?: string; action?: string } | undefined
    const pendingId = value?.pendingId
    const verb = value?.action
    if (pendingId === undefined || (verb !== 'allow' && verb !== 'reject')) return {}
    // Permission: allowlist member (§7.2). Empty operator id fails closed.
    if (!config.allowedOpenIds.includes(action.operatorOpenId)) {
      return { toast: '你没有权限操作此审批' }
    }
    const entry = pendingApprovals.get(pendingId)
    if (entry === undefined || entry.settled) {
      return { toast: '该审批已失效或已在别处决定' }
    }
    // The card's chat must still hold an active binding for the session.
    const binding = bindings.get(entry.chatId as FeishuChatId)
    if (binding === undefined || binding.status !== 'active') {
      return { toast: '该会话已解绑，审批按钮已失效' }
    }
    const outcome: ApprovalOutcome = verb === 'allow' ? 'allowed-once' : 'rejected'
    entry.resolve(outcome)
    freezeCard(entry, verb === 'allow' ? 'decided-allow' : 'decided-reject')
    return { toast: verb === 'allow' ? '已允许（本次）' : '已拒绝' }
  })

  /** Route one deduplicated, authorized text message to the bound session. */
  const routeMessage = async (eventId: FeishuEventId, record: InboundMessage): Promise<void> => {
    const binding = bindings.get(record.chatId)
    if (binding === undefined || binding.status !== 'active') {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding' })
      reply(record.chatId, '当前没有绑定的会话。用 /ls 查看、/use <id> 绑定，或 /new 新建。')
      return
    }
    const resolved: ResolveResult = await resolve(binding.sessionId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: resolved.error.code })
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
  }

  const handleCommand = async (eventId: FeishuEventId, record: InboundEvent, text: string): Promise<void> => {
    const command = parseCommand(text)
    if (command === undefined) return
    const chatId = record.chatId
    const commit = async (result: string): Promise<void> => {
      await inboundEvents.put(eventId, { ...record, status: 'committed', result } as InboundEvent)
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
        const persisted = (await ctx.sessionPersistence.list())
          .filter(h => inWorkspace(h.cwd) && h.origin !== 'subagent')
        const seen = new Set(persisted.map(h => String(h.id)))
        const live = ctx.sessions.list()
          .filter(sess => !seen.has(String(sess.id))
            && inWorkspace(sess.header.cwd) && sess.header.origin !== 'subagent')
          .map(sess => sess.header)
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
        listings.set(chatId, ordered)
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
        await bindings.delete(chatId)
        cards.delete(chatId)
        await commit(`已解绑 ${binding.sessionId}。会话仍在运行，可随时 /use 重新绑定。`)
        return
      }
      case 'stop': {
        const binding = bindings.get(chatId)
        if (binding === undefined || binding.status !== 'active') {
          await commit('当前没有绑定的会话。')
          return
        }
        const agent = ctx.agents.get(binding.sessionId as unknown as SessionId)
        if (agent === undefined || agent.status !== 'running') {
          await commit('会话当前没有在执行任务。')
          return
        }
        // keepInbox: queued messages survive for the next turn (design M2).
        // The completion answer is the turn/end terminal the card listener
        // renders as 已停止 — not whenIdle(), which a queued followup defers.
        agent.cancel({ kind: 'user' }, { keepInbox: true })
        await commit('已请求停止当前任务。结果以任务卡状态为准；排队中的消息会在下一轮继续。')
        return
      }
      case 'use': {
        let targetId = command.sessionId
        if (/^\d+$/u.test(targetId)) {
          const ordered = listings.get(chatId)
          const picked = ordered?.[Number(targetId) - 1]
          if (picked === undefined) {
            await commit('编号无效或列表已过期。请先发送 /ls 获取最新编号。')
            return
          }
          targetId = picked
        }
        // Workspace gate BEFORE resolving: a session outside the allowed
        // roots is not bindable even by full id (design §6.6).
        const inWorkspace = await buildWorkspaceFilter(config.allowedWorkspaces)
        const targetCwd = sessionCwd(targetId)
        if (!inWorkspace(await targetCwd)) {
          await commit('无法绑定：该会话不在允许的工作区内。')
          return
        }
        const target = targetId as unknown as SessionId
        const resolved = await resolve(target)
        if ('error' in resolved) { await commit(`无法绑定：${resolved.error.code}`); return }
        const binding: ChatBinding = {
          sessionId: targetId as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        await bindings.put(chatId, binding)
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
        await bindings.put(chatId, binding)
        await ctx.sessions.flush(handle.agent.session)
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
      if (message.chatType !== 'p2p') return
      if (!config.allowedOpenIds.includes(message.senderOpenId)) {
        ctx.logger.warn('feishu-bridge: rejected sender (allowlist), event %s', message.eventId)
        return
      }
      const eventId = message.eventId as FeishuEventId
      if (inboundEvents.get(eventId) !== undefined) return // at-least-once dedup
      if (Date.now() - message.createTimeMs > config.freshnessMs) {
        await inboundEvents.put(eventId, {
          kind: 'message',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'expired', reason: 'stale',
        })
        return
      }
      if (message.text === undefined) {
        reply(message.chatId, '暂不支持非文本消息。')
        return
      }
      const command = parseCommand(message.text)
      if (command !== undefined) {
        const record: InboundEvent = {
          kind: 'command',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'received',
          command: command.kind,
          commandArgsHash: hashText(message.text),
        }
        await inboundEvents.put(eventId, record)
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
      await routeMessage(eventId, record)
    })
  })

  await recoverInterrupted()
  await sweepPendingCards()
  ctx.logger.info('feishu-bridge mounted: %d user(s), %d workspace root(s), %d binding(s)',
    config.allowedOpenIds.length, config.allowedWorkspaces.length, bindings.size)

  /**
   * Restart sweep (design §6.4): every persisted pending approval card is
   * from a dead process. With a cardMessageId, freeze it as invalidated;
   * without one (crashed before exposure), just delete. Never write
   * approval/decided — card invalidation is not a decision.
   */
  async function sweepPendingCards(): Promise<void> {
    for (const [key, record] of pendingCards.entries()) {
      if (record.cardMessageId !== undefined) {
        const spec: ApprovalCardSpec = {
          pendingId: record.pendingId, toolName: record.toolName,
          ...record.reason === undefined ? {} : { reason: record.reason },
          sessionTitle: record.sessionTitle, webUrl: config.webUrl,
        }
        void ctx.feishu.patchCard(record.cardMessageId as string, renderApprovalCardFrozen(spec, 'invalidated'))
          .catch((error: unknown) => {
            ctx.logger.warn('feishu-bridge stale approval card freeze failed: %s', String(error))
          })
        ctx.logger.info('feishu-bridge: invalidated stale approval card %s', record.pendingId)
      }
      await pendingCards.delete(key)
    }
  }

  /** Startup reconciliation (design §6.1/§6.2) on the same per-chat queues. */
  async function recoverInterrupted(): Promise<void> {
    for (const [eventId, record] of inboundEvents.entries()) {
      if (record.kind === 'message' && (record.status === 'received' || record.status === 'recovering')) {
        void enqueueChatWork(record.chatId, () => recoverMessage(eventId, record))
      } else if (record.kind === 'command' && record.status === 'received') {
        void enqueueChatWork(record.chatId, async () => {
          await inboundEvents.put(eventId, { ...record, status: 'rejected' })
          if (record.target !== undefined) {
            reply(record.chatId, `重启前有一条 /${record.command} 命令中断，可能已生效（目标 ${record.target}），请用 /status 核实。`)
          } else {
            reply(record.chatId, `重启前有一条 /${record.command} 命令未完成，未产生影响，请重发。`)
          }
        })
      }
    }
  }

  async function recoverMessage(eventId: FeishuEventId, record: InboundMessage): Promise<void> {
    await inboundEvents.put(eventId, { ...record, status: 'recovering' })
    const binding = bindings.get(record.chatId)
    const targetId = record.target ?? binding?.sessionId
    if (targetId === undefined) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding-at-recovery' })
      return
    }
    const resolved = await resolve(targetId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: `recovery-${resolved.error.code}` })
      reply(record.chatId, `重启前有一条消息未能送达（${resolved.error.code}）。`)
      return
    }
    const verdict = reconcileMessage(record, resolved.agent.session.events)
    switch (verdict.action) {
      case 'enqueued':
        await inboundEvents.put(eventId, { ...record, status: 'enqueued', text: undefined, target: targetId })
        return
      case 'rejected':
        await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, target: targetId, reason: verdict.via })
        reply(record.chatId, '重启前有一条消息随任务取消被丢弃。')
        return
      case 'reroute':
      case 'refollowup': {
        if (record.text === undefined) {
          await inboundEvents.put(eventId, { ...record, status: 'rejected', target: targetId, reason: 'text-cleared-cannot-redeliver' })
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

/** Stable non-reversible digest for command audit rows. */
function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}
