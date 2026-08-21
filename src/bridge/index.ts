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
import { randomBytes } from 'node:crypto'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  type AgentOptions,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import {
  classifyFeishuFailure,
  isPermanentFeishuFailure,
  type FeishuCardAction,
  type FeishuDeliveryIdentity,
  type FeishuInboundMessage,
} from '../gateway/index.ts'
import { auditHash, safeErrorFact } from '../audit.ts'
// Declaration-merge imports: storage-domain contributes ctx.storageDomain,
// session-persistence contributes ctx.sessionPersistence.
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  canonicalDeliveryId, feishuBotDomain, feishuDeliveryDomain, projectionCursorId,
  type ChatBinding, type FeishuChatId, type FeishuEventId, type FeishuInboundKey,
  type FeishuDeliveryId, type FeishuMessageId, type FeishuOpenId,
  type InboundCommand, type InboundEvent, type InboundMessage, type OutboundSegment,
  type OutboundSegmentId, type ProjectionCursorId, type SessionIdString,
  type CanonicalDelivery,
} from './domain.ts'
import { parseCommand } from './commands.ts'
import { authorizeCwd, buildWorkspaceFilter, validateDefaultWorkspace } from './workspace.ts'
import { createBridgeAgentResolver, type ResolveResult } from './resolver.ts'
import { createModelSelectionRegistry } from './model-selection.ts'
import { escapeLarkMarkdownLiteral } from './lark-markdown.ts'
import { formatSessionDisplayTitle } from './display.ts'
import {
  MODEL_PAGE_SIZE,
  revalidateEffort,
  renderModelCard,
  renderModelEffortCard,
  renderModelProviderCard,
  renderModelStatusCard,
  type ModelCardEffort,
  type ModelCardModel,
  type ModelCardProvider,
} from './model-card.ts'
import { reconcileMessage } from './inbound.ts'
import {
  directBoundTaskMessageId,
  foldFeishuTaskResults,
  isInternalTaskMessage,
  reduceFeishuTask,
  renderTaskCard,
  type TokenInfo,
} from './task-card.ts'
import { renderResultCard, segmentResultCards } from './result-card.ts'
import {
  danglingActiveBindings, isRecoveryExpired,
  planDurableRetention, planRetention, pruneProjectionCursors,
  sortPendingOutbox, watermarkKey,
} from './reliability.ts'
import { pairApprovalId, renderApprovalGroupCard, type ApprovalCardSpec, type ApprovalItemState } from './approval.ts'
import {
  renderSessionListCard,
  renderSessionListStatusCard,
  renderSessionWorkspaceCard,
  SESSION_LIST_PAGE_SIZE,
  type SessionListChoice,
} from './session-list-card.ts'
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
  /** Lifetime of the most recent `/ls` card and ordinal snapshot per chat. */
  listingTtlMs: number
  /** Minimum interval between task-card updates in milliseconds (M2). */
  cardThrottleMs: number
  /** Maximum age of received/recovering work eligible for restart recovery. */
  recoveryTtlMs: number
  /** Maximum time to wait while releasing a target created by a failed binding switch. */
  bindingCleanupTimeoutMs: number
  /** Maximum time Bridge disposal waits for already accepted work. */
  disposeDrainTimeoutMs: number
  /** Retention period for terminal inbound rows. */
  inboundRetentionMs: number
  /** Hard capacity for inbound rows; recoverable rows are never evicted. */
  inboundMaxRecords: number
  /** Retention period for terminal outbound rows. */
  outboundRetentionMs: number
  /** Maximum age of an unsent outbound segment before abandonment. */
  outboundPendingTtlMs: number
  /** Hard capacity for outbound rows; fresh pending rows are never evicted. */
  outboundMaxRecords: number
  /** Retention period for terminal canonical delivery rows. */
  deliveryRetentionMs: number
  /** Maximum age of a pending canonical delivery before abandonment. */
  deliveryPendingTtlMs: number
  /** Hard capacity for canonical delivery rows. */
  deliveryMaxRecords: number
  /** Maximum age of a persisted approval no longer owned by this process. */
  approvalPendingTtlMs: number
  /** Hard capacity for persisted approval rows. */
  approvalMaxRecords: number
  /** Retention period for an unbound cursor with no pending delivery. */
  projectionCursorRetentionMs: number
  /** Hard capacity for projection cursors. */
  projectionCursorMaxRecords: number
  /** Interval between retention sweeps. */
  maintenanceIntervalMs: number
  /** Optional provider override; omitted follows Harness agentDefaultModel. */
  agentProvider?: string
  /** Optional model override; must be paired with agentProvider. */
  agentModel?: string
  /** Web GUI base URL shown on approval cards. */
  webUrl: string
  /** Feishu progress card detail: concise, summary, or full. */
  progressDetail: 'concise' | 'summary' | 'full'
}

const ConfigSchema: z<Config> = z.object({
  allowedOpenIds: z.array(z.string()).default([]),
  allowedWorkspaces: z.array(z.string()).default([]),
  defaultWorkspace: z.string(),
  freshnessMs: z.natural().default(600_000),
  listingTtlMs: z.natural().default(300_000),
  cardThrottleMs: z.natural().default(1_000),
  recoveryTtlMs: z.natural().default(86_400_000),
  bindingCleanupTimeoutMs: z.natural().default(5_000),
  disposeDrainTimeoutMs: z.natural().default(5_000),
  inboundRetentionMs: z.natural().default(604_800_000),
  inboundMaxRecords: z.natural().default(50_000),
  outboundRetentionMs: z.natural().default(604_800_000),
  outboundPendingTtlMs: z.natural().default(86_400_000),
  outboundMaxRecords: z.natural().default(10_000),
  deliveryRetentionMs: z.natural().default(604_800_000),
  deliveryPendingTtlMs: z.natural().default(86_400_000),
  deliveryMaxRecords: z.natural().default(10_000),
  approvalPendingTtlMs: z.natural().default(86_400_000),
  approvalMaxRecords: z.natural().default(1_000),
  projectionCursorRetentionMs: z.natural().default(604_800_000),
  projectionCursorMaxRecords: z.natural().default(10_000),
  maintenanceIntervalMs: z.natural().default(86_400_000),
  agentProvider: z.string(),
  agentModel: z.string(),
  webUrl: z.string().default('http://127.0.0.1:3080'),
  progressDetail: z.union(['concise', 'summary', 'full'] as const).default('summary'),
})

export const Config: z<Config> = z.transform(ConfigSchema, (config) => {
  const providerConfigured = Boolean(config.agentProvider?.trim())
  const modelConfigured = Boolean(config.agentModel?.trim())
  if (providerConfigured !== modelConfigured) {
    throw new z.ValidationError(
      'agentProvider and agentModel must be configured together',
      {},
    )
  }
  return config
}, true)

export const name = 'feishu-bridge'
export const inject = [
  'feishu', 'agents', 'sessions', 'sessionPersistence', 'storageDomain',
  'agentDefaultModel', 'workspaceRegistry', 'sessionProjections', 'sessionProjectionCache', 'llm',
]

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
  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // Cordis waits for an async plugin callback before unloading its effects.
    // Observe this Fiber's disposal here so startup never publishes new owners.
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('feishu-bridge setup disposed'))
    }
  })
  return mount(ctx, config, setupAbort.signal).then(
    (active) => {
      if (active && !setupAbort.signal.aborted) ctx.feishu.markBridgeReady()
    },
    (error: unknown) => {
      if (setupAbort.signal.aborted) return
      ctx.feishu.markBridgeFailed(error)
      ctx.logger.error('feishu-bridge mount failed: %s', safeErrorFact(error))
      throw error
    },
  ).finally(stopSetupCancellation)
}

async function mount(ctx: Context, config: Config, setupSignal: AbortSignal): Promise<boolean> {
  await validateDefaultWorkspace(config.defaultWorkspace, config.allowedWorkspaces)
  setupSignal.throwIfAborted()
  const defaultModel = ctx.get('agentDefaultModel') as {
    currentSelection: () => ModelSelection
  } | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') as {
    readonly archivedSessionIds: readonly SessionId[]
    list: () => readonly { path: string; title?: string; name?: string; sessionIds: readonly SessionId[] }[] | Promise<readonly { path: string; title?: string; name?: string; sessionIds: readonly SessionId[] }[]>
  } | undefined
  const sessionProjections = ctx.get('sessionProjections' as never) as {
    snapshot: (session: { readonly events: readonly SessionEvent[] }) => {
      values: { title?: unknown }
    }
  } | undefined
  const sessionProjectionCache = ctx.get('sessionProjectionCache' as never) as {
    coldSnapshot: (sessionId: SessionId) => Promise<{ values: { title?: unknown } }>
  } | undefined
  if (defaultModel === undefined) throw new Error('feishu-bridge: agentDefaultModel service missing')
  if (workspaceRegistry === undefined) throw new Error('feishu-bridge: workspaceRegistry service missing')
  if (sessionProjections === undefined) throw new Error('feishu-bridge: sessionProjections service missing')
  if (sessionProjectionCache === undefined) throw new Error('feishu-bridge: sessionProjectionCache service missing')
  const configuredProvider = config.agentProvider?.trim() || undefined
  const configuredModel = config.agentModel?.trim() || undefined
  if ((configuredProvider === undefined) !== (configuredModel === undefined)) {
    throw new Error('feishu-bridge: agentProvider and agentModel must be configured together')
  }
  const domain = await ctx.storageDomain.open(feishuBotDomain)
  const deliveryDomain = await (async () => {
    try {
      setupSignal.throwIfAborted()
      const opened = await ctx.storageDomain.open(feishuDeliveryDomain)
      if (setupSignal.aborted) {
        try {
          await opened.close()
        } catch (closeError: unknown) {
          ctx.logger.error('feishu-bridge delivery domain rollback failed: %s', safeErrorFact(closeError))
        }
        setupSignal.throwIfAborted()
      }
      return opened
    } catch (error: unknown) {
      try {
        await domain.close()
      } catch (closeError: unknown) {
        ctx.logger.error('feishu-bridge primary domain rollback failed: %s', safeErrorFact(closeError))
      }
      throw error
    }
  })()
  let disposed = false
  let storageWritable = true
  let drainExpired = false
  let settlePendingApprovalsOnDispose = (): void => {}
  let unregisterEarlyHandlersOnDispose = (): void => {}
  let disposeBridge = async (): Promise<void> => {
    disposed = true
    settlePendingApprovalsOnDispose()
    unregisterEarlyHandlersOnDispose()
    const deadlineAt = Date.now() + config.disposeDrainTimeoutMs
    while (true) {
      const accepted = [...backgroundWork]
      if (accepted.length === 0) {
        // A completed initialization rung can enqueue its compensating delete
        // in the next microtask. Require one stable empty checkpoint.
        await Promise.resolve()
        if (backgroundWork.size === 0) break
        continue
      }
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) break
      let timer: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([
        Promise.all(accepted.map(work => work.then(() => undefined, () => undefined)))
          .then(() => true as const),
        new Promise<false>(resolveTimeout => {
          timer = setTimeout(() => { resolveTimeout(false) }, remaining)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (!drained) break
      await Promise.resolve()
    }
    drainExpired = true
    storageWritable = false
    await deliveryDomain.close()
    await domain.close()
  }
  try {
    setupSignal.throwIfAborted()
    ctx.effect(() => () => disposeBridge(), 'feishuBridge.lifecycle')
  } catch (error: unknown) {
    // The Fiber can become inactive in the microtask between the second open
    // and lifecycle registration. Until registration succeeds, rollback is
    // still this stack frame's responsibility.
    disposed = true
    storageWritable = false
    try {
      await deliveryDomain.close()
    } catch (closeError: unknown) {
      ctx.logger.error('feishu-bridge delivery domain registration rollback failed: %s', safeErrorFact(closeError))
    }
    try {
      await domain.close()
    } catch (closeError: unknown) {
      ctx.logger.error('feishu-bridge primary domain registration rollback failed: %s', safeErrorFact(closeError))
    }
    throw error
  }
  /** Reject late mutations before they can reach a domain that has closed. */
  const guardTable = <T extends object>(table: T): T => new Proxy(table, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      if (property === 'put' || property === 'update' || property === 'delete') {
        return (...args: unknown[]): unknown => {
          if (!storageWritable) return Promise.reject(new Error('feishu-bridge: storage closed'))
          return Reflect.apply(value, target, args)
        }
      }
      return value.bind(target) as unknown
    },
  })
  const bindings = guardTable(domain.table('bindings'))
  const inboundEvents = guardTable(domain.table('inbound_events'))
  const outboundSegments = guardTable(domain.table('outbound_segments'))
  const pendingCards = guardTable(domain.table('pending_cards'))
  const deliveries = guardTable(deliveryDomain.table('deliveries'))
  const projectionCursors = guardTable(deliveryDomain.table('projection_cursors'))
  const setWatermarks = (watermarks: Record<string, number>): Promise<void> => {
    if (!storageWritable) return Promise.reject(new Error('feishu-bridge: storage closed'))
    return domain.global.set({ watermarks })
  }
  let maintenanceTail: Promise<void> = Promise.resolve()
  const backgroundWork = new Set<Promise<unknown>>()
  const trackBackground = <T>(work: Promise<T>): Promise<T> => {
    backgroundWork.add(work)
    void work.then(
      () => { backgroundWork.delete(work) },
      () => { backgroundWork.delete(work) },
    )
    return work
  }
  // M7.0: the effective per-agent model selection, captured when an agent is
  // created or cold-resumed. The configured override carries no effort — the
  // adapter/provider default applies; the default path carries the complete
  // provider/model/reasoningEffort triple. `agentOptions` alone would drop
  // the effort silently, because dsh-agent's AgentOptions has no such field.
  const defaultSelection = (): ModelSelection => configuredProvider === undefined
    ? defaultModel.currentSelection()
    : { provider: configuredProvider, model: configuredModel! }
  const agentOptions = (): AgentOptions => defaultSelection()
  const archivedSessionIds = (): Set<string> =>
    new Set(workspaceRegistry.archivedSessionIds.map(String))
  // M7.3: the registry keeps one ref per bridge-owned session; entries die
  // with their agent scope (model-selection.ts). `install` is handed to the
  // resolver for cold resumes and called directly in the /new setup.
  const modelSelections = createModelSelectionRegistry(defaultSelection)
  const resolve = createBridgeAgentResolver(ctx, agentOptions, modelSelections.install)

  /**
   * Human name for one reasoning effort, resolved through the adapter's
   * route metadata (M7.3). Three outcomes stay distinct in the text: named,
   * unnamed (metadata present but id unknown — show the raw id), and
   * metadata-unavailable (resolveModelInfo threw — raw id plus a marker).
   * All adapter/user-supplied fragments are inert in the resulting text (S4).
   */
  const describeEffort = async (
    provider: string, model: string, effort: ReasoningEffortId | undefined,
  ): Promise<string> => {
    if (effort === undefined) return '未指定（模型默认）'
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const name = info.reasoning?.efforts.find(candidate => candidate.id === effort)?.name
      return escapeLarkMarkdownLiteral(name === undefined ? String(effort) : name)
    } catch {
      return `${escapeLarkMarkdownLiteral(String(effort))}（元数据不可用）`
    }
  }

  /** One provider/model/effort selection rendered for a /status line. */
  const describeSelection = async (selection: ModelSelection): Promise<string> =>
    `${escapeLarkMarkdownLiteral(selection.provider)}/${escapeLarkMarkdownLiteral(selection.model)}（档位：${await describeEffort(
      selection.provider, selection.model, selection.reasoningEffort,
    )}）`

  /** Recorded cwd of a session: live header first, then persisted header. */
  const sessionCwd = async (sessionId: string): Promise<string | undefined> => {
    for (const session of ctx.sessions.list()) {
      if (String(session.id) === sessionId) return session.header.cwd
    }
    const header = (await ctx.sessionPersistence.list(setupSignal))
      .find(h => String(h.id) === sessionId)
    return header?.cwd
  }

  /** Current live and persisted session identities, without loading agents. */
  const knownSessionIds = async (): Promise<Set<string>> => new Set([
    ...ctx.sessions.list().map(session => String(session.id)),
    ...(await ctx.sessionPersistence.list(setupSignal)).map(header => String(header.id)),
  ])

  interface SessionListing {
    token: string
    ordered: string[]
    workspaces: Array<{
      key: string
      name: string
      sessions: Array<{ id: SessionId; cwd: string; createdAt?: number }>
      choices?: SessionListChoice[]
    }>
    at: number
    operatorOpenId: string
    messageId?: string
    presentation: 'staged' | 'visible' | 'text' | 'uncertain'
    state: 'listing' | 'navigating' | 'binding' | 'consumed'
    view: { level: 'workspaces'; page: number }
      | { level: 'sessions'; workspaceIndex: number; page: number }
  }
  /** Last stable `/ls` snapshot per chat; card actions resolve token/index through this map. */
  const listings = new Map<string, SessionListing>()

  /** M7.1: last stable `/model` snapshot per chat (design §5.3). */
  interface ModelListing {
    token: string
    at: number
    operatorOpenId: string
    messageId?: string
    presentation: 'staged' | 'visible' | 'text' | 'uncertain'
    state: 'listing' | 'consumed'
    view: { level: 'providers'; page: number; providers: ModelCardProvider[] }
      | { level: 'models'; page: number; providerIndex: number; providers: ModelCardProvider[]; models: ModelCardModel[] }
      | {
        level: 'efforts'
        page: number
        providerIndex: number
        modelIndex: number
        providers: ModelCardProvider[]
        models: ModelCardModel[]
        efforts: ModelCardEffort[]
        currentEffortName?: string
      }
  }
  const modelListings = new Map<string, ModelListing>()

  const workspaceLabel = (cwd: string | undefined): string =>
    cwd?.replace(/[/\\]+$/u, '').split(/[/\\]/u).filter(Boolean).at(-1) ?? '未知工作区'

  const displayTitle = (title: string, cwd: string | undefined): string =>
    formatSessionDisplayTitle(title, workspaceLabel(cwd))

  const shortSessionId = (sessionId: string): string => sessionId.length > 18
    ? `${sessionId.slice(0, 15)}…`
    : sessionId

  const sessionTitle = async (header: { id: SessionId }): Promise<string> => {
    try {
      const live = ctx.sessions.get(header.id)
      const value = live === undefined
        ? (await sessionProjectionCache.coldSnapshot(header.id)).values.title
        : sessionProjections.snapshot(live).values.title
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      ctx.logger.warn('feishu-audit action=session-title-degraded session=%s reason=projection-read',
        auditHash(String(header.id)))
    }
    return '未命名会话'
  }

  const sessionChoice = async (
    header: { id: SessionId; cwd: string; createdAt?: number },
  ): Promise<SessionListChoice> => ({
    sessionId: String(header.id),
    title: formatSessionDisplayTitle(await sessionTitle(header), workspaceLabel(header.cwd)),
    workspace: workspaceLabel(header.cwd),
    timeLabel: header.createdAt === undefined
      ? '未知'
      : new Date(header.createdAt).toLocaleString('zh-CN', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        }),
    shortId: shortSessionId(String(header.id)),
  })

  /** Resolve titles only after the user enters a workspace; cache them for snapshot stability. */
  const workspaceSessionChoices = async (
    listing: SessionListing,
    workspaceIndex: number,
  ): Promise<SessionListChoice[] | undefined> => {
    const workspace = listing.workspaces[workspaceIndex]
    if (workspace === undefined) return undefined
    workspace.choices ??= await Promise.all(workspace.sessions.map(sessionChoice))
    return workspace.choices
  }

  /** Serial work queue per chat; recovery and fresh events share it. */
  const chatTails = new Map<string, Promise<void>>()
  const enqueueChatWork = (chatId: string, work: () => Promise<void>): Promise<void> => {
    if (disposed) return Promise.resolve()
    const tail = chatTails.get(chatId) ?? Promise.resolve()
    const next = tail.then(work, work)
    const settled = next.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge chat %s work failed: %s', auditHash(chatId), safeErrorFact(error))
    })
    chatTails.set(chatId, settled)
    void settled.then(() => {
      if (chatTails.get(chatId) === settled) chatTails.delete(chatId)
    })
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
      await setWatermarks({ ...watermarks, [key]: sequence })
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
    const deliveryId = key as string
    try {
      try {
        await ctx.feishu.sendCard(attempted.chatId, card, {
          deliveryId, stage: 'legacy-result-card', segmentIndex: attempted.segmentIndex,
        })
      } catch (error: unknown) {
        if (!isPermanentFeishuFailure(error)) throw error
        ctx.logger.warn('feishu-bridge result card send failed; using text fallback: %s', safeErrorFact(error))
        await ctx.feishu.sendText(attempted.chatId, attempted.text, {
          deliveryId, stage: 'legacy-result-text-fallback', segmentIndex: attempted.segmentIndex,
        })
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

  /** Legacy rows predate canonical deliveries and therefore remain the first chat barrier. */
  const hasPendingLegacyDelivery = (chatId: FeishuChatId): boolean =>
    [...outboundSegments.entries()].some(([, row]) =>
      row.status === 'pending' && row.chatId === chatId)

  let cursorAdmissionTail: Promise<void> = Promise.resolve()
  const reservedCursorKeys = new Set<string>()
  const advanceProjectionCursor = (
    chatId: FeishuChatId, sessionId: SessionIdString, sourceEventSeq: number,
  ): Promise<void> => {
    const operation = cursorAdmissionTail.then(async () => {
      const key = projectionCursorId(chatId, sessionId)
      const current = projectionCursors.get(key)
      if (sourceEventSeq <= (current?.sourceEventSeq ?? -1)) return
      if (current === undefined && projectionCursors.size >= config.projectionCursorMaxRecords) {
        await runMaintenance()
      }
      if (current === undefined && projectionCursors.size >= config.projectionCursorMaxRecords) {
        ctx.logger.warn('feishu-audit action=cursor-backpressure chat=%s session=%s records=%d limit=%d',
          auditHash(chatId), auditHash(sessionId), projectionCursors.size,
          config.projectionCursorMaxRecords)
        throw new Error('feishu-bridge: projection cursor capacity exhausted')
      }
      await projectionCursors.put(key, { sourceEventSeq, updatedAt: Date.now() })
    })
    cursorAdmissionTail = operation.catch((error: unknown) => {
      ctx.logger.error('feishu-bridge cursor admission failed: %s', safeErrorFact(error))
    })
    return operation
  }

  /** Deliver one complete canonical result; segmentation is deterministic and non-durable. */
  const deliverCanonical = async (
    key: FeishuDeliveryId, initial: CanonicalDelivery,
  ): Promise<boolean> => {
    const current = deliveries.get(key) ?? initial
    if (current.status !== 'pending') {
      await advanceProjectionCursor(current.chatId, current.sessionId, current.sourceEventSeq)
      return true
    }
    if (Date.now() - current.createdAt > config.deliveryPendingTtlMs) {
      await deliveries.put(key, { ...current, status: 'abandoned', text: '' })
      await advanceProjectionCursor(current.chatId, current.sessionId, current.sourceEventSeq)
      ctx.logger.warn('feishu-audit action=delivery-abandoned chat=%s session=%s seq=%d attempts=%d',
        auditHash(current.chatId), auditHash(current.sessionId), current.sourceEventSeq, current.attempts)
      return true
    }

    const attempted: CanonicalDelivery = { ...current, attempts: current.attempts + 1 }
    await deliveries.put(key, attempted)
    const cwd = await sessionCwd(attempted.sessionId)
    const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? String(attempted.sessionId)
    const segments = segmentResultCards(attempted.chatId, workspaceName, attempted.text)
    try {
      for (const [segmentIndex, segment] of segments.entries()) {
        const cardIdentity: FeishuDeliveryIdentity = {
          deliveryId: key as string,
          stage: 'result-card',
          segmentIndex,
        }
        try {
          await ctx.feishu.sendCard(attempted.chatId, segment.card, cardIdentity)
        } catch (error: unknown) {
          if (!isPermanentFeishuFailure(error)) throw error
          ctx.logger.warn('feishu-audit action=delivery-card-fallback chat=%s session=%s seq=%d segment=%d error=%s',
            auditHash(attempted.chatId), auditHash(attempted.sessionId), attempted.sourceEventSeq,
            segmentIndex, safeErrorFact(error))
          await ctx.feishu.sendText(attempted.chatId, segment.text, {
            deliveryId: key as string,
            stage: 'result-text-fallback',
            segmentIndex,
          })
        }
      }
      await deliveries.put(key, { ...attempted, status: 'sent', text: '' })
      await advanceProjectionCursor(attempted.chatId, attempted.sessionId, attempted.sourceEventSeq)
      ctx.logger.info('feishu-audit action=delivery-sent chat=%s session=%s seq=%d segments=%d attempts=%d',
        auditHash(attempted.chatId), auditHash(attempted.sessionId), attempted.sourceEventSeq,
        segments.length, attempted.attempts)
      return true
    } catch (error: unknown) {
      ctx.logger.error('feishu-audit action=delivery-pending chat=%s session=%s seq=%d attempts=%d error=%s',
        auditHash(attempted.chatId), auditHash(attempted.sessionId), attempted.sourceEventSeq,
        attempted.attempts, safeErrorFact(error))
      return false
    }
  }

  /** A materialized-but-unsent result is a hard FIFO barrier for the whole chat. */
  const deliverPendingCanonical = async (chatId: FeishuChatId): Promise<boolean> => {
    const pending = [...deliveries.entries()]
      .filter(([, row]) => row.status === 'pending' && row.chatId === chatId)
      .sort(([leftKey, left], [rightKey, right]) =>
        left.createdAt - right.createdAt
        || ((left.sessionId as string) === (right.sessionId as string)
          ? left.sourceEventSeq - right.sourceEventSeq
          : 0)
        || (leftKey as string).localeCompare(rightKey as string))
    for (const [key, row] of pending) {
      if (!await deliverCanonical(key, row)) return false
    }
    return true
  }

  const sessionEventsFrom = async (
    sessionId: SessionIdString, fromSeq: number,
  ): Promise<readonly SessionEvent[]> => {
    const live = ctx.sessions.list().find(session => String(session.id) === (sessionId as string))
    if (live !== undefined) {
      // Do not flush the complete live log on this hot path. Once an
      // assistant result appears, catchUpProjection first persists its full
      // canonical delivery; that row is the durable recovery boundary.
      return live.events.filter(event => event.seq >= fromSeq)
    }
    return (await ctx.sessionPersistence.readFrom(
      sessionId as unknown as SessionId, fromSeq,
    )).events
  }

  let deliveryAdmissionTail: Promise<void> = Promise.resolve()
  const materializeDelivery = (
    key: FeishuDeliveryId, candidate: CanonicalDelivery,
  ): Promise<CanonicalDelivery | undefined> => {
    let materialized: CanonicalDelivery | undefined
    const operation = deliveryAdmissionTail.then(async () => {
      materialized = deliveries.get(key)
      if (materialized !== undefined) return
      if (deliveries.size >= config.deliveryMaxRecords) await runMaintenance()
      if (deliveries.size >= config.deliveryMaxRecords) {
        ctx.logger.warn('feishu-audit action=delivery-backpressure chat=%s session=%s seq=%d records=%d limit=%d',
          auditHash(candidate.chatId), auditHash(candidate.sessionId), candidate.sourceEventSeq,
          deliveries.size, config.deliveryMaxRecords)
        return
      }
      await deliveries.put(key, candidate)
      materialized = candidate
    })
    const result = operation.then(() => materialized)
    deliveryAdmissionTail = result.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge delivery admission failed: %s', safeErrorFact(error))
    })
    return result
  }

  /** One projection path for startup recovery and task-terminal notifications. */
  const catchUpProjection = async (
    chatId: FeishuChatId, sessionId: SessionIdString,
  ): Promise<void> => {
    // Upgrade compatibility: a failed legacy outbox row is older than every
    // canonical row and must keep blocking this destination until restart.
    if (hasPendingLegacyDelivery(chatId)) return
    // The cursor records durable materialization, so a failed network send can
    // sit behind it. Retry that row before reading anything newer.
    if (!await deliverPendingCanonical(chatId)) return
    const cursorKey = projectionCursorId(chatId, sessionId)
    const fromSeq = (projectionCursors.get(cursorKey)?.sourceEventSeq ?? -1) + 1
    const events = await sessionEventsFrom(sessionId, Math.max(0, fromSeq))
    const folded = foldFeishuTaskResults(events, fromSeq)
    for (const result of folded.results) {
      const deliveryKey = canonicalDeliveryId(chatId, sessionId, result.taskStartSeq)
      let delivery = deliveries.get(deliveryKey)
      if (delivery === undefined) {
        const candidate: CanonicalDelivery = {
          chatId, sessionId, sourceEventSeq: result.sourceEventSeq,
          text: result.text, status: 'pending', attempts: 0, createdAt: Date.now(),
        }
        // The complete task-wide result is durable before its cursor moves.
        delivery = await materializeDelivery(deliveryKey, candidate)
        // Keep the cursor before this task so restart deterministically retries
        // it after delivery capacity becomes available.
        if (delivery === undefined) return
      }
      await advanceProjectionCursor(chatId, sessionId, result.sourceEventSeq)
      if (!await deliverCanonical(deliveryKey, delivery)) return
    }
    // Collapse only the settled/irrelevant suffix. An open Feishu task leaves
    // the cursor before its direct input for restart-safe aggregation.
    if (folded.cursorThrough >= fromSeq) {
      await advanceProjectionCursor(chatId, sessionId, folded.cursorThrough)
    }
  }

  /** A new binding owns only events committed after the binding point. */
  const seedProjectionCursorAtHead = async (
    chatId: FeishuChatId, sessionId: SessionIdString,
  ): Promise<void> => {
    const events = await sessionEventsFrom(sessionId, 0)
    const head = events.at(-1)
    if (head !== undefined) await advanceProjectionCursor(chatId, sessionId, head.seq)
  }

  /** A turn terminal schedules the same task-wide catch-up used at startup. */
  ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'turn/end') return
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active' || (binding.sessionId as string) !== String(session.id)) continue
      void enqueueChatWork(chatId, () =>
        catchUpProjection(chatId as FeishuChatId, binding.sessionId))
    }
  })

  /**
   * Task cards: one card per direct Feishu task, shared by every internal
   * continuation turn. Card state is process-local and
   * droppable (design §6.3: a restart never rebuilds an old card).
   */
  interface CardTracker {
    turn: number
    /** Scan boundary including the direct task's preceding turn/start. */
    taskStartSeq: number
    /** Stable direct input identity; internal messages cannot replace it. */
    taskMessageId: string
    /** Bound session needed when a pending timer is promoted during drain. */
    sessionId: SessionIdString
    messageId: string | undefined
    /** A newer session snapshot has been accepted by this actor. */
    dirty: boolean
    /** A turn terminal bypasses throttling; only task settlement closes the actor. */
    terminalRequested: boolean
    lastPatchAt: number
    frozen: boolean
    timer: ReturnType<typeof setTimeout> | undefined
    actor: Promise<void> | undefined
  }
  const cards = new Map<string, CardTracker>() // key: chatId
  const cardActors = new Set<Promise<void>>()
  const CARD_EVENT_TYPES = new Set([
    'user/message', 'turn/start', 'tool/call', 'tool/result',
    'tool/code-dispatch', 'llm/retry', 'turn/end',
  ])

  const clearCardTimer = (tracker: CardTracker): void => {
    if (tracker.timer === undefined) return
    clearTimeout(tracker.timer)
    tracker.timer = undefined
  }

  const startCardActor = (
    chatId: string, sessionId: SessionIdString, tracker: CardTracker,
  ): void => {
    if (tracker.actor !== undefined || tracker.frozen || !tracker.dirty) return
    clearCardTimer(tracker)
    tracker.dirty = false
    tracker.terminalRequested = false
    const actor = (async () => {
      try {
        const session = ctx.sessions.list().find(s => String(s.id) === (sessionId as string))
        if (session === undefined) return
        const folded = reduceFeishuTask(session.events, tracker.taskStartSeq)
        if (folded === undefined || folded.taskMessageId !== tracker.taskMessageId) return
        const snapshot = folded.snapshot
        // tokenMeter is optional: measurement failure removes only the token line.
        const meter = ctx.get('tokenMeter') as { measure?: (s: unknown) => { totalTokens: number; baseline: { kind: string } } } | undefined
        let tokens: TokenInfo | undefined
        try {
          const measured = meter?.measure?.(session)
          if (measured !== undefined) {
            tokens = { totalTokens: measured.totalTokens, anchored: measured.baseline.kind === 'usage' }
          }
        } catch { /* card facts remain valid without token measurement */ }
        const cwd = session.header.cwd
        const workspace = workspaceLabel(cwd)
        const title = cwd === undefined ? undefined : workspace
        const card = renderTaskCard(snapshot, tokens, title === undefined ? undefined : {
          title,
          progressDetail: config.progressDetail,
        })
        if (tracker.messageId === undefined) {
          tracker.messageId = await ctx.feishu.sendCard(chatId, card)
        } else {
          await ctx.feishu.patchCard(tracker.messageId, card)
        }
        tracker.lastPatchAt = Date.now()
        if (folded.settled) tracker.frozen = true
      } catch (error: unknown) {
        // A failed/ambiguous create must never be retried as a second card.
        // Terminal text replies use the durable delivery path instead.
        tracker.frozen = true
        ctx.logger.warn('feishu-bridge card update failed for %s: %s', auditHash(chatId), safeErrorFact(error))
      } finally {
        tracker.actor = undefined
        if (drainExpired) tracker.frozen = true
        if (tracker.frozen) clearCardTimer(tracker)
        else if (tracker.dirty && tracker.terminalRequested) {
          startCardActor(chatId, sessionId, tracker)
        } else if (tracker.dirty) {
          scheduleCard(chatId, sessionId, tracker)
        }
      }
    })()
    tracker.actor = actor
    cardActors.add(actor)
    void actor.then(
      () => { cardActors.delete(actor) },
      () => { cardActors.delete(actor) },
    )
  }

  const scheduleCard = (chatId: string, sessionId: SessionIdString, tracker: CardTracker): void => {
    if (tracker.frozen || tracker.actor !== undefined || tracker.timer !== undefined) return
    if (disposed) {
      startCardActor(chatId, sessionId, tracker)
      return
    }
    const wait = Math.max(0, config.cardThrottleMs - (Date.now() - tracker.lastPatchAt))
    tracker.timer = setTimeout(() => {
      tracker.timer = undefined
      startCardActor(chatId, sessionId, tracker)
    }, wait)
  }

  const requestCard = (
    chatId: string, sessionId: SessionIdString, tracker: CardTracker, terminal: boolean,
  ): void => {
    if (tracker.frozen) return
    tracker.dirty = true
    if (terminal) {
      tracker.terminalRequested = true
      clearCardTimer(tracker)
      startCardActor(chatId, sessionId, tracker)
      return
    }
    scheduleCard(chatId, sessionId, tracker)
  }

  ctx.on('session/event', (session, event) => {
    if (disposed) return
    if (!CARD_EVENT_TYPES.has(event.type)) return
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active' || (binding.sessionId as string) !== (session.id as string)) continue
      let tracker = cards.get(chatId)
      const directMessageId = event.type === 'user/message'
        ? directBoundTaskMessageId(event.data)
        : null
      if (directMessageId !== null) {
        const precedingStart = [...session.events]
          .reverse()
          .find(candidate => candidate.seq < event.seq && candidate.type === 'turn/start')
        const turn = (precedingStart?.data as { turn?: unknown } | undefined)?.turn
        tracker = {
          turn: typeof turn === 'number' ? turn : 0,
          taskStartSeq: precedingStart?.seq ?? event.seq,
          taskMessageId: directMessageId,
          sessionId: binding.sessionId, messageId: undefined,
          dirty: false, terminalRequested: false,
          lastPatchAt: 0, frozen: false, timer: undefined, actor: undefined,
        }
        cards.set(chatId, tracker)
      } else if (tracker === undefined) {
        continue
      } else if (event.type === 'user/message' && !isInternalTaskMessage(event.data)) {
        continue
      }
      const turn = (event.data as { turn?: unknown }).turn
      if (typeof turn === 'number') tracker.turn = turn
      requestCard(chatId, binding.sessionId, tracker, event.type === 'turn/end')
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
    detachAbort: () => void
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
    sessionId: string
    messageId?: string
    /** A create may have reached Feishu even though no message id came back. */
    createUncertain: boolean
    items: Map<string, { spec: ApprovalCardSpec; state: ApprovalItemState }>
    chain: Promise<void>
  }
  type ApprovalPushResult =
    | { ok: true; operation: 'send' | 'patch'; messageId: string }
    | { ok: false; operation: 'send' | 'patch'; error: unknown }
  const approvalGroups = new Map<string, ApprovalGroup>()
  /** Recently settled panels remain available for follow-up approvals within the task grace window. */
  const settledApprovalGroups = new Map<string, { group: ApprovalGroup; expiresAt: number }>()
  /** pendingId -> its group, surviving group rotation (for late settles). */
  const groupOf = new Map<string, ApprovalGroup>()
  const approvalReservations = new Set<string>()
  let approvalAdmissionTail: Promise<void> = Promise.resolve()

  /** Reserve one durable approval slot without letting parallel requests oversubscribe it. */
  const reserveApprovalSlot = (pendingId: string): Promise<boolean> => {
    let reserved = false
    const operation = approvalAdmissionTail.then(async () => {
      if (pendingCards.size + approvalReservations.size >= config.approvalMaxRecords) {
        await runMaintenance()
      }
      if (pendingCards.size + approvalReservations.size >= config.approvalMaxRecords) return
      approvalReservations.add(pendingId)
      reserved = true
    })
    const result = operation.then(() => reserved)
    approvalAdmissionTail = result.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge approval admission failed: %s', safeErrorFact(error))
    })
    return result
  }

  /** Best-effort terminal cleanup stays observable; a leftover row is invalidated on restart. */
  const deletePendingCard = (pendingId: string, reason: string): void => {
    void trackBackground(pendingCards.delete(pendingId as never)).catch((error: unknown) => {
      ctx.logger.error('feishu-bridge approval record cleanup failed: %s', safeErrorFact(error))
      ctx.logger.warn('feishu-audit action=approval-cleanup-failed pending=%s reason=%s',
        auditHash(pendingId), reason)
    })
  }

  /** approvalIds held by this channel; feeds the pairing scan's claimed set. */
  const claimedApprovalIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const entry of pendingApprovals.values()) ids.add(entry.approvalId)
    return ids
  }

  const detachGroupItem = (group: ApprovalGroup, pendingId: string): void => {
    group.items.delete(pendingId)
    if (groupOf.get(pendingId) === group) groupOf.delete(pendingId)
    const anyPending = [...group.items.values()].some(item => item.state === 'pending')
    if (!anyPending && approvalGroups.get(group.chatId) === group) {
      approvalGroups.delete(group.chatId)
      settledApprovalGroups.set(`${group.chatId}:${group.sessionId}`, { group, expiresAt: Date.now() + 120_000 })
    }
  }

  const pushGroup = async (
    group: ApprovalGroup, admittedPendingId?: string,
  ): Promise<ApprovalPushResult> => {
    let operation: 'send' | 'patch' = 'send'
    const attempt = group.chain.then(async (): Promise<string> => {
      // A terminal update queued behind an ambiguous initial create must not
      // issue a second create when the first message id never became known.
      if (group.messageId === undefined
        && ![...group.items.values()].some(item => item.state === 'pending')) return ''
      const card = renderApprovalGroupCard([...group.items.values()])
      if (group.messageId === undefined) {
        operation = 'send'
        if (group.createUncertain) {
          throw Object.assign(new Error('feishu-bridge: approval card create outcome is uncertain'), {
            feishuFailureKind: 'ambiguous' as const,
          })
        }
        try {
          group.messageId = await ctx.feishu.sendCard(group.chatId, card)
        } catch (error: unknown) {
          if (classifyFeishuFailure(error) === 'ambiguous') group.createUncertain = true
          throw error
        }
      } else {
        operation = 'patch'
        try {
          await ctx.feishu.patchCard(group.messageId, card)
        } catch (error: unknown) {
          // Keep admission compensation inside the actor. A later terminal
          // update queued on this group must never render an item whose own
          // presentation patch failed and is about to move to a standalone card.
          const admitted = admittedPendingId === undefined
            ? undefined
            : group.items.get(admittedPendingId)
          if (admitted?.state === 'pending'
            && groupOf.get(admittedPendingId!) === group) {
            detachGroupItem(group, admittedPendingId!)
          }
          throw error
        }
      }
      return group.messageId
    })
    group.chain = attempt.then(() => undefined, () => undefined)
    try {
      const messageId = await attempt
      return { ok: true, operation, messageId }
    } catch (error: unknown) {
      ctx.logger.warn('feishu-bridge approval card update failed: %s', safeErrorFact(error))
      return { ok: false, operation, error }
    }
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
    if (!anyPending && approvalGroups.get(group.chatId) === group) {
      approvalGroups.delete(group.chatId)
      settledApprovalGroups.set(`${group.chatId}:${group.sessionId}`, { group, expiresAt: Date.now() + 120_000 })
    }
    void trackBackground(pushGroup(group)).then((result) => {
      if (!result.ok) {
        ctx.logger.warn('feishu-audit action=approval-settle-update-failed chat=%s operation=%s',
          auditHash(group.chatId), result.operation)
      }
    })
  }

  /** One idempotent terminal path owns Promise, registry, durable row, and card state. */
  const finishApproval = (
    pendingId: string,
    outcome: ApprovalOutcome,
    state: Exclude<ApprovalItemState, 'pending'>,
    reason: string,
  ): boolean => {
    const entry = pendingApprovals.get(pendingId)
    if (entry === undefined || entry.settled) return false
    entry.settled = true
    entry.detachAbort()
    pendingApprovals.delete(pendingId)
    deletePendingCard(pendingId, reason)
    settleItem(pendingId, state)
    entry.resolve(outcome)
    return true
  }
  settlePendingApprovalsOnDispose = () => {
    for (const pendingId of [...pendingApprovals.keys()]) {
      finishApproval(pendingId, 'unavailable', 'invalidated', 'disposed')
    }
  }

  /** Release a registration that is delegating to the next answerer. */
  const dropApproval = (pendingId: string): void => {
    const entry = pendingApprovals.get(pendingId)
    if (entry === undefined || entry.settled) return
    entry.settled = true
    entry.detachAbort()
    pendingApprovals.delete(pendingId)
  }

  const unregisterApprovalRequests = ctx.on('approval/request', async (req, next) => {
    if (disposed) return next()
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
    const requestAborted = (): boolean => req.signal?.aborted === true
    if (requestAborted()) return 'cancelled'
    if (!await reserveApprovalSlot(pendingId)) {
      if (requestAborted()) return 'cancelled'
      ctx.logger.warn('feishu-audit action=approval-backpressure approval=%s chat=%s records=%d limit=%d',
        auditHash(approvalId), auditHash(boundChatId), pendingCards.size, config.approvalMaxRecords)
      return next()
    }
    if (disposed) {
      approvalReservations.delete(pendingId)
      return 'unavailable'
    }
    if (requestAborted()) {
      approvalReservations.delete(pendingId)
      return 'cancelled'
    }
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
        resolve: resolvePromise,
        detachAbort: () => {},
      }
    })
    pendingApprovals.set(pendingId, entry!)

    // Register before the first durable/card await, then close the standard
    // check/register race by inspecting the signal once more.
    const onAbort = (): void => {
      if (!finishApproval(pendingId, 'cancelled', 'withdrawn', 'withdrawn')) return
      approvalReservations.delete(pendingId)
      ctx.logger.info('feishu-audit action=approval-withdrawn pending=%s approval=%s chat=%s',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
    }
    entry!.detachAbort = () => { req.signal?.removeEventListener('abort', onAbort) }
    req.signal?.addEventListener('abort', onAbort, { once: true })
    if (requestAborted()) onAbort()
    if (entry!.settled) {
      approvalReservations.delete(pendingId)
      return feishuAnswer
    }

    const settledDuringInitialization = (): boolean => {
      if (!entry!.settled && disposed) {
        finishApproval(pendingId, 'unavailable', 'invalidated', 'disposed')
      } else if (!entry!.settled && requestAborted()) {
        onAbort()
      }
      if (!entry!.settled) return false
      // An abort can race a put: repeat deletion after each completed rung so
      // delete-before-put cannot recreate a zombie durable row.
      deletePendingCard(pendingId, 'initialization-settled')
      return true
    }

    // Durable-first (compensation ladder, design §6.4): record → card →
    // backfill. A failure at any rung unwinds and delegates via next().
    try {
      await trackBackground(pendingCards.put(pendingId as never, {
        kind: 'approval', pendingId, chatId: boundChatId, approvalId,
        toolName: req.toolName,
        ...req.reason === undefined ? {} : { reason: req.reason },
        sessionTitle: spec.sessionTitle, presentation: 'staged', createdAt: Date.now(),
      } as never))
      approvalReservations.delete(pendingId)
    } catch (error: unknown) {
      approvalReservations.delete(pendingId)
      if (entry!.settled) return feishuAnswer
      dropApproval(pendingId)
      ctx.logger.error('feishu-bridge approval record write failed: %s', safeErrorFact(error))
      ctx.logger.warn('feishu-audit action=approval-delegated pending=%s approval=%s chat=%s reason=record-write',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
      return next()
    }
    if (settledDuringInitialization()) return feishuAnswer
    // Join the chat's live group, or open a fresh card.
    let group = approvalGroups.get(boundChatId)
    if (group === undefined || group.sessionId !== String(req.agent.session.id)) {
      const settledKey = `${boundChatId}:${String(req.agent.session.id)}`
      const settled = settledApprovalGroups.get(settledKey)
      if (settled !== undefined && settled.expiresAt > Date.now()) {
        group = settled.group
        approvalGroups.set(boundChatId, group)
        settledApprovalGroups.delete(settledKey)
      } else {
        if (settled !== undefined) settledApprovalGroups.delete(settledKey)
        group = {
          chatId: boundChatId, sessionId: String(req.agent.session.id), createUncertain: false,
          items: new Map(), chain: Promise.resolve(),
        }
        approvalGroups.set(boundChatId, group)
      }
    }
    group.items.set(pendingId, { spec, state: 'pending' })
    groupOf.set(pendingId, group)
    let presentation = await trackBackground(pushGroup(group, pendingId))
    if (settledDuringInitialization()) return feishuAnswer
    if (!presentation.ok && presentation.operation === 'patch') {
      // The existing card never showed this item. Restore the in-memory
      // group to its visible state, then present this approval independently.
      detachGroupItem(group, pendingId)
      const standalone: ApprovalGroup = {
        chatId: boundChatId,
        sessionId: String(req.agent.session.id),
        createUncertain: false,
        items: new Map([[pendingId, { spec, state: 'pending' }]]),
        chain: Promise.resolve(),
      }
      group = standalone
      groupOf.set(pendingId, standalone)
      presentation = await trackBackground(pushGroup(standalone, pendingId))
      if (settledDuringInitialization()) return feishuAnswer
      ctx.logger.warn('feishu-audit action=approval-group-fallback pending=%s approval=%s chat=%s',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
    }
    if (!presentation.ok) {
      // A create with ambiguous outcome may have produced a card. Keep a
      // durable uncertain fact for startup's safe rejection, but never claim
      // it as visible or wait for its buttons in this process.
      detachGroupItem(group, pendingId)
      dropApproval(pendingId)
      const failureKind = classifyFeishuFailure(presentation.error)
      if (presentation.operation === 'send' && failureKind === 'ambiguous') {
        try {
          await trackBackground(pendingCards.update(pendingId as never, currentCard => ({
            ...currentCard,
            presentation: 'uncertain',
          })))
        } catch (error: unknown) {
          ctx.logger.error('feishu-bridge uncertain approval state write failed: %s', safeErrorFact(error))
        }
      } else {
        deletePendingCard(pendingId, 'send-failed')
      }
      ctx.logger.warn('feishu-audit action=approval-delegated pending=%s approval=%s chat=%s reason=card-%s failure=%s',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId),
        presentation.operation, failureKind)
      return next()
    }
    try {
      await trackBackground(pendingCards.update(pendingId as never, currentCard => ({
        ...currentCard,
        cardMessageId: presentation.messageId as never,
        presentation: 'visible',
      })))
    } catch (error: unknown) {
      // The card exists, but without its durable message id startup cannot
      // freeze it. Invalidate it now and delegate; the agent must not wait on
      // a card whose identity was not committed.
      if (entry!.settled) {
        deletePendingCard(pendingId, 'initialization-settled')
        return feishuAnswer
      }
      dropApproval(pendingId)
      settleItem(pendingId, 'invalidated')
      try {
        await trackBackground(pendingCards.delete(pendingId as never))
      } catch (cleanupError: unknown) {
        ctx.logger.error('feishu-bridge approval backfill cleanup failed: %s', safeErrorFact(cleanupError))
      }
      ctx.logger.error('feishu-bridge approval card id write failed: %s', safeErrorFact(error))
      ctx.logger.warn('feishu-audit action=approval-delegated pending=%s approval=%s chat=%s reason=card-id-write',
        auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId))
      return next()
    }
    if (settledDuringInitialization()) return feishuAnswer
    ctx.logger.info('feishu-audit action=approval-presented pending=%s approval=%s chat=%s session=%s',
      auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId),
      auditHash(String(req.agent.session.id)))

    // Plan α: delegate immediately; both channels stay live; the first REAL
    // decision wins. The chain's fail-closed 'unavailable' (no other
    // answerer) is NOT a decision — the Feishu card is live, so this channel
    // keeps waiting instead of losing to an empty chain (weclaw: absence of
    // an answer never defaults the outcome).
    const web = next()
    const webDecision = web.then((outcome): Promise<ApprovalOutcome> | ApprovalOutcome => {
      if (outcome === 'unavailable') return new Promise<ApprovalOutcome>(() => {})
      // Web decided first: mark our item decided-elsewhere.
      if (finishApproval(pendingId, outcome, 'elsewhere', 'decided-elsewhere')) {
        ctx.logger.info('feishu-audit action=approval-decided-elsewhere pending=%s approval=%s chat=%s outcome=%s',
          auditHash(pendingId), auditHash(approvalId), auditHash(boundChatId), outcome)
      }
      return outcome
    }, (): Promise<ApprovalOutcome> => new Promise<ApprovalOutcome>(() => {}))
    return Promise.race([feishuAnswer, webDecision])
  }, { prepend: true })

  /** All card button clicks share one Gateway slot; dispatch by payload kind. */
  const unregisterCardActions = ctx.feishu.handleCardActions(async (action) => {
    if (disposed) return { toast: '该卡片已失效' }
    // Feishu delivers button values as an object OR as a JSON string
    // depending on client/schema version; accept both. An unrecognized
    // payload gets a visible toast — silent {} looked like a dead button
    // in live acceptance.
    let raw = action.value
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw) } catch { raw = undefined }
    }
    const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? raw as {
          kind?: string
          pendingId?: string
          action?: string
          token?: string
          index?: number
          page?: number
          level?: 'workspaces' | 'sessions' | 'providers' | 'models' | 'efforts'
          workspaceIndex?: number
          effortId?: string
        }
      : undefined
    if (value?.kind === 'session-list') return handleSessionListCardAction(action, value)
    if (value?.kind === 'model') return handleModelCardAction(action, value)
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
    if (!finishApproval(
      pendingId, outcome, verb === 'allow' ? 'allowed' : 'rejected', 'decided',
    )) {
      return { toast: '该审批已失效或已在别处决定' }
    }
    ctx.logger.info('feishu-audit action=approval-click-decided operator=%s message=%s pending=%s approval=%s outcome=%s',
      auditHash(action.operatorOpenId), auditHash(action.messageId), auditHash(pendingId),
      auditHash(entry.approvalId), outcome)
    return { toast: verb === 'allow' ? '已允许（本次）' : '已拒绝' }
  })
  unregisterEarlyHandlersOnDispose = () => {
    unregisterApprovalRequests()
    unregisterCardActions()
  }

  type BindingOwnership = {
    ownership: 'existing' | 'created-here'
    dispose?: () => Promise<void>
  }
  type BindingFailureReason =
    | 'binding-write-failed'
    | 'binding-state-uncertain'
    | 'binding-changed-during-compensation'
  type BindingSwitchResult =
    | { ok: true }
    | {
      ok: false
      reason: BindingFailureReason
      message: string
    }

  const sameBinding = (left: ChatBinding | undefined, right: ChatBinding | undefined): boolean =>
    left === right || (left !== undefined && right !== undefined
      && left.sessionId === right.sessionId
      && left.status === right.status
      && left.boundBy === right.boundBy
      && left.boundAt === right.boundAt)

  /** Idempotently restore one exact structural after-image without clobbering a newer write. */
  const restorePreparedBinding = async (
    chatId: FeishuChatId,
    previous: ChatBinding | undefined,
    candidate: ChatBinding,
    source: string,
  ): Promise<void> => {
    let observed: ChatBinding | undefined
    try {
      observed = bindings.get(chatId)
    } catch (error: unknown) {
      ctx.logger.error('feishu-bridge %s rollback read failed: %s', source, safeErrorFact(error))
      return
    }
    if (!sameBinding(observed, candidate)) return
    try {
      if (previous === undefined) await bindings.delete(chatId)
      else await bindings.put(chatId, previous)
    } catch (error: unknown) {
      ctx.logger.error('feishu-bridge %s rollback failed: %s', source, safeErrorFact(error))
    }
  }

  /** Release only a capability created by this switch, without blocking the command indefinitely. */
  const cleanupBindingTarget = async (
    chatId: FeishuChatId, target: SessionIdString, dispose: () => Promise<void>,
  ): Promise<'disposed' | 'failed' | 'timeout'> => {
    const cleanup = Promise.resolve().then(dispose).then(
      () => 'disposed' as const,
      (error: unknown) => {
        ctx.logger.error('feishu-bridge binding target cleanup failed: %s', safeErrorFact(error))
        return 'failed' as const
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolveTimeout => {
      timer = setTimeout(() => { resolveTimeout('timeout') }, config.bindingCleanupTimeoutMs)
    })
    const outcome = await Promise.race([cleanup, timeout])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      ctx.logger.warn('feishu-audit action=binding-cleanup-timeout chat=%s session=%s timeoutMs=%d',
        auditHash(chatId), auditHash(target), config.bindingCleanupTimeoutMs)
      void cleanup.then((lateOutcome) => {
        ctx.logger.info('feishu-audit action=binding-cleanup-late chat=%s session=%s outcome=%s',
          auditHash(chatId), auditHash(target), lateOutcome)
      })
    }
    return outcome
  }

  /**
   * Persist one candidate binding and compensate only while that exact
   * after-image is still current. Existing agents never carry dispose
   * authority; created-here targets are released after a safe rollback.
   */
  const switchBinding = async (
    chatId: FeishuChatId,
    previous: ChatBinding | undefined,
    candidate: ChatBinding,
    target: BindingOwnership,
    seedCursor = true,
  ): Promise<BindingSwitchResult> => {
    const preparedCursorKey = projectionCursorId(chatId, candidate.sessionId) as string
    reservedCursorKeys.add(preparedCursorKey)
    try {
      if (seedCursor) await seedProjectionCursorAtHead(chatId, candidate.sessionId)
      await bindings.put(chatId, candidate)
      return { ok: true }
    } catch (writeError: unknown) {
      ctx.logger.error('feishu-bridge binding prepare/write failed: %s', safeErrorFact(writeError))
    } finally {
      reservedCursorKeys.delete(preparedCursorKey)
    }

    let reason: BindingFailureReason = 'binding-write-failed'
    const observed = bindings.get(chatId)
    if (sameBinding(observed, candidate)) {
      try {
        if (previous === undefined) await bindings.delete(chatId)
        else await bindings.put(chatId, previous)
      } catch (rollbackError: unknown) {
        reason = 'binding-state-uncertain'
        ctx.logger.error('feishu-bridge binding rollback failed: %s', safeErrorFact(rollbackError))
      }
    } else if (!sameBinding(observed, previous)) {
      // A newer after-image won. Never overwrite it with the stale snapshot.
      reason = 'binding-changed-during-compensation'
    }

    const currentBinding = bindings.get(chatId)
    if (sameBinding(currentBinding, candidate)) reason = 'binding-state-uncertain'
    else if (!sameBinding(currentBinding, previous) && reason === 'binding-write-failed') {
      reason = 'binding-changed-during-compensation'
    }

    let cleanup: 'disposed' | 'failed' | 'timeout' | undefined
    if (target.ownership === 'created-here' && target.dispose !== undefined
      && !sameBinding(currentBinding, candidate)) {
      cleanup = await cleanupBindingTarget(chatId, candidate.sessionId, target.dispose)
    }
    ctx.logger.warn('feishu-audit action=binding-compensated chat=%s session=%s reason=%s cleanup=%s',
      auditHash(chatId), auditHash(candidate.sessionId), reason, cleanup ?? 'not-owned')

    const cleanupSuffix = cleanup === 'timeout' || cleanup === 'failed'
      ? ' 临时会话清理尚未确认。'
      : ''
    if (reason === 'binding-state-uncertain') {
      return {
        ok: false,
        reason,
        message: `绑定结果不确定，未能确认恢复原绑定；请用 /status 核实。${cleanupSuffix}`,
      }
    }
    if (reason === 'binding-changed-during-compensation') {
      return {
        ok: false,
        reason,
        message: `绑定未完成，期间绑定已被其他操作更新；未覆盖当前绑定，请用 /status 核实。${cleanupSuffix}`,
      }
    }
    return {
      ok: false,
      reason,
      message: `绑定失败，当前绑定未改变。${cleanupSuffix}`,
    }
  }

  type ExistingBindingResult =
    | { ok: true; message: string }
    | { ok: false; reason: string; message: string; reject: boolean }

  /** Keep one target's cold/live decision and binding transaction indivisible across chats. */
  const bindingTargetTails = new Map<string, Promise<void>>()
  const withBindingTarget = <T>(targetId: string, work: () => Promise<T>): Promise<T> => {
    const tail = bindingTargetTails.get(targetId) ?? Promise.resolve()
    const result = tail.then(work, work)
    const settled = result.then(() => undefined, () => undefined)
    bindingTargetTails.set(targetId, settled)
    void settled.then(() => {
      if (bindingTargetTails.get(targetId) === settled) bindingTargetTails.delete(targetId)
    })
    return result
  }

  /** One binding contract shared by typed `/use` and `/ls` card selection. */
  const bindExistingSessionUnlocked = async (
    chatId: FeishuChatId,
    operatorOpenId: FeishuOpenId,
    targetId: string,
    stageTarget?: (target: SessionIdString) => Promise<void>,
  ): Promise<ExistingBindingResult> => {
    const currentBinding = bindings.get(chatId)
    if (currentBinding?.status === 'active' && currentBinding.boundBy !== operatorOpenId) {
      return {
        ok: false,
        reason: 'not-binder',
        message: '只有当前会话的绑定者可以替换 active 绑定；请先由绑定者 /release。',
        reject: false,
      }
    }
    if (archivedSessionIds().has(targetId)) {
      return {
        ok: false,
        reason: 'archived',
        message: '无法绑定：该会话已归档，请先在 Web 端取消归档。',
        reject: false,
      }
    }
    const inWorkspace = await buildWorkspaceFilter(config.allowedWorkspaces)
    if (!await inWorkspace(await sessionCwd(targetId))) {
      return {
        ok: false,
        reason: 'outside-workspaces',
        message: '无法绑定：该会话不在允许的工作区内。',
        reject: false,
      }
    }
    const binding: ChatBinding = {
      sessionId: targetId as SessionIdString,
      status: 'active',
      boundBy: operatorOpenId,
      boundAt: Date.now(),
    }
    let setupEntered = false
    let setupAdopted = false
    let rollbackRequested = false
    let preparationError: unknown
    let preparedSwitch: BindingSwitchResult | undefined
    const resolved = await resolve(targetId as unknown as SessionId, async (agentCtx) => {
      setupEntered = true
      // A failed setup or publication owns rollback while the Agent is still
      // unpublished. Once resolve returns the published Agent, this operation
      // adopts it and the disposer becomes a no-op.
      agentCtx.effect(() => async () => {
        rollbackRequested = true
        if (!setupAdopted) {
          await restorePreparedBinding(
            chatId, currentBinding, binding, 'unpublished binding',
          )
        }
      }, `feishuBridge.bindingPreparation(${targetId})`)
      return trackBackground((async () => {
        const throwIfRollbackRequested = async (): Promise<void> => {
          if (!rollbackRequested) return
          await restorePreparedBinding(
            chatId, currentBinding, binding, 'late unpublished binding',
          )
          throw new Error('feishu-bridge: binding preparation disposed before publication')
        }
        try {
          await stageTarget?.(targetId as SessionIdString)
          await throwIfRollbackRequested()
          preparedSwitch = await switchBinding(chatId, currentBinding, binding, {
            ownership: 'existing',
          })
          await throwIfRollbackRequested()
          if (!preparedSwitch.ok) {
            throw new Error(`feishu-bridge: binding preparation failed: ${preparedSwitch.reason}`)
          }
        } catch (error: unknown) {
          preparationError = error
          throw error
        }
      })())
    })
    if ('error' in resolved) {
      if (preparedSwitch !== undefined && !preparedSwitch.ok) {
        return {
          ok: false, reason: preparedSwitch.reason,
          message: preparedSwitch.message, reject: true,
        }
      }
      if (preparationError !== undefined) throw preparationError
      return {
        ok: false,
        reason: resolved.error.code,
        message: `无法绑定：${resolved.error.code}`,
        reject: false,
      }
    }
    if (setupEntered) setupAdopted = true
    if (preparedSwitch?.ok && sameBinding(bindings.get(chatId), binding)) {
      ctx.logger.info('feishu-audit action=binding-%s chat=%s session=%s sender=%s',
        currentBinding === undefined ? 'created' : 'replaced', auditHash(chatId),
        auditHash(binding.sessionId), auditHash(operatorOpenId))
      return { ok: true, message: `已绑定 ${escapeLarkMarkdownLiteral(targetId)}。直接发消息即可对话。` }
    }
    // A live Agent existed before this operation, or another resolver won the
    // publication race. It carries no disposal authority; prepare normally.
    await stageTarget?.(targetId as SessionIdString)
    const switched = await switchBinding(chatId, currentBinding, binding, {
      ownership: 'existing',
    })
    if (!switched.ok) {
      return { ok: false, reason: switched.reason, message: switched.message, reject: true }
    }
    ctx.logger.info('feishu-audit action=binding-%s chat=%s session=%s sender=%s',
      currentBinding === undefined ? 'created' : 'replaced', auditHash(chatId),
      auditHash(binding.sessionId), auditHash(operatorOpenId))
    return { ok: true, message: `已绑定 ${targetId}。直接发消息即可对话。` }
  }

  const bindExistingSession = (
    chatId: FeishuChatId,
    operatorOpenId: FeishuOpenId,
    targetId: string,
    stageTarget?: (target: SessionIdString) => Promise<void>,
  ): Promise<ExistingBindingResult> => withBindingTarget(
    targetId,
    () => bindExistingSessionUnlocked(chatId, operatorOpenId, targetId, stageTarget),
  )

  /** Handle one validated-by-token `/ls` pagination or selection action. */
  const handleSessionListCardAction = async (
    action: FeishuCardAction,
    value: {
      action?: string
      token?: string
      index?: number
      page?: number
      level?: string
      workspaceIndex?: number
    },
  ): Promise<{ toast?: string }> => {
    if (!config.allowedOpenIds.includes(action.operatorOpenId)) {
      return { toast: '你没有权限操作此会话卡' }
    }
    const listing = listings.get(action.chatId)
    if (listing === undefined || value.token === undefined || value.token !== listing.token) {
      return { toast: '该会话列表已失效，请重新发送 /ls' }
    }
    if (Date.now() - listing.at > config.listingTtlMs) {
      listings.delete(action.chatId)
      return { toast: '该会话列表已过期，请重新发送 /ls' }
    }
    if (listing.operatorOpenId !== action.operatorOpenId) {
      return { toast: '只有该列表的发起人可以操作' }
    }
    if (listing.presentation === 'uncertain') {
      // A timeout may mean the original card exists, but without the returned
      // message id we cannot distinguish it from a copied/forwarded card.
      // Preserve shape-level dedupe while failing closed on every click.
      return { toast: '该会话卡状态不确定，请重新发送 /ls' }
    }
    if (listing.presentation !== 'visible' || listing.messageId !== action.messageId) {
      return { toast: '该按钮不属于当前会话卡' }
    }
    if (listing.state !== 'listing') {
      if (listing.state === 'navigating') return { toast: '正在更新会话卡，请稍候' }
      return { toast: listing.state === 'binding' ? '正在绑定，请稍候' : '该会话卡已处理' }
    }

    const reportNavigationFailure = async (stage: string): Promise<void> => {
      try {
        await ctx.feishu.sendText(action.chatId, '会话卡更新失败，请重新发送 /ls。', {
          deliveryId: `session-list:${listing.token}`,
          stage,
          segmentIndex: 0,
        })
      } catch (error: unknown) {
        ctx.logger.error('feishu-bridge session-list navigation fallback failed: %s', safeErrorFact(error))
      }
    }

    const enqueueBinding = (
      loadChoice: () => Promise<SessionListChoice | undefined>,
    ): void => {
      void enqueueChatWork(action.chatId, async () => {
        const choice = await loadChoice()
        if (choice === undefined) {
          listing.state = 'consumed'
          await reportNavigationFailure('session-list-choice-missing')
          return
        }
        try {
          await ctx.feishu.patchCard(action.messageId, renderSessionListStatusCard('binding', choice))
        } catch (error: unknown) {
          ctx.logger.warn('feishu-audit action=session-list-accepted-patch-failed chat=%s message=%s error=%s',
            auditHash(action.chatId), auditHash(action.messageId), safeErrorFact(error))
        }
        let outcome: ExistingBindingResult
        try {
          outcome = await bindExistingSession(
            action.chatId as FeishuChatId,
            action.operatorOpenId as FeishuOpenId,
            choice.sessionId,
          )
        } catch (error: unknown) {
          ctx.logger.error('feishu-bridge session-list binding failed: %s', safeErrorFact(error))
          outcome = {
            ok: false,
            reason: 'unexpected',
            message: '绑定失败，请重新发送 /ls 后再试。',
            reject: true,
          }
        }
        listing.state = 'consumed'
        const terminal = outcome.ok
          ? renderSessionListStatusCard('bound', choice)
          : renderSessionListStatusCard('failed', choice, outcome.message)
        try {
          await ctx.feishu.patchCard(action.messageId, terminal)
        } catch (error: unknown) {
          ctx.logger.warn('feishu-audit action=session-list-terminal-patch-failed chat=%s message=%s session=%s error=%s',
            auditHash(action.chatId), auditHash(action.messageId), auditHash(choice.sessionId), safeErrorFact(error))
          const text = outcome.ok
            ? `已绑定「${escapeLarkMarkdownLiteral(choice.title)}」。直接发送消息即可继续任务。`
            : `「${escapeLarkMarkdownLiteral(choice.title)}」绑定失败：${outcome.message}`
          try {
            await ctx.feishu.sendText(action.chatId, text, {
              deliveryId: `session-list:${listing.token}`,
              stage: outcome.ok ? 'session-list-bound-fallback' : 'session-list-failed-fallback',
              segmentIndex: 0,
            })
          } catch (fallbackError: unknown) {
            ctx.logger.error('feishu-bridge session-list terminal fallback failed: %s', safeErrorFact(fallbackError))
          }
        }
        ctx.logger.info('feishu-audit action=session-list-selection-completed chat=%s message=%s session=%s outcome=%s',
          auditHash(action.chatId), auditHash(action.messageId), auditHash(choice.sessionId),
          outcome.ok ? 'bound' : outcome.reason)
      })
    }

    if (value.action === 'workspace') {
      if (!Number.isInteger(value.index)) return { toast: '工作空间无效，请重新发送 /ls' }
      const workspaceIndex = value.index!
      const workspace = listing.workspaces[workspaceIndex]
      if (workspace === undefined) return { toast: '工作空间无效，请重新发送 /ls' }
      if (workspace.sessions.length === 1) {
        const currentBinding = bindings.get(action.chatId as FeishuChatId)
        if (currentBinding?.status === 'active' && currentBinding.boundBy !== action.operatorOpenId) {
          return { toast: '只有当前会话的绑定者可以替换绑定' }
        }
        listing.state = 'binding'
        enqueueBinding(async () => (await workspaceSessionChoices(listing, workspaceIndex))?.[0])
        return { toast: '正在绑定会话…' }
      }
      listing.state = 'navigating'
      void enqueueChatWork(action.chatId, async () => {
        try {
          const choices = await workspaceSessionChoices(listing, workspaceIndex)
          if (choices === undefined) throw new Error('workspace snapshot missing')
          await ctx.feishu.patchCard(action.messageId, renderSessionListCard({
            token: listing.token,
            workspaceIndex,
            workspaceName: workspace.name,
            choices,
            page: 0,
          }))
          listing.ordered = choices.map(choice => choice.sessionId)
          listing.view = { level: 'sessions', workspaceIndex, page: 0 }
        } catch (error: unknown) {
          ctx.logger.warn('feishu-audit action=session-list-workspace-patch-failed chat=%s message=%s error=%s',
            auditHash(action.chatId), auditHash(action.messageId), safeErrorFact(error))
          await reportNavigationFailure('session-list-workspace-fallback')
        } finally {
          if (listing.state === 'navigating') listing.state = 'listing'
        }
      })
      return { toast: '正在加载会话…' }
    }

    if (value.action === 'back') {
      if (listing.view.level !== 'sessions') return { toast: '已经在工作空间列表' }
      const workspacePage = Math.floor(listing.view.workspaceIndex / SESSION_LIST_PAGE_SIZE)
      listing.state = 'navigating'
      void enqueueChatWork(action.chatId, async () => {
        try {
          await ctx.feishu.patchCard(action.messageId, renderSessionWorkspaceCard({
            token: listing.token,
            workspaces: listing.workspaces.map(workspace => ({
              name: workspace.name,
              sessionCount: workspace.sessions.length,
            })),
            page: workspacePage,
          }))
          listing.ordered = []
          listing.view = { level: 'workspaces', page: workspacePage }
        } catch (error: unknown) {
          ctx.logger.warn('feishu-audit action=session-list-back-patch-failed chat=%s message=%s error=%s',
            auditHash(action.chatId), auditHash(action.messageId), safeErrorFact(error))
          await reportNavigationFailure('session-list-back-fallback')
        } finally {
          if (listing.state === 'navigating') listing.state = 'listing'
        }
      })
      return { toast: '正在返回工作空间…' }
    }

    if (value.action === 'page') {
      const page = value.page
      if (!Number.isInteger(page) || page === undefined || page < 0) {
        return { toast: '页码无效，请重新发送 /ls' }
      }
      let nextCard: object | undefined
      let nextView: SessionListing['view'] | undefined
      if (value.level === 'workspaces' && listing.view.level === 'workspaces') {
        const pageCount = Math.max(1, Math.ceil(listing.workspaces.length / SESSION_LIST_PAGE_SIZE))
        if (page >= pageCount) return { toast: '页码无效，请重新发送 /ls' }
        nextCard = renderSessionWorkspaceCard({
          token: listing.token,
          workspaces: listing.workspaces.map(workspace => ({
            name: workspace.name,
            sessionCount: workspace.sessions.length,
          })),
          page,
        })
        nextView = { level: 'workspaces', page }
      } else if (value.level === 'sessions' && listing.view.level === 'sessions'
        && value.workspaceIndex === listing.view.workspaceIndex) {
        const workspace = listing.workspaces[listing.view.workspaceIndex]
        const choices = workspace?.choices
        const pageCount = Math.max(1, Math.ceil((choices?.length ?? 0) / SESSION_LIST_PAGE_SIZE))
        if (workspace === undefined || choices === undefined || page >= pageCount) {
          return { toast: '页码无效，请重新发送 /ls' }
        }
        nextCard = renderSessionListCard({
          token: listing.token,
          workspaceIndex: listing.view.workspaceIndex,
          workspaceName: workspace.name,
          choices,
          page,
        })
        nextView = { level: 'sessions', workspaceIndex: listing.view.workspaceIndex, page }
      }
      if (nextCard === undefined || nextView === undefined) {
        return { toast: '该翻页按钮已失效，请重新发送 /ls' }
      }
      listing.state = 'navigating'
      void enqueueChatWork(action.chatId, async () => {
        try {
          await ctx.feishu.patchCard(action.messageId, nextCard)
          listing.view = nextView
        } catch (error: unknown) {
          ctx.logger.warn('feishu-audit action=session-list-page-patch-failed chat=%s message=%s error=%s',
            auditHash(action.chatId), auditHash(action.messageId), safeErrorFact(error))
          await reportNavigationFailure('session-list-page-fallback')
        } finally {
          if (listing.state === 'navigating') listing.state = 'listing'
        }
      })
      return { toast: '正在翻页…' }
    }

    if (value.action !== 'select' || !Number.isInteger(value.index)
      || !Number.isInteger(value.workspaceIndex)
      || listing.view.level !== 'sessions'
      || listing.view.workspaceIndex !== value.workspaceIndex) {
      return { toast: '无法识别的会话选择，请重新发送 /ls' }
    }
    const choices = listing.workspaces[value.workspaceIndex!]?.choices
    const choice = choices?.[value.index!]
    if (choice === undefined) return { toast: '该会话不存在于当前列表' }
    const currentBinding = bindings.get(action.chatId as FeishuChatId)
    if (currentBinding?.status === 'active' && currentBinding.boundBy !== action.operatorOpenId) {
      return { toast: '只有当前会话的绑定者可以替换绑定' }
    }
    listing.state = 'binding'
    enqueueBinding(async () => choice)
    return { toast: '正在绑定会话…' }
  }

  /** Handle one validated-by-token `/model` navigation or switch action (M7.1). */
  const handleModelCardAction = async (
    action: FeishuCardAction,
    value: {
      action?: string
      token?: string
      index?: number
      page?: number
      level?: string
      effortId?: string
    },
  ): Promise<{ toast?: string }> => {
    if (!config.allowedOpenIds.includes(action.operatorOpenId)) {
      return { toast: '你没有权限操作此模型卡' }
    }
    const listing = modelListings.get(action.chatId)
    if (listing === undefined || value.token === undefined || value.token !== listing.token) {
      return { toast: '该模型卡已失效，请重新发送 /model' }
    }
    if (Date.now() - listing.at > config.listingTtlMs) {
      modelListings.delete(action.chatId)
      return { toast: '该模型卡已过期，请重新发送 /model' }
    }
    if (listing.operatorOpenId !== action.operatorOpenId) {
      return { toast: '只有该模型卡的发起人可以操作' }
    }
    if (listing.presentation === 'uncertain') {
      return { toast: '该模型卡状态不确定，请重新发送 /model' }
    }
    if (listing.presentation !== 'visible' || listing.messageId !== action.messageId) {
      return { toast: '该按钮不属于当前模型卡' }
    }
    if (listing.state !== 'listing') return { toast: '该模型卡已处理' }

    // The switch targets the bound bridge-owned session; the four ownership
    // shapes mirror /effort and /status (§6.1).
    const binding = bindings.get(action.chatId as FeishuChatId)
    if (binding === undefined || binding.boundBy !== action.operatorOpenId) {
      return { toast: '只有当前会话的绑定者可以切换模型' }
    }
    const sessionId = binding.sessionId as unknown as SessionId
    const ref = modelSelections.get(sessionId)
    if (ref === undefined) {
      if (ctx.agents.get(sessionId) !== undefined) {
        return { toast: '该会话由 Web 端持有模型选择权，请在 Web 端切换' }
      }
      return { toast: '该会话未激活，请先发送一条消息恢复会话' }
    }

    const reportFailure = async (stage: string, text: string): Promise<void> => {
      try {
        await ctx.feishu.sendText(action.chatId, text, {
          deliveryId: `model:${listing.token}`,
          stage,
          segmentIndex: 0,
        })
      } catch (error: unknown) {
        ctx.logger.error('feishu-bridge model card fallback failed: %s', safeErrorFact(error))
      }
    }

    const patchOrReport = async (next: object): Promise<void> => {
      try {
        await ctx.feishu.patchCard(action.messageId, next)
      } catch (error: unknown) {
        ctx.logger.warn('feishu-audit action=model-card-patch-failed chat=%s message=%s error=%s',
          auditHash(action.chatId), auditHash(action.messageId), safeErrorFact(error))
        await reportFailure('model-card-patch-failed', '模型卡更新失败，请重新发送 /model。')
      }
    }

    const finalize = async (detail: string): Promise<void> => {
      listing.state = 'consumed'
      ctx.logger.info('feishu-audit action=model-switch-applied chat=%s session=%s sender=%s provider=%s model=%s',
        auditHash(action.chatId), auditHash(binding.sessionId), auditHash(action.operatorOpenId),
        auditHash(ref.current?.provider ?? ''), auditHash(ref.current?.model ?? ''))
      await patchOrReport(renderModelStatusCard('applied', detail))
    }

    const verb = value.action

    if (verb === 'page') {
      const view = listing.view
      const page = Number.isInteger(value.page) ? value.page! : -1
      if (page < 0) return { toast: '页码无效，请重新发送 /model' }
      if (view.level === 'providers') {
        if (page >= Math.max(1, Math.ceil(view.providers.length / MODEL_PAGE_SIZE))) {
          return { toast: '页码无效，请重新发送 /model' }
        }
        listing.view = { ...view, page }
        await patchOrReport(renderModelProviderCard({ token: listing.token, page, providers: view.providers }))
      } else if (view.level === 'models') {
        if (page >= Math.max(1, Math.ceil(view.models.length / MODEL_PAGE_SIZE))) {
          return { toast: '页码无效，请重新发送 /model' }
        }
        const provider = view.providers[view.providerIndex]!
        listing.view = { ...view, page }
        await patchOrReport(renderModelCard({
          token: listing.token, page, providerId: provider.id, providerName: provider.name,
          models: view.models,
        }))
      } else {
        if (page >= Math.max(1, Math.ceil(view.efforts.length / MODEL_PAGE_SIZE))) {
          return { toast: '页码无效，请重新发送 /model' }
        }
        const provider = view.providers[view.providerIndex]!
        const model = view.models[view.modelIndex]!
        listing.view = { ...view, page }
        await patchOrReport(renderModelEffortCard({
          token: listing.token, page, providerName: provider.name, modelName: model.name,
          efforts: view.efforts, currentEffortName: view.currentEffortName,
        }))
      }
      return { toast: '正在翻页…' }
    }

    if (verb === 'back') {
      const view = listing.view
      if (view.level === 'models') {
        listing.view = { level: 'providers', page: 0, providers: view.providers }
        await patchOrReport(renderModelProviderCard({ token: listing.token, page: 0, providers: view.providers }))
      } else if (view.level === 'efforts') {
        const provider = view.providers[view.providerIndex]!
        listing.view = { level: 'models', page: 0, providerIndex: view.providerIndex, providers: view.providers, models: view.models }
        await patchOrReport(renderModelCard({
          token: listing.token, page: 0, providerId: provider.id, providerName: provider.name,
          models: view.models,
        }))
      }
      return { toast: '正在返回…' }
    }

    if (verb === 'provider') {
      const view = listing.view
      if (view.level !== 'providers') return { toast: '该模型卡已失效，请重新发送 /model' }
      const provider = view.providers[value.index ?? -1]
      if (provider === undefined) return { toast: '该模型卡已失效，请重新发送 /model' }
      let models
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch (error: unknown) {
        ctx.logger.warn('feishu-audit action=model-catalog-unavailable chat=%s provider=%s error=%s',
          auditHash(action.chatId), auditHash(provider.id), safeErrorFact(error))
        listing.state = 'consumed'
        await reportFailure('model-catalog-unavailable', '模型目录不可用，未修改当前选择。请稍后重新发送 /model。')
        return { toast: '模型目录不可用' }
      }
      const entries: ModelCardModel[] = models.map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      }))
      if (entries.length === 0) {
        listing.state = 'consumed'
        await reportFailure('model-catalog-empty', '该 provider 没有列出可用模型，未修改当前选择。')
        return { toast: '没有可用模型' }
      }
      listing.view = {
        level: 'models', page: 0, providerIndex: value.index!, providers: view.providers, models: entries,
      }
      await patchOrReport(renderModelCard({
        token: listing.token, page: 0, providerId: provider.id, providerName: provider.name, models: entries,
      }))
      return { toast: '正在进入模型列表…' }
    }

    if (verb === 'model') {
      const view = listing.view
      if (view.level !== 'models') return { toast: '该模型卡已失效，请重新发送 /model' }
      const model = view.models[value.index ?? -1]
      if (model === undefined) return { toast: '该模型卡已失效，请重新发送 /model' }
      const provider = view.providers[view.providerIndex]!
      let info
      try {
        info = await ctx.llm.resolveModelInfo(provider.id, model.id)
      } catch {
        listing.state = 'consumed'
        await reportFailure('model-info-unavailable', '模型元数据不可用，未修改当前选择。请稍后重新发送 /model。')
        return { toast: '模型元数据不可用' }
      }
      const efforts = info.reasoning?.efforts
      const current = ref.current
      const revalidated = revalidateEffort(current?.reasoningEffort, info.reasoning)
      const effortName = (id: ReasoningEffortId | undefined): string | undefined =>
        id === undefined ? undefined
          : (info.reasoning?.efforts.find(candidate => candidate.id === id)?.name ?? String(id))
      if (efforts !== undefined && efforts.length > 0) {
        // Offer the effort level; keep-current only when the current effort
        // stays valid on the new route (§5.4 — an invalid effort must never
        // be silently kept).
        const currentEffortName = revalidated.changed ? undefined : effortName(revalidated.next)
        listing.view = {
          level: 'efforts', page: 0,
          providerIndex: view.providerIndex, modelIndex: value.index!,
          providers: view.providers, models: view.models,
          efforts: efforts.map(candidate => ({ id: candidate.id, name: candidate.name })),
          currentEffortName,
        }
        await patchOrReport(renderModelEffortCard({
          token: listing.token, page: 0, providerName: provider.name, modelName: model.name,
          efforts: efforts.map(candidate => ({ id: candidate.id, name: candidate.name })),
          currentEffortName,
        }))
        return { toast: '正在进入档位选择…' }
      }
      // Route without reasoning metadata: apply immediately with a cleared
      // effort (§5.4 branch three — the provider default applies).
      ref.current = { provider: provider.id, model: model.id }
      await finalize(`已选择 ${escapeLarkMarkdownLiteral(provider.id)}/${escapeLarkMarkdownLiteral(model.id)}；该模型不提供可选档位，已清空档位（跟随模型默认），下一轮生效。`)
      return { toast: '模型已切换' }
    }

    if (verb === 'effort' || verb === 'keep-current' || verb === 'clear') {
      const view = listing.view
      if (view.level !== 'efforts') return { toast: '该模型卡已失效，请重新发送 /model' }
      const provider = view.providers[view.providerIndex]!
      const model = view.models[view.modelIndex]!
      let requested: ReasoningEffortId | undefined
      if (verb === 'clear') {
        requested = undefined
      } else if (verb === 'keep-current') {
        requested = ref.current?.reasoningEffort
      } else {
        const effort = view.efforts.find(candidate => String(candidate.id) === value.effortId)
        if (effort === undefined) return { toast: '该档位已失效，请重新发送 /model' }
        requested = effort.id
      }
      // Validate the final route once more before committing the switch.
      let info
      try {
        info = await ctx.llm.resolveModelInfo(provider.id, model.id)
      } catch {
        listing.state = 'consumed'
        await reportFailure('model-info-unavailable', '模型元数据不可用，未修改当前选择。请稍后重新发送 /model。')
        return { toast: '模型元数据不可用' }
      }
      const revalidated = revalidateEffort(requested, info.reasoning)
      const finalEffort = revalidated.next
      ref.current = {
        provider: provider.id,
        model: model.id,
        ...(finalEffort === undefined ? {} : { reasoningEffort: finalEffort }),
      }
      const effortLabel = finalEffort === undefined
        ? '档位：未指定（模型默认）'
        : `档位：${escapeLarkMarkdownLiteral(info.reasoning?.efforts.find(candidate => candidate.id === finalEffort)?.name ?? String(finalEffort))}`
      await finalize(`已选择 ${escapeLarkMarkdownLiteral(provider.id)}/${escapeLarkMarkdownLiteral(model.id)}（${effortLabel}），下一轮生效。重启后临时切换会丢失。`)
      return { toast: '模型已切换' }
    }

    return { toast: '无法识别的模型卡按钮，请重新发送 /model' }
  }

  /** Route one deduplicated, authorized text message to the bound session. */
  const routeMessage = async (eventId: FeishuInboundKey, record: InboundMessage): Promise<void> => {
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

  const handleCommand = async (eventId: FeishuInboundKey, record: InboundCommand, text: string): Promise<void> => {
    const command = parseCommand(text)
    if (command === undefined) return
    const chatId = record.chatId
    let current = record
    const stageTarget = async (target: SessionIdString): Promise<void> => {
      current = { ...current, target }
      await inboundEvents.put(eventId, current)
    }
    const commit = async (result: string, visible = true): Promise<void> => {
      current = { ...current, status: 'committed', result, reason: undefined }
      await inboundEvents.put(eventId, current)
      ctx.logger.info('feishu-audit action=command-committed event=%s chat=%s sender=%s command=%s',
        auditHash(eventId), auditHash(chatId), auditHash(record.senderOpenId), record.command)
      if (visible) reply(chatId, result)
    }
    const reject = async (reason: string, result: string): Promise<void> => {
      current = { ...current, status: 'rejected', result, reason }
      await inboundEvents.put(eventId, current)
      ctx.logger.warn('feishu-audit action=command-rejected event=%s chat=%s sender=%s command=%s reason=%s',
        auditHash(eventId), auditHash(chatId), auditHash(record.senderOpenId), record.command, reason)
      reply(chatId, result)
    }
    switch (command.kind) {
      case 'help':
        await commit([
          '可用命令：',
          '/new [cwd] — 新建会话并绑定（cwd 须在允许的工作区内）',
          '/ls — 先选工作空间，再按真实标题选择未归档会话',
          '/use <sessionId|编号> — 绑定未归档会话（编号对应当前打开的工作空间）',
          '/status — 绑定状态、当前会话与新会话默认的模型/档位',
          '/effort <id> — 只切换档位；非法值回显该模型可选档位（仅绑定者）',
          '/model — 三层选择卡切换 provider/模型/档位（仅绑定者）',
          '/stop — 停止当前任务（排队消息保留）',
          '/release — 解绑并停止后续飞书同步（会话继续运行）',
          '模型/档位选择只在进程内生效，重启后回落 Web 默认。',
          '普通文本会作为消息发给绑定的会话。',
        ].join('\n'))
        return
      case 'ls': {
        // Mirror the Web workspace browser: workspaceRegistry owns the
        // authoritative workspace/session membership. Persistence is used only
        // to hydrate the headers for those registered ids; allowedWorkspaces
        // remains a safety boundary for binding, not a second discovery index.
        const inWorkspace = await buildWorkspaceFilter(config.allowedWorkspaces)
        const archived = archivedSessionIds()
        const allPersisted = await ctx.sessionPersistence.list()
        const persistedById = new Map(allPersisted.map(header => [String(header.id), header]))
        const liveById = new Map(ctx.sessions.list().map(session => [String(session.id), session.header]))
        const registryWorkspaces = await workspaceRegistry.list()
        const headers: typeof allPersisted = []
        const seen = new Set<string>()
        for (const workspace of registryWorkspaces) {
          for (const sessionId of workspace.sessionIds) {
            const id = String(sessionId)
            if (seen.has(id) || archived.has(id)) continue
            const header = liveById.get(id) ?? persistedById.get(id)
            if (header === undefined || header.origin === 'subagent' || !(await inWorkspace(header.cwd))) continue
            seen.add(id)
            headers.push(header)
          }
        }
        headers.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        if (headers.length === 0) {
          listings.delete(chatId)
          await commit('没有可绑定的会话。用 /new 新建。')
          return
        }
        const workspaceMap = new Map<string, {
          key: string
          name: string
          sessions: Array<{ id: SessionId; cwd: string; createdAt?: number }>
          choices?: SessionListChoice[]
        }>()
        for (const header of headers) {
          if (header.cwd === undefined) continue
          const key = header.cwd.replace(/[/\\]+$/u, '')
          const workspace = workspaceMap.get(key) ?? {
            key,
            name: workspaceLabel(key),
            sessions: [],
          }
          workspace.sessions.push({ id: header.id, cwd: key, createdAt: header.createdAt })
          workspaceMap.set(key, workspace)
        }
        const workspaces = [...workspaceMap.values()]
        const basenameCounts = new Map<string, number>()
        for (const workspace of workspaces) {
          basenameCounts.set(workspace.name, (basenameCounts.get(workspace.name) ?? 0) + 1)
        }
        const basenameOrdinals = new Map<string, number>()
        for (const workspace of workspaces) {
          if ((basenameCounts.get(workspace.name) ?? 0) < 2) continue
          const ordinal = (basenameOrdinals.get(workspace.name) ?? 0) + 1
          basenameOrdinals.set(workspace.name, ordinal)
          workspace.name = `${workspace.name}（${ordinal}）`
        }
        const token = randomBytes(18).toString('base64url')
        const listing: SessionListing = {
          token,
          ordered: [],
          workspaces,
          at: Date.now(),
          operatorOpenId: record.senderOpenId,
          presentation: 'staged',
          state: 'listing',
          view: { level: 'workspaces', page: 0 },
        }
        listings.set(chatId, listing)
        const card = renderSessionWorkspaceCard({
          token,
          workspaces: workspaces.map(workspace => ({
            name: workspace.name,
            sessionCount: workspace.sessions.length,
          })),
          page: 0,
        })
        try {
          listing.messageId = await ctx.feishu.sendCard(chatId, card, {
            deliveryId: eventId as string,
            stage: 'session-list-card',
            segmentIndex: 0,
          })
          listing.presentation = 'visible'
          await commit('', false)
        } catch (error: unknown) {
          if (isPermanentFeishuFailure(error)) {
            listing.presentation = 'text'
            const fallbackHeaders = workspaces.flatMap(workspace => workspace.sessions).slice(0, 20)
            const choices = await Promise.all(fallbackHeaders.map(sessionChoice))
            listing.ordered = choices.map(choice => choice.sessionId)
            const lines = choices.flatMap((choice, index) => [
              `[${index + 1}] ${escapeLarkMarkdownLiteral(choice.title)}`,
              `    ${escapeLarkMarkdownLiteral(choice.workspace)} · ${choice.timeLabel} · ${choice.shortId}`,
            ])
            if (headers.length > choices.length) {
              lines.push(`仅显示前 ${choices.length} 条；卡片恢复后可按工作空间查看全部会话。`)
            }
            lines.push('卡片不可用，请回复 /use <编号> 绑定。')
            await commit(lines.join('\n'))
          } else {
            // The card may already exist, so never send a second shape. Its
            // message id is unknown, therefore card actions fail closed.
            listing.presentation = 'uncertain'
            await commit('', false)
            ctx.logger.warn('feishu-audit action=session-list-send-uncertain event=%s chat=%s sender=%s error=%s',
              auditHash(eventId), auditHash(chatId), auditHash(record.senderOpenId), safeErrorFact(error))
          }
        }
        return
      }
      case 'status': {
        // M7.3: distinguish the bound session's actual value from the
        // new-session default. Four shapes: unbound; bridge-owned (ref
        // installed — the current selection is the next step's); existing
        // (live agent without a bridge ref — Web holds selection); cold
        // (bound but not live — ownership decided by whichever frontend
        // resumes, and a bridge resume adopts the default).
        const binding = bindings.get(chatId)
        const lines: string[] = []
        if (binding === undefined) {
          lines.push('未绑定会话。')
        } else {
          lines.push(`绑定：${binding.sessionId}（${binding.status}），由 ${binding.boundBy} 于 ${new Date(binding.boundAt).toLocaleString()} 绑定。`)
          const sessionId = binding.sessionId as unknown as SessionId
          const ref = modelSelections.get(sessionId)
          const live = ctx.agents.get(sessionId)
          if (ref !== undefined) {
            const current = ref.current
            lines.push(current === undefined
              ? '当前会话：未指定（下一轮回落新会话默认值）'
              : `当前会话：${await describeSelection(current)}`)
            lines.push('切换在下一轮生效；重启后临时切换会丢失（模型选择不持久化）。')
          } else if (live !== undefined) {
            lines.push('当前会话由 Web 端持有模型选择权，实际值以 Web 端为准。')
          } else {
            lines.push('当前会话未激活；恢复后由飞书接管模型选择，将使用新会话默认值。')
          }
        }
        const source = configuredProvider === undefined ? 'Web GUI 设置' : '部署配置'
        lines.push(`新会话默认：${await describeSelection(defaultSelection())}（来源：${source}）`)
        await commit(lines.join('\n'))
        return
      }
      case 'effort': {
        // M7.2: boundBy-gated effort-only switch on the bridge-owned ref
        // (design §5.1/§5.2). Same four ownership shapes as /status: unbound,
        // bridge-owned, live Web-owned existing, cold. Cold sessions are not
        // resumed merely for a switch; a plain message resumes them first.
        const binding = bindings.get(chatId)
        if (binding === undefined) {
          await commit('未绑定会话。请先 /new 或 /use 绑定后再切换档位。')
          return
        }
        if (binding.boundBy !== record.senderOpenId) {
          await commit('只有当前会话的绑定者可以切换模型档位。')
          return
        }
        const sessionId = binding.sessionId as unknown as SessionId
        const ref = modelSelections.get(sessionId)
        if (ref === undefined) {
          if (ctx.agents.get(sessionId) !== undefined) {
            await commit('该会话由 Web 端持有模型选择权，请在 Web 端切换档位。')
          } else {
            await commit('该会话未激活，未修改档位。请先发送一条消息恢复会话，再切换档位。')
          }
          return
        }
        // A cleared current selection means "next turn falls back to the
        // new-session default" (/status wording), so validate against the
        // default route and make the switch explicit on it.
        const effective = ref.current ?? defaultSelection()
        let info
        try {
          info = await ctx.llm.resolveModelInfo(effective.provider, effective.model)
        } catch {
          await commit('档位元数据不可用，未修改当前选择。')
          return
        }
        const efforts = info.reasoning?.efforts
        if (efforts === undefined || efforts.length === 0) {
          await commit('该模型不提供可选档位，未修改当前选择。')
          return
        }
        const requested = ReasoningEffortId(command.effortId)
        const matched = efforts.find(candidate => candidate.id === requested)
        if (matched === undefined) {
          await commit(`非法档位 "${escapeLarkMarkdownLiteral(command.effortId)}"。该模型可选档位：${efforts.map(candidate => `${escapeLarkMarkdownLiteral(candidate.id)}（${escapeLarkMarkdownLiteral(candidate.name)}）`).join(' / ')}`)
          return
        }
        ref.current = {
          provider: effective.provider,
          model: effective.model,
          reasoningEffort: requested,
        }
        await commit(`已选择档位：${escapeLarkMarkdownLiteral(matched.name)}（${escapeLarkMarkdownLiteral(effective.provider)}/${escapeLarkMarkdownLiteral(effective.model)}），下一轮生效。重启后临时切换会丢失。`)
        return
      }
      case 'model': {
        // M7.1: three-layer selection card (design §5.3). Same four ownership
        // shapes as /effort; card actions carry the same token/TTL/operator/
        // messageId validation skeleton as /ls.
        const binding = bindings.get(chatId)
        if (binding === undefined) {
          await commit('未绑定会话。请先 /new 或 /use 绑定后再切换模型。')
          return
        }
        if (binding.boundBy !== record.senderOpenId) {
          await commit('只有当前会话的绑定者可以切换模型。')
          return
        }
        const sessionId = binding.sessionId as unknown as SessionId
        if (modelSelections.get(sessionId) === undefined) {
          if (ctx.agents.get(sessionId) !== undefined) {
            await commit('该会话由 Web 端持有模型选择权，请在 Web 端切换模型。')
          } else {
            await commit('该会话未激活，请先发送一条消息恢复会话，再切换模型。')
          }
          return
        }
        const providers: ModelCardProvider[] = ctx.llm.listProviders()
          .map(provider => ({ id: provider.id, name: provider.name }))
        if (providers.length === 0) {
          await commit('没有已注册的 provider 可切换。')
          return
        }
        const token = randomBytes(18).toString('base64url')
        const listing: ModelListing = {
          token,
          at: Date.now(),
          operatorOpenId: record.senderOpenId,
          presentation: 'staged',
          state: 'listing',
          view: { level: 'providers', page: 0, providers },
        }
        modelListings.set(chatId, listing)
        const card = renderModelProviderCard({ token, page: 0, providers })
        try {
          listing.messageId = await ctx.feishu.sendCard(chatId, card, {
            deliveryId: eventId as string,
            stage: 'model-card',
            segmentIndex: 0,
          })
          listing.presentation = 'visible'
          await commit('', false)
        } catch (error: unknown) {
          if (isPermanentFeishuFailure(error)) {
            listing.presentation = 'text'
            const lines = providers.map((provider, index) =>
              `[${index + 1}] ${escapeLarkMarkdownLiteral(provider.name)}`)
            lines.push('卡片不可用，请稍后重发 /model 或使用 /effort 切换档位。')
            await commit(lines.join('\n'))
          } else {
            listing.presentation = 'uncertain'
            await commit('', false)
            ctx.logger.warn('feishu-audit action=model-card-send-uncertain event=%s chat=%s sender=%s error=%s',
              auditHash(eventId), auditHash(chatId), auditHash(record.senderOpenId), safeErrorFact(error))
          }
        }
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
        await commit(`已解绑 ${binding.sessionId}。后续会话消息不再同步到飞书；会话仍在运行，可随时 /use 重新绑定。`)
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
        const outcome = await bindExistingSession(
          chatId,
          record.senderOpenId,
          targetId,
          stageTarget,
        )
        if (outcome.ok) await commit(outcome.message)
        else if (outcome.reject) await reject(outcome.reason, outcome.message)
        else await commit(outcome.message)
        return
      }
      case 'new': {
        const currentBinding = bindings.get(chatId)
        const cwdInput = command.cwd ?? config.defaultWorkspace
        if (cwdInput === undefined) { await commit('未配置默认工作区，且未提供 cwd。'); return }
        const authorized = await authorizeCwd(
          command.cwd === undefined ? cwdInput : command.cwd, config.allowedWorkspaces)
        if (!authorized.ok) { await commit(`目录不可用：${authorized.reason}`); return }
        const sessionId = `feishu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as unknown as SessionId
        await stageTarget(sessionId as unknown as SessionIdString)
        const binding: ChatBinding = {
          sessionId: sessionId as unknown as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        let setupAdopted = false
        let rollbackRequested = false
        let preparationError: unknown
        let preparedSwitch: BindingSwitchResult | undefined
        try {
          await ctx.agents.create({
            sessionId,
            meta: { cwd: authorized.realpath },
            agentOptions: agentOptions(),
            setup: async (agentCtx) => {
              // M7.0: model selection (with reasoning effort) installs in the
              // agent scope before publication, alongside M6's ownership
              // compensation. Ownership is unambiguous here: /new created it.
              modelSelections.install(agentCtx, sessionId)
              agentCtx.effect(() => async () => {
                rollbackRequested = true
                if (!setupAdopted) {
                  await restorePreparedBinding(
                    chatId, currentBinding, binding, 'unpublished /new',
                  )
                }
              }, `feishuBridge.newBindingPreparation(${String(sessionId)})`)
              return trackBackground((async () => {
                const throwIfRollbackRequested = async (): Promise<void> => {
                  if (!rollbackRequested) return
                  await restorePreparedBinding(
                    chatId, currentBinding, binding, 'late unpublished /new',
                  )
                  throw new Error('feishu-bridge: /new setup disposed before publication')
                }
                try {
                  const unpublishedSession = agentCtx.agent?.session
                  if (unpublishedSession === undefined) {
                    throw new Error('feishu-bridge: unpublished agent missing during /new setup')
                  }
                  preparedSwitch = await switchBinding(chatId, currentBinding, binding, {
                    ownership: 'existing',
                  }, false)
                  await throwIfRollbackRequested()
                  if (!preparedSwitch.ok) {
                    throw new Error(`feishu-bridge: /new binding preparation failed: ${preparedSwitch.reason}`)
                  }
                  // Register the empty session's durable metadata before
                  // publication. session/created will claim this ownerless state;
                  // no live-only SessionStore.flush is legal inside setup.
                  await ctx.sessionPersistence.create(unpublishedSession.header)
                  await throwIfRollbackRequested()
                } catch (error: unknown) {
                  preparationError = error
                  throw error
                }
              })())
            },
          })
          setupAdopted = true
        } catch (error: unknown) {
          if (preparedSwitch !== undefined && !preparedSwitch.ok) {
            await reject(preparedSwitch.reason, preparedSwitch.message)
            return
          }
          throw preparationError ?? error
        }
        if (!sameBinding(bindings.get(chatId), binding)) {
          throw new Error('feishu-bridge: /new agent published without its prepared binding')
        }
        ctx.logger.info('feishu-audit action=binding-created chat=%s session=%s sender=%s',
          auditHash(chatId), auditHash(binding.sessionId), auditHash(record.senderOpenId))
        await commit(`已创建并绑定会话 ${String(sessionId)}（cwd: ${escapeLarkMarkdownLiteral(authorized.realpath)}）。`)
        return
      }
      case 'invalid':
        await commit(`命令 /${escapeLarkMarkdownLiteral(command.name)} 参数不正确（${command.problem}）。发送 /help 查看用法。`)
        return
      case 'unknown':
        await commit(`未知命令 /${escapeLarkMarkdownLiteral(command.name)}。发送 /help 查看可用命令。`)
        return
    }
  }

  /**
   * Durable admission is globally serialized so cleanup, capacity checks,
   * duplicate lookup, and the insert form one atomic process-local boundary.
   * Business work starts on the per-chat queue only after the durable write;
   * the SDK callback may ACK as soon as this promise settles.
   */
  let admissionTail: Promise<void> = Promise.resolve()
  const admitOne = async (message: FeishuInboundMessage): Promise<void> => {
    if (disposed) throw new Error('feishu-bridge: disposed')
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

    const inboundKey = message.messageId as FeishuInboundKey
    const legacyKey = message.eventId as FeishuInboundKey
    const byMessageId = inboundEvents.get(inboundKey)
    const existing = byMessageId
      ?? (legacyKey === inboundKey ? undefined : inboundEvents.get(legacyKey))
    if (existing !== undefined) {
      ctx.logger.info('feishu-audit action=inbound-duplicate event=%s message=%s chat=%s sender=%s kind=%s status=%s',
        auditHash(message.eventId), auditHash(message.messageId), auditHash(message.chatId),
        auditHash(message.senderOpenId), existing.kind, existing.status)
      // Commands persist their first result so an at-least-once Feishu
      // delivery receives the same answer without repeating side effects.
      if (existing.kind === 'command'
        && (existing.status === 'committed' || existing.status === 'rejected')
        && existing.result !== undefined && existing.result !== '') {
        void enqueueChatWork(existing.chatId, async () => { reply(existing.chatId, existing.result!) })
      }
      return
    }

    // Retire eligible terminal rows before enforcing the hard ceiling. If
    // protected work fills the table, rejecting keeps the SDK callback from
    // ACKing and lets Feishu redeliver; no body is logged or persisted.
    if (inboundEvents.size >= config.inboundMaxRecords) await runMaintenance()
    if (inboundEvents.size >= config.inboundMaxRecords) {
      ctx.logger.warn('feishu-audit action=inbound-backpressure event=%s message=%s chat=%s sender=%s records=%d limit=%d',
        auditHash(message.eventId), auditHash(message.messageId), auditHash(message.chatId),
        auditHash(message.senderOpenId), inboundEvents.size, config.inboundMaxRecords)
      throw new Error('feishu-bridge: inbound capacity exhausted')
    }

    const receivedAt = Date.now()
    const wireIds = {
      eventId: message.eventId as FeishuEventId,
      feishuMessageId: message.messageId as FeishuMessageId,
    }
    if (receivedAt - message.createTimeMs > config.freshnessMs) {
      await inboundEvents.put(inboundKey, {
        kind: 'message',
        chatId: message.chatId as FeishuChatId,
        senderOpenId: message.senderOpenId as FeishuOpenId,
        ...wireIds,
        receivedAt, status: 'expired', reason: 'stale',
      })
      ctx.logger.warn('feishu-audit action=inbound-expired event=%s message=%s chat=%s sender=%s',
        auditHash(message.eventId), auditHash(message.messageId),
        auditHash(message.chatId), auditHash(message.senderOpenId))
      return
    }
    if (message.text === undefined) {
      await inboundEvents.put(inboundKey, {
        kind: 'message', chatId: message.chatId as FeishuChatId,
        senderOpenId: message.senderOpenId as FeishuOpenId,
        ...wireIds,
        receivedAt, status: 'rejected', reason: 'unsupported-content',
      })
      ctx.logger.info('feishu-audit action=inbound-rejected event=%s message=%s chat=%s sender=%s reason=unsupported-content',
        auditHash(message.eventId), auditHash(message.messageId),
        auditHash(message.chatId), auditHash(message.senderOpenId))
      void enqueueChatWork(message.chatId, async () => { reply(message.chatId, '暂不支持非文本消息。') })
      return
    }
    const command = parseCommand(message.text)
    if (command !== undefined) {
      const record: InboundCommand = {
        kind: 'command',
        chatId: message.chatId as FeishuChatId,
        senderOpenId: message.senderOpenId as FeishuOpenId,
        ...wireIds,
        receivedAt, status: 'received',
        command: command.kind,
        commandArgsHash: auditHash(message.text),
      }
      await inboundEvents.put(inboundKey, record)
      ctx.logger.info('feishu-audit action=command-received event=%s message=%s chat=%s sender=%s command=%s args=%s',
        auditHash(message.eventId), auditHash(message.messageId), auditHash(record.chatId),
        auditHash(record.senderOpenId), record.command, record.commandArgsHash)
      void enqueueChatWork(message.chatId, () => handleCommand(inboundKey, record, message.text!))
      return
    }
    const record: InboundMessage = {
      kind: 'message',
      chatId: message.chatId as FeishuChatId,
      senderOpenId: message.senderOpenId as FeishuOpenId,
      ...wireIds,
      receivedAt, status: 'received',
      text: message.text,
    }
    await inboundEvents.put(inboundKey, record)
    ctx.logger.info('feishu-audit action=inbound-received event=%s message=%s chat=%s sender=%s',
      auditHash(message.eventId), auditHash(message.messageId),
      auditHash(record.chatId), auditHash(record.senderOpenId))
    void enqueueChatWork(message.chatId, () => routeMessage(inboundKey, record))
  }

  const admitMessage = (message: FeishuInboundMessage): Promise<void> => {
    const result = admissionTail.then(() => admitOne(message), () => admitOne(message))
    admissionTail = result.then(() => undefined, () => undefined)
    return result
  }

  await sweepPendingCards()
  setupSignal.throwIfAborted()
  await validateBindings()
  setupSignal.throwIfAborted()
  await recoverInterrupted()
  setupSignal.throwIfAborted()
  await runMaintenance()
  setupSignal.throwIfAborted()
  // Enqueue outbound recovery before intake, but never hold readiness on
  // external Feishu I/O; the per-chat tails preserve recovery-first order.
  await recoverOutbox()
  setupSignal.throwIfAborted()
  await initializeProjectionCursors()
  setupSignal.throwIfAborted()
  await recoverCanonicalDeliveries()
  setupSignal.throwIfAborted()
  await catchUpBoundSessions()
  setupSignal.throwIfAborted()

  const unregisterInbound = ctx.feishu.handleInboundMessages(admitMessage)
  // Preserve the public event seam for local integrations and older tests;
  // the Gateway itself uses the Promise-returning admission slot above.
  ctx.on('feishu/message', (message: FeishuInboundMessage) => {
    void admitMessage(message).catch((error: unknown) => {
      ctx.logger.error('feishu-bridge legacy inbound admission failed: %s', safeErrorFact(error))
    })
  })
  disposeBridge = async () => {
    // Cordis unloads sibling effects concurrently, so this single lifecycle
    // owner must both drain and close the domains. Card timers are promoted
    // to immediate actor work before the final storage close.
    disposed = true
    settlePendingApprovalsOnDispose()
    unregisterInbound()
    unregisterEarlyHandlersOnDispose()
    const deadlineAt = Date.now() + config.disposeDrainTimeoutMs
    const waitWithinDeadline = async (work: Promise<unknown>): Promise<boolean> => {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const completed = await Promise.race([
        work.then(() => true, () => true),
        new Promise<false>(resolveTimeout => {
          timer = setTimeout(() => { resolveTimeout(false) }, remaining)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return completed
    }

    let drained = await waitWithinDeadline(ctx.feishu.stopIntake())
    if (drained) drained = await waitWithinDeadline(admissionTail)
    while (drained) {
      for (const [chatId, tracker] of cards) {
        if (tracker.timer !== undefined) {
          clearCardTimer(tracker)
          startCardActor(chatId, tracker.sessionId, tracker)
        }
      }
      const fixedTails = {
        watermark: watermarkTail,
        cursor: cursorAdmissionTail,
        delivery: deliveryAdmissionTail,
        approval: approvalAdmissionTail,
        maintenance: maintenanceTail,
      }
      const groupTails = [...approvalGroups.values()].map(group => [group, group.chain] as const)
      const targetTails = [...bindingTargetTails.entries()]
      const pending = [
        ...chatTails.values(),
        ...targetTails.map(([, chain]) => chain),
        ...cardActors,
        ...groupTails.map(([, chain]) => chain),
        ...backgroundWork,
        ...Object.values(fixedTails),
      ]
      drained = await waitWithinDeadline(
        Promise.all(pending.map(work => work.then(() => undefined, () => undefined))),
      )
      if (!drained) break
      await Promise.resolve()
      if (fixedTails.watermark === watermarkTail
        && fixedTails.cursor === cursorAdmissionTail
        && fixedTails.delivery === deliveryAdmissionTail
        && fixedTails.approval === approvalAdmissionTail
        && fixedTails.maintenance === maintenanceTail
        && groupTails.every(([group, chain]) => group.chain === chain)
        && targetTails.every(([target, chain]) => bindingTargetTails.get(target) === chain)
        && chatTails.size === 0 && bindingTargetTails.size === 0
        && cardActors.size === 0 && backgroundWork.size === 0
        && [...cards.values()].every(tracker => tracker.actor === undefined && tracker.timer === undefined)
      ) break
    }
    if (!drained) {
      drainExpired = true
      ctx.logger.warn('feishu-audit action=bridge-drain-timeout chatQueues=%d targetQueues=%d cardActors=%d approvalGroups=%d background=%d timeoutMs=%d',
        chatTails.size, bindingTargetTails.size, cardActors.size, approvalGroups.size, backgroundWork.size,
        config.disposeDrainTimeoutMs)
    }
    storageWritable = false
    await deliveryDomain.close()
    await domain.close()
  }
  await ctx.feishu.startIntake()

  // A dispose may race the asynchronous intake start. The lifecycle effect
  // will stop that accepted intake; skip timer/readiness publication here.
  setupSignal.throwIfAborted()

  if (config.maintenanceIntervalMs > 0) {
    const timer = setInterval(() => {
      if (disposed) return
      void runMaintenance().catch((error: unknown) => {
        ctx.logger.error('feishu-bridge maintenance failed: %s', safeErrorFact(error))
      })
    }, config.maintenanceIntervalMs)
    ctx.effect(() => () => clearInterval(timer), 'feishuBridge.maintenanceTimer')
  }
  ctx.logger.info('feishu-bridge mounted: %d user(s), %d workspace root(s), %d binding(s)',
    config.allowedOpenIds.length, config.allowedWorkspaces.length, bindings.size)
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

  /** Serialize cleanup so admission checks observe one deterministic sweep. */
  function runMaintenance(): Promise<void> {
    const operation = maintenanceTail.then(performMaintenance, performMaintenance)
    maintenanceTail = operation.catch((error: unknown) => {
      ctx.logger.error('feishu-bridge maintenance failed: %s', safeErrorFact(error))
    })
    return operation
  }

  /** Apply TTL/capacity rules; content is cleared before abandonment. */
  async function performMaintenance(): Promise<void> {
    const now = Date.now()
    const plan = planRetention(inboundEvents.entries(), outboundSegments.entries(), now, config)
    const activeApprovalKeys = new Set([
      ...pendingApprovals.keys(),
      ...approvalReservations,
    ])
    const activeCursorKeys = new Set<string>(reservedCursorKeys)
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status === 'active') {
        activeCursorKeys.add(projectionCursorId(chatId, binding.sessionId) as string)
      }
    }
    const pendingCursorKeys = new Set<string>()
    for (const [, row] of deliveries.entries()) {
      if (row.status === 'pending') {
        pendingCursorKeys.add(projectionCursorId(row.chatId, row.sessionId) as string)
      }
    }
    for (const [, row] of outboundSegments.entries()) {
      if (row.status === 'pending') {
        pendingCursorKeys.add(projectionCursorId(row.chatId, row.sessionId) as string)
      }
    }
    const durablePlan = planDurableRetention(
      deliveries.entries(), pendingCards.entries(), projectionCursors.entries(), now, config,
      activeApprovalKeys, activeCursorKeys, pendingCursorKeys,
    )

    for (const key of plan.outboundAbandon) {
      const typedKey = key as OutboundSegmentId
      const row = outboundSegments.get(typedKey)
      if (row === undefined || row.status !== 'pending') continue
      await outboundSegments.put(typedKey, { ...row, status: 'abandoned', text: '' })
      ctx.logger.warn('feishu-audit action=outbox-abandoned chat=%s session=%s seq=%d segment=%d attempts=%d',
        auditHash(row.chatId), auditHash(row.sessionId), row.sourceEventSeq, row.segmentIndex, row.attempts)
    }
    for (const key of durablePlan.deliveryAbandon) {
      const typedKey = key as FeishuDeliveryId
      const row = deliveries.get(typedKey)
      if (row === undefined || row.status !== 'pending') continue
      await deliveries.put(typedKey, { ...row, status: 'abandoned', text: '' })
      ctx.logger.warn('feishu-audit action=delivery-abandoned chat=%s session=%s seq=%d attempts=%d',
        auditHash(row.chatId), auditHash(row.sessionId), row.sourceEventSeq, row.attempts)
    }
    for (const key of plan.inboundDelete) await inboundEvents.delete(key as FeishuInboundKey)
    for (const key of plan.outboundDelete) await outboundSegments.delete(key as OutboundSegmentId)
    for (const key of durablePlan.deliveryDelete) await deliveries.delete(key as FeishuDeliveryId)
    for (const key of durablePlan.approvalDelete) await pendingCards.delete(key as never)
    for (const key of durablePlan.cursorDelete) await projectionCursors.delete(key as ProjectionCursorId)

    const watermarkCleanup = watermarkTail.then(async () => {
      const current = domain.global.get()
      const watermarks = current.watermarks as Record<string, number>
      const kept = pruneProjectionCursors(watermarks, activeCursorKeys, pendingCursorKeys)
      if (Object.keys(kept).length !== Object.keys(watermarks).length) {
        await setWatermarks(kept)
      }
      return Object.keys(watermarks).length - Object.keys(kept).length
    })
    watermarkTail = watermarkCleanup.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge watermark cleanup failed: %s', safeErrorFact(error))
    })
    const watermarksDeleted = await watermarkCleanup

    for (const [chatId, listing] of listings) {
      if (now - listing.at > config.listingTtlMs) listings.delete(chatId)
    }

    const deleted = plan.inboundDelete.length + plan.outboundDelete.length
      + durablePlan.deliveryDelete.length + durablePlan.approvalDelete.length
      + durablePlan.cursorDelete.length + watermarksDeleted
    if (deleted > 0) {
      ctx.logger.info('feishu-audit action=retention-sweep inboundDeleted=%d deadLetterDeleted=%d deliveryDeleted=%d approvalDeleted=%d cursorDeleted=%d watermarkDeleted=%d',
        plan.inboundDelete.length, plan.outboundDelete.length, durablePlan.deliveryDelete.length,
        durablePlan.approvalDelete.length, durablePlan.cursorDelete.length, watermarksDeleted)
    }
    if (plan.inboundOverCapacity || plan.outboundOverCapacity
      || durablePlan.deliveryOverCapacity || durablePlan.approvalOverCapacity
      || durablePlan.projectionCursorOverCapacity) {
      ctx.logger.warn('feishu-audit action=retention-backpressure inbound=%s deadLetter=%s delivery=%s approval=%s cursor=%s',
        String(plan.inboundOverCapacity), String(plan.outboundOverCapacity),
        String(durablePlan.deliveryOverCapacity), String(durablePlan.approvalOverCapacity),
        String(durablePlan.projectionCursorOverCapacity))
    }
  }

  /** Queue legacy recovery in deterministic FIFO order without blocking plugin readiness on I/O. */
  async function recoverOutbox(): Promise<void> {
    const groupsByChat = new Map<string, [OutboundSegmentId, OutboundSegment][][]>()
    const groups = new Map<string, [OutboundSegmentId, OutboundSegment][]>()
    for (const [key, row] of sortPendingOutbox(outboundSegments.entries())) {
      const groupKey = JSON.stringify([row.chatId, row.sessionId, row.sourceEventSeq])
      let group = groups.get(groupKey)
      if (group === undefined) {
        group = []
        groups.set(groupKey, group)
        const chatGroups = groupsByChat.get(row.chatId) ?? []
        chatGroups.push(group)
        groupsByChat.set(row.chatId, chatGroups)
      }
      group.push([key, row])
    }
    for (const [chatId, chatGroups] of groupsByChat) {
      void enqueueChatWork(chatId, async () => {
        for (const group of chatGroups) {
          const first = group[0]
          if (first === undefined) continue
          const row = first[1]
          for (const [key, pending] of group) {
            if (!await deliverOutboundSegment(key, pending)) return
          }
          const eventRows = [...outboundSegments.entries()]
            .map(([, candidate]) => candidate)
            .filter(candidate => candidate.chatId === row.chatId
              && candidate.sessionId === row.sessionId
              && candidate.sourceEventSeq === row.sourceEventSeq)
          if (eventRows.length === row.segmentCount && eventRows.every(candidate => candidate.status !== 'pending')) {
            await advanceWatermark(row.chatId, row.sessionId, row.sourceEventSeq)
            await advanceProjectionCursor(row.chatId, row.sessionId, row.sourceEventSeq)
          }
        }
      })
    }
  }

  /** Seed the new cursor table from successfully completed legacy outbox watermarks. */
  async function initializeProjectionCursors(): Promise<void> {
    const watermarks = domain.global.get().watermarks as Record<string, number>
    for (const [key, sourceEventSeq] of Object.entries(watermarks)) {
      let pair: unknown
      try { pair = JSON.parse(key) } catch { continue }
      if (!Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue
      await advanceProjectionCursor(
        pair[0] as FeishuChatId, pair[1] as SessionIdString, sourceEventSeq,
      )
    }
  }

  /** Queue every canonical row, including the sent-before-cursor crash window. */
  async function recoverCanonicalDeliveries(): Promise<void> {
    const ordered = [...deliveries.entries()].sort(([leftKey, left], [rightKey, right]) =>
      (left.chatId as string).localeCompare(right.chatId as string)
      || left.createdAt - right.createdAt
      || ((left.sessionId as string) === (right.sessionId as string)
        ? left.sourceEventSeq - right.sourceEventSeq
        : 0)
      || (leftKey as string).localeCompare(rightKey as string))
    const byChat = new Map<string, [FeishuDeliveryId, CanonicalDelivery][]>()
    for (const entry of ordered) {
      const row = entry[1]
      const group = byChat.get(row.chatId) ?? []
      group.push(entry)
      byChat.set(row.chatId, group)
    }
    for (const [chatId, rows] of byChat) {
      void enqueueChatWork(chatId, async () => {
        if (hasPendingLegacyDelivery(chatId as FeishuChatId)) return
        for (const [key, row] of rows) {
          if (!await deliverCanonical(key, row)) return
        }
      })
    }
  }

  /** Queue every active binding catch-up before intake opens. */
  async function catchUpBoundSessions(): Promise<void> {
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active') continue
      void enqueueChatWork(chatId, () => catchUpProjection(chatId, binding.sessionId))
    }
  }

  /**
   * Restart sweep (design §6.4): every persisted pending approval card is
   * from a dead process. Records sharing one cardMessageId were items of
   * one GROUP card — patch each message once with all its items
   * invalidated (per-record patches would overwrite each other). Records
   * without a messageId (not durably confirmed visible) are just deleted. Never
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
  async function recoverCommand(eventId: FeishuInboundKey, record: InboundCommand): Promise<void> {
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

  async function recoverMessage(eventId: FeishuInboundKey, record: InboundMessage): Promise<void> {
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
  return true
}
