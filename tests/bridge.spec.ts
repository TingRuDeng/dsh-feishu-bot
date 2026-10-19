/**
 * Assembled bridge behavior: full plugin mount over real SessionStore,
 * AgentRegistry, AgentLoop, JSONL persistence, and a JSON storage domain,
 * with a stub `feishu` transport capturing outbound sends. Covers the bridge
 * acceptance flows from M1 through M5: authorization and commands, durable
 * recovery, terminal projection, approvals, retention, and HMR readiness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import LlmRuntime, { createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
// The persistence plugin moved from a default export to the named `apply`
// shape the rest of its family uses. Importing the namespace keeps this test
// working under both, instead of failing at mount with an opaque
// "invalid plugin ... received undefined".
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import * as bridge from '../src/bridge/index.ts'
import type { FeishuInboundMessage } from '../src/gateway/index.ts'
import { resultCardEnvelopeBytes } from '../src/bridge/result-card.ts'

/** Stub transport: records sends, never talks to Feishu. */
class StubFeishu extends Service {
  sent: { chatId: string; text: string }[] = []
  cards: { messageId: string; card: object }[] = []
  sessionListCardAttempts: object[] = []
  sessionListDeliveries: unknown[] = []
  resultCardAttempts: object[] = []
  approvalCardAttempts: object[] = []
  blockFirstApprovalCardCreate = false
  private releaseBlockedApprovalCard: (() => void) | undefined
  blockNextApprovalPatch = false
  private releaseBlockedApprovalPatch: (() => void) | undefined
  approvalPatchAttempts: { messageId: string; card: object }[] = []
  failResultCards = false
  resultCardError: Error | undefined
  nextResultCardError: Error | undefined
  blockFirstResultCardCreate = false
  private releaseBlockedResultCard: (() => void) | undefined
  failTexts = false
  failNextApprovalPatch = false
  failNextSessionListPagePatch = false
  failNextSessionListTerminalPatch = false
  nextApprovalCardError: Error | undefined
  nextSessionListCardError: Error | undefined
  taskCardCreateAttempts: object[] = []
  blockFirstTaskCardCreate = false
  private releaseBlockedTaskCard: (() => void) | undefined
  private inboundHandler: ((message: FeishuInboundMessage) => Promise<void>) | undefined
  private intakeStarted = false
  startIntakeCalls = 0
  stopIntakeCalls = 0
  markBridgeReadyCalls = 0
  private resolveBridgeReady!: () => void
  private rejectBridgeReady!: (reason: unknown) => void
  private readonly bridgeReady = new Promise<void>((resolve, reject) => {
    this.resolveBridgeReady = resolve
    this.rejectBridgeReady = reject
  })
  constructor(ctx: Context) {
    super(ctx, 'feishu')
  }

  async sendText(chatId: string, text: string, _delivery?: unknown): Promise<string> {
    if (this.failTexts) throw new Error('simulated text failure')
    this.sent.push({ chatId, text })
    return `om_${this.sent.length}`
  }

  async sendCard(_chatId: string, card: object, _delivery?: unknown): Promise<string> {
    const json = JSON.stringify(card)
    if (json.includes('选择会话') || json.includes('选择工作空间')) {
      this.sessionListCardAttempts.push(card)
      this.sessionListDeliveries.push(_delivery)
    }
    if ((json.includes('选择会话') || json.includes('选择工作空间'))
      && this.nextSessionListCardError !== undefined) {
      const error = this.nextSessionListCardError
      this.nextSessionListCardError = undefined
      throw error
    }
    if (json.includes('最终结果')) {
      this.resultCardAttempts.push(card)
      if (this.blockFirstResultCardCreate && this.resultCardAttempts.length === 1) {
        await new Promise<void>(resolve => { this.releaseBlockedResultCard = resolve })
      }
      if (this.nextResultCardError !== undefined) {
        const error = this.nextResultCardError
        this.nextResultCardError = undefined
        throw error
      }
      if (this.resultCardError !== undefined) throw this.resultCardError
      if (this.failResultCards) {
        throw Object.assign(new Error('simulated result-card failure'), {
          feishuFailureKind: 'permanent',
        })
      }
    }
    if (json.includes('审批请求')) {
      this.approvalCardAttempts.push(card)
      if (this.blockFirstApprovalCardCreate && this.approvalCardAttempts.length === 1) {
        await new Promise<void>(resolve => { this.releaseBlockedApprovalCard = resolve })
      }
      if (this.nextApprovalCardError !== undefined) {
        const error = this.nextApprovalCardError
        this.nextApprovalCardError = undefined
        throw error
      }
    }
    if (!json.includes('最终结果') && (json.includes('思考中') || json.includes('已完成')
      || json.includes('已停止') || json.includes('任务失败'))) {
      this.taskCardCreateAttempts.push(card)
      if (this.blockFirstTaskCardCreate && this.taskCardCreateAttempts.length === 1) {
        await new Promise<void>(resolve => { this.releaseBlockedTaskCard = resolve })
      }
    }
    const messageId = `card_${this.cards.length + 1}`
    this.cards.push({ messageId, card })
    return messageId
  }

  async patchCard(messageId: string, card: object): Promise<void> {
    if (JSON.stringify(card).includes('审批请求')) {
      this.approvalPatchAttempts.push({ messageId, card })
      if (this.blockNextApprovalPatch) {
        this.blockNextApprovalPatch = false
        await new Promise<void>(resolve => { this.releaseBlockedApprovalPatch = resolve })
      }
    }
    if (this.failNextApprovalPatch && JSON.stringify(card).includes('审批请求')) {
      this.failNextApprovalPatch = false
      throw new Error('simulated approval patch failure')
    }
    if (this.failNextSessionListTerminalPatch
      && (JSON.stringify(card).includes('会话已绑定') || JSON.stringify(card).includes('绑定失败'))) {
      this.failNextSessionListTerminalPatch = false
      throw new Error('simulated session-list terminal patch failure')
    }
    if (this.failNextSessionListPagePatch && JSON.stringify(card).includes('· 会话 · 2/')) {
      this.failNextSessionListPagePatch = false
      throw new Error('simulated session-list page patch failure')
    }
    this.cards.push({ messageId, card })
  }

  releaseTaskCardCreate(): void {
    this.releaseBlockedTaskCard?.()
    this.releaseBlockedTaskCard = undefined
  }

  releaseResultCardCreate(): void {
    this.releaseBlockedResultCard?.()
    this.releaseBlockedResultCard = undefined
  }

  releaseApprovalCardCreate(): void {
    this.releaseBlockedApprovalCard?.()
    this.releaseBlockedApprovalCard = undefined
  }

  releaseApprovalPatch(): void {
    this.releaseBlockedApprovalPatch?.()
    this.releaseBlockedApprovalPatch = undefined
  }

  cardHandler: ((action: { operatorOpenId: string; chatId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>) | undefined
  private cardHandlerGeneration = 0

  handleCardActions(handler: (action: { operatorOpenId: string; chatId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>): () => void {
    const generation = ++this.cardHandlerGeneration
    this.cardHandler = handler
    return () => {
      if (this.cardHandlerGeneration === generation) this.cardHandler = undefined
    }
  }

  handleInboundMessages(handler: (message: FeishuInboundMessage) => Promise<void>): () => void {
    if (this.inboundHandler !== undefined && this.inboundHandler !== handler) {
      throw new Error('inbound handler already registered')
    }
    this.inboundHandler = handler
    return () => {
      if (this.inboundHandler === handler) this.inboundHandler = undefined
    }
  }

  async startIntake(): Promise<void> {
    if (this.inboundHandler === undefined) throw new Error('cannot start without admission handler')
    this.startIntakeCalls += 1
    this.intakeStarted = true
  }

  async stopIntake(): Promise<void> {
    this.stopIntakeCalls += 1
    this.intakeStarted = false
  }

  whenBridgeReady(): Promise<void> { return this.bridgeReady }
  markBridgeReady(): void {
    this.markBridgeReadyCalls += 1
    this.resolveBridgeReady()
  }
  markBridgeFailed(error: unknown): void { this.rejectBridgeReady(error) }

  async deliverInbound(message: FeishuInboundMessage): Promise<void> {
    if (!this.intakeStarted || this.inboundHandler === undefined) return
    await this.inboundHandler(message)
  }

  /** Test hook: simulate a card button click. */
  async clickCard(
    operatorOpenId: string, messageId: string, value: unknown, chatId = 'oc_chat_1',
  ): Promise<{ toast?: string } | undefined> {
    if (this.cardHandler === undefined) throw new Error('no card handler registered')
    return this.cardHandler({ operatorOpenId, chatId, messageId, value })
  }
}

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const OWNER = 'ou_test_owner'
const OTHER = 'ou_test_other'

function cardButtonValue(card: object, label: string): unknown {
  const legacyElements = (card as { elements?: unknown[] }).elements ?? []
  const bodyElements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? []
  const elements = [...legacyElements, ...bodyElements]
  for (const element of elements) {
    const direct = element as { tag?: string; text?: { content?: string }; value?: unknown }
    if (direct.tag === 'button' && direct.text?.content === label) return direct.value
    const actions = (element as { actions?: unknown[] }).actions ?? []
    for (const action of actions) {
      const button = action as { text?: { content?: string }; value?: unknown }
      if (button.text?.content === label) return button.value
    }
  }
  return undefined
}

function cardActionValue(card: object, actionName: string): unknown {
  const legacyElements = (card as { elements?: unknown[] }).elements ?? []
  const bodyElements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? []
  for (const element of [...legacyElements, ...bodyElements]) {
    const direct = element as { tag?: string; value?: unknown }
    const directValue = direct.value as { action?: string } | undefined
    if (direct.tag === 'button' && directValue?.action === actionName) return direct.value
    for (const action of (element as { actions?: unknown[] }).actions ?? []) {
      const value = (action as { value?: unknown }).value as { action?: string } | undefined
      if (value?.action === actionName) return (action as { value: unknown }).value
    }
  }
  return undefined
}

/**
 * A session seed that makes a session count as used.
 *
 * `/ls` hides sessions that still hold only the configuration every session is
 * created with, matching the Web GUI. A test that needs a listed session must
 * therefore give it at least one event of its own.
 */
const usedSeed = (turn = 1) => [
  { type: 'turn/start', seq: 0, time: 1, data: { turn } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn, reason: { kind: 'completed' } } },
] as never

async function mountBridge(
  adapter: MockAdapter, configOverrides: object = {}, existingRoot?: string,
  configureFeishu?: (feishu: StubFeishu) => void,
  configureContext?: (ctx: Context) => void | Promise<void>,
  captureBridgeFiber?: (fiber: { uid: number | null; dispose: () => Promise<void> }) => void,
  defaultSelection?: () => { provider: string; model: string; reasoningEffort?: unknown },
): Promise<{
  ctx: Context
  feishu: StubFeishu
  root: string
  bridgeFiber: { uid: number | null; dispose: () => Promise<void> }
  deliver: (message: Partial<FeishuInboundMessage> & { text?: string }) => Promise<void>
  drain: () => Promise<void>
  archiveSession: (sessionId: string) => void
  registerWorkspaceSession: (sessionId: string) => void
  workspaces: readonly { id: string; path: string; title: string; sessionIds: readonly string[] }[]
  attachedSessions: ReadonlyMap<string, string[]>
  createWorkspace: (path: string, title?: string) => Promise<{ id: string; path: string }>
}> {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
  if (existingRoot === undefined) dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserApproval)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('sessionProjectionCache' as never, {
    coldSnapshot: async (sessionId: string) => {
      const handle = await ctx.sessionPersistence.open(sessionId as never, 'read')
      const stored = await handle.read()
      await handle.close()
      const event = stored.events.findLast(item => item.type === 'session/title')
      const title = (event?.data as { title?: unknown } | undefined)?.title
      return {
        asOfSeq: stored.events.at(-1)?.seq ?? -1,
        values: { title: typeof title === 'string' && title.length > 0 ? title : null },
      }
    },
  } as never)
  const archivedSessionIds = new Set<string>()
  // Mirrors the real registry: a Workspace is an entity, and membership is
  // driven by attachSession (+ the cwd check), NOT derived from cwd alone.
  // Recording attaches is what makes "did /new join a workspace?" observable.
  const attachedSessions = new Map<string, string[]>()
  const workspaces: {
    id: string
    path: string
    title: string
    createdAt: string
    updatedAt: string
    sessionIds: readonly string[]
    attachSession: (sessionId: string) => Promise<void>
  }[] = []
  const makeWorkspace = (path: string, title: string) => {
    const ids: string[] = []
    const workspace = {
      id: `ws-${workspaces.length + 1}`,
      path,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      get sessionIds(): readonly string[] { return ids },
      attachSession: async (sessionId: string): Promise<void> => {
        // The real entity refuses a session whose stored cwd is absent, does
        // not resolve, is not a directory, or differs from the workspace path.
        const header = ctx.sessions.list().find(session => String(session.id) === sessionId)?.header
        const stored = header?.cwd
          ?? (await ctx.sessionPersistence.list())
            .find(session => String(session.header.id) === sessionId)?.header.cwd
        if (stored === undefined) {
          throw new Error(`cannot attach session '${sessionId}': its stored header carries no cwd`)
        }
        const resolved = await realpath(stored)
        const expected = await realpath(path)
        if (resolved !== expected) {
          throw new Error(`cannot attach session '${sessionId}': its cwd resolves to '${resolved}'`)
        }
        if (!ids.includes(sessionId)) ids.unshift(sessionId)
        attachedSessions.set(sessionId, [...ids])
      },
    }
    return workspace
  }
  ctx.provide('agentDefaultModel', {
    currentSelection: defaultSelection ?? (() => ({ provider: 'mock', model: 'm' })),
  })
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archivedSessionIds] },
    // The real registry canonicalizes with realpath before comparing, and the
    // bridge hands it an already-resolved cwd. Comparing raw strings would
    // miss on macOS, where a temp dir is /var/... but resolves to /private/var.
    resolveByPath: async (path: string) => {
      const canonical = await realpath(path)
      return workspaces.find(workspace => workspace.path === canonical)
        ?? workspaces.find(workspace => workspace.path === path)
    },
    create: async (path: string, title?: string) => {
      const workspace = makeWorkspace(path, title ?? basename(path))
      workspaces.push(workspace)
      return workspace
    },
    list: async () => {
      // The real registry projects `sessionIds` from attach membership, but a
      // caller that never attached (as these tests' direct ctx.agents.create
      // calls do) still has a cwd to group by. Mirror both so /ls keeps working.
      const derived = new Map<string, string[]>()
      const headers = new Map<string, string | undefined>()
      for (const session of ctx.sessions.list()) headers.set(String(session.id), session.header.cwd)
      for (const session of await ctx.sessionPersistence.list()) {
        headers.set(String(session.header.id), session.header.cwd)
      }
      for (const [id, cwd] of headers) {
        if (cwd === undefined) continue
        const ids = derived.get(cwd) ?? []
        ids.push(id)
        derived.set(cwd, ids)
      }
      const seen = new Set(workspaces.map(workspace => workspace.path))
      const extra = [...derived]
        .filter(([cwd]) => !seen.has(cwd))
        .map(([cwd, sessionIds]) => ({ ...makeWorkspace(cwd, basename(cwd)), sessionIds }))
      return [...workspaces, ...extra]
    },
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(StubFeishu)
  const feishu = ctx.get('feishu') as unknown as StubFeishu
  void feishu.whenBridgeReady().catch(() => {})
  configureFeishu?.(feishu)
  await configureContext?.(ctx)
  const bridgeFiber = ctx.plugin(bridge, {
    allowedOpenIds: [OWNER],
    allowedWorkspaces: [root],
    defaultWorkspace: root,
    freshnessMs: 600_000,
    cardThrottleMs: 1_000,
    agentProvider: 'mock',
    agentModel: 'm',
    ...configOverrides,
  })
  captureBridgeFiber?.(bridgeFiber)
  await bridgeFiber.await()
  if (captureBridgeFiber === undefined) {
    await vi.waitFor(() => {
      if (ctx.storageDomain.get('feishu_bot') === undefined) throw new Error('bridge domain not mounted yet')
    }, { timeout: 5_000, interval: 10 })
    await feishu.whenBridgeReady()
  }
  let eventCounter = 0
  const deliver = async (message: Partial<FeishuInboundMessage> & { text?: string }): Promise<void> => {
    await feishu.deliverInbound({
      eventId: `ev_${++eventCounter}`,
      chatId: 'oc_chat_1',
      senderOpenId: OWNER,
      chatType: 'p2p',
      messageId: `om_in_${eventCounter}`,
      createTimeMs: Date.now(),
      text: 'hi',
      ...message,
    })
    await drain()
  }
  const drain = async (): Promise<void> => {
    // Chat queues are internal; settle when the outbound count stays stable
    // across two consecutive checks (bounded at 4s).
    let last = -1
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const count = feishu.sent.length + feishu.cards.length
      const inboundBusy = [...(ctx.storageDomain.get('feishu_bot')?.table('inbound_events').entries() ?? [])]
        .some(([, row]) => (row as { status?: string }).status === 'received'
          || (row as { status?: string }).status === 'recovering')
      const agentBusy = ctx.agents.list().some(agent => agent.status === 'running')
      if (!inboundBusy && !agentBusy && count === last) return
      last = count
    }
  }
  return {
    ctx, feishu, root, bridgeFiber, deliver, drain,
    archiveSession: sessionId => { archivedSessionIds.add(sessionId) },
    registerWorkspaceSession: (sessionId: string) => {
      const workspace = makeWorkspace(root, basename(root))
      workspaces.push(workspace)
      void workspace.attachSession(sessionId)
    },
    // Observation helpers for the workspace-membership tests.
    workspaces,
    attachedSessions,
    createWorkspace: async (path: string, title?: string) => {
      const workspace = makeWorkspace(await realpath(path), title ?? basename(path))
      workspaces.push(workspace)
      return workspace
    },
  }
}

describe('assembled bridge (M1 acceptance)', () => {
  it('non-allowlisted sender is ignored entirely', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ senderOpenId: 'ou_stranger', text: '/help' })
    expect(feishu.sent).toEqual([])
  })

  it('group chats are ignored even from allowlisted senders', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ chatType: 'group', text: '/help' })
    expect(feishu.sent).toEqual([])
  })

  it('/help replies with the command list', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/help' })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('/new')
    expect(feishu.sent[0]!.text).toContain('/use')
  })

  it('duplicate committed command events replay the first result without re-running work', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ eventId: 'ev_dup', text: '/help' })
    await deliver({ eventId: 'ev_dup', text: '/help' })
    expect(feishu.sent).toHaveLength(2)
    expect(feishu.sent[1]!.text).toBe(feishu.sent[0]!.text)
  })

  it('duplicate rejected binding commands replay the durable failure without repeating side effects', async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([]))
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    let attempts = 0
    bindings.put = async (key, value) => {
      if ((value as { status?: string }).status === 'active') {
        attempts += 1
        throw new Error('simulated binding persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({ eventId: 'ev_rejected_a', messageId: 'om_rejected_once', text: '/new' })
    const firstResult = feishu.sent.at(-1)!.text
    await deliver({ eventId: 'ev_rejected_b', messageId: 'om_rejected_once', text: '/new' })

    expect(attempts).toBe(1)
    expect(feishu.sent.at(-1)!.text).toBe(firstResult)
    expect(feishu.sent.filter(item => item.text === firstResult)).toHaveLength(2)
  })

  it('deduplicates a command by message_id when Feishu redelivers it with a new event_id', async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ eventId: 'ev_delivery_a', messageId: 'om_logical_once', text: '/new' })
    const sessionsAfterFirstDelivery = ctx.sessions.list().length

    await deliver({ eventId: 'ev_delivery_b', messageId: 'om_logical_once', text: '/new' })

    expect(ctx.sessions.list()).toHaveLength(sessionsAfterFirstDelivery)
    const inbound = ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
    expect(inbound.get('om_logical_once')).toMatchObject({
      eventId: 'ev_delivery_a',
      feishuMessageId: 'om_logical_once',
    })
    expect(inbound.get('ev_delivery_a')).toBeUndefined()
  })

  it('recognizes an existing v1 event_id-keyed row during the compatibility window', async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([]))
    const inbound = ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
    await inbound.put('ev_legacy_command' as never, {
      kind: 'command',
      chatId: 'oc_chat_1',
      senderOpenId: OWNER,
      receivedAt: Date.now(),
      status: 'committed',
      command: 'help',
      commandArgsHash: 'legacy-hash',
      result: 'legacy-result',
    })

    await deliver({
      eventId: 'ev_legacy_command',
      messageId: 'om_new_delivery_for_legacy_event',
      text: '/new',
    })

    expect(feishu.sent).toEqual([{ chatId: 'oc_chat_1', text: 'legacy-result' }])
    expect(inbound.size).toBe(1)
    expect(ctx.sessions.list()).toEqual([])
  })

  it('rejects admission before ACK when recoverable inbound rows fill hard capacity', async () => {
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([]),
      { inboundMaxRecords: 1 },
    )
    const inbound = ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
    await inbound.put('om_inflight' as never, {
      kind: 'message',
      chatId: 'oc_chat_1',
      senderOpenId: OWNER,
      receivedAt: Date.now(),
      status: 'received',
      text: 'still recoverable',
    })

    await expect(deliver({
      eventId: 'ev_over_capacity',
      messageId: 'om_over_capacity',
      text: '/help',
    })).rejects.toThrow(/capacity/u)
    expect(inbound.size).toBe(1)
    expect(feishu.sent).toEqual([])
  })

  it('free text without a binding explains how to bind', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: 'hello agent' })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('/new')
  })

  it('/new outside the allowed workspaces rejects', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new /etc' })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('outside-workspaces')
  })

  it('/new gives the session the preset tool surface (regression: only working_directory)', { timeout: 20_000 }, async () => {
    // A Feishu /new session once received `working_directory` and nothing else,
    // because tools reach an Agent only through an AGENT PRESET and the bridge
    // never mounted one. Assert on the tool surface the Agent actually gets.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('ok')]),
      {},
      undefined,
      undefined,
      async (ctx) => {
        await ctx.plugin(Loader)
        ctx.loader.builtins.group = Group
        await ctx.plugin(AgentPresets, { default: 'standard' })
        await ctx.plugin({
          inject: ['agentPresets'],
          async* apply(child: Context) {
            yield await child.agentPresets.register({
              id: 'standard',
              plugins: [{
                id: 'tool-todo',
                name: '@deepseek-ai/dsh-tool-todo',
                config: { allowParallelInProgress: true },
              }],
            })
          },
        })
      },
    )
    await deliver({ text: '/new' })
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')

    const bound = [...ctx.agents.list()][0]
    const names = ctx.tools.schemas(scopeOf(bound.ctx)).map(schema => schema.name)
    expect(names).toContain('todo_write')
  })

  it('/new attaches the session to the workspace for its cwd, not Ungrouped', { timeout: 20_000 }, async () => {
    // Reported: a Feishu /new session never appears under its workspace in the
    // Web GUI and lands in Ungrouped instead. Web grouping is driven by
    // Workspace ENTITY membership (workspace.sessionIds), which is populated
    // by attachSession — not derived from a session's cwd. The bridge created
    // the session with the right cwd but never joined it to the workspace.
    const { ctx, feishu, deliver, workspaces, root } = await mountBridge(
      new MockAdapter([textResponse('ok')]),
    )
    // A workspace for the configured default directory already exists, as it
    // would after the user opened that folder in the Web GUI.
    expect(workspaces.some(candidate => candidate.path === root)).toBe(false)
    await deliver({ text: '/new' })
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')

    const bound = [...ctx.agents.list()][0]
    const sessionId = String(bound.session.id)
    const workspace = workspaces.find(candidate => candidate.sessionIds.includes(sessionId))
    expect(workspace).toBeDefined()
    expect(workspace!.sessionIds).toContain(sessionId)
  })

  it('/new joins the workspace that ALREADY exists for its directory', { timeout: 20_000 }, async () => {
    // The reported case: the folder is already open in the Web GUI, so the
    // entity predates the Feishu session. Reusing it (rather than minting a
    // second entity for the same path) is what makes the session appear under
    // the existing workspace instead of a duplicate or Ungrouped.
    const { ctx, feishu, deliver, workspaces, root, createWorkspace } = await mountBridge(
      new MockAdapter([textResponse('ok')]),
    )
    const canonicalRoot = await realpath(root)
    await createWorkspace(canonicalRoot, 'mycode')
    const preexisting = workspaces.find(candidate => candidate.path === canonicalRoot)
    expect(preexisting).toBeDefined()

    await deliver({ text: '/new' })
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')
    const sessionId = String([...ctx.agents.list()][0].session.id)
    // Joined to the pre-existing entity; no duplicate workspace for the path.
    expect(preexisting!.sessionIds).toContain(sessionId)
    expect(workspaces.filter(candidate => candidate.path === canonicalRoot)).toHaveLength(1)
  })

  it('/new still succeeds when no workspace can be resolved (best-effort attach)', { timeout: 20_000 }, async () => {
    // Grouping is cosmetic: a registry that cannot be joined must not fail a
    // session that is otherwise usable, and must not leave the chat unbound.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('ok')]),
      {},
      undefined,
      undefined,
      (ctx) => {
        const registry = ctx.get('workspaceRegistry') as Record<string, unknown>
        delete registry.resolveByPath
        delete registry.create
      },
    )
    await deliver({ text: '/new' })
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')
    expect([...ctx.agents.list()]).toHaveLength(1)
  })

  it('full loop: /new binds, text reaches the model, reply reaches the chat', { timeout: 20_000 }, async () => {    const { feishu, root, deliver } = await mountBridge(new MockAdapter([textResponse('模型的回答')]))
    await deliver({ text: '/new' })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')

    await deliver({ text: '请帮我做一件事' })
    const result = feishu.cards.find(c => JSON.stringify(c.card).includes('最终结果'))
    expect(result).toBeDefined()
    const card = result!.card as {
      schema: string
      header: { title: { content: string }; template: string }
      body: { elements: { tag: string; content: string }[] }
    }
    expect(card.schema).toBe('2.0')
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: `${basename(root)} · 最终结果 · 1/1` },
      template: 'green',
    })
    expect(card.body.elements[1]).toEqual({ tag: 'markdown', content: '模型的回答' })
  })

  it('uses the Harness default model when bridge overrides are omitted', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('Harness 默认模型已生效')]),
      { agentProvider: undefined, agentModel: undefined },
    )
    await deliver({ text: '/new' })
    await deliver({ text: '使用当前 Web 默认模型' })

    expect(feishu.cards.some(card =>
      JSON.stringify(card.card).includes('Harness 默认模型已生效'))).toBe(true)
  })

  it('rejects a partial bridge model override', () => {
    const result = bridge.Config['~standard'].validate({ agentProvider: 'mock' })
    if ('then' in result) throw new Error('unexpected async schema')

    expect(result.issues?.[0]?.message)
      .toContain('agentProvider and agentModel must be configured together')
  })

  describe('M7.0: default model selection installation', () => {
    const high = ReasoningEffortId('high')
    const max = ReasoningEffortId('max')
    // The adapter default differs from the selection on purpose: without the
    // bridge-installed selection ref the first request would materialize the
    // adapter default, so these assertions can only pass through the ref.
    const reasoningInfo = {
      efforts: [
        { id: high, name: 'High' },
        { id: max, name: 'Max' },
      ],
      defaultEffort: max,
    }

    it('/new-created sessions carry the default reasoningEffort on the first request', { timeout: 20_000 }, async () => {
      const adapter = new MockAdapter([textResponse('effort 已生效')], reasoningInfo)
      const { deliver } = await mountBridge(
        adapter,
        { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: high }),
      )
      await deliver({ text: '/new' })
      await deliver({ text: '测试 effort' })

      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.reasoningEffort).toBe(high)
    })

    it('/use cold recovery installs the default selection on the resumed agent', { timeout: 20_000 }, async () => {
      const first = await mountBridge(new MockAdapter([]))
      const coldSessionId = 'cold-use-effort'
      // AgentLoop owns the durable write handle: seeding through
      // `sessions.create()` registers no persistence writer, so the cold
      // session would never reach disk and could not be resumed.
      const seeded = await first.ctx.agents.create({
        sessionId: coldSessionId as never,
        agentOptions: { provider: 'mock', model: 'm' },
        seed: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ] as never,
        meta: { cwd: first.root },
      })
      await first.ctx.sessions.flush(seeded.agent.session)
      await first.ctx.fiber.dispose()

      const adapter = new MockAdapter([textResponse('恢复后的回答')], reasoningInfo)
      const second = await mountBridge(
        adapter,
        { agentProvider: undefined, agentModel: undefined },
        first.root, undefined, undefined, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: high }),
      )
      await second.deliver({ eventId: 'ev_use_effort', text: `/use ${coldSessionId}` })
      await second.deliver({ text: '恢复后继续' })

      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.reasoningEffort).toBe(high)
    })

    it('does not install the selection ref on a live Web-owned agent bound via /use', { timeout: 20_000 }, async () => {
      // The live agent stands in for a Web-created session; it has no effort
      // of its own, so the adapter default (max) must materialize. If the
      // bridge wrongly installed its ref on the `existing` ownership path,
      // the bridge default (high) would win instead.
      const probeRoot = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
      dirs.push(probeRoot)
      const adapter = new MockAdapter([textResponse('已有会话的回答')], reasoningInfo)
      const { deliver } = await mountBridge(
        adapter,
        { agentProvider: undefined, agentModel: undefined },
        probeRoot, undefined, async (ctx) => {
          await ctx.agents.create({
            sessionId: 'web-owned-live' as never,
            seed: usedSeed(),
            meta: { cwd: probeRoot },
            agentOptions: { provider: 'mock', model: 'm' },
          })
        }, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: high }),
      )
      await deliver({ eventId: 'ev_use_web_owned', text: '/use web-owned-live' })
      await deliver({ text: '继续已有会话' })

      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.reasoningEffort).toBe(max)
    })
  })

  describe('M7.3: /status model selection reporting', () => {
    const high = ReasoningEffortId('high')
    const max = ReasoningEffortId('max')
    const reasoningInfo = {
      efforts: [
        { id: high, name: 'High' },
        { id: max, name: 'Max' },
      ],
      defaultEffort: max,
    }
    const defaultSelection = () => ({ provider: 'mock', model: 'm', reasoningEffort: high })

    it('unbound: reports the new-session default with its source', async () => {
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([], reasoningInfo), { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined, defaultSelection,
      )
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('未绑定会话')
      expect(text).toContain('新会话默认：mock/m（档位：High）')
      expect(text).toContain('来源：Web GUI 设置')
    })

    it('configured override: default line carries the deployment source and unspecified effort', async () => {
      const { feishu, deliver } = await mountBridge(new MockAdapter([]))
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('新会话默认：mock/m（档位：未指定（模型默认））')
      expect(text).toContain('来源：部署配置')
    })

    it('bridge-owned binding: reports current value, default, and the restart caveat', async () => {
      const adapter = new MockAdapter([], reasoningInfo)
      const { feishu, deliver } = await mountBridge(
        adapter, { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined, defaultSelection,
      )
      await deliver({ text: '/new' })
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('当前会话：mock/m（档位：High）')
      expect(text).toContain('新会话默认：mock/m（档位：High）')
      expect(text).toContain('重启后临时切换会丢失')
    })

    it('existing (live Web-owned): defers the current value to Web', async () => {
      const probeRoot = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
      dirs.push(probeRoot)
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([], reasoningInfo),
        { agentProvider: undefined, agentModel: undefined },
        probeRoot, undefined, async (ctx) => {
          await ctx.agents.create({
            sessionId: 'web-owned-status' as never,
            seed: usedSeed(),
            meta: { cwd: probeRoot },
            agentOptions: { provider: 'mock', model: 'm' },
          })
        }, undefined, defaultSelection,
      )
      await deliver({ eventId: 'ev_use_status_web', text: '/use web-owned-status' })
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('以 Web 端为准')
      expect(text).toContain('新会话默认：mock/m（档位：High）')
    })

    it('cold bound session: reports inactive and that resume adopts the default', async () => {
      // A session only exists across restarts once it has a durable event log
      // (upstream persistence materializes lazily on first append), so give
      // the /new session one turn before disposing the first process.
      const first = await mountBridge(
        new MockAdapter([textResponse('第一条消息的回复')], reasoningInfo),
        { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined, defaultSelection,
      )
      await first.deliver({ text: '/new' })
      await first.deliver({ text: '先聊一句让会话落盘' })
      await first.ctx.fiber.dispose()

      const second = await mountBridge(
        new MockAdapter([], reasoningInfo),
        { agentProvider: undefined, agentModel: undefined },
        first.root, undefined, undefined, undefined, defaultSelection,
      )
      // Unique wire ids: the second process's counter restarts, and the first
      // process's rows are already in the durable inbound table.
      await second.deliver({ eventId: 'ev_status_cold', messageId: 'om_status_cold', text: '/status' })
      // Startup recovery may replay the prior turn's terminal card; the
      // /status reply is not necessarily the last send, so scan for it.
      const texts = second.feishu.sent.map(send => send.text)
      expect(texts.some(text => text.includes('未激活'))).toBe(true)
      expect(texts.some(text => text.includes('新会话默认：mock/m（档位：High）'))).toBe(true)
    })

    it('resolveModelInfo failure falls back to the raw effort id with a marker', async () => {
      const adapter = new MockAdapter([], reasoningInfo)
      const { feishu, deliver } = await mountBridge(
        adapter, { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined, defaultSelection,
      )
      adapter.failResolveModel = true
      await deliver({ text: '/new' })
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('档位：high（元数据不可用）')
      adapter.failResolveModel = false
    })
  })

  describe('M7.2: /effort switching', () => {
    const high = ReasoningEffortId('high')
    const max = ReasoningEffortId('max')
    const reasoningInfo = {
      efforts: [
        { id: high, name: 'High' },
        { id: max, name: 'Max' },
      ],
      defaultEffort: max,
    }
    const defaultSelection = () => ({ provider: 'mock', model: 'm', reasoningEffort: high })
    const mountEffort = (adapter: MockAdapter, configOverrides: object = {}, configureContext?: (ctx: Context) => void | Promise<void>) =>
      mountBridge(
        adapter, { agentProvider: undefined, agentModel: undefined, ...configOverrides },
        undefined, undefined, configureContext, undefined, defaultSelection,
      )

    it('rejects without a binding', async () => {
      const { feishu, deliver } = await mountEffort(new MockAdapter([], reasoningInfo))
      await deliver({ text: '/effort max' })
      expect(feishu.sent.at(-1)!.text).toContain('未绑定')
    })

    it('rejects a non-boundBy allowlisted sender', async () => {
      const { feishu, deliver } = await mountEffort(
        new MockAdapter([], reasoningInfo), { allowedOpenIds: [OWNER, OTHER] },
      )
      await deliver({ text: '/new' })
      await deliver({ senderOpenId: OTHER, text: '/effort max' })
      expect(feishu.sent.at(-1)!.text).toContain('绑定者')
    })

    it('rejects on a live Web-owned existing session without installing a ref', async () => {
      // probeRoot doubles as the bridge root so the Web-created agent's cwd
      // stays inside allowedWorkspaces (same pattern as the M7.3 test).
      const probeRoot = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
      dirs.push(probeRoot)
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([], reasoningInfo),
        { agentProvider: undefined, agentModel: undefined },
        probeRoot, undefined, async (ctx) => {
          await ctx.agents.create({
            sessionId: 'web-owned-effort' as never,
            seed: usedSeed(),
            meta: { cwd: probeRoot },
            agentOptions: { provider: 'mock', model: 'm' },
          })
        }, undefined, defaultSelection,
      )
      await deliver({ eventId: 'ev_use_effort_web', text: '/use web-owned-effort' })
      await deliver({ text: '/effort max' })
      expect(feishu.sent.at(-1)!.text).toContain('Web 端')
    })

    it('rejects on a cold bound session without resuming it', async () => {
      const first = await mountEffort(new MockAdapter([textResponse('让会话落盘')], reasoningInfo))
      await first.deliver({ text: '/new' })
      await first.deliver({ text: '先聊一句' })
      const binding = first.ctx.storageDomain.get('feishu_bot')!.table('bindings')
        .get('oc_chat_1') as { sessionId: string }
      await first.ctx.fiber.dispose()

      const cold = await mountBridge(
        new MockAdapter([], reasoningInfo),
        { agentProvider: undefined, agentModel: undefined },
        first.root, undefined, undefined, undefined, defaultSelection,
      )
      await cold.deliver({ eventId: 'ev_effort_cold', messageId: 'om_effort_cold', text: '/effort max' })
      const texts = cold.feishu.sent.map(send => send.text)
      expect(texts.some(text => text.includes('未激活'))).toBe(true)
      // The binding is cold: /effort must not have resumed any agent.
      expect(cold.ctx.agents.get(binding.sessionId as never)).toBeUndefined()
    })

    it('a legal switch takes effect on the next request', async () => {
      const adapter = new MockAdapter([textResponse('档位切换后的回答')], reasoningInfo)
      const { feishu, deliver } = await mountEffort(adapter)
      await deliver({ text: '/new' })
      await deliver({ text: '/effort max' })
      expect(feishu.sent.at(-1)!.text).toContain('下一轮生效')
      await deliver({ text: '测试档位' })
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]!.reasoningEffort).toBe(max)
      await deliver({ text: '/status' })
      expect(feishu.sent.at(-1)!.text).toContain('当前会话：mock/m（档位：Max）')
    })

    it('an illegal effort echoes the legal set and leaves the selection unchanged', async () => {
      const adapter = new MockAdapter([textResponse('未切换的回答')], reasoningInfo)
      const { feishu, deliver } = await mountEffort(adapter)
      await deliver({ text: '/new' })
      await deliver({ text: '/effort bogus' })
      const reply = feishu.sent.at(-1)!.text
      expect(reply).toContain('非法档位')
      expect(reply).toContain('high')
      expect(reply).toContain('max')
      await deliver({ text: '测试档位' })
      expect(adapter.requests[0]!.reasoningEffort).toBe(high)
    })

    it('metadata failure leaves the selection untouched', async () => {
      const adapter = new MockAdapter([textResponse('未修改的回答')], reasoningInfo)
      const { feishu, deliver } = await mountEffort(adapter)
      await deliver({ text: '/new' })
      adapter.failResolveModel = true
      await deliver({ text: '/effort max' })
      expect(feishu.sent.at(-1)!.text).toContain('未修改')
      // Reset before the text turn: request routing itself resolves model
      // metadata, so the flag would fail the whole turn otherwise.
      adapter.failResolveModel = false
      await deliver({ text: '测试档位' })
      expect(adapter.requests[0]!.reasoningEffort).toBe(high)
    })

    it('a route without reasoning metadata rejects the switch', async () => {
      const adapter = new MockAdapter([], undefined)
      const { feishu, deliver } = await mountEffort(adapter)
      await deliver({ text: '/new' })
      await deliver({ text: '/effort high' })
      expect(feishu.sent.at(-1)!.text).toContain('不提供可选档位')
    })
  })

  describe('S4: adversarial markdown escaping on text paths', () => {
    const hostileEfforts = (): LlmModelReasoningInfo => ({
      efforts: [
        { id: ReasoningEffortId('high'), name: 'High[1](快)' },
        { id: ReasoningEffortId('max'), name: 'Max**强**' },
      ],
      defaultEffort: ReasoningEffortId('max'),
    })

    it('/status escapes adapter-supplied effort names', async () => {
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([], hostileEfforts()),
        { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: ReasoningEffortId('high') }),
      )
      await deliver({ text: '/new' })
      await deliver({ text: '/status' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('档位：High\\[1\\]\\(快\\)')
      expect(text).not.toContain('档位：High[1](快)')
    })

    it('/effort echoes an illegal adversarial id escaped and leaves the choice intact', async () => {
      const adapter = new MockAdapter([], hostileEfforts())
      const { feishu, deliver } = await mountBridge(
        adapter, { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: ReasoningEffortId('high') }),
      )
      await deliver({ text: '/new' })
      await deliver({ text: '/effort h[i](x)' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('非法档位 "h\\[i\\]\\(x\\)"')
      expect(text).toContain('high（High\\[1\\]\\(快\\)）')
    })

    it('/effort success escapes the adapter-supplied display name', async () => {
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([], hostileEfforts()),
        { agentProvider: undefined, agentModel: undefined },
        undefined, undefined, undefined, undefined,
        () => ({ provider: 'mock', model: 'm', reasoningEffort: ReasoningEffortId('high') }),
      )
      await deliver({ text: '/new' })
      await deliver({ text: '/effort max' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('已选择档位：Max\\*\\*强\\*\\*')
      expect(text).not.toContain('已选择档位：Max**强**')
    })

    it('/ls text fallback escapes adversarial session titles', async () => {
      const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
      ctx.sessions.create('hostile-title' as never, {
        seed: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'session/title', seq: 1, time: 2, data: { title: '恶意[标题](链接)' } },
        ] as never,
        meta: { cwd: root },
      })
      feishu.nextSessionListCardError = Object.assign(
        new Error('simulated session-list card failure'), { feishuFailureKind: 'permanent' },
      )
      await deliver({ text: '/ls' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('恶意\\[标题\\]\\(链接\\)')
      expect(text).not.toContain('恶意[标题](链接)')
    })

    it('/unknown echoes the adversarial command name escaped', async () => {
      const { feishu, deliver } = await mountBridge(new MockAdapter([]))
      await deliver({ text: '/h[1](x)' })
      const text = feishu.sent.at(-1)!.text
      expect(text).toContain('未知命令 /h\\[1\\]\\(x\\)')
      expect(text).not.toContain('未知命令 /h[1](x)')
    })
  })

  describe('M7.1: /model three-layer card', () => {
    const high = ReasoningEffortId('high')
    const max = ReasoningEffortId('max')
    const reasoningHighMax = { efforts: [{ id: high, name: 'High' }, { id: max, name: 'Max' }], defaultEffort: max }
    const reasoningMaxOnly = { efforts: [{ id: max, name: 'Max' }], defaultEffort: max }
    const defaultSelection = () => ({ provider: 'mock', model: 'm', reasoningEffort: high })
    const mountModel = (adapter: MockAdapter, overrides: object = {}, configureContext?: (ctx: Context) => void | Promise<void>) =>
      mountBridge(
        adapter, { agentProvider: undefined, agentModel: undefined, ...overrides },
        undefined, undefined, configureContext, undefined, defaultSelection,
      )

    it('rejects without a binding', async () => {
      const { feishu, deliver } = await mountModel(new MockAdapter([]))
      await deliver({ text: '/model' })
      expect(feishu.sent.at(-1)!.text).toContain('未绑定')
    })

    it('rejects a non-boundBy allowlisted sender', async () => {
      const { feishu, deliver } = await mountModel(
        new MockAdapter([]), { allowedOpenIds: [OWNER, OTHER] },
      )
      await deliver({ text: '/new' })
      await deliver({ senderOpenId: OTHER, text: '/model' })
      expect(feishu.sent.at(-1)!.text).toContain('绑定者')
    })

    it('rejects on a live Web-owned existing session', async () => {
      const probeRoot = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
      dirs.push(probeRoot)
      const { feishu, deliver } = await mountBridge(
        new MockAdapter([]),
        { agentProvider: undefined, agentModel: undefined },
        probeRoot, undefined, async (ctx) => {
          await ctx.agents.create({
            sessionId: 'web-owned-model' as never,
            seed: usedSeed(),
            meta: { cwd: probeRoot },
            agentOptions: { provider: 'mock', model: 'm' },
          })
        }, undefined, defaultSelection,
      )
      await deliver({ eventId: 'ev_use_model_web', text: '/use web-owned-model' })
      await deliver({ text: '/model' })
      expect(feishu.sent.at(-1)!.text).toContain('Web 端')
    })

    it('rejects on a cold bound session without resuming it', async () => {
      const first = await mountModel(new MockAdapter([textResponse('让会话落盘')]))
      await first.deliver({ text: '/new' })
      await first.deliver({ text: '先聊一句' })
      const binding = first.ctx.storageDomain.get('feishu_bot')!.table('bindings')
        .get('oc_chat_1') as { sessionId: string }
      await first.ctx.fiber.dispose()

      const cold = await mountBridge(
        new MockAdapter([]),
        { agentProvider: undefined, agentModel: undefined },
        first.root, undefined, undefined, undefined, defaultSelection,
      )
      await cold.deliver({ eventId: 'ev_model_cold', messageId: 'om_model_cold', text: '/model' })
      const texts = cold.feishu.sent.map(send => send.text)
      expect(texts.some(text => text.includes('未激活'))).toBe(true)
      expect(cold.ctx.agents.get(binding.sessionId as never)).toBeUndefined()
    })

    it('navigates provider → model → effort and applies on the next request', { timeout: 20_000 }, async () => {
      const adapter = new MockAdapter([textResponse('切换后回答')])
      adapter.reasoningByModel = { m: reasoningHighMax, m2: reasoningMaxOnly }
      adapter.models = [
        { provider: 'mock', id: 'm2', name: '模型二' },
        { provider: 'mock', id: 'm', name: '模型一' },
      ]
      const { feishu, deliver } = await mountModel(adapter)
      await deliver({ text: '/new' })
      await deliver({ text: '/model' })

      const providerCard = feishu.cards.at(-1)!
      expect(JSON.stringify(providerCard.card)).toContain('选择模型')
      await feishu.clickCard(OWNER, providerCard.messageId, cardButtonValue(providerCard.card, '1. mock'))

      const modelCard = feishu.cards.at(-1)!
      expect(JSON.stringify(modelCard.card)).toContain('模型二')
      await feishu.clickCard(OWNER, modelCard.messageId, cardButtonValue(modelCard.card, '选择此模型'))

      const effortCard = feishu.cards.at(-1)!
      expect(JSON.stringify(effortCard.card)).toContain('选择档位')
      // Current effort (high) is invalid on m2 → no keep-current button.
      expect(JSON.stringify(effortCard.card)).not.toContain('保持当前')
      await feishu.clickCard(OWNER, effortCard.messageId, cardButtonValue(effortCard.card, 'Max'))

      const statusCard = feishu.cards.at(-1)!
      expect(JSON.stringify(statusCard.card)).toContain('模型已切换')
      await deliver({ text: '切换后测试' })
      expect(adapter.requests.at(-1)).toMatchObject({
        provider: 'mock', model: 'm2', reasoningEffort: max,
      })
    })

    it('applies directly with cleared effort when the route has no reasoning metadata', { timeout: 20_000 }, async () => {
      const adapter = new MockAdapter([textResponse('无档位回答')])
      adapter.reasoningByModel = { m: reasoningHighMax, plain: undefined }
      adapter.models = [{ provider: 'mock', id: 'plain', name: 'Plain 模型' }]
      const { feishu, deliver } = await mountModel(adapter)
      await deliver({ text: '/new' })
      await deliver({ text: '/model' })

      const providerCard = feishu.cards.at(-1)!
      await feishu.clickCard(OWNER, providerCard.messageId, cardButtonValue(providerCard.card, '1. mock'))
      const modelCard = feishu.cards.at(-1)!
      await feishu.clickCard(OWNER, modelCard.messageId, cardButtonValue(modelCard.card, '选择此模型'))

      const statusCard = feishu.cards.at(-1)!
      expect(JSON.stringify(statusCard.card)).toContain('模型已切换')
      expect(JSON.stringify(statusCard.card)).toContain('档位')
      await deliver({ text: '无档位测试' })
      expect(adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'plain' })
      expect(adapter.requests.at(-1)!.reasoningEffort).toBeUndefined()
    })

    it('catalog failure reports and leaves the switch unmade', { timeout: 20_000 }, async () => {
      const adapter = new MockAdapter([], reasoningHighMax)
      adapter.models = [{ provider: 'mock', id: 'm', name: '模型一' }]
      const { feishu, deliver } = await mountModel(adapter)
      await deliver({ text: '/new' })
      adapter.failListModels = true
      await deliver({ text: '/model' })
      const providerCard = feishu.cards.at(-1)!
      await feishu.clickCard(OWNER, providerCard.messageId, cardButtonValue(providerCard.card, '1. mock'))
      expect(feishu.sent.at(-1)!.text).toContain('模型目录不可用')
      adapter.failListModels = false
    })
  })

  it('result-card creation failure falls back to text without losing the answer', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([textResponse('不能丢失的回答')]))
    await deliver({ text: '/new' })
    feishu.failResultCards = true

    await deliver({ text: '请给出结果' })

    const domain = ctx.storageDomain.get('feishu_bot')!
    const delivery = ctx.storageDomain.get('feishu_bot_delivery')
    expect(delivery).toBeDefined()
    await vi.waitFor(() => {
      expect([...delivery!.table('deliveries').entries()].map(([, row]) => row))
        .toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })])
    }, { timeout: 5_000, interval: 20 })
    expect(feishu.resultCardAttempts).toHaveLength(1)
    expect(feishu.resultCardAttempts[0]).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, wide_screen_mode: true },
      body: {
        direction: 'vertical',
        elements: [
          { tag: 'markdown', content: '**任务已完成 · 最终产出**' },
          { tag: 'markdown', content: '不能丢失的回答' },
        ],
      },
    })
    expect(feishu.resultCardAttempts[0]).not.toHaveProperty('elements')
    expect(feishu.sent.filter(message => message.text === '不能丢失的回答')).toHaveLength(1)
    const rows = [...delivery!.table('deliveries').entries()]
      .map(([, row]) => row as { status: string; text: string; attempts: number })
    expect(rows).toEqual([{
      chatId: 'oc_chat_1',
      sessionId: expect.any(String),
      sourceEventSeq: expect.any(Number),
      text: '',
      status: 'sent',
      attempts: 1,
      createdAt: expect.any(Number),
    }])
    expect(domain.table('outbound_segments').size).toBe(0)
  })

  it('keeps an ambiguous result-card timeout pending instead of cross-shape text fallback', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([textResponse('只允许同形态重试')]))
    await deliver({ text: '/new' })
    feishu.resultCardError = Object.assign(new Error('socket timeout after write'), { code: 'ETIMEDOUT' })

    await deliver({ text: '触发不确定发送结果' })

    const delivery = ctx.storageDomain.get('feishu_bot_delivery')
    expect(delivery).toBeDefined()
    await vi.waitFor(() => {
      expect(delivery!.table('deliveries').size).toBe(1)
    }, { timeout: 5_000, interval: 20 })
    expect(feishu.sent.some(message => message.text === '只允许同形态重试')).toBe(false)
    expect(feishu.resultCardAttempts).toHaveLength(1)
    expect(feishu.resultCardAttempts[0]).toMatchObject({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown' }, { tag: 'markdown', content: '只允许同形态重试' }] },
    })
    const rows = [...delivery!.table('deliveries').entries()]
      .map(([, row]) => row as { status: string; text: string })
    expect(rows).toEqual([expect.objectContaining({ status: 'pending', text: '只允许同形态重试' })])
  })

  it('retries a pending canonical result before a later task can pass it', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([
      textResponse('必须先送达的第一项结果'),
      textResponse('只能排在后面的第二项结果'),
    ]))
    await deliver({ text: '/new' })
    feishu.nextResultCardError = Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' })

    await deliver({ text: '第一项任务' })

    const delivery = ctx.storageDomain.get('feishu_bot_delivery')!
    expect([...delivery.table('deliveries').entries()].map(([, row]) => row))
      .toEqual([expect.objectContaining({ status: 'pending', text: '必须先送达的第一项结果', attempts: 1 })])

    await deliver({ text: '第二项任务' })

    await vi.waitFor(() => {
      const rows = [...delivery.table('deliveries').entries()]
        .map(([, row]) => row as { status: string })
      expect(rows).toHaveLength(2)
      expect(rows.every(row => row.status === 'sent')).toBe(true)
    }, { timeout: 2_000, interval: 20 })
    const resultCards = feishu.cards
      .filter(({ card }) => JSON.stringify(card).includes('最终结果'))
      .map(({ card }) => JSON.stringify(card))
    expect(resultCards).toHaveLength(2)
    expect(resultCards[0]).toContain('必须先送达的第一项结果')
    expect(resultCards[1]).toContain('只能排在后面的第二项结果')
  })

  it('keeps an older chat delivery ahead of results from a newly bound session', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(
      new MockAdapter([textResponse('新绑定会话的结果')]),
    )
    await deliver({ text: '/new' })
    const original = ctx.storageDomain.get('feishu_bot')!.table('bindings')
      .get('oc_chat_1') as { sessionId: string }
    const nextSessionId = 'canonical-fifo-next-session'
    const next = await ctx.agents.create({
      sessionId: nextSessionId as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.sessions.flush(next.agent.session)
    const deliveries = ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries')
    const olderKey = JSON.stringify(['oc_chat_1', original.sessionId, 50, 'result'])
    await deliveries.put(olderKey, {
      chatId: 'oc_chat_1', sessionId: original.sessionId, sourceEventSeq: 50,
      text: '旧绑定尚未送达的结果', status: 'pending', attempts: 0,
      createdAt: Date.now() - 1_000,
    })
    await deliver({ text: `/use ${nextSessionId}` })
    feishu.nextResultCardError = Object.assign(new Error('timeout after write'), {
      code: 'ETIMEDOUT',
    })

    await deliver({ text: '运行新绑定会话任务' })

    expect(feishu.resultCardAttempts).toHaveLength(1)
    expect(JSON.stringify(feishu.resultCardAttempts[0])).toContain('旧绑定尚未送达的结果')
    expect(deliveries.get(olderKey)).toMatchObject({ status: 'pending', attempts: 1 })
    expect([...deliveries.entries()].map(([, row]) => row)).toHaveLength(1)
  })

  it('keeps canonical delivery storage within its hard capacity', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('等待容量释放后再投影')]),
      { deliveryMaxRecords: 0 },
    )
    await deliver({ text: '/new' })
    await deliver({ text: '触发容量背压' })

    expect(ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').size).toBe(0)
    expect(feishu.cards.some(card => JSON.stringify(card.card).includes('等待容量释放后再投影')))
      .toBe(false)
  })

  it('terminal projection uses byte-preflight result-card segments', { timeout: 20_000 }, async () => {
    const answer = 'x'.repeat(30_000)
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([textResponse(answer)]))
    await deliver({ text: '/new' })

    await deliver({ text: '请返回长结果' })

    await vi.waitFor(() => {
      expect(feishu.cards.filter(card => JSON.stringify(card.card).includes('最终结果'))).toHaveLength(2)
    }, { timeout: 5_000, interval: 20 })
    const resultCards = feishu.cards.filter(card => JSON.stringify(card.card).includes('最终结果'))
    expect(resultCards).toHaveLength(2)
    expect(ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').size).toBe(1)
    expect(ctx.storageDomain.get('feishu_bot')!.table('outbound_segments').size).toBe(0)
    for (const result of resultCards) {
      expect(result.card).toMatchObject({
        schema: '2.0',
        config: { update_multi: true, wide_screen_mode: true },
        body: { direction: 'vertical', elements: [{ tag: 'markdown' }, { tag: 'markdown' }] },
      })
      expect(result.card).not.toHaveProperty('elements')
      expect(resultCardEnvelopeBytes('oc_chat_1', result.card as never)).toBeLessThanOrEqual(24 * 1_024)
    }
  })

  it('task card projects turn progress and freezes at completion (M2)', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([textResponse('答复')]))
    await deliver({ text: '/new' })
    await deliver({ text: '跑个任务' })
    // The turn produced a card (turn/start schedules, turn/end freezes).
    expect(feishu.cards.length).toBeGreaterThan(0)
    expect(feishu.cards.some(card => JSON.stringify(card.card).includes('已完成'))).toBe(true)
  })

  it('starts a fresh task card and result for the next direct Feishu message', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([
      textResponse('第一项结果'),
      textResponse('第二项结果'),
    ]))
    await deliver({ text: '/new' })
    await deliver({ text: '第一项任务' })
    await deliver({ text: '第二项任务' })

    const taskCards = feishu.cards.filter(({ card }) => {
      const json = JSON.stringify(card)
      return !json.includes('最终结果') && (json.includes('思考中')
        || json.includes('已完成') || json.includes('任务失败'))
    })
    const resultCards = feishu.cards.filter(({ card }) =>
      JSON.stringify(card).includes('最终结果'))
    expect(new Set(taskCards.map(card => card.messageId)).size).toBe(2)
    expect(new Set(resultCards.map(card => card.messageId)).size).toBe(2)
    expect(ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').size).toBe(2)
  })

  it('steers supplementary Feishu input into the active task instead of queueing another turn', { timeout: 20_000 }, async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    const agent = [...ctx.sessions.list()].map(session => ctx.agents.get(session.id)).find(Boolean)!
    await deliver({ text: '开始长任务' })
    await vi.waitFor(() => {
      if (agent.status !== 'running') throw new Error('agent not running')
    })
    const steer = vi.spyOn(agent, 'steer')
    const followup = vi.spyOn(agent, 'followup')

    await deliver({ text: '补充引导：优先处理审批收纳' })

    expect(steer).toHaveBeenCalledTimes(1)
    expect(followup).not.toHaveBeenCalled()
  })
  it('projects a Web-origin task to the currently bound Feishu chat', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('Web 任务最终结果')]),
    )
    await deliver({ text: '/new' })
    const agent = [...ctx.sessions.list()]
      .map(session => ctx.agents.get(session.id))
      .find(candidate => candidate !== undefined)!

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '从 Web 发起任务' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    await agent.whenIdle()
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) =>
        JSON.stringify(card).includes('Web 任务最终结果'))) {
        throw new Error('bound Web task result has not reached Feishu yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const taskCards = feishu.cards.filter(({ card }) => {
      const json = JSON.stringify(card)
      return !json.includes('最终结果') && (json.includes('思考中')
        || json.includes('已完成') || json.includes('任务失败'))
    })
    const resultCards = feishu.cards.filter(({ card }) =>
      JSON.stringify(card).includes('最终结果'))
    expect(new Set(taskCards.map(card => card.messageId)).size).toBe(1)
    expect(new Set(resultCards.map(card => card.messageId)).size).toBe(1)
    expect(JSON.stringify(resultCards.at(-1)?.card)).toContain('Web 任务最终结果')
    expect(ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').size).toBe(1)
  })

  it('collapses one Feishu task with subagent continuation turns into one task card and one final result', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver, drain } = await mountBridge(
      new MockAdapter([]),
      { cardThrottleMs: 0 },
    )
    await deliver({ text: '/new' })
    const session = ctx.sessions.list()[0]!
    const append = session.append.bind(session) as unknown as (
      type: string, data: unknown, intent?: { surfaceOp?: 'append' },
    ) => unknown
    const user = (source: unknown) => createUserMessage({
      content: [{ type: 'text', text: 'fixture text is never asserted or logged' }],
      source: source as never,
    })
    const assistant = (turn: number, step: number, content: unknown[]) => ({
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: content as never,
        source: { kind: 'model', provider: 'mock', model: 'm' },
      }),
    })

    append('turn/start', { turn: 1 })
    append('user/message', user({ kind: 'user', via: 'feishu' }), { surfaceOp: 'append' })
    append('assistant/message', assistant(1, 1, [
      { type: 'text', text: '中间说明不应成为结果卡' },
      { type: 'tool-call', id: 'call-root', name: 'run_code', arguments: '{}' },
    ]), { surfaceOp: 'append' })
    append('tool/code-dispatch', {
      rootCallId: 'call-root', parentCallId: 'call-root', subCallId: 'spawn-a',
      name: 'subagent', arguments: { run_in_background: true },
      content: [{ type: 'text', text: 'started subagent child-a' }], isError: false,
    })
    append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE', message: 'fixture' } },
    })

    append('turn/start', { turn: 2 })
    append('user/message', user({
      kind: 'subagent-report', form: 'relay', senderSessionId: 'child-a',
    }), { surfaceOp: 'append' })
    append('assistant/message', assistant(2, 1, [
      { type: 'text', text: '内部阶段结果不应新增消息' },
    ]), { surfaceOp: 'append' })
    append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    append('turn/start', { turn: 3 })
    append('user/message', user({
      kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-a',
    }), { surfaceOp: 'append' })
    append('assistant/message', assistant(3, 1, [
      { type: 'text', text: '任务最终结果' },
    ]), { surfaceOp: 'append' })
    append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await drain()

    const taskCards = feishu.cards.filter(({ card }) => {
      const json = JSON.stringify(card)
      return !json.includes('最终结果') && (json.includes('思考中')
        || json.includes('已完成') || json.includes('任务失败'))
    })
    const resultCards = feishu.cards.filter(({ card }) =>
      JSON.stringify(card).includes('最终结果'))
    expect(new Set(taskCards.map(card => card.messageId)).size).toBe(1)
    expect(new Set(resultCards.map(card => card.messageId)).size).toBe(1)
    expect(JSON.stringify(resultCards.at(-1)?.card)).toContain('任务最终结果')
    expect(JSON.stringify(resultCards)).not.toContain('中间说明不应成为结果卡')
    expect(ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').size).toBe(1)
  })

  it('serializes a blocked first task-card create with a fast terminal update into one message', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(
      new MockAdapter(['hang']),
      { cardThrottleMs: 10_000 },
    )
    await deliver({ text: '/new' })
    feishu.blockFirstTaskCardCreate = true

    try {
      await deliver({ text: '首张 running 卡发送被阻塞' })
      await vi.waitFor(() => {
        if (feishu.taskCardCreateAttempts.length === 0) throw new Error('task card create not attempted')
      }, { timeout: 5_000, interval: 10 })
      expect(JSON.stringify(feishu.taskCardCreateAttempts[0])).toContain('思考中')
      await deliver({ text: '/stop' })
      expect(feishu.taskCardCreateAttempts).toHaveLength(1)
    } finally {
      feishu.releaseTaskCardCreate()
    }
    await vi.waitFor(() => {
      const taskCards = feishu.cards.filter(({ card }) => {
        const json = JSON.stringify(card)
        return json.includes('思考中') || json.includes('已完成')
          || json.includes('已停止') || json.includes('任务失败')
      })
      expect(JSON.stringify(taskCards.at(-1)?.card)).toContain('已停止')
      expect(new Set(taskCards.map(({ messageId }) => messageId)).size).toBe(1)
      expect(feishu.taskCardCreateAttempts).toHaveLength(1)
    }, { timeout: 5_000, interval: 10 })
  })

  it('drains an accepted task-card actor before closing bridge domains', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(
      new MockAdapter([textResponse('快速完成')]),
      { cardThrottleMs: 0 },
    )
    await mounted.deliver({ text: '/new' })
    mounted.feishu.blockFirstTaskCardCreate = true
    await mounted.deliver({ text: '完成但暂时阻塞任务卡发送' })
    await vi.waitFor(() => {
      expect(mounted.feishu.taskCardCreateAttempts).toHaveLength(1)
    }, { timeout: 5_000, interval: 10 })

    const disposing = mounted.bridgeFiber.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(disposed).toBe(false)
      expect(mounted.ctx.storageDomain.get('feishu_bot')).toBeDefined()
      expect(mounted.ctx.storageDomain.get('feishu_bot_delivery')).toBeDefined()
    } finally {
      mounted.feishu.releaseTaskCardCreate()
      await disposing
    }
    expect(mounted.ctx.storageDomain.get('feishu_bot')).toBeUndefined()
    expect(mounted.ctx.storageDomain.get('feishu_bot_delivery')).toBeUndefined()
  })

  it('bounds bridge drain when an accepted task-card transport never settles', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(
      new MockAdapter([textResponse('快速完成')]),
      { cardThrottleMs: 0, disposeDrainTimeoutMs: 20 },
    )
    await mounted.deliver({ text: '/new' })
    mounted.feishu.blockFirstTaskCardCreate = true
    await mounted.deliver({ text: '阻塞卡片直到关闭期限' })
    await vi.waitFor(() => {
      expect(mounted.feishu.taskCardCreateAttempts).toHaveLength(1)
    }, { timeout: 5_000, interval: 10 })

    const disposing = mounted.bridgeFiber.dispose()
    try {
      await expect(Promise.race([
        disposing.then(() => 'disposed' as const),
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 250)),
      ])).resolves.toBe('disposed')
      expect(mounted.ctx.storageDomain.get('feishu_bot')).toBeUndefined()
      expect(mounted.ctx.storageDomain.get('feishu_bot_delivery')).toBeUndefined()
    } finally {
      mounted.feishu.releaseTaskCardCreate()
      await disposing
    }
  })

  it('leaves a timed-out canonical delivery durable without writing after domain close', { timeout: 20_000 }, async () => {
    const first = await mountBridge(
      new MockAdapter([textResponse('关闭后由重启恢复的结果')]),
      { cardThrottleMs: 0, disposeDrainTimeoutMs: 20 },
    )
    await first.deliver({ text: '/new' })
    first.feishu.blockFirstResultCardCreate = true
    await first.deliver({ text: '阻塞最终结果发送' })
    await vi.waitFor(() => {
      expect(first.feishu.resultCardAttempts).toHaveLength(1)
    }, { timeout: 5_000, interval: 10 })

    await first.bridgeFiber.dispose()
    expect(first.ctx.storageDomain.get('feishu_bot_delivery')).toBeUndefined()
    first.feishu.releaseResultCardCreate()
    await vi.waitFor(() => {
      expect(first.feishu.cards.some(card =>
        JSON.stringify(card.card).includes('关闭后由重启恢复的结果'))).toBe(true)
    }, { timeout: 5_000, interval: 10 })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    let rows: { status: string; text: string; attempts: number }[] = []
    await vi.waitFor(() => {
      expect(second.feishu.cards.some(card =>
        JSON.stringify(card.card).includes('关闭后由重启恢复的结果'))).toBe(true)
      rows = [...second.ctx.storageDomain.get('feishu_bot_delivery')!
        .table('deliveries').entries()].map(([, row]) => row as {
          status: string; text: string; attempts: number
        })
      expect(rows).toEqual([expect.objectContaining({
        status: 'sent', text: '', attempts: 2,
      })])
    }, { timeout: 5_000, interval: 10 })
    expect(rows).toEqual([expect.objectContaining({
      status: 'sent', text: '', attempts: 2,
    })])
  })

  it('/stop without a running task reports idle; without a binding reports unbound (M2)', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/stop' })
    expect(feishu.sent.at(-1)!.text).toContain('没有绑定')
    await deliver({ text: '/new' })
    await deliver({ text: '/stop' })
    expect(feishu.sent.at(-1)!.text).toContain('没有在执行')
  })

  it('/stop during a hung turn freezes the card as stopped (M2)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '开始一个会卡住的任务' })
    await deliver({ text: '/stop' })
    expect(feishu.sent.at(-1)!.text).toContain('已请求停止')
    // The abort terminal (turn/end aborted) renders the frozen stopped card.
    await vi.waitFor(() => {
      const last = feishu.cards.at(-1)
      if (last === undefined || !JSON.stringify(last.card).includes('已停止')) {
        throw new Error('stopped card not rendered yet')
      }
    }, { timeout: 10_000, interval: 100 })
    void ctx
  })

  it('approval plan α: card click allow resolves the request; card freezes (M3)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '触发一个长任务' })   // turn opens and hangs
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Bash', reason: '要执行危险命令' })
    // The bridge's prepended listener pairs the asked event and sends a card.
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const value = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]
    expect(value).toBeDefined()
    const toast = await feishu.clickCard(OWNER, sent.messageId, { pendingId: value, action: 'allow' })
    expect(toast?.toast).toContain('已允许')
    expect(await outcome).toBe('allowed-once')
    // The pending card froze into the decided state.
    const frozen = feishu.cards.at(-1)!
    expect(JSON.stringify(frozen.card)).toContain('已允许')
  })

  it('marks the Feishu card decided-elsewhere when another answerer decides first', { timeout: 20_000 }, async () => {
    // The Web GUI registers its own answerer on the SAME `approval/request`
    // waterfall, so a session bound to Feishu shows a dialog in BOTH
    // frontends. The bridge delegates via next() and races the two; when the
    // Web answers first the Feishu card must freeze as decided-elsewhere
    // rather than stay clickable. This ordering had no test at all.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-elsewhere-1' as never,
      toolName: 'Bash',
    })
    // Stands in for the Web GUI: sits after the bridge (registered first with
    // prepend) and answers as soon as the bridge delegates to it.
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    const outcome = await ctx.approval.request({ agent, toolName: 'Bash' })
    expect(outcome).toBe('allowed-once')

    await vi.waitFor(() => {
      expect(JSON.stringify(feishu.cards.at(-1)?.card)).toContain('已在别处决定')
    }, { timeout: 5_000, interval: 20 })
    // Bounded wait instead of an immediate read: the row delete is backgrounded.
    let size = -1
    try {
      await vi.waitFor(() => {
        size = ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size
        if (size !== 0) throw new Error(`pending_cards still ${size}`)
      }, { timeout: 5_000, interval: 50 })
    } catch {
      throw new Error(`LEAK CONFIRMED: pending_cards=${size} after 5s`)
    }
  })

  it('settles the bridge approval waterfall as cancelled when a visible ask aborts', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-abort-visible' as never,
      toolName: 'Bash',
    })
    const controller = new AbortController()
    const outcome = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Bash', signal: controller.signal },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    controller.abort()

    await expect(Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 500)),
    ])).resolves.toBe('cancelled')
    await vi.waitFor(() => {
      expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(0)
      expect(JSON.stringify(feishu.cards.at(-1)?.card)).toContain('已撤回')
    }, { timeout: 2_000, interval: 20 })
  })

  it('clicking a card whose request aborted answers stale, not decided-elsewhere-by-a-human', { timeout: 20_000 }, async () => {
    // The reported symptom: a Feishu approval said "已在别处决定" although the
    // user decided NOWHERE, leaving the channel stuck until someone clicked in
    // the Web GUI. A withdrawn item (aborted tool signal) is settled, so a
    // later click on its card must be reported as stale rather than as another
    // human having decided elsewhere.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', { id: 'stale-click-1' as never, toolName: 'Bash' })
    const controller = new AbortController()
    const outcome = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Bash', signal: controller.signal },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    // The tool call goes away (turn end / interruption) with no human decision.
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')

    // The card must show withdrawn, NOT decided-elsewhere: nobody decided.
    await vi.waitFor(() => {
      const last = JSON.stringify(feishu.cards.at(-1)?.card)
      expect(last).toContain('已撤回')
    }, { timeout: 5_000, interval: 20 })
    expect(JSON.stringify(feishu.cards.at(-1)?.card)).not.toContain('已在别处决定')
  })

  it('a click on a withdrawn item reports the real fate instead of a phantom elsewhere', { timeout: 20_000 }, async () => {
    // Reproduces the reported dead end end-to-end: the user clicks 允许 in
    // Feishu after the item already settled for a NON-human reason, and the
    // only feedback is a toast. Whichever branch answers, the toast must not
    // claim a human decided elsewhere, and the click must not be silently
    // dropped: the outcome that unblocked the agent has to be observable.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', { id: 'stale-click-2' as never, toolName: 'Bash' })
    const controller = new AbortController()
    const outcome = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Bash', signal: controller.signal },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const pendingValue = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]
    expect(pendingValue).toBeDefined()

    // Settle it out from under the click, with no human anywhere.
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')

    const result = await feishu.clickCard(OWNER, sent.messageId, {
      pendingId: pendingValue, action: 'allow',
    })
    // Reports the item's real fate (withdrawn), not a phantom human decision.
    expect(result?.toast).toContain('已撤回')
  })

  it('a turn cancelled with an approval pending withdraws it, and the click says 已撤回', { timeout: 20_000 }, async () => {
    // The reported dead end. A tool call passes its execution signal to
    // approval.request(); cancelling the turn (the Web GUI's stop button, an
    // interruption) aborts that signal, so the bridge withdraws the card. A
    // later click used to answer "该审批已失效或已在别处决定", which sent the
    // operator hunting for a decision in the Web GUI that never happened.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', { id: 'cancel-withdrawn-1' as never, toolName: 'Bash' })

    // The signal a real tool call would hand the approval request.
    const toolSignal = new AbortController()
    const outcome = ctx.approval.request({
      agent, toolName: 'Bash', signal: toolSignal.signal,
    })
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const pendingValue = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]
    expect(pendingValue).toBeDefined()

    // Stop the turn while the approval waits: this is what session.cancel()
    // does to the Agent's phase signal, which the tool call inherits.
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    toolSignal.abort(new Error('stopped'))

    await expect(outcome).resolves.toBe('cancelled')
    // The withdraw is published as the group's final, collapsed card. This
    // stub records every card version it is handed, so the earlier
    // "审批请求" snapshot stays in the list; the LAST card is the live one.
    await vi.waitFor(() => {
      const last = JSON.stringify(feishu.cards.filter(
        c => JSON.stringify(c.card).includes('审批'),
      ).at(-1)?.card)
      if (!last.includes('已撤回')) throw new Error(`approval group not withdrawn yet: ${last.slice(0, 200)}`)
    }, { timeout: 5_000, interval: 20 })

    // The click must name the real fate, never a phantom human decision.
    const result = await feishu.clickCard(OWNER, sent.messageId, {
      pendingId: pendingValue, action: 'allow',
    })
    expect(result?.toast).toContain('已撤回')
    expect(result?.toast).not.toContain('已在别处决定')
  })

  it('records a durable audit row naming why a pending approval was withdrawn', { timeout: 20_000 }, async () => {
    // Diagnosis for "Feishu kept saying something was decided elsewhere" was
    // impossible after the fact: the approval audit lines reach ctx.logger
    // only, and log files are not retained. A withdrawn approval must leave a
    // durable row stating WHICH path withdrew it.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', { id: 'audit-withdraw-1' as never, toolName: 'Bash' })

    const toolSignal = new AbortController()
    const outcome = ctx.approval.request({ agent, toolName: 'Bash', signal: toolSignal.signal })
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    toolSignal.abort(new Error('stopped'))
    await expect(outcome).resolves.toBe('cancelled')

    await vi.waitFor(() => {
      const rows = [...ctx.storageDomain.get('feishu_bot_delivery')!.table('approval_audit').entries()]
      const withdrawn = rows.find(([, row]) => (row as { action?: string }).action === 'withdrawn')
      if (withdrawn === undefined) {
        throw new Error(`no withdrawn audit row yet: ${JSON.stringify(rows)}`)
      }
      // The cause must be distinguishable, not just "it ended".
      expect(withdrawn[1]).toMatchObject({ action: 'withdrawn', cause: 'signal-abort' })
    }, { timeout: 5_000, interval: 20 })
  })

  it('records what a click on a withdrawn card landed on, not just that it was refused', { timeout: 20_000 }, async () => {
    // The exact report: the operator clicked a Feishu approval and the answer
    // claimed a decision had been made elsewhere. Afterwards there was no
    // durable trace of WHICH settled state the click hit, so the cause could
    // only be guessed. The row must name the landed-on state and its cause.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', { id: 'audit-click-1' as never, toolName: 'Bash' })

    const toolSignal = new AbortController()
    const outcome = ctx.approval.request({ agent, toolName: 'Bash', signal: toolSignal.signal })
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const pendingValue = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]

    // Withdraw it, then click: the reported dead end.
    toolSignal.abort(new Error('stopped'))
    await expect(outcome).resolves.toBe('cancelled')

    const result = await feishu.clickCard(OWNER, sent.messageId, {
      pendingId: pendingValue, action: 'allow',
    })
    expect(result?.toast).toContain('已撤回')

    await vi.waitFor(() => {
      const rows = [...ctx.storageDomain.get('feishu_bot_delivery')!.table('approval_audit').entries()]
        .map(([, row]) => row as { action?: string; cause?: string })
      const rejected = rows.find(row => row.action === 'click-rejected')
      if (rejected === undefined) throw new Error(`no click-rejected row: ${JSON.stringify(rows)}`)
      // Distinguishes "a human decided elsewhere" from "the tool call went away".
      expect(rejected).toMatchObject({ action: 'click-rejected', cause: 'not-pending' })
    }, { timeout: 5_000, interval: 20 })
  })

  it('does not publish an approval whose signal already aborted before bridge initialization', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-abort-before-init' as never,
      toolName: 'Write',
    })
    const controller = new AbortController()
    controller.abort()

    const outcome = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Write', signal: controller.signal },
      () => Promise.resolve('unavailable' as const),
    )

    await expect(Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 500)),
    ])).resolves.toBe('cancelled')
    expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(0)
    expect(feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))).toBe(false)
  })

  it('compensates an approval aborted while its durable record is being initialized', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const pendingCards = ctx.storageDomain.get('feishu_bot')!.table('pending_cards') as unknown as {
      size: number
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = pendingCards.put.bind(pendingCards)
    let signalPutStarted!: () => void
    const putStarted = new Promise<void>(resolve => { signalPutStarted = resolve })
    let releasePut!: () => void
    const putGate = new Promise<void>(resolve => { releasePut = resolve })
    let signalPutCompleted!: () => void
    const putCompleted = new Promise<void>(resolve => { signalPutCompleted = resolve })
    pendingCards.put = async (key, value) => {
      if ((value as { kind?: string }).kind === 'approval') {
        signalPutStarted()
        await putGate
        await originalPut(key, value)
        signalPutCompleted()
        return
      }
      await originalPut(key, value)
    }
    const controller = new AbortController()
    const outcome = ctx.approval.request({
      agent, toolName: 'Write', reason: '初始化中撤回', signal: controller.signal,
    })
    await putStarted

    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')
    releasePut()
    await putCompleted

    await vi.waitFor(() => {
      expect(pendingCards.size).toBe(0)
      expect(feishu.cards.some(card => JSON.stringify(card.card).includes('初始化中撤回'))).toBe(false)
    }, { timeout: 2_000, interval: 20 })
  })

  it('does not retry an ambiguously-created approval card after aborting its initial send', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-abort-ambiguous-send' as never,
      toolName: 'Bash',
    })
    feishu.blockFirstApprovalCardCreate = true
    feishu.nextApprovalCardError = Object.assign(new Error('timeout after approval card create'), {
      feishuFailureKind: 'ambiguous',
    })
    const controller = new AbortController()
    const outcome = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Bash', signal: controller.signal },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      expect(feishu.approvalCardAttempts).toHaveLength(1)
    }, { timeout: 2_000, interval: 20 })

    controller.abort()
    feishu.releaseApprovalCardCreate()

    await expect(outcome).resolves.toBe('cancelled')
    await vi.waitFor(() => {
      expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(0)
    }, { timeout: 2_000, interval: 20 })
    expect(feishu.approvalCardAttempts).toHaveLength(1)
  })

  it('does not create a second group card after an ambiguous create while another item is pending', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-group-ambiguous-first' as never,
      callId: 'call-group-first',
      toolName: 'Bash',
    })
    feishu.blockFirstApprovalCardCreate = true
    feishu.nextApprovalCardError = Object.assign(new Error('timeout after approval card create'), {
      feishuFailureKind: 'ambiguous',
    })
    const firstController = new AbortController()
    const first = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Bash', callId: 'call-group-first', signal: firstController.signal },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      expect(feishu.approvalCardAttempts).toHaveLength(1)
    }, { timeout: 2_000, interval: 20 })

    agent.session.append('approval/asked', {
      id: 'bridge-group-ambiguous-second' as never,
      callId: 'call-group-second',
      toolName: 'Write',
    })
    const second = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'Write', callId: 'call-group-second' },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(2)
    }, { timeout: 2_000, interval: 20 })

    firstController.abort()
    feishu.releaseApprovalCardCreate()

    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('unavailable')
    await vi.waitFor(() => {
      expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(1)
    }, { timeout: 2_000, interval: 20 })
    expect(feishu.approvalCardAttempts).toHaveLength(1)
    expect([...ctx.storageDomain.get('feishu_bot')!.table('pending_cards').entries()]
      .map(([, row]) => row)).toEqual([expect.objectContaining({
      approvalId: 'bridge-group-ambiguous-second',
      presentation: 'uncertain',
    })])
  })

  it('settles an already-visible approval as unavailable when the bridge is disposed', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver, bridgeFiber } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Bash', reason: 'HMR 前仍待处理' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('HMR 前仍待处理'))) {
        throw new Error('approval card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    await bridgeFiber.dispose()

    await expect(Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 500)),
    ])).resolves.toBe('unavailable')
    expect(JSON.stringify(feishu.cards.at(-1)?.card)).toContain('已失效')
  })

  it('approval: unauthorized clicker is rejected without consuming the pending entry (M3)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Write', reason: 'x' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const value = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!
    const badToast = await feishu.clickCard('ou_intruder', sent.messageId, { pendingId: value, action: 'allow' })
    expect(badToast?.toast).toContain('没有权限')
    // The rightful owner can still decide afterwards.
    const goodToast = await feishu.clickCard(OWNER, sent.messageId, { pendingId: value, action: 'reject' })
    expect(goodToast?.toast).toContain('已拒绝')
    expect(await outcome).toBe('rejected')
  })

  it('approval: forwarded chats and mismatched card messages cannot decide a pending request', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Bash' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const pendingId = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!

    const forwarded = await feishu.clickCard(OWNER, sent.messageId, { pendingId, action: 'allow' }, 'oc_forwarded')
    expect(forwarded?.toast).toContain('不属于')
    await expect(Promise.race([
      outcome.then(() => 'decided'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 20)),
    ])).resolves.toBe('pending')

    const wrongMessage = await feishu.clickCard(OWNER, 'card_forged', { pendingId, action: 'allow' })
    expect(wrongMessage?.toast).toContain('不属于')
    const accepted = await feishu.clickCard(OWNER, sent.messageId, { pendingId, action: 'reject' })
    expect(accepted?.toast).toContain('已拒绝')
    expect(await outcome).toBe('rejected')
  })

  it('approval: a card cannot decide after its chat is rebound to another session', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const original = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent: original, toolName: 'Write', reason: '旧会话审批' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('旧会话审批'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('旧会话审批'))!
    const pendingId = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!

    await deliver({ text: '/new' })
    const toast = await feishu.clickCard(OWNER, sent.messageId, { pendingId, action: 'allow' })
    expect(toast?.toast).toContain('失效')
    await expect(Promise.race([
      outcome.then(() => 'decided'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 20)),
    ])).resolves.toBe('pending')
  })

  it('approval: a JSON-string button value decides the same as an object (M3 fix)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Bash', reason: 'x' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const value = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!
    // Some Feishu clients deliver the button value as a JSON STRING.
    const toast = await feishu.clickCard(OWNER, sent.messageId, JSON.stringify({ pendingId: value, action: 'allow' }))
    expect(toast?.toast).toContain('已允许')
    expect(await outcome).toBe('allowed-once')
  })

  it('approval: an unrecognized click payload replies with a visible toast, never silence (M3 fix)', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new' })
    const toast = await feishu.clickCard(OWNER, 'card_x', 'not-json-at-all')
    expect(toast?.toast).toBeDefined()

    const nullToast = await feishu.clickCard(OWNER, 'card_x', null)
    expect(nullToast?.toast).toBeDefined()
  })

  it('reuses the same approval panel when a follow-up approval arrives after the first decision', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const first = ctx.approval.request({ agent, toolName: 'Bash', reason: '第一步' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('第一步'))) throw new Error('first card missing')
    }, { timeout: 10_000, interval: 50 })
    const firstCard = feishu.cards.at(-1)!
    const firstPending = JSON.parse(JSON.stringify(firstCard.card)).elements
      .flatMap((element: { actions?: Array<{ value?: { pendingId?: string } }> }) => element.actions ?? [])
      .map((button: { value?: { pendingId?: string } }) => button.value?.pendingId)
      .find((pendingId: string | undefined): pendingId is string => pendingId !== undefined)!
    await feishu.clickCard(OWNER, firstCard.messageId, { pendingId: firstPending, action: 'allow' })
    expect(await first).toBe('allowed-once')
    const second = ctx.approval.request({ agent, toolName: 'Write', reason: '第二步' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('第二步'))) throw new Error('second card missing')
    }, { timeout: 10_000, interval: 50 })
    const secondCard = feishu.cards.at(-1)!
    expect(secondCard.messageId).toBe(firstCard.messageId)
    expect(JSON.stringify(secondCard.card)).toContain('✅ 已允许（本次）')
    expect(JSON.stringify(secondCard.card)).toContain('第二步')
    const secondPending = JSON.parse(JSON.stringify(secondCard.card)).elements
      .flatMap((element: { actions?: Array<{ value?: { pendingId?: string } }> }) => element.actions ?? [])
      .map((button: { value?: { pendingId?: string } }) => button.value?.pendingId)
      .find((pendingId: string | undefined): pendingId is string => pendingId !== firstPending)!
    await feishu.clickCard(OWNER, secondCard.messageId, { pendingId: secondPending, action: 'reject' })
    expect(await second).toBe('rejected')
  })

  it('parallel approvals collapse into one group card with per-item buttons (M3 UX)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const first = ctx.approval.request({ agent, toolName: 'Bash', reason: '第一个' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const second = ctx.approval.request({ agent, toolName: 'Write', reason: '第二个' })
    await vi.waitFor(() => {
      const last = feishu.cards.at(-1)
      if (last === undefined || !JSON.stringify(last.card).includes('Write')) throw new Error('no second item yet')
    }, { timeout: 10_000, interval: 50 })
    // Both questions ride ONE message: every card update targets the same id.
    const ids = new Set(feishu.cards.filter(c => JSON.stringify(c.card).includes('审批请求')).map(c => c.messageId))
    expect(ids.size).toBe(1)
    const grouped = feishu.cards.at(-1)!
    const json = JSON.stringify(grouped.card)
    expect(json).toContain('2/2 待处理')
    const pids = [...new Set([...json.matchAll(/"pendingId":"(pc_[^"]+)"/g)].map(m => m[1]!))]
    expect(pids.length).toBe(2)
    // Decide them one by one on the same card.
    const toast1 = await feishu.clickCard(OWNER, grouped.messageId, { pendingId: pids[0], action: 'allow' })
    expect(toast1?.toast).toContain('已允许')
    expect(await first).toBe('allowed-once')
    await vi.waitFor(() => {
      const j = JSON.stringify(feishu.cards.at(-1)!.card)
      if (!j.includes('1/2 待处理')) throw new Error('not re-rendered yet')
    }, { timeout: 10_000, interval: 50 })
    const toast2 = await feishu.clickCard(OWNER, grouped.messageId, { pendingId: pids[1], action: 'reject' })
    expect(toast2?.toast).toContain('已拒绝')
    expect(await second).toBe('rejected')
    await vi.waitFor(() => {
      const j = JSON.stringify(feishu.cards.at(-1)!.card)
      if (!j.includes('已处理')) throw new Error('not terminal yet')
    }, { timeout: 10_000, interval: 50 })
    const finalJson = JSON.stringify(feishu.cards.at(-1)!.card)
    expect(finalJson).toContain('本轮审批已处理')
    expect(finalJson).toContain('已处理：2 个')
    expect(finalJson).not.toContain('"allow"')
  })

  it('falls back to a standalone visible approval when an existing group patch fails', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    void ctx.approval.request({ agent, toolName: 'Bash', reason: '第一项' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('第一项'))) throw new Error('first card missing')
    }, { timeout: 5_000, interval: 20 })
    const firstMessageId = feishu.cards.find(c => JSON.stringify(c.card).includes('第一项'))!.messageId
    feishu.failNextApprovalPatch = true

    void ctx.approval.request({ agent, toolName: 'Write', reason: '必须可见的第二项' })
    await vi.waitFor(() => {
      const standalone = feishu.cards.find(c => c.messageId !== firstMessageId
        && JSON.stringify(c.card).includes('必须可见的第二项'))
      if (standalone === undefined) throw new Error('standalone fallback card missing')
    }, { timeout: 2_000, interval: 20 })
  })

  it('removes a failed group admission before a queued terminal patch can render it', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-patch-race-first' as never,
      callId: 'call-patch-race-first',
      toolName: 'Bash',
    })
    const firstController = new AbortController()
    const first = ctx.waterfall(
      'approval/request',
      {
        agent, toolName: 'Bash', callId: 'call-patch-race-first',
        reason: '首项卡片', signal: firstController.signal,
      },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('首项卡片'))) {
        throw new Error('first approval card missing')
      }
    }, { timeout: 2_000, interval: 20 })
    const originalMessageId = feishu.cards
      .find(card => JSON.stringify(card.card).includes('首项卡片'))!.messageId

    feishu.blockNextApprovalPatch = true
    feishu.failNextApprovalPatch = true
    agent.session.append('approval/asked', {
      id: 'bridge-patch-race-second' as never,
      callId: 'call-patch-race-second',
      toolName: 'Write',
    })
    const second = ctx.waterfall(
      'approval/request',
      {
        agent, toolName: 'Write', callId: 'call-patch-race-second',
        reason: '只应出现在独立卡片',
      },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!feishu.approvalPatchAttempts.some(({ card }) =>
        JSON.stringify(card).includes('只应出现在独立卡片'))) {
        throw new Error('second-item patch has not started')
      }
    }, { timeout: 2_000, interval: 20 })

    firstController.abort()
    feishu.releaseApprovalPatch()

    await expect(first).resolves.toBe('cancelled')
    await vi.waitFor(() => {
      const standalone = feishu.cards.find(card => card.messageId !== originalMessageId
        && JSON.stringify(card.card).includes('只应出现在独立卡片'))
      if (standalone === undefined) throw new Error('standalone fallback card missing')
    }, { timeout: 2_000, interval: 20 })
    const originalUpdates = feishu.cards.filter(card => card.messageId === originalMessageId).slice(1)
    expect(originalUpdates.length).toBeGreaterThan(0)
    expect(originalUpdates.every(card =>
      !JSON.stringify(card.card).includes('只应出现在独立卡片'))).toBe(true)

    const standalone = feishu.cards.find(card => card.messageId !== originalMessageId
      && JSON.stringify(card.card).includes('只应出现在独立卡片'))!
    const pendingId = (JSON.stringify(standalone.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!
    const toast = await feishu.clickCard(OWNER, standalone.messageId, {
      pendingId,
      action: 'reject',
    })
    expect(toast?.toast).toContain('已拒绝')
    await expect(second).resolves.toBe('rejected')
  })

  it('delegates instead of waiting when a visible approval card id cannot be persisted', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const pendingCards = ctx.storageDomain.get('feishu_bot')!.table('pending_cards') as unknown as {
      size: number
      get: (key: string) => Record<string, unknown> | undefined
      update: (
        key: string,
        mutate: (current: Record<string, unknown>) => Record<string, unknown>,
      ) => Promise<unknown>
    }
    const originalUpdate = pendingCards.update.bind(pendingCards)
    pendingCards.update = async (key, mutate) => {
      const current = pendingCards.get(key)
      if (current === undefined) throw new Error('missing pending card')
      if ('cardMessageId' in mutate(current)) {
        throw new Error('simulated card id backfill failure')
      }
      return originalUpdate(key, mutate)
    }
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.approval.request({ agent, toolName: 'Bash', reason: '必须持久化卡片标识' })
    const settled = await Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 1_000)),
    ])

    expect(settled).toBe('unavailable')
    expect(pendingCards.size).toBe(0)
    const card = feishu.cards.find(item => JSON.stringify(item.card).includes('必须持久化卡片标识'))!
    const pendingId = (JSON.stringify(card.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!
    const toast = await feishu.clickCard(OWNER, card.messageId, { pendingId, action: 'allow' })
    expect(toast?.toast).toContain('失效')
  })

  it('keeps an ambiguous standalone approval send staged and never claims it as visible', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    void ctx.approval.request({ agent, toolName: 'Bash', reason: '第一项' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('第一项'))) throw new Error('first card missing')
    }, { timeout: 5_000, interval: 20 })
    feishu.failNextApprovalPatch = true
    feishu.nextApprovalCardError = Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' })

    const outcome = ctx.approval.request({ agent, toolName: 'Write', reason: '发送结果不确定的第二项' })
    const settled = await Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 1_000)),
    ])

    expect(settled).toBe('unavailable')
    const rows = [...ctx.storageDomain.get('feishu_bot')!.table('pending_cards').entries()]
      .map(([, row]) => row as { toolName: string; cardMessageId?: string; presentation?: string })
    const uncertain = rows.find(row => row.toolName === 'Write')
    expect(uncertain).toMatchObject({ presentation: 'uncertain' })
    expect(uncertain?.cardMessageId).toBeUndefined()
  })

  it('/use adopts an approval already pending in Web', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(new MockAdapter(['hang']))
    const handle = await mounted.ctx.agents.create({
      sessionId: 'web-pending-approval' as never,
      meta: { cwd: mounted.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Web task awaiting approval' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    await vi.waitFor(() => {
      if (!handle.agent.session.snapshotEvents().some(event => event.type === 'turn/start')) throw new Error('turn not open')
    })
    mounted.ctx.on('approval/request', () => new Promise(() => {}))
    void mounted.ctx.approval.request({ agent: handle.agent, toolName: 'Bash', reason: 'dangerous write' })
    await new Promise(resolve => setTimeout(resolve, 0))

    await mounted.deliver({ text: '/use web-pending-approval' })

    await vi.waitFor(() => {
      if (!mounted.feishu.cards.some(({ card }) => JSON.stringify(card).includes('dangerous write'))) {
        throw new Error('pending approval card missing')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('approval with no bound chat delegates to the rest of the chain (M3)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    await deliver({ text: '/release' })  // unbind: bridge must step aside
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = await ctx.approval.request({ agent, toolName: 'Bash' })
    // No listener beyond the bridge: the fail-closed default answers.
    expect(outcome).toBe('unavailable')
    expect(feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))).toBe(false)
  })

  it('delegates approval without persistence when approval capacity is exhausted', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']), {
      approvalMaxRecords: 0,
    })
    await deliver({ text: '/new' })
    await deliver({ text: '保持任务运行' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    await expect(ctx.approval.request({ agent, toolName: 'Bash' })).resolves.toBe('unavailable')
    expect(ctx.storageDomain.get('feishu_bot')!.table('pending_cards').size).toBe(0)
    expect(feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))).toBe(false)
  })

  it('/use by ordinal rejects a stale listing snapshot (M4: TTL)', { timeout: 20_000 }, async () => {
    // Fake only Date: drain() and the per-chat queues need real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { ctx, root, feishu, deliver, drain } = await mountBridge(new MockAdapter([]))
      // Two sessions with content: `/new` alone would leave them holding only
      // the configuration every session is born with, which /ls hides (as the
      // Web GUI does). This test is about listing TTL, not about /new.
      for (const id of ['stale-a', 'stale-b']) {
        await ctx.agents.create({
          sessionId: id as never,
          seed: usedSeed(),
          meta: { cwd: root },
          agentOptions: { provider: 'mock', model: 'm' },
        })
      }
      await deliver({ text: '/ls' })
      const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
      await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
      await drain()
      expect(feishu.cards.findLast(item => item.messageId === listing.messageId
        && JSON.stringify(item.card).includes('· 会话 ·'))).toBeDefined()
      // Past the snapshot TTL the ordinal must not silently bind.
      vi.setSystemTime(Date.now() + 6 * 60_000)
      await deliver({ text: '/use 1' })
      expect(feishu.sent.at(-1)!.text).toContain('列表已过期')
    } finally {
      vi.useRealTimers()
    }
  })

  it('/status and /release reflect and clear the binding', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('未绑定会话')
    await deliver({ text: '/new' })
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('当前会话')
    await deliver({ text: '/release' })
    expect(feishu.sent.at(-1)!.text).toContain('已解绑')
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('未绑定会话')
  })

  it('only boundBy may release or stop an active binding', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([]), {
      allowedOpenIds: [OWNER, OTHER],
    })
    await deliver({ text: '/new' })
    const original = ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1') as { sessionId: string }

    await deliver({ senderOpenId: OTHER, text: '/release' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定者')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toMatchObject({ sessionId: original.sessionId, status: 'active' })

    await deliver({ senderOpenId: OTHER, text: '/stop' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定者')
  })

  it('only boundBy may replace an active binding with /use', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]), {
      allowedOpenIds: [OWNER, OTHER],
    })
    await deliver({ text: '/new' })
    const original = ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1') as { sessionId: string }
    await ctx.agents.create({
      sessionId: 'second-session' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ senderOpenId: OTHER, text: '/use second-session' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定者')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toMatchObject({ sessionId: original.sessionId, status: 'active' })
  })

  it('does not publish a /new session when durable metadata registration fails', { timeout: 20_000 }, async () => {
    const { ctx, feishu } = await mountBridge(new MockAdapter([]))
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let resolveCreated!: (sessionId: string) => void
    const created = new Promise<string>(resolve => { resolveCreated = resolve })
    Object.defineProperty(ctx.agents, 'create', {
      configurable: true,
      value: async (...args: Parameters<typeof originalCreate>) => {
        resolveCreated(String(args[0].sessionId))
        return originalCreate(...args)
      },
    })
    const originalPersistCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    let failed = false
    Object.defineProperty(ctx.sessionPersistence, 'create', {
      configurable: true,
      value: async (...args: Parameters<typeof originalPersistCreate>) => {
        if (!failed && String(args[0].id).startsWith('feishu-')) {
          failed = true
          throw new Error('simulated session metadata persistence failure')
        }
        return originalPersistCreate(...args)
      },
    })

    await feishu.deliverInbound({
      eventId: 'ev_new_flush_failure', messageId: 'om_new_flush_failure',
      chatId: 'oc_chat_1', senderOpenId: OWNER, chatType: 'p2p',
      createTimeMs: Date.now(), text: '/new',
    })
    const sessionId = await created

    await vi.waitFor(() => {
      expect(ctx.agents.get(sessionId as never) === undefined).toBe(true)
    }, { timeout: 2_000, interval: 20 })
  })

  it('disposes a session created by /new when the binding write fails', { timeout: 20_000 }, async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter([]))
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    let failed = false
    bindings.put = async (key, value) => {
      if (!failed && (value as { status?: string }).status === 'active') {
        failed = true
        throw new Error('simulated binding persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({
      eventId: 'ev_new_binding_failure',
      messageId: 'om_new_binding_failure',
      text: '/new',
    })
    const staged = ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
      .get('om_new_binding_failure') as { target?: string } | undefined
    expect(staged?.target).toEqual(expect.any(String))
    expect(ctx.agents.get(staged!.target as never) === undefined).toBe(true)
  })

  it('disposes a cold session resumed by /use when the binding write fails', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const coldSessionId = 'cold-use-binding-failure'
    // AgentLoop owns the durable write handle: seeding through
    // `sessions.create()` registers no persistence writer, so the cold
    // session would never reach disk and could not be resumed.
    const seeded = await first.ctx.agents.create({
      sessionId: coldSessionId as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(seeded.agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const bindings = second.ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    bindings.put = async (key, value) => {
      if ((value as { sessionId?: string }).sessionId === coldSessionId) {
        throw new Error('simulated binding persistence failure')
      }
      await originalPut(key, value)
    }

    await second.deliver({ eventId: 'ev_use_binding_failure', text: `/use ${coldSessionId}` })
    expect(second.ctx.agents.get(coldSessionId as never) === undefined).toBe(true)
  })

  it('disposes a cold-resumed target when projection cursor seeding fails before binding', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const coldSessionId = 'cold-use-cursor-failure'
    // AgentLoop owns the durable write handle: seeding through
    // `sessions.create()` registers no persistence writer, so the cold
    // session would never reach disk and could not be resumed.
    const seeded = await first.ctx.agents.create({
      sessionId: coldSessionId as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(seeded.agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const cursors = second.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('projection_cursors') as unknown as {
        put: (key: string, value: unknown) => Promise<void>
      }
    const originalPut = cursors.put.bind(cursors)
    cursors.put = async (key, value) => {
      if (key.includes(coldSessionId)) throw new Error('simulated cursor persistence failure')
      await originalPut(key, value)
    }

    await second.deliver({
      eventId: 'ev_use_cursor_failure',
      messageId: 'om_use_cursor_failure',
      text: `/use ${coldSessionId}`,
    })

    expect(second.ctx.agents.get(coldSessionId as never) === undefined).toBe(true)
    expect(second.ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1')).toBeUndefined()
    expect(second.ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
      .get('om_use_cursor_failure')).toMatchObject({
        status: 'rejected', reason: 'binding-write-failed',
      })
  })

  it('disposes a cold-resumed /use target when staging that target fails', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const coldSessionId = 'cold-use-stage-failure'
    // AgentLoop owns the durable write handle: seeding through
    // `sessions.create()` registers no persistence writer, so the cold
    // session would never reach disk and could not be resumed.
    const seeded = await first.ctx.agents.create({
      sessionId: coldSessionId as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(seeded.agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const inbound = second.ctx.storageDomain.get('feishu_bot')!.table('inbound_events') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = inbound.put.bind(inbound)
    let failed = false
    let resolveStageFailed!: () => void
    const stageFailed = new Promise<void>(resolve => { resolveStageFailed = resolve })
    inbound.put = async (key, value) => {
      if (!failed && (value as { target?: string }).target === coldSessionId) {
        failed = true
        resolveStageFailed()
        throw new Error('simulated target staging failure')
      }
      await originalPut(key, value)
    }

    await second.feishu.deliverInbound({
      eventId: 'ev_use_stage_failure', messageId: 'om_use_stage_failure',
      chatId: 'oc_chat_1', senderOpenId: OWNER, chatType: 'p2p',
      createTimeMs: Date.now(), text: `/use ${coldSessionId}`,
    })
    await stageFailed

    await vi.waitFor(() => {
      expect(second.ctx.agents.get(coldSessionId as never) === undefined).toBe(true)
    }, { timeout: 2_000, interval: 20 })
    expect(second.ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toBeUndefined()
  })

  it('keeps a cold /use agent unpublished until its binding is durable across chats', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const coldSessionId = 'cold-use-cross-chat-adoption'
    // AgentLoop owns the durable write handle: seeding through
    // `sessions.create()` registers no persistence writer, so the cold
    // session would never reach disk and could not be resumed.
    const seeded = await first.ctx.agents.create({
      sessionId: coldSessionId as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(seeded.agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const bindings = second.ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      get: (key: string) => { sessionId?: string; status?: string } | undefined
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    let signalFirstPut!: () => void
    const firstPutStarted = new Promise<void>(resolve => { signalFirstPut = resolve })
    let releaseFirstPut!: () => void
    const firstPutGate = new Promise<void>(resolve => { releaseFirstPut = resolve })
    let signalSecondPut!: () => void
    const secondPutStarted = new Promise<void>(resolve => { signalSecondPut = resolve })
    let failedFirst = false
    bindings.put = async (key, value) => {
      if ((value as { sessionId?: string }).sessionId === coldSessionId && key === 'oc_adopt_first') {
        signalFirstPut()
        await firstPutGate
        if (!failedFirst) {
          failedFirst = true
          throw new Error('simulated first-chat binding failure')
        }
      }
      if ((value as { sessionId?: string }).sessionId === coldSessionId && key === 'oc_adopt_second') {
        signalSecondPut()
      }
      await originalPut(key, value)
    }
    try {
      await second.feishu.deliverInbound({
        eventId: 'ev_cross_chat_first', messageId: 'om_cross_chat_first',
        chatId: 'oc_adopt_first', senderOpenId: OWNER, chatType: 'p2p',
        createTimeMs: Date.now(), text: `/use ${coldSessionId}`,
      })
      await firstPutStarted
      expect(second.ctx.agents.get(coldSessionId as never)).toBeUndefined()

      await second.feishu.deliverInbound({
        eventId: 'ev_cross_chat_second', messageId: 'om_cross_chat_second',
        chatId: 'oc_adopt_second', senderOpenId: OWNER, chatType: 'p2p',
        createTimeMs: Date.now(), text: `/use ${coldSessionId}`,
      })
      await expect(Promise.race([
        secondPutStarted.then(() => 'started' as const),
        new Promise<'waiting'>(resolve => setTimeout(() => { resolve('waiting') }, 100)),
      ])).resolves.toBe('waiting')

      releaseFirstPut()
      await secondPutStarted
      await vi.waitFor(() => {
        expect(bindings.get('oc_adopt_first')).toBeUndefined()
        expect(bindings.get('oc_adopt_second')).toMatchObject({
          sessionId: coldSessionId,
          status: 'active',
        })
        expect(second.ctx.agents.get(coldSessionId as never)).toBeDefined()
        expect(second.ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
          .get('om_cross_chat_first')).toMatchObject({
          status: 'rejected', reason: 'binding-write-failed',
        })
        expect(second.ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
          .get('om_cross_chat_second')).toMatchObject({ status: 'committed' })
      }, { timeout: 3_000, interval: 20 })
    } finally {
      releaseFirstPut?.()
    }
  })

  it('removes a late binding write after cold setup is disposed', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const coldSessionId = 'cold-use-dispose-late-write'
    // AgentLoop owns the durable write handle: seeding through
    // `sessions.create()` registers no persistence writer, so the cold
    // session would never reach disk and could not be resumed.
    const seeded = await first.ctx.agents.create({
      sessionId: coldSessionId as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(seeded.agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const bindingDomain = second.ctx.storageDomain.get('feishu_bot')!
    const bindings = bindingDomain.table('bindings') as unknown as {
      get: (key: string) => unknown
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalGet = bindings.get.bind(bindings)
    const originalPut = bindings.put.bind(bindings)
    let signalPutStarted!: () => void
    const putStarted = new Promise<void>(resolve => { signalPutStarted = resolve })
    let releasePut!: () => void
    const putGate = new Promise<void>(resolve => { releasePut = resolve })
    let signalPutFinished!: () => void
    const putFinished = new Promise<void>(resolve => { signalPutFinished = resolve })
    let disposingStarted = false
    let rollbackObserved = false
    let signalRollbackObserved!: () => void
    const rollbackCheckObserved = new Promise<void>(resolve => { signalRollbackObserved = resolve })
    let candidatePutStarted = false
    bindings.get = (key) => {
      const value = originalGet(key)
      if (disposingStarted && candidatePutStarted && key === 'oc_late_binding'
        && value === undefined && !rollbackObserved) {
        rollbackObserved = true
        signalRollbackObserved()
      }
      return value
    }
    bindings.put = async (key, value) => {
      if (key === 'oc_late_binding'
        && (value as { sessionId?: string }).sessionId === coldSessionId) {
        candidatePutStarted = true
        signalPutStarted()
        await putGate
        await originalPut(key, value)
        signalPutFinished()
        return
      }
      await originalPut(key, value)
    }
    const deliveryDomain = second.ctx.storageDomain.get('feishu_bot_delivery')! as unknown as {
      close: () => Promise<void>
    }
    const originalDeliveryClose = deliveryDomain.close.bind(deliveryDomain)
    let releaseDeliveryClose!: () => void
    const deliveryCloseGate = new Promise<void>(resolve => { releaseDeliveryClose = resolve })
    deliveryDomain.close = async () => {
      await deliveryCloseGate
      await originalDeliveryClose()
    }
    try {
      await second.feishu.deliverInbound({
        eventId: 'ev_late_binding', messageId: 'om_late_binding',
        chatId: 'oc_late_binding', senderOpenId: OWNER, chatType: 'p2p',
        createTimeMs: Date.now(), text: `/use ${coldSessionId}`,
      })
      await putStarted
      expect(second.ctx.agents.get(coldSessionId as never)).toBeUndefined()

      disposingStarted = true
      const disposing = second.bridgeFiber.dispose()
      await rollbackCheckObserved
      releasePut()
      await putFinished
      releaseDeliveryClose()
      await disposing
      await second.ctx.fiber.dispose()

      const third = await mountBridge(new MockAdapter([]), {}, first.root)
      expect(third.ctx.storageDomain.get('feishu_bot')!.table('bindings')
        .get('oc_late_binding')).toBeUndefined()
      expect(third.ctx.agents.get(coldSessionId as never)).toBeUndefined()
    } finally {
      releasePut?.()
      releaseDeliveryClose?.()
    }
  })

  it('never disposes an existing live session when /use cannot persist the binding', { timeout: 20_000 }, async () => {
    const { ctx, root, deliver } = await mountBridge(new MockAdapter([]))
    const liveSessionId = 'live-use-binding-failure'
    const handle = await ctx.agents.create({
      sessionId: liveSessionId as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    bindings.put = async (key, value) => {
      if ((value as { sessionId?: string }).sessionId === liveSessionId) {
        throw new Error('simulated binding persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({ eventId: 'ev_existing_binding_failure', text: `/use ${liveSessionId}` })
    expect(ctx.agents.get(liveSessionId as never) === handle.agent).toBe(true)
  })

  it('rolls back an applied /new after-image and disposes only its created session', { timeout: 20_000 }, async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter([]))
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      get: (key: string) => unknown
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    let failed = false
    bindings.put = async (key, value) => {
      if (!failed && (value as { status?: string }).status === 'active') {
        failed = true
        await originalPut(key, value)
        throw new Error('simulated ambiguous binding persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({
      eventId: 'ev_new_after_image_failure',
      messageId: 'om_new_after_image_failure',
      text: '/new',
    })

    const row = ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
      .get('om_new_after_image_failure') as { target?: string; status?: string; reason?: string }
    expect(bindings.get('oc_chat_1')).toBeUndefined()
    expect(ctx.agents.get(row.target as never)).toBeUndefined()
    expect(row).toMatchObject({ status: 'rejected', reason: 'binding-write-failed' })
  })

  it('does not overwrite a newer binding while compensating a failed /use after-image', { timeout: 20_000 }, async () => {
    const { ctx, root, feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new' })
    await ctx.agents.create({
      sessionId: 'candidate-binding' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.agents.create({
      sessionId: 'newer-binding' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      get: (key: string) => unknown
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    let injected = false
    bindings.put = async (key, value) => {
      if (!injected && (value as { sessionId?: string }).sessionId === 'candidate-binding') {
        injected = true
        await originalPut(key, value)
        await originalPut(key, {
          sessionId: 'newer-binding', status: 'active', boundBy: OWNER, boundAt: Date.now() + 1,
        })
        throw new Error('simulated late persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({
      eventId: 'ev_use_after_image_race',
      messageId: 'om_use_after_image_race',
      text: '/use candidate-binding',
    })

    expect(bindings.get('oc_chat_1')).toMatchObject({ sessionId: 'newer-binding' })
    expect(ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
      .get('om_use_after_image_race')).toMatchObject({
        status: 'rejected', reason: 'binding-changed-during-compensation',
      })
    expect(feishu.sent.at(-1)!.text).toContain('其他操作更新')
  })

  it('bounds created-session cleanup without changing the primary binding failure result', { timeout: 20_000 }, async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter([]), { bindingCleanupTimeoutMs: 10 })
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    Object.defineProperty(ctx.agents, 'create', {
      configurable: true,
      value: async (...args: Parameters<typeof originalCreate>) => {
        const handle = await originalCreate(...args)
        return { agent: handle.agent, dispose: () => new Promise<void>(() => {}) }
      },
    })
    const bindings = ctx.storageDomain.get('feishu_bot')!.table('bindings') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const originalPut = bindings.put.bind(bindings)
    bindings.put = async (key, value) => {
      if ((value as { status?: string }).status === 'active') {
        throw new Error('simulated binding persistence failure')
      }
      await originalPut(key, value)
    }

    await deliver({
      eventId: 'ev_new_cleanup_timeout',
      messageId: 'om_new_cleanup_timeout',
      text: '/new',
    })

    expect(ctx.storageDomain.get('feishu_bot')!.table('inbound_events')
      .get('om_new_cleanup_timeout')).toMatchObject({
        status: 'rejected', reason: 'binding-write-failed',
      })
  })

  it('an allowlisted but non-boundBy operator cannot decide an approval', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']), {
      allowedOpenIds: [OWNER, OTHER],
    })
    await deliver({ text: '/new' })
    await deliver({ text: '任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    const outcome = ctx.approval.request({ agent, toolName: 'Bash' })
    await vi.waitFor(() => {
      if (!feishu.cards.some(c => JSON.stringify(c.card).includes('审批请求'))) throw new Error('no card yet')
    }, { timeout: 10_000, interval: 50 })
    const sent = feishu.cards.find(c => JSON.stringify(c.card).includes('审批请求'))!
    const pendingId = (JSON.stringify(sent.card).match(/"pendingId":"(pc_[^"]+)"/) ?? [])[1]!

    const denied = await feishu.clickCard(OTHER, sent.messageId, { pendingId, action: 'allow' })
    expect(denied?.toast).toContain('绑定者')
    const accepted = await feishu.clickCard(OWNER, sent.messageId, { pendingId, action: 'reject' })
    expect(accepted?.toast).toContain('已拒绝')
    expect(await outcome).toBe('rejected')
  })

  it('stale events expire without visible effect', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/help', createTimeMs: Date.now() - 3_600_000 })
    expect(feishu.sent).toEqual([])
  })

  it('routed text is logged with source kind user (Web renders it as the human)', async () => {
    const { ctx, deliver } = await mountBridge(new MockAdapter([textResponse('ok')]))
    await deliver({ text: '/new' })
    await deliver({ text: '来自手机的消息' })
    const live = [...(ctx.agents as unknown as { entries?: () => Iterable<[string, unknown]> }).entries?.() ?? []]
    // Find the bound session via any live agent's log.
    let found = false
    for (const sessionId of ctx.sessions.list().map(s => s.id)) {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      for (const event of agent.session.snapshotEvents()) {
        if (event.type !== 'user/message') continue
        const data = event.data as { content?: { type: string; text?: string }[]; source?: { kind?: string } }
        if (data.content?.some(b => b.text === '来自手机的消息')) {
          expect(data.source?.kind).toBe('user')
          found = true
        }
      }
    }
    void live
    expect(found).toBe(true)
  })

  it('/ls card keeps the ordinal snapshot so /use <n> remains a text fallback', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    // Two USED sessions keep this workspace in navigation mode. `/new` would
    // not do: it leaves a session holding only its birth configuration, which
    // /ls hides exactly as the Web GUI does.
    for (const id of ['ordinal-a', 'ordinal-b']) {
      await ctx.agents.create({
        sessionId: id as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
    }
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))
    expect(listing).toBeDefined()
    expect(JSON.stringify(listing!.card)).toContain(basename(root))
    await feishu.clickCard(OWNER, listing!.messageId, cardActionValue(listing!.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing!.messageId)!
    expect(JSON.stringify(sessions.card)).toContain('未命名会话')
    await deliver({ text: '/use 1' })
    expect(feishu.sent.at(-1)!.text).toContain('已绑定')
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定：')
  })

  it('/ls opens a workspace card first and resolves titles only after entering one workspace', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')
    await mkdir(alpha)
    await mkdir(beta)
    const alphaHandle = await ctx.agents.create({
      sessionId: 'alpha-session' as never,
      seed: usedSeed(),
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    alphaHandle.agent.session.append('session/title' as never, {
      title: 'Alpha 的真实标题', messageSeqs: [], source: { kind: 'user' },
    } as never)
    const alphaSecond = await ctx.agents.create({
      sessionId: 'alpha-session-2' as never,
      seed: usedSeed(),
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    alphaSecond.agent.session.append('session/title' as never, {
      title: 'Alpha 的第二个标题', messageSeqs: [], source: { kind: 'user' },
    } as never)
    const betaHandle = await ctx.agents.create({
      sessionId: 'beta-session' as never,
      seed: usedSeed(),
      meta: { cwd: beta },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    betaHandle.agent.session.append('session/title' as never, {
      title: 'Beta 的真实标题', messageSeqs: [], source: { kind: 'user' },
    } as never)

    await deliver({ text: '/ls' })

    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    expect(listing).toBeDefined()
    expect(JSON.stringify(listing.card)).not.toContain('Alpha 的真实标题')
    expect(JSON.stringify(listing.card)).not.toContain('Beta 的真实标题')
    const workspaceValue = cardButtonValue(listing.card, '2. alpha（2 个会话）')
      ?? cardButtonValue(listing.card, '1. alpha（2 个会话）')
    const response = await feishu.clickCard(
      OWNER,
      listing.messageId,
      workspaceValue,
    )
    await drain()

    expect(response?.toast).toBe('正在加载会话…')
    const sessionCard = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    expect(JSON.stringify(sessionCard.card)).toContain('Alpha 的真实标题')
    expect(JSON.stringify(sessionCard.card)).not.toContain('Beta 的真实标题')
    const sessionValue = cardButtonValue(sessionCard.card, '1. 【alpha】Alpha 的真实标题')
      ?? cardButtonValue(sessionCard.card, '2. 【alpha】Alpha 的真实标题')
    expect(sessionValue).toMatchObject({
      action: 'select', workspaceIndex: (workspaceValue as { index: number }).index,
      index: expect.any(Number),
    })
  })

  it('/new defaults to the workspace the operator last entered via /ls', { timeout: 20_000 }, async () => {
    // Reported expectation: after picking a workspace in /ls, a following /new
    // should create inside THAT workspace rather than the configured default.
    // The two differ here on purpose: defaultWorkspace is `root`, while the
    // operator navigates into root/alpha.
    const { ctx, feishu, root, deliver, drain, workspaces } = await mountBridge(new MockAdapter([]))
    const alpha = join(root, 'alpha')
    await mkdir(alpha)
    const { agent: seeded } = await ctx.agents.create({
      sessionId: 'alpha-seeded' as never,
      seed: usedSeed(),
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    seeded.session.append('session/title' as never, {
      title: 'Alpha 的会话', messageSeqs: [], source: { kind: 'user' },
    } as never)

    await deliver({ text: '/ls' })
    const listing = feishu.cards.findLast(item => JSON.stringify(item.card).includes('选择工作空间'))!
    // Entering the workspace is what records the operator's choice.
    const workspaceValue = cardButtonValue(listing.card, '1. alpha（1 个会话）')
      ?? cardButtonValue(listing.card, '2. alpha（1 个会话）')
    await feishu.clickCard(OWNER, listing.messageId, workspaceValue)
    await drain()

    // Now /new with no explicit path must land in alpha.
    await deliver({ text: '/new' })
    const created = [...ctx.agents.list()].find(candidate => String(candidate.session.id).startsWith('feishu-'))
    expect(created).toBeDefined()
    expect(created!.session.header.cwd).toBe(await realpath(alpha))
    const workspace = workspaces.find(candidate => candidate.sessionIds.includes(String(created!.session.id)))
    expect(workspace?.path).toBe(await realpath(alpha))
  })

  it('/new falls back to defaultWorkspace when no workspace was entered', { timeout: 20_000 }, async () => {
    // The remembered choice must not outlive its usefulness: without a /ls
    // selection, /new keeps using the configured default.
    const { ctx, feishu, root, deliver, workspaces } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new' })
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')
    const created = [...ctx.agents.list()][0]
    expect(created.session.header.cwd).toBe(await realpath(root))
    const workspace = workspaces.find(candidate => candidate.sessionIds.includes(String(created.session.id)))
    expect(workspace?.path).toBe(await realpath(root))
  })

  it('/new drops a remembered workspace that became unusable and uses the default', { timeout: 20_000 }, async () => {
    // The remembered directory can vanish between the /ls that chose it and
    // the /new that uses it. Blocking /new on a choice the operator can no
    // longer see is worse than falling back to the configured default.
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const alpha = join(root, 'alpha')
    await mkdir(alpha)
    await ctx.agents.create({
      sessionId: 'alpha-seeded' as never,
      seed: usedSeed(),
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ text: '/ls' })
    const listing = feishu.cards.findLast(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const workspaceValue = cardButtonValue(listing.card, '1. alpha（1 个会话）')
      ?? cardButtonValue(listing.card, '2. alpha（1 个会话）')
    await feishu.clickCard(OWNER, listing.messageId, workspaceValue)
    await drain()

    // The chosen directory disappears before /new runs.
    await rm(alpha, { recursive: true, force: true })

    await deliver({ text: '/new' })
    expect(feishu.sent.at(-1)!.text).toContain('已创建并绑定')
    const created = [...ctx.agents.list()].find(candidate => String(candidate.session.id).startsWith('feishu-'))
    expect(created!.session.header.cwd).toBe(await realpath(root))
  })

  it('/ls disambiguates duplicate workspace basenames without exposing parent paths', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    const left = join(root, 'left', 'shared')
    const right = join(root, 'right', 'shared')
    await mkdir(left, { recursive: true })
    await mkdir(right, { recursive: true })
    await ctx.agents.create({
      sessionId: 'left-shared-session' as never,
      seed: usedSeed(),
      meta: { cwd: left },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.agents.create({
      sessionId: 'right-shared-session' as never,
      seed: usedSeed(),
      meta: { cwd: right },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ text: '/ls' })

    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const json = JSON.stringify(listing.card)
    expect(json).toContain('shared（1）（1 个会话）')
    expect(json).toContain('shared（2）（1 个会话）')
    expect(json).not.toContain('/left/')
    expect(json).not.toContain('/right/')
  })

  it('/ls returns from a session page to the same workspace card', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    for (let index = 1; index <= 2; index += 1) {
      await ctx.agents.create({
        sessionId: `back-session-${index}` as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
    }
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing.messageId)!

    const response = await feishu.clickCard(
      OWNER,
      listing.messageId,
      cardButtonValue(sessions.card, '← 返回工作空间'),
    )
    await drain()

    expect(response?.toast).toBe('正在返回工作空间…')
    const returned = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    expect(JSON.stringify(returned.card)).toContain('选择工作空间')
    expect(cardActionValue(returned.card, 'workspace')).toBeDefined()
  })

  it('/ls keeps more than twenty sessions reachable through workspace paging', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    for (let index = 1; index <= 21; index += 1) {
      const handle = await ctx.agents.create({
        sessionId: `uncapped-session-${index}` as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
      handle.agent.session.append('session/title' as never, {
        title: `未截断会话 ${index}`, messageSeqs: [], source: { kind: 'user' },
      } as never)
    }
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    expect(JSON.stringify(listing.card)).toContain('21 个会话')
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()

    let page = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    await feishu.clickCard(OWNER, listing.messageId, cardButtonValue(page.card, '下一页'))
    await drain()
    page = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    await feishu.clickCard(OWNER, listing.messageId, cardButtonValue(page.card, '下一页'))
    await drain()
    page = feishu.cards.findLast(item => item.messageId === listing.messageId)!

    expect(JSON.stringify(page.card)).toContain('会话 · 3/3')
    expect(cardActionValue(page.card, 'select')).toMatchObject({ index: 14 })
  })

  it('/ls renders the live title as the primary card label instead of a session id', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'opaque-live-id' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '排查飞书任务失败', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await ctx.agents.create({
      sessionId: 'live-title-filler' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ text: '/ls' })

    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))
    expect(listing).toBeDefined()
    expect(JSON.stringify(listing!.card)).not.toContain('排查飞书任务失败')
    await feishu.clickCard(OWNER, listing!.messageId, cardActionValue(listing!.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing!.messageId)!
    expect(JSON.stringify(sessions.card)).toContain('排查飞书任务失败')
    expect(cardButtonValue(sessions.card, `1. 【${basename(root)}】排查飞书任务失败`)
      ?? cardButtonValue(sessions.card, `2. 【${basename(root)}】排查飞书任务失败`)).toBeDefined()
    expect(feishu.sessionListDeliveries).toEqual([{
      deliveryId: 'om_in_1',
      stage: 'session-list-card',
      segmentIndex: 0,
    }])
    expect(feishu.sent).toEqual([])
  })

  it('/ls resolves the latest title of a cold persisted session', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'opaque-cold-id' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '冷会话的真实名称', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    await ctx.agents.create({
      sessionId: 'cold-title-filler' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ text: '/ls' })

    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))
    expect(listing).toBeDefined()
    expect(JSON.stringify(listing!.card)).not.toContain('冷会话的真实名称')
    await feishu.clickCard(OWNER, listing!.messageId, cardActionValue(listing!.card, 'workspace'))
    await drain()
    expect(JSON.stringify(feishu.cards.findLast(item => item.messageId === listing!.messageId)!.card))
      .toContain('冷会话的真实名称')
    expect(feishu.sent).toEqual([])
  })

  it('/ls falls back to a named numbered list only after a permanent card rejection', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'permanent-card-rejection' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '卡片失败时仍可选择', messageSeqs: [], source: { kind: 'user' },
    } as never)
    feishu.nextSessionListCardError = Object.assign(new Error('card schema rejected'), {
      feishuFailureKind: 'permanent',
    })

    await deliver({ text: '/ls' })

    expect(feishu.cards).toEqual([])
    expect(feishu.sent.at(-1)?.text).toContain('[1] 【feishu\\-bridge\\-')
    expect(feishu.sent.at(-1)?.text).toContain('卡片失败时仍可选择')
    expect(feishu.sent.at(-1)?.text).toContain('/use <编号>')
  })

  it('/ls does not send a text duplicate after an ambiguous card-create timeout', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'ambiguous-card-timeout' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '不应重复发送的会话卡', messageSeqs: [], source: { kind: 'user' },
    } as never)
    feishu.nextSessionListCardError = Object.assign(new Error('timeout after write'), {
      code: 'ETIMEDOUT',
    })

    await deliver({ text: '/ls' })

    expect(feishu.cards).toEqual([])
    expect(feishu.sent).toEqual([])
  })

  it('does not trust a copied /ls card message id after an ambiguous create timeout', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    await ctx.agents.create({
      sessionId: 'ambiguous-card-copy-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    feishu.nextSessionListCardError = Object.assign(new Error('timeout after write'), {
      code: 'ETIMEDOUT',
    })
    await deliver({ text: '/ls' })
    const attemptedCard = feishu.sessionListCardAttempts.at(-1)!

    const response = await feishu.clickCard(
      OWNER, 'copied_or_forwarded_card', cardActionValue(attemptedCard, 'workspace'),
    )
    await drain()

    expect(response?.toast).toContain('状态不确定')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1')).toBeUndefined()
  })

  it('selecting a /ls card row binds that session without a typed /use command', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'click-bind-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '点击即可接手的会话', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!

    const response = await feishu.clickCard(
      OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'),
    )
    await drain()

    expect(response?.toast).toBe('正在绑定会话…')
    // The card handler acknowledges immediately; binding runs in the chat FIFO.
    // Wait for the durable result instead of relying on the generic drain
    // heuristic, which can settle before a slower CI runner finishes it.
    await vi.waitFor(() => {
      expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
        .toMatchObject({ sessionId: 'click-bind-target', status: 'active', boundBy: OWNER })
    }, { timeout: 5_000, interval: 20 })
    const finalCard = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    expect(finalCard.card).toMatchObject({ header: { template: 'green' } })
    expect(JSON.stringify(finalCard.card)).toContain('点击即可接手的会话')
    expect(feishu.sent).toEqual([])
  })

  it('paginates the original /ls snapshot in place even when a newer session appears', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const originalTitles: string[] = []
    for (let index = 1; index <= 8; index += 1) {
      const title = `原快照会话 ${index}`
      originalTitles.push(title)
      const handle = await ctx.agents.create({
        sessionId: `snapshot-${index}` as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
      handle.agent.session.append('session/title' as never, {
        title, messageSeqs: [], source: { kind: 'user' },
      } as never)
    }
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()
    const firstPage = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    const firstJson = JSON.stringify(firstPage.card)
    const omitted = originalTitles.filter(title => !firstJson.includes(title))
    expect(omitted).toHaveLength(1)

    const newer = await ctx.agents.create({
      sessionId: 'new-after-snapshot' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    newer.agent.session.append('session/title' as never, {
      title: '翻页后才出现的新会话', messageSeqs: [], source: { kind: 'user' },
    } as never)

    const response = await feishu.clickCard(
      OWNER, firstPage.messageId, cardButtonValue(firstPage.card, '下一页'),
    )
    await drain()

    expect(response?.toast).toBe('正在翻页…')
    const secondPage = feishu.cards.findLast(item => item.messageId === firstPage.messageId)!
    expect(JSON.stringify(secondPage.card)).toContain(omitted[0])
    expect(JSON.stringify(secondPage.card)).not.toContain('翻页后才出现的新会话')
    expect(cardActionValue(secondPage.card, 'select')).toMatchObject({ index: 7 })
  })

  it('returns quickly and sends a visible fallback when /ls pagination cannot patch the original card', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    for (let index = 1; index <= 8; index += 1) {
      await ctx.agents.create({
        sessionId: `page-failure-${index}` as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
    }
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    feishu.failNextSessionListPagePatch = true

    const response = await feishu.clickCard(
      OWNER, listing.messageId, cardButtonValue(sessions.card, '下一页'),
    )
    await drain()

    expect(response?.toast).toBe('正在翻页…')
    expect(feishu.sent.at(-1)?.text).toContain('会话卡更新失败')
  })

  it('rejects a forged /ls snapshot token without changing the binding', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    await ctx.agents.create({
      sessionId: 'token-protected-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const original = cardActionValue(listing.card, 'workspace') as Record<string, unknown>

    const response = await feishu.clickCard(OWNER, listing.messageId, {
      ...original,
      token: 'forged-token',
    })

    expect(response?.toast).toContain('失效')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').size).toBe(0)
  })

  it('rejects a /ls selection from a different card message id', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    await ctx.agents.create({
      sessionId: 'message-protected-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const value = cardActionValue(listing.card, 'workspace')

    const forwarded = await feishu.clickCard(
      OWNER, listing.messageId, value, 'oc_forwarded_chat',
    )
    expect(forwarded?.toast).toContain('失效')

    const response = await feishu.clickCard(
      OWNER, 'forwarded_or_forged_message', value,
    )

    expect(response?.toast).toContain('不属于当前会话卡')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').size).toBe(0)
  })

  it('rejects an expired /ls card before binding', { timeout: 20_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
      await ctx.agents.create({
        sessionId: 'expired-card-target' as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
      await deliver({ text: '/ls' })
      const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
      vi.setSystemTime(Date.now() + 6 * 60_000)

      const response = await feishu.clickCard(
        OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'),
      )

      expect(response?.toast).toContain('过期')
      expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects non-allowlisted and non-binding-owner /ls card operators', { timeout: 20_000 }, async () => {
    const { ctx, root, feishu, deliver } = await mountBridge(new MockAdapter([]), {
      allowedOpenIds: [OWNER, OTHER],
    })
    // OWNER holds the binding, which is what makes OTHER not its binder. The
    // listed session needs content of its own; a merely created one is hidden
    // (as the Web GUI hides it), so seed it.
    await ctx.agents.create({
      sessionId: 'operators-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await deliver({ text: '/new' })
    await ctx.storageDomain.get('feishu_bot')!.table('bindings').put('oc_chat_1', {
      sessionId: 'operators-target',
      status: 'active',
      boundBy: OWNER,
      boundAt: Date.now(),
    } as never)
    await deliver({ senderOpenId: OTHER, text: '/ls' })
    const listing = feishu.cards.findLast(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const value = cardActionValue(listing.card, 'workspace')

    const stranger = await feishu.clickCard('ou_not_allowlisted', listing.messageId, value)
    expect(stranger?.toast).toContain('没有权限')
    const other = await feishu.clickCard(OTHER, listing.messageId, value)
    expect(other?.toast).toContain('绑定者')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toMatchObject({ boundBy: OWNER })
  })

  it('accepts only the first selection click from one /ls card', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    await ctx.agents.create({
      sessionId: 'single-click-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    const value = cardActionValue(listing.card, 'workspace')

    const first = await feishu.clickCard(OWNER, listing.messageId, value)
    const second = await feishu.clickCard(OWNER, listing.messageId, value)
    await drain()

    expect(first?.toast).toBe('正在绑定会话…')
    expect(second?.toast).toMatch(/正在绑定|已处理/u)
    expect(feishu.cards.filter(item => item.messageId === listing.messageId
      && (item.card as { header?: { template?: string } }).header?.template === 'green'))
      .toHaveLength(1)
  })

  it('rechecks archive state after /ls and rejects a session archived before the click', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain, archiveSession } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'archived-after-listing' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '随后被归档的会话', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    archiveSession('archived-after-listing')

    const response = await feishu.clickCard(
      OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'),
    )
    await drain()

    expect(response?.toast).toBe('正在绑定会话…')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').size).toBe(0)
    const terminal = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    expect(terminal.card).toMatchObject({ header: { template: 'red' } })
    expect(JSON.stringify(terminal.card)).toContain('已归档')
  })

  it('falls back to text when the terminal session-selection card cannot be patched', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'terminal-patch-target' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '必须收到终态的会话', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))!
    feishu.failNextSessionListTerminalPatch = true

    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()

    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toMatchObject({ sessionId: 'terminal-patch-target', status: 'active' })
    expect(feishu.sent.at(-1)?.text).toMatch(/^已绑定「【feishu\\-bridge\\-[^】]+】必须收到终态的会话」。直接发送消息即可继续任务。$/u)
  })

  it('/use <n> without a prior /ls explains the numbering is stale', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/use 3' })
    expect(feishu.sent.at(-1)!.text).toContain('/ls')
  })

  it('/ls hides archived sessions', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, archiveSession } = await mountBridge(new MockAdapter([]))
    for (const sessionId of ['visible-session', 'archived-session']) {
      const handle = await ctx.agents.create({
        sessionId: sessionId as never,
        seed: usedSeed(),
        meta: { cwd: root },
        agentOptions: { provider: 'mock', model: 'm' },
      })
      await ctx.sessions.flush(handle.agent.session)
    }
    archiveSession('archived-session')

    await deliver({ text: '/ls' })

    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))
    expect(listing).toBeDefined()
    const listingJson = JSON.stringify(listing!.card)
    expect(listingJson).toContain(`${basename(root)}（1 个会话）`)
    expect(listingJson).not.toContain('archived-session')
  })

  it('/use by full id rejects an archived session', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, archiveSession } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'archived-direct' as never,
      seed: usedSeed(),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.sessions.flush(handle.agent.session)
    archiveSession('archived-direct')

    await deliver({ text: '/use archived-direct' })

    expect(feishu.sent.at(-1)!.text).toContain('已归档')
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').size).toBe(0)
  })

  it('/use by full id also rejects sessions outside allowedWorkspaces', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([]))
    const outside = await mkdtemp(join(tmpdir(), 'outside-ws-'))
    dirs.push(outside)
    const handle = await ctx.agents.create({
      sessionId: 'outside-direct' as never,
      seed: usedSeed(),
      meta: { cwd: outside },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.sessions.flush(handle.agent.session)
    await deliver({ text: '/use outside-direct' })
    expect(feishu.sent.at(-1)!.text).toContain('无法绑定')
  })

  it('non-text messages get the unsupported-content notice', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ eventId: 'ev_non_text_a', messageId: 'om_non_text', text: undefined })
    await deliver({ eventId: 'ev_non_text_b', messageId: 'om_non_text', text: undefined })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('非文本')
  })

  it('closes the first storage domain when opening the delivery domain fails', { timeout: 20_000 }, async () => {
    const firstDomain = { close: vi.fn(async () => {}) }
    const deliveryFailure = Object.assign(new Error('delivery domain is already open'), {
      code: 'already-open',
    })
    const open = vi.fn()
      .mockResolvedValueOnce(firstDomain)
      .mockRejectedValueOnce(deliveryFailure)
    const fakeContext = {
      fiber: { uid: 1 },
      on: () => () => {},
      storageDomain: { open },
      get: (name: string) => ({
        agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'm' }) },
        workspaceRegistry: { archivedSessionIds: [] },
        sessionProjections: {
          snapshot: () => ({ values: {} }),
          register: () => () => {},
          stateOf: () => undefined,
        },
        sessionProjectionCache: { coldSnapshot: async () => ({ values: {} }) },
      })[name],
      feishu: { markBridgeReady: vi.fn(), markBridgeFailed: vi.fn() },
      logger: { error: vi.fn() },
    }
    const root = await mkdtemp(join(tmpdir(), 'feishu-domain-open-'))
    dirs.push(root)

    await expect(bridge.apply(fakeContext as never, {
      allowedOpenIds: [OWNER], allowedWorkspaces: [root], defaultWorkspace: root,
      agentProvider: 'mock', agentModel: 'm',
    } as bridge.Config)).rejects.toBe(deliveryFailure)

    expect(firstDomain.close).toHaveBeenCalledTimes(1)
  })

  it('closes both domains when disposal wins the lifecycle-registration microtask', { timeout: 20_000 }, async () => {
    const primaryDomain = { close: vi.fn(async () => {}) }
    const deliveryDomain = { close: vi.fn(async () => {}) }
    let resolveDelivery!: (domain: typeof deliveryDomain) => void
    const delayedDelivery = new Promise<typeof deliveryDomain>(resolve => {
      resolveDelivery = resolve
    })
    const ownerFiber = { uid: 1 as number | null }
    let pluginListener: ((fiber: typeof ownerFiber) => void) | undefined
    const open = vi.fn()
      .mockResolvedValueOnce(primaryDomain)
      .mockReturnValueOnce(delayedDelivery)
    const fakeContext = {
      fiber: ownerFiber,
      on: (event: string, listener: (fiber: typeof ownerFiber) => void) => {
        if (event === 'internal/plugin') pluginListener = listener
        return () => {}
      },
      effect: () => {
        if (ownerFiber.uid === null) throw new Error('cannot register effect on inactive fiber')
      },
      storageDomain: { open },
      get: (name: string) => ({
        agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'm' }) },
        workspaceRegistry: { archivedSessionIds: [] },
        sessionProjections: {
          snapshot: () => ({ values: {} }),
          register: () => () => {},
          stateOf: () => undefined,
        },
        sessionProjectionCache: { coldSnapshot: async () => ({ values: {} }) },
      })[name],
      feishu: { markBridgeReady: vi.fn(), markBridgeFailed: vi.fn() },
      logger: { error: vi.fn() },
    }
    const root = await mkdtemp(join(tmpdir(), 'feishu-domain-register-'))
    dirs.push(root)

    const applying = bridge.apply(fakeContext as never, {
      allowedOpenIds: [OWNER], allowedWorkspaces: [root], defaultWorkspace: root,
      agentProvider: 'mock', agentModel: 'm',
    } as bridge.Config)
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledTimes(2)
    }, { timeout: 1_000, interval: 10 })
    void delayedDelivery.then(() => {
      ownerFiber.uid = null
      pluginListener?.(ownerFiber)
    })
    resolveDelivery(deliveryDomain)

    await applying
    expect(primaryDomain.close).toHaveBeenCalledTimes(1)
    expect(deliveryDomain.close).toHaveBeenCalledTimes(1)
  })

  it('does not start intake, a maintenance timer, or readiness after disposal during startup recovery', { timeout: 20_000 }, async () => {
    let transport: StubFeishu | undefined
    let fiber: { uid: number | null; dispose: () => Promise<void> } | undefined
    let signalListStarted!: () => void
    const listStarted = new Promise<void>(resolve => { signalListStarted = resolve })
    let releaseList!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    let setupSignal: AbortSignal | undefined
    const maintenanceIntervalMs = 123_457
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      const mounting = mountBridge(
        new MockAdapter([]), { maintenanceIntervalMs }, undefined,
        (feishu) => { transport = feishu },
        (ctx) => {
          const originalList = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
          let blocked = false
          Object.defineProperty(ctx.sessionPersistence, 'list', {
            configurable: true,
            value: async (...args: Parameters<typeof originalList>) => {
              if (!blocked) {
                blocked = true
                setupSignal = args[0]?.signal
                signalListStarted()
                if (setupSignal === undefined) throw new Error('startup list is missing its abort signal')
                await Promise.race([
                  listGate,
                  new Promise<never>((_resolve, reject) => {
                    setupSignal!.addEventListener('abort', () => {
                      reject(setupSignal!.reason)
                    }, { once: true })
                  }),
                ])
              }
              return originalList(...args)
            },
          })
        },
        (candidate) => { fiber = candidate },
      )
      await listStarted
      const disposing = fiber!.dispose()
      releaseList()
      await mounting
      await disposing

      expect(transport?.startIntakeCalls).toBe(0)
      expect(transport?.markBridgeReadyCalls).toBe(0)
      expect(setupSignal?.aborted).toBe(true)
      expect(intervalSpy.mock.calls.some(([, delay]) => delay === maintenanceIntervalMs)).toBe(false)
    } finally {
      releaseList?.()
      intervalSpy.mockRestore()
    }
  })

  it('settles an approval admitted while startup recovery is still blocked', { timeout: 20_000 }, async () => {
    let transport: StubFeishu | undefined
    let bridgeContext: Context | undefined
    let liveAgent: ReturnType<Context['agents']['get']>
    let fiber: { uid: number | null; dispose: () => Promise<void> } | undefined
    let signalListStarted!: () => void
    const listStarted = new Promise<void>(resolve => { signalListStarted = resolve })
    const mounting = mountBridge(
      new MockAdapter([]), {}, undefined,
      (feishu) => { transport = feishu },
      async (ctx) => {
        bridgeContext = ctx
        const handle = await ctx.agents.create({
          sessionId: 'startup-approval-agent' as never,
          seed: usedSeed(),
          meta: { cwd: (await ctx.sessionPersistence.list())[0]?.header.cwd },
          agentOptions: { provider: 'mock', model: 'm' },
        })
        liveAgent = handle.agent
        const originalList = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
        let blocked = false
        Object.defineProperty(ctx.sessionPersistence, 'list', {
          configurable: true,
          value: async (...args: Parameters<typeof originalList>) => {
            if (!blocked) {
              blocked = true
              const signal = args[0]?.signal
              if (signal === undefined) throw new Error('startup list is missing its abort signal')
              signalListStarted()
              await new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
              })
            }
            return originalList(...args)
          },
        })
      },
      (candidate) => { fiber = candidate },
    )
    await listStarted
    const pendingCards = bridgeContext!.storageDomain.get('feishu_bot')!.table('pending_cards') as unknown as {
      delete: (key: string) => Promise<void>
    }
    const originalDelete = pendingCards.delete.bind(pendingCards)
    let pendingDeleteCount = 0
    pendingCards.delete = async (key) => {
      await originalDelete(key)
      pendingDeleteCount += 1
    }
    await bridgeContext!.storageDomain.get('feishu_bot')!.table('bindings').put('oc_startup_approval', {
      sessionId: 'startup-approval-agent', status: 'active', boundBy: OWNER, boundAt: Date.now(),
    })
    liveAgent!.session.append('approval/asked', {
      id: 'startup-visible-approval' as never,
      toolName: 'Bash',
    })
    const outcome = bridgeContext!.waterfall(
      'approval/request',
      { agent: liveAgent!, toolName: 'Bash' },
      () => Promise.resolve('unavailable' as const),
    )
    await vi.waitFor(() => {
      if (!transport?.cards.some(card => JSON.stringify(card.card).includes('审批请求'))) {
        throw new Error('startup approval card is not visible yet')
      }
    }, { timeout: 2_000, interval: 20 })

    const disposing = fiber!.dispose()

    await expect(Promise.race([
      outcome,
      new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 500)),
    ])).resolves.toBe('unavailable')
    await mounting
    await disposing
    expect(pendingDeleteCount).toBeGreaterThan(0)
    expect(JSON.stringify(transport?.cards.at(-1)?.card)).toContain('已失效')
    expect(transport?.markBridgeReadyCalls).toBe(0)
  })

  it('restart resumes a durable pending outbox segment and advances its watermark', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    await domain.table('outbound_segments').put('oc_chat_1:s-recover:7:0', {
      chatId: 'oc_chat_1', sessionId: 's-recover', sourceEventSeq: 7,
      segmentIndex: 0, segmentCount: 1, text: '重启后续发',
      status: 'pending', attempts: 0, createdAt: Date.now(),
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const recovered = second.ctx.storageDomain.get('feishu_bot')!
    let row: {
      status: string; text: string; attempts: number
    } | undefined
    await vi.waitFor(() => {
      row = recovered.table('outbound_segments').get('oc_chat_1:s-recover:7:0') as typeof row
      if (row?.status !== 'sent') throw new Error(`outbox row is still ${row?.status ?? 'missing'}`)
      if (!Object.values((recovered.global.get() as { watermarks: Record<string, number> }).watermarks).includes(7)) {
        throw new Error('outbox watermark has not advanced yet')
      }
      const cursor = second.ctx.storageDomain.get('feishu_bot_delivery')!
        .table('projection_cursors').get(JSON.stringify(['oc_chat_1', 's-recover'])) as {
          sourceEventSeq?: number
        } | undefined
      if (cursor?.sourceEventSeq !== 7) throw new Error('projection cursor has not advanced yet')
    }, { timeout: 5_000, interval: 10 })
    expect(row).toMatchObject({ status: 'sent', text: '', attempts: 1 })
    const recoveredResult = second.feishu.cards.find(card =>
      JSON.stringify(card.card).includes('重启后续发'))
    expect(recoveredResult?.card).toMatchObject({
      schema: '2.0',
      config: { update_multi: true, wide_screen_mode: true },
      body: {
        direction: 'vertical',
        elements: [
          { tag: 'markdown', content: '**任务已完成 · 最终产出**' },
          { tag: 'markdown', content: '重启后续发' },
        ],
      },
    })
    expect(recoveredResult?.card).not.toHaveProperty('elements')
    expect(Object.values((recovered.global.get() as { watermarks: Record<string, number> }).watermarks))
      .toContain(7)
    expect(second.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('projection_cursors').get(JSON.stringify(['oc_chat_1', 's-recover'])))
      .toMatchObject({ sourceEventSeq: 7 })
  })

  it('stops legacy recovery for a chat when its first pending segment fails', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    await domain.table('outbound_segments').put('oc_legacy:s_legacy:7:0', {
      chatId: 'oc_legacy', sessionId: 's_legacy', sourceEventSeq: 7,
      segmentIndex: 0, segmentCount: 2, text: 'legacy segment zero',
      status: 'pending', attempts: 0, createdAt: Date.now(),
    })
    await domain.table('outbound_segments').put('oc_legacy:s_legacy:7:1', {
      chatId: 'oc_legacy', sessionId: 's_legacy', sourceEventSeq: 7,
      segmentIndex: 1, segmentCount: 2, text: 'legacy segment one',
      status: 'pending', attempts: 0, createdAt: Date.now(),
    })
    await domain.table('outbound_segments').put('oc_legacy:s_legacy:8:0', {
      chatId: 'oc_legacy', sessionId: 's_legacy', sourceEventSeq: 8,
      segmentIndex: 0, segmentCount: 1, text: 'legacy later result',
      status: 'pending', attempts: 0, createdAt: Date.now() + 1,
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root, (feishu) => {
      feishu.nextResultCardError = Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' })
    })
    await second.drain()
    const recovered = second.ctx.storageDomain.get('feishu_bot')!.table('outbound_segments')

    expect(recovered.get('oc_legacy:s_legacy:7:0')).toMatchObject({ status: 'pending', attempts: 1 })
    expect(recovered.get('oc_legacy:s_legacy:7:1')).toMatchObject({ status: 'pending', attempts: 0 })
    expect(recovered.get('oc_legacy:s_legacy:8:0')).toMatchObject({ status: 'pending', attempts: 0 })
    const watermarkKey = JSON.stringify(['oc_legacy', 's_legacy'])
    expect(second.ctx.storageDomain.get('feishu_bot')!.global.get().watermarks[watermarkKey])
      .toBeUndefined()
    expect(second.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('projection_cursors').get(JSON.stringify(['oc_legacy', 's_legacy'])))
      .toBeUndefined()
  })

  it('stops canonical startup recovery for a chat after its first delivery fails', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const delivery = first.ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries')
    const firstKey = JSON.stringify(['oc_canonical_fifo', 's_canonical_fifo', 7, 'result'])
    const secondKey = JSON.stringify(['oc_canonical_fifo', 's_canonical_fifo', 12, 'result'])
    await delivery.put(firstKey, {
      chatId: 'oc_canonical_fifo', sessionId: 's_canonical_fifo', sourceEventSeq: 7,
      text: 'canonical first pending', status: 'pending', attempts: 0, createdAt: Date.now(),
    })
    await delivery.put(secondKey, {
      chatId: 'oc_canonical_fifo', sessionId: 's_canonical_fifo', sourceEventSeq: 12,
      text: 'canonical later pending', status: 'pending', attempts: 0, createdAt: Date.now() + 1,
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root, (feishu) => {
      feishu.nextResultCardError = Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' })
    })
    await second.drain()
    const recovered = second.ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries')

    expect(recovered.get(firstKey)).toMatchObject({ status: 'pending', attempts: 1 })
    expect(recovered.get(secondKey)).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('does not let canonical startup recovery pass a failed legacy row in the same chat', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const legacyKey = 'oc_mixed_fifo:s_legacy:50:0'
    await first.ctx.storageDomain.get('feishu_bot')!.table('outbound_segments').put(legacyKey, {
      chatId: 'oc_mixed_fifo', sessionId: 's_legacy', sourceEventSeq: 50,
      segmentIndex: 0, segmentCount: 1, text: 'mixed legacy first',
      status: 'pending', attempts: 0, createdAt: Date.now(),
    })
    const canonicalKey = JSON.stringify(['oc_mixed_fifo', 's_canonical', 1, 'result'])
    await first.ctx.storageDomain.get('feishu_bot_delivery')!.table('deliveries').put(canonicalKey, {
      chatId: 'oc_mixed_fifo', sessionId: 's_canonical', sourceEventSeq: 1,
      text: 'mixed canonical later', status: 'pending', attempts: 0,
      createdAt: Date.now() + 1,
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root, (feishu) => {
      feishu.nextResultCardError = Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' })
    })
    await second.drain()

    expect(second.ctx.storageDomain.get('feishu_bot')!
      .table('outbound_segments').get(legacyKey)).toMatchObject({ status: 'pending', attempts: 1 })
    expect(second.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('deliveries').get(canonicalKey)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(second.feishu.resultCardAttempts).toHaveLength(1)
    expect(JSON.stringify(second.feishu.resultCardAttempts[0])).toContain('mixed legacy first')
  })

  it('restart prunes stale cursors and watermarks after binding and pending work are gone', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const key = JSON.stringify(['oc_stale', 's_stale'])
    await first.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('projection_cursors').put(key, { sourceEventSeq: 7, updatedAt: 1 })
    await first.ctx.storageDomain.get('feishu_bot')!.global.set({ watermarks: { [key]: 7 } })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {
      projectionCursorRetentionMs: 0,
    }, first.root)
    expect(second.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('projection_cursors').get(key)).toBeUndefined()
    expect(second.ctx.storageDomain.get('feishu_bot')!.global.get().watermarks)
      .not.toHaveProperty(key)
  })

  it('publishes readiness after queuing a blocked startup delivery', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const deliveryKey = JSON.stringify(['oc_startup', 's_startup', 7, 'result'])
    await first.ctx.storageDomain.get('feishu_bot_delivery')!
      .table('deliveries').put(deliveryKey, {
        chatId: 'oc_startup', sessionId: 's_startup', sourceEventSeq: 7,
        text: '启动恢复不能等待网络完成', status: 'pending', attempts: 0, createdAt: Date.now(),
      })
    await first.ctx.fiber.dispose()

    let transport: StubFeishu | undefined
    const restarting = mountBridge(new MockAdapter([]), {}, first.root, (feishu) => {
      transport = feishu
      feishu.blockFirstResultCardCreate = true
    })
    try {
      const outcome = await Promise.race([
        restarting.then(() => 'ready' as const),
        new Promise<'timed-out'>(resolve => setTimeout(() => { resolve('timed-out') }, 1_000)),
      ])
      expect(outcome).toBe('ready')
      await vi.waitFor(() => {
        expect(transport?.resultCardAttempts).toHaveLength(1)
      }, { timeout: 1_000, interval: 10 })
    } finally {
      transport?.releaseResultCardCreate()
      await restarting
    }
  })

  it('restart catches up a terminal assistant message committed while the bridge was offline', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([textResponse('离线期间完成的结果')]))
    const handle = await first.ctx.agents.create({
      sessionId: 'offline-external' as never,
      meta: { cwd: first.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await first.deliver({ text: '/use offline-external' })
    const agent = handle.agent
    await first.bridgeFiber.dispose()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '桥接器离线时执行' }],
      source: { kind: 'user', via: 'feishu' } as never,
    }))
    await agent.whenIdle()
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    await vi.waitFor(() => {
      if (!second.feishu.cards.some(card => JSON.stringify(card.card).includes('离线期间完成的结果'))) {
        throw new Error('offline result has not been delivered yet')
      }
    }, { timeout: 5_000, interval: 10 })
    expect(second.feishu.cards.some(card => JSON.stringify(card.card).includes('离线期间完成的结果')))
      .toBe(true)
  })

  it('restart catches up a long stored log and delivers its final settled task', { timeout: 30_000 }, async () => {
    // Restart catch-up over a log several pages long. NOTE: this does not
    // isolate the paged read — the padding turns are folded and delivered live,
    // so the decisive result reaches the restart as a durable delivery row
    // rather than being found by paging. It pins end-to-end restart behaviour
    // over a long log; the page-boundary contract itself is pinned by
    // tests/session-read.spec.ts.
    const first = await mountBridge(new MockAdapter([textResponse('翻页之后才可见的结果')]))
    const handle = await first.ctx.agents.create({
      sessionId: 'long-paged-offline' as never,
      meta: { cwd: first.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await first.deliver({ text: '/use long-paged-offline' })
    const agent = handle.agent
    // Only the bridge goes away; the agent keeps committing to a real log.
    await first.bridgeFiber.dispose()

    // Padding committed through real turns, so the log is several pages deep.
    for (let round = 0; round < 130; round++) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '填充' }],
        source: { kind: 'user', via: 'feishu' } as never,
      }))
      await agent.whenIdle()
    }
    // The decisive task, now far beyond the first page.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '翻页之后才可见的结果' }],
      source: { kind: 'user', via: 'feishu' } as never,
    }))
    await agent.whenIdle()
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    await vi.waitFor(() => {
      if (!second.feishu.cards.some(card => JSON.stringify(card.card).includes('翻页之后才可见的结果'))) {
        throw new Error('a result beyond the first read window has not been delivered yet')
      }
    }, { timeout: 20_000, interval: 20 })
  })

  it('/use immediately projects an already-running Web task into Feishu', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(new MockAdapter(['hang']))
    const handle = await mounted.ctx.agents.create({
      sessionId: 'running-web-task' as never,
      meta: { cwd: mounted.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '正在 Web 中执行' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    await vi.waitFor(() => {
      if (!handle.agent.session.snapshotEvents().some(event => event.type === 'user/message')) throw new Error('task not started')
    })

    await mounted.deliver({ text: '/use running-web-task' })

    await vi.waitFor(() => {
      if (!mounted.feishu.cards.some(({ card }) => JSON.stringify(card).includes('思考中'))) {
        throw new Error('running task card missing')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('/use seeds the projection cursor at the existing log head without replaying history', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(new MockAdapter([
      textResponse('绑定前的历史结果'),
      textResponse('绑定后的新结果'),
    ]))
    const handle = await mounted.ctx.agents.create({
      sessionId: 'existing-with-history' as never,
      meta: { cwd: mounted.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '先在其他入口执行' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    await handle.agent.whenIdle()
    await mounted.ctx.sessions.flush(handle.agent.session)
    const existingHead = handle.agent.session.snapshotEvents().at(-1)!.seq

    await mounted.deliver({ text: '/use existing-with-history' })

    const deliveryDomain = mounted.ctx.storageDomain.get('feishu_bot_delivery')!
    expect(deliveryDomain.table('projection_cursors')
      .get(JSON.stringify(['oc_chat_1', 'existing-with-history'])))
      .toMatchObject({ sourceEventSeq: existingHead })
    expect(mounted.feishu.cards.some(card => JSON.stringify(card.card).includes('绑定前的历史结果')))
      .toBe(false)

    await mounted.deliver({ text: '绑定后继续执行' })
    await vi.waitFor(() => {
      if (!mounted.feishu.cards.some(card => JSON.stringify(card.card).includes('绑定后的新结果'))) {
        throw new Error('new result was not projected')
      }
    }, { timeout: 5_000, interval: 10 })
    expect(mounted.feishu.cards.some(card => JSON.stringify(card.card).includes('绑定前的历史结果')))
      .toBe(false)
  })

  it('restart resumes a canonical delivery written before its projection cursor advanced', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    await first.deliver({ text: '/new' })
    const binding = first.ctx.storageDomain.get('feishu_bot')!.table('bindings')
      .get('oc_chat_1') as { sessionId: string }
    const deliveryDomain = first.ctx.storageDomain.get('feishu_bot_delivery')
    expect(deliveryDomain).toBeDefined()
    const deliveryKey = JSON.stringify(['oc_chat_1', binding.sessionId, 7, 'result'])
    await deliveryDomain!.table('deliveries').put(deliveryKey, {
      chatId: 'oc_chat_1', sessionId: binding.sessionId, sourceEventSeq: 7,
      text: 'cursor 提交前已经持久化的结果', status: 'pending', attempts: 0,
      createdAt: Date.now(),
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const recovered = second.ctx.storageDomain.get('feishu_bot_delivery')!
    await vi.waitFor(() => {
      const row = recovered.table('deliveries').get(deliveryKey) as {
        status?: string
      } | undefined
      if (row?.status !== 'sent') throw new Error(`canonical delivery is still ${row?.status ?? 'missing'}`)
      const cursor = recovered.table('projection_cursors')
        .get(JSON.stringify(['oc_chat_1', binding.sessionId])) as { sourceEventSeq?: number } | undefined
      if (cursor?.sourceEventSeq !== 7) throw new Error('canonical cursor has not advanced yet')
    }, { timeout: 5_000, interval: 10 })
    expect(second.feishu.cards.some(card => JSON.stringify(card.card).includes('cursor 提交前已经持久化的结果')))
      .toBe(true)
    expect(recovered.table('deliveries').get(deliveryKey)).toMatchObject({
      status: 'sent', text: '', attempts: 1,
    })
    expect(recovered.table('projection_cursors').get(JSON.stringify(['oc_chat_1', binding.sessionId])))
      .toMatchObject({ sourceEventSeq: 7 })
  })

  it('restart abandons an over-TTL pending outbox row without sending its body', { timeout: 20_000 }, async () => {
    const config = { outboundPendingTtlMs: 10 }
    const first = await mountBridge(new MockAdapter([]), config)
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    await domain.table('outbound_segments').put('oc_chat_1:s-stale:9:0', {
      chatId: 'oc_chat_1', sessionId: 's-stale', sourceEventSeq: 9,
      segmentIndex: 0, segmentCount: 1, text: '不应发送的正文',
      status: 'pending', attempts: 2, createdAt: Date.now() - 1_000,
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), config, first.root)
    let row: { status: string; text: string; attempts: number } | undefined
    await vi.waitFor(() => {
      row = second.ctx.storageDomain.get('feishu_bot')!
        .table('outbound_segments').get('oc_chat_1:s-stale:9:0') as typeof row
      if (row?.status !== 'abandoned') throw new Error(`outbox row is still ${row?.status ?? 'missing'}`)
    }, { timeout: 5_000, interval: 10 })
    expect(row).toMatchObject({ status: 'abandoned', text: '', attempts: 2 })
    expect(second.feishu.cards.some(card => JSON.stringify(card.card).includes('不应发送的正文'))).toBe(false)
    expect(second.feishu.sent.some(message => message.text.includes('不应发送的正文'))).toBe(false)
  })

  it('restart rejects an over-TTL received message and clears its text', { timeout: 20_000 }, async () => {
    const config = { recoveryTtlMs: 10 }
    const first = await mountBridge(new MockAdapter([]), config)
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    await domain.table('inbound_events').put('ev_stale_recovery', {
      kind: 'message', chatId: 'oc_chat_1', senderOpenId: OWNER,
      receivedAt: Date.now() - 1_000, status: 'received', text: '不得残留',
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), config, first.root)
    let row: { status: string; text?: string; reason?: string } | undefined
    await vi.waitFor(() => {
      row = second.ctx.storageDomain.get('feishu_bot')!
        .table('inbound_events').get('ev_stale_recovery') as typeof row
      if (row?.status !== 'rejected') throw new Error(`inbound row is still ${row?.status ?? 'missing'}`)
    }, { timeout: 5_000, interval: 10 })
    expect(row).toMatchObject({ status: 'rejected', reason: 'interrupted' })
    expect(row?.text).toBeUndefined()
    expect(second.feishu.sent.at(-1)?.text).toContain('超过恢复期限')
  })

  it('restart marks a binding unavailable when its session no longer exists', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([]))
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    await domain.table('bindings').put('oc_chat_1', {
      sessionId: 'missing-session', status: 'active', boundBy: OWNER, boundAt: Date.now(),
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    await vi.waitFor(() => {
      expect(second.ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
        .toMatchObject({ sessionId: 'missing-session', status: 'unavailable' })
    }, { timeout: 5_000, interval: 10 })
    expect(second.feishu.sent.at(-1)?.text).toContain('已标记为不可用')
  })

  it('restart reconciles a staged /use target by restoring its missing binding once', { timeout: 20_000 }, async () => {
    const first = await mountBridge(new MockAdapter([textResponse('seed persisted session')]))
    await first.deliver({ text: '/new' })
    await first.deliver({ text: '先产生一轮可恢复日志' })
    const domain = first.ctx.storageDomain.get('feishu_bot')!
    const binding = domain.table('bindings').get('oc_chat_1') as { sessionId: string }
    await domain.table('bindings').delete('oc_chat_1')
    await domain.table('inbound_events').put('ev_interrupted_use', {
      kind: 'command', chatId: 'oc_chat_1', senderOpenId: OWNER,
      receivedAt: Date.now(), status: 'received', command: 'use',
      commandArgsHash: 'hash-only', target: binding.sessionId,
    })
    await first.ctx.fiber.dispose()

    const second = await mountBridge(new MockAdapter([]), {}, first.root)
    const recovered = second.ctx.storageDomain.get('feishu_bot')!
    await vi.waitFor(() => {
      expect(recovered.table('bindings').get('oc_chat_1'))
        .toMatchObject({ sessionId: binding.sessionId, status: 'active' })
      expect(recovered.table('inbound_events').get('ev_interrupted_use'))
        .toMatchObject({ status: 'committed', target: binding.sessionId })
    }, { timeout: 5_000, interval: 20 })
    expect(recovered.table('bindings').get('oc_chat_1'))
      .toMatchObject({ sessionId: binding.sessionId, status: 'active' })
    expect(recovered.table('inbound_events').get('ev_interrupted_use'))
      .toMatchObject({ status: 'committed', target: binding.sessionId })
  })

  it('bridge HMR disposal closes its domain and unregisters inbound and approval listeners', { timeout: 20_000 }, async () => {
    const mounted = await mountBridge(new MockAdapter(['hang']))
    const handle = await mounted.ctx.agents.create({
      sessionId: 'hmr-external' as never,
      meta: { cwd: mounted.root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await mounted.deliver({ text: '/use hmr-external' })
    await mounted.deliver({ text: '保持一个开放中的 turn' })
    const agent = handle.agent
    await vi.waitFor(() => { expect(agent.status).toBe('running') }, { timeout: 5_000, interval: 20 })
    const sentBefore = mounted.feishu.sent.length
    expect(mounted.ctx.storageDomain.get('feishu_bot_delivery')).toBeDefined()

    await mounted.bridgeFiber.dispose()
    expect(mounted.ctx.storageDomain.get('feishu_bot')).toBeUndefined()
    expect(mounted.ctx.storageDomain.get('feishu_bot_delivery')).toBeUndefined()
    expect(mounted.feishu.cardHandler).toBeUndefined()
    await mounted.deliver({ text: '/help' })
    expect(mounted.feishu.sent).toHaveLength(sentBefore)
    await expect(mounted.ctx.approval.request({ agent, toolName: 'Bash' }))
      .resolves.toBe('unavailable')
    expect(mounted.feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))).toBe(false)
  })

  it('drives the task fold from the projection registry, not a per-update log scan', { timeout: 20_000 }, async () => {
    // The card path used to re-fold `session.snapshotEvents()` on every update.
    // The fold is now projection-owned: assert the registry actually carries it
    // for a live session, so the read is not silently returning undefined.
    const mounted = await mountBridge(new MockAdapter([]))
    const handle = await mounted.ctx.agents.create({
      sessionId: 'projection-driven' as never,
      agentOptions: { provider: 'mock', model: 'm' },
      meta: { cwd: mounted.root },
    })
    await mounted.deliver({ text: `/use projection-driven` })
    await mounted.deliver({ text: '任务输入' })

    const session = handle.agent.session
    await vi.waitFor(() => {
      const state = mounted.ctx.sessionProjections.stateOf(session, 'feishuTask')
      expect(state).toBeDefined()
      expect(state!.task?.taskMessageId).toBeDefined()
    }, { timeout: 10_000, interval: 20 })
  })
  it('answers a user question from Feishu instead of leaving it to the Web GUI', { timeout: 20_000 }, async () => {
    // Reported: a question asked by the agent could only be answered in the
    // Web GUI; Feishu showed nothing at all, so a phone-only operator was
    // stuck. The bridge must present the question and settle the waterfall.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      {
        agent,
        questions: [{
          id: 'q1',
          question: '要用哪个数据库？',
          options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        }],
      },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('要用哪个数据库'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const questionCard = feishu.cards.findLast(card => JSON.stringify(card.card).includes('要用哪个数据库'))!
    const value = cardButtonValue(questionCard.card, 'Postgres')
    expect(value).toBeDefined()
    await feishu.clickCard(OWNER, questionCard.messageId, value)

    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['Postgres'] }],
    })
  })

  it('accepts a free-text Feishu message as the answer to a pending question', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '项目叫什么名字？' }] },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('项目叫什么名字'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    // The operator simply types the answer; it must not be treated as a new task.
    await deliver({ text: '就叫 dsh-feishu-bot' })

    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '就叫 dsh-feishu-bot' }],
    })
  })

  it('collects every choice for a multi-select question', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      {
        agent,
        questions: [{
          id: 'q1',
          question: '要启用哪些检查？',
          multiSelect: true,
          options: [{ label: 'lint' }, { label: 'typecheck' }],
        }],
      },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('要启用哪些检查'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const card = feishu.cards.findLast(c => JSON.stringify(c.card).includes('要启用哪些检查'))!
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'lint'))
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'typecheck'))

    // Multi-select waits for explicit confirmation rather than settling on the
    // first click, so the operator can revise the set.
    const confirmCard = feishu.cards.findLast(c => JSON.stringify(c.card).includes('确认'))
    await feishu.clickCard(OWNER, confirmCard.messageId, cardButtonValue(confirmCard.card, '确认'))

    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['lint', 'typecheck'] }],
    })
  })

  it('delegates a question for a session no chat is bound to', { timeout: 20_000 }, async () => {
    // A question for a session with no bound chat must not be swallowed: the
    // bridge delegates to the next answerer (the Web GUI) instead. The session
    // is created directly rather than via /new, because /new is exactly what
    // binds a chat and would make the bridge the legitimate answerer.
    const { ctx, root } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'unbound-question' as never,
      agentOptions: { provider: 'mock', model: 'm' },
      seed: usedSeed(),
      meta: { cwd: root },
    })

    const outcome = ctx.waterfall(
      'user-questions/request',
      { agent: handle.agent, questions: [{ id: 'q1', question: '谁来决定？' }] },
      () => Promise.resolve({ answers: [{ id: 'q1', selected: ['web-decided'] }] }),
    )
    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['web-decided'] }],
    })
  })
  it('supersedes an open question when a second one arrives, releasing the first', { timeout: 20_000 }, async () => {
    // One card cannot hold two live question sets apart, so the newer question
    // wins and the older call is released rather than left hanging forever.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const first = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '第一个问题？' }] },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('第一个问题'))) {
        throw new Error('first question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const second = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q2', question: '第二个问题？' }] },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('第二个问题'))) {
        throw new Error('second question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    // The superseded call is released, so its agent is not stuck.
    await expect(first).rejects.toThrow(/not answered in Feishu/)
    // The FIRST question's card must drop its buttons and say it went
    // unanswered. The stub keeps every card version, so assert on the last card
    // that still mentions the superseded question rather than on the newest
    // card overall (which is the second question's).
    await vi.waitFor(() => {
      const superseded = feishu.cards.filter(c => JSON.stringify(c.card).includes('第一个问题')).at(-1)
      expect(JSON.stringify(superseded?.card)).toContain('未作答')
    }, { timeout: 5_000, interval: 20 })

    // The newest question is the one still answerable. Search for the card that
    // still carries a live 跳过 button: the newest version mentioning the
    // question could be a settled card, which has no controls.
    const card = feishu.cards.filter(c => cardButtonValue(c.card, '跳过') !== undefined
      && JSON.stringify(c.card).includes('第二个问题')).at(-1)
    expect(card).toBeDefined()
    await feishu.clickCard(OWNER, card!.messageId, cardButtonValue(card!.card, '跳过'))
    await expect(second).rejects.toThrow(/not answered in Feishu/)
  })

  it('leaves slash commands usable while a question is open', { timeout: 20_000 }, async () => {
    // A question makes a bare message an answer, but /stop and friends must
    // stay available: the operator may need to abandon the turn outright.
    // Two guards enforce this (intake skips commands, and the answer path
    // refuses a leading slash), so removing EITHER alone is masked by the
    // other; this test only goes red when both are gone.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '还继续吗？' }] },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('还继续吗'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    // A command must be handled as a command, not swallowed as the answer.
    await deliver({ text: '/help' })
    await vi.waitFor(() => {
      expect(JSON.stringify(feishu.sent.at(-1)?.text)).toContain('/new')
    }, { timeout: 5_000, interval: 20 })

    // The question is still open, so a plain message still answers it.
    await deliver({ text: '继续' })
    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: '继续' }],
    })
  })
  it('keeps each multi-select pick marked on the card after the click', { timeout: 20_000 }, async () => {
    // Reported live: the button only turned blue at the moment of the click and
    // then reverted, so the operator could not see which options were already
    // chosen. The patch that follows a pick must therefore render the
    // accumulated set, and it must survive a SECOND pick (which is when the
    // first one was observed to be lost).
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      {
        agent,
        questions: [{
          id: 'q1',
          question: '要启用哪些检查？',
          multiSelect: true,
          options: [{ label: 'lint' }, { label: 'typecheck' }, { label: 'unit' }],
        }],
      },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('要启用哪些检查'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const card = feishu.cards.findLast(c => cardButtonValue(c.card, 'lint') !== undefined)!
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'lint'))

    // The newest version of the card must show lint as selected.
    const afterFirst = feishu.cards.filter(c => c.messageId === card.messageId).at(-1)!
    expect(pickStyles(afterFirst.card)).toEqual({ lint: 'primary', typecheck: 'default', unit: 'default' })

    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'typecheck'))

    // Both picks stay marked: the second click must ADD to the set, not reset it.
    const afterSecond = feishu.cards.filter(c => c.messageId === card.messageId).at(-1)!
    expect(pickStyles(afterSecond.card)).toEqual({ lint: 'primary', typecheck: 'primary', unit: 'default' })

    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, '确认'))
    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['lint', 'typecheck'] }],
    })
  })

  it('unmarks an option when it is picked a second time', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      {
        agent,
        questions: [{
          id: 'q1', question: '要启用哪些检查？', multiSelect: true,
          options: [{ label: 'lint' }, { label: 'typecheck' }],
        }],
      },
      () => Promise.reject(new Error('no answerer')),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('要启用哪些检查'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const card = feishu.cards.findLast(c => cardButtonValue(c.card, 'lint') !== undefined)!
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'lint'))
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'lint'))

    const latest = feishu.cards.filter(c => c.messageId === card.messageId).at(-1)!
    expect(pickStyles(latest.card)).toEqual({ lint: 'default', typecheck: 'default' })

    // Toggling everything off and confirming must refuse, not answer emptily.
    const toast = await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, '确认'))
    expect(toast?.toast).toContain('请先选择')
    expect(JSON.stringify(feishu.cards.filter(c => c.messageId === card.messageId).at(-1)!.card))
      .not.toContain('已回答')
    // Still open, so the operator can carry on.
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'typecheck'))
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, '确认'))
    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['typecheck'] }],
    })
  })
  it('lets the Web GUI answer the same question instead of stealing it', { timeout: 20_000 }, async () => {
    // Reported regression: after Feishu gained question support, the Web GUI
    // stopped showing prompts entirely. The bridge registered { prepend: true }
    // and, for a bound chat, returned without calling next() — so the remote
    // (Web) answerer was never consulted. Both channels must be offered the
    // request and whichever answers first must win.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '谁来回答？' }] },
      () => Promise.resolve({ answers: [{ id: 'q1', selected: ['web-gui'] }] }),
    )

    // The Web answer stands even though a Feishu card was also published.
    await expect(outcome).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['web-gui'] }],
    })
    // The Feishu card must be retired, so the question cannot be answered twice.
    await vi.waitFor(() => {
      const settled = feishu.cards.filter(c => JSON.stringify(c.card).includes('谁来回答')).at(-1)
      expect(JSON.stringify(settled?.card)).toContain('未作答')
    }, { timeout: 5_000, interval: 20 })
  })

  it('still answers from Feishu when the Web GUI never answers', { timeout: 20_000 }, async () => {
    // The race must not make Feishu unusable when the Web answerer stays silent
    // (that is the phone-only case the channel exists for).
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const outcome = ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '只从飞书答？', options: [{ label: 'OK' }] }] },
      () => new Promise(() => {}),
    )
    await vi.waitFor(() => {
      if (!feishu.cards.some(card => JSON.stringify(card.card).includes('只从飞书答'))) {
        throw new Error('question card is not visible yet')
      }
    }, { timeout: 5_000, interval: 20 })

    const card = feishu.cards.findLast(c => JSON.stringify(c.card).includes('只从飞书答'))!
    await feishu.clickCard(OWNER, card.messageId, cardButtonValue(card.card, 'OK'))
    await expect(outcome).resolves.toEqual({ answers: [{ id: 'q1', selected: ['OK'] }] })
  })
  it('opens a progress card for a task started in the Web GUI after binding', { timeout: 20_000 }, async () => {
    // Reported: switching back to a session that has a task running in the Web
    // GUI gave no sign of it in Feishu, and no progress was mirrored. Adoption
    // only ran at BINDING time (adoptRunningTask from /use and /ls), so a task
    // started later — the common case — was invisible: the session/event
    // listener dropped every event because no tracker existed for the chat.
    // One scripted reply per turn: the mock throws "script exhausted" and the
    // turn fails otherwise.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('飞书侧任务结果'), textResponse('Web 侧任务完成')]),
    )
    await deliver({ text: '/new' })
    const agent = [...ctx.sessions.list()]
      .map(session => ctx.agents.get(session.id))
      .find(candidate => candidate !== undefined)!

    // Finish a Feishu-originated task first, so the chat holds a FROZEN tracker
    // for it — the state a later Web task has to displace.
    await deliver({ text: '先跑一个飞书任务' })
    await agent.whenIdle()
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('飞书侧任务结果'))) {
        throw new Error('the first task has not settled in Feishu yet')
      }
    }, { timeout: 5_000, interval: 20 })
    const cardsBefore = feishu.cards.length

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '从 Web 发起的新任务' }],
      source: { kind: 'user', via: 'web' } as never,
    }))

    // A card must be opened for the Web-originated task without any new /use or
    // /ls binding, and its result must land in the same chat.
    await agent.whenIdle()
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('Web 侧任务完成'))) {
        throw new Error('Web task result has not reached Feishu yet')
      }
    }, { timeout: 5_000, interval: 20 })

    // The Web task owns exactly one card, tracked under a message id of its
    // own — not the id of the card the finished Feishu task used.
    const webCardIds = new Set(feishu.cards
      .filter(({ card }) => JSON.stringify(card).includes('Web 侧任务完成'))
      .map(card => card.messageId))
    expect(webCardIds.size).toBe(1)
    // Its progress was mirrored onto that card, not sent as a bare text reply.
    expect(feishu.cards.length).toBeGreaterThan(cardsBefore)
    expect(feishu.sent.some(({ text }) => text.includes('Web 侧任务完成'))).toBe(false)
  })
  it('mirrors a Web task that is ALREADY RUNNING when the chat binds to it', { timeout: 20_000 }, async () => {
    // The reported case: a task is already running in the Web GUI, and the
    // operator switches the Feishu chat onto that session ("切换到 web 有任务的
    // 会话"). Binding must adopt the in-flight task and publish its progress,
    // because no session/event will arrive for a turn that started earlier.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter(['hang', textResponse('绑定前就在跑的任务完成')]),
    )
    // Bind a first chat so a session exists, then let it go idle-agnostic.
    await deliver({ text: '/new' })
    const agent = [...ctx.sessions.list()]
      .map(session => ctx.agents.get(session.id))
      .find(candidate => candidate !== undefined)!

    // Start a task from the Web side and leave it RUNNING (adapter hangs).
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Web 侧长任务' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    // Wait until the Web turn is genuinely in flight.
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('思考中'))) {
        throw new Error('the running Web task has no progress card yet')
      }
    }, { timeout: 5_000, interval: 20 })
    const whileRunning = feishu.cards.filter(({ card }) => JSON.stringify(card).includes('思考中')).length

    // Re-bind the chat onto that very session: adoption must re-publish the
    // running task's card rather than leave the session looking idle.
    await deliver({ text: '/use ' + String([...ctx.sessions.list()][0]!.id) })
    await vi.waitFor(() => {
      const resumed = feishu.cards.filter(({ card }) => JSON.stringify(card).includes('思考中')).length
      if (resumed <= whileRunning) throw new Error('binding did not re-publish the running task')
    }, { timeout: 5_000, interval: 20 })
  })
  // The cold-resume path — a task still RUNNING when the process restarts — has
  // no end-to-end test here, and is deliberately not asserted green.
  //
  // Established: catchUpBoundSessions replays settled RESULTS only, so a task
  // that has not finished gets no card at startup. resumeRunningTask() rebuilds
  // the fold from the durable event log and hands it to the card actor, which
  // is what lets a card be opened before the session is resumed.
  //
  // An earlier diagnosis blamed validateBindings() for marking the binding
  // `unavailable`. That was WRONG: it was an artefact of this fixture, whose
  // session never reaches disk. Checked against the real profile, the binding's
  // session artifact is present and the binding stays active.
  //
  // A faithful restart fixture therefore needs a session log that actually
  // persists. tests/zz-cold-resume.spec.ts pins the FOLD against a real log;
  // it does not cover the wiring, so the integration still needs a live check.

  it('reports the last task result when switching to an IDLE session', { timeout: 20_000 }, async () => {
    // The reported need: /ls onto a session that is NOT running must say what
    // that session last did, so the operator knows what they are returning to.
    // Adoption only handled the RUNNING case, so an idle session said nothing
    // about its previous task.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('上次任务的结论：构建已通过')]),
    )
    await deliver({ text: '/new' })
    const sessionId = String([...ctx.sessions.list()][0]!.id)
    await deliver({ text: '跑一下构建' })
    const agent = ctx.agents.get([...ctx.sessions.list()][0]!.id)!
    await agent.whenIdle()

    // Now switch to that (idle) session and expect its last result to be shown.
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('上次任务的结论'))) {
        throw new Error('the previous result was never projected at all')
      }
    }, { timeout: 5_000, interval: 20 })
    const before = feishu.sent.length

    await deliver({ text: `/use ${sessionId}` })
    await vi.waitFor(() => {
      if (feishu.sent.length <= before) {
        throw new Error('switching to an idle session reported nothing about its last task')
      }
    }, { timeout: 5_000, interval: 20 })

    const after = feishu.sent.slice(before).map(({ text }) => text).join('\n')
    expect(after).toContain('上次任务的结论')
  })
  it('shows the running progress when switching to a session that IS working', { timeout: 20_000 }, async () => {
    // The other half of the same need: /ls onto a session with a task in flight
    // must show that task's progress, so the switch answers "what is this doing
    // right now?" as well as "what did it last do?".
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    const sessionId = String([...ctx.sessions.list()][0]!.id)
    const agent = [...ctx.sessions.list()]
      .map(session => ctx.agents.get(session.id))
      .find(candidate => candidate !== undefined)!

    // Start a task from the WEB side and leave it running.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'web 侧长任务' }],
      source: { kind: 'user', via: 'web' } as never,
    }))
    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('思考中'))) {
        throw new Error('the web task never got a progress card')
      }
    }, { timeout: 5_000, interval: 20 })
    const before = feishu.cards.length

    await deliver({ text: `/use ${sessionId}` })
    await vi.waitFor(() => {
      const resumed = feishu.cards.slice(before)
        .some(({ card }) => JSON.stringify(card).includes('思考中'))
      if (!resumed) throw new Error('switching to a busy session showed no progress')
    }, { timeout: 5_000, interval: 20 })
  })
  it('keeps the question card answerable while the Web GUI is NOT answering', { timeout: 20_000 }, async () => {
    // Reported: question cards vanished. The Web race settles the Feishu card
    // the moment the Web answerer resolves — and with no browser attached (or a
    // session outside the browser's scope) `next()` resolves immediately by
    // delegating onward. The card was therefore retired before the operator
    // could ever click it.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    void ctx.waterfall(
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: '这个问题必须能点', options: [{ label: '是' }] }] },
      // The Web side delegates onward instead of answering: no browser here.
      (() => Promise.resolve({ answers: [{ id: 'q1', selected: [] }] })) as never,
    ).catch(() => undefined)

    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('这个问题必须能点'))) {
        throw new Error('the question card never appeared')
      }
    }, { timeout: 5_000, interval: 20 })

    // The operator must still be able to answer it: the card must NOT have been
    // auto-retired to 未作答 just because the Web answerer resolved.
    const live = feishu.cards.filter(({ card }) => {
      const json = JSON.stringify(card)
      return json.includes('这个问题必须能点') && !json.includes('已回答') && !json.includes('未作答')
    })
    expect(live.length).toBeGreaterThan(0)
  })
  it('shows the approval card even when an autonomous reviewer decides instantly', { timeout: 20_000 }, async () => {
    // Reported: approval cards stopped appearing. The composed chain answers
    // such requests on its own — this profile runs `smart-approval`, which has
    // a model decide — so the operator may never see a card at all. This pins
    // that the card is STILL published and then marked as decided elsewhere,
    // rather than being skipped because nothing was pending by then.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()]
      .map(session => ctx.agents.get(session.id))
      .find(candidate => candidate !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-auto-reviewer-1' as never,
      toolName: 'Bash',
    })
    // Stands in for the autonomous reviewer: answers before a human could.
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    const outcome = await ctx.approval.request({ agent, toolName: 'Bash' })
    expect(outcome).toBe('allowed-once')

    // The decision must be visible in the chat: some card must carry it.
    await vi.waitFor(() => {
      const approval = feishu.cards.filter(({ card }) => {
        const json = JSON.stringify(card)
        return json.includes('审批') || json.includes('已在别处决定')
      })
      if (approval.length === 0) {
        throw new Error('an auto-decided approval published no card at all')
      }
      expect(JSON.stringify(approval.at(-1)!.card)).toContain('已在别处决定')
    }, { timeout: 5_000, interval: 20 })
  })

  it('retires the question card when the request times out, so it cannot look answerable', { timeout: 20_000 }, async () => {
    // Reported: a card whose request has expired keeps looking clickable. The
    // timed ask aborts `request.signal` at its deadline, so the bridge is told;
    // what matters is that the CARD is updated to match, otherwise the operator
    // is left with buttons that silently do nothing.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!

    const controller = new AbortController()
    void ctx.waterfall('user-questions/request', {
      agent,
      signal: controller.signal,
      questions: [{ id: 'q1', question: '超时前请回答', options: [{ label: '选项A' }] }],
    }, () => new Promise(() => {})).catch(() => undefined)

    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('超时前请回答'))) {
        throw new Error('the question card never appeared')
      }
    }, { timeout: 5_000, interval: 20 })

    // The deadline passes.
    controller.abort()

    await vi.waitFor(() => {
      const settled = feishu.cards.filter(({ card }) => {
        const json = JSON.stringify(card)
        return json.includes('超时前请回答') && json.includes('未作答')
      })
      if (settled.length === 0) {
        throw new Error('the card still looks answerable after the request expired')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('retires the approval card when the request is abandoned, not just the record', { timeout: 20_000 }, async () => {
    // Reported: an expired approval card keeps looking clickable, and the only
    // way out is the Web GUI. When the request's lifetime ends the card must be
    // updated to say so, or the operator is left clicking a dead button.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']))
    await deliver({ text: '/new' })
    await deliver({ text: '保持一个开放任务' })
    const agent = [...ctx.sessions.list()].map(s => ctx.agents.get(s.id)).find(a => a !== undefined)!
    agent.session.append('approval/asked', {
      id: 'bridge-expiry-1' as never,
      toolName: 'Bash',
    })
    const controller = new AbortController()
    void ctx.waterfall('approval/request', {
      agent, toolName: 'Bash', signal: controller.signal,
    }, () => new Promise(() => {})).catch(() => undefined)

    await vi.waitFor(() => {
      if (!feishu.cards.some(({ card }) => JSON.stringify(card).includes('审批请求'))) {
        throw new Error('the approval card never appeared')
      }
    }, { timeout: 5_000, interval: 20 })

    // The request's lifetime ends (e.g. the tool call timed out).
    controller.abort()

    await vi.waitFor(() => {
      // The group card is COLLAPSED once nothing is pending, and it names the
      // terminal state of the item it held. Asserting on that avoids pinning
      // the internal wording of the expanded form.
      const cards = feishu.cards.map(({ card }) => JSON.stringify(card))
      const retired = cards.filter(json => json.includes('已收纳') && json.includes('已撤回'))
      if (retired.length === 0) {
        throw new Error('the approval card still looks clickable after the request ended')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('reports the last result when binding to a session whose task already finished', { timeout: 20_000 }, async () => {
    // Reported: the operator ran a task in the Web GUI, then bound that session
    // from Feishu. Only the bind confirmation arrived — no progress, and no
    // summary of what the session had just done. The task had already finished,
    // so this is the IDLE branch of the bind report, and it produced nothing.
    const { ctx, feishu, deliver } = await mountBridge(
      new MockAdapter([textResponse('构建已通过，三个包全部成功')]),
    )
    // Build a session in another chat and let its task finish, so the session
    // exists with a settled task but is NOT bound to the chat we will use.
    await deliver({ text: '/new' })
    const sessionId = String([...ctx.sessions.list()][0]!.id)
    await deliver({ text: '跑一下构建' })
    const agent = ctx.agents.get([...ctx.sessions.list()][0]!.id)!
    await agent.whenIdle()
    await deliver({ text: '/release' })
    feishu.cards.length = 0
    feishu.sent.length = 0

    await deliver({ text: `/use ${sessionId}` })

    await vi.waitFor(() => {
      const text = feishu.sent.map(entry => entry.text).join('\n')
      if (!text.includes('空闲') || !text.includes('构建已通过')) {
        throw new Error('binding to an idle session did not report its last result')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('reports a task whose message carries no `via` marker', { timeout: 20_000 }, async () => {
    // Reported with concrete diagnosis: binding to a session that is running a
    // task in the Web GUI produced no progress at all, and the projection held
    // NO task (taskMessageId=null). Such a session's own log shows why — its
    // user messages have `kind: 'user'` but no `via` field at all, because a
    // task started in the Web GUI is not always tagged `via: 'web'`. Requiring
    // the marker meant the task was never recognized, so nothing was reported.
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter(['hang']), { cardThrottleMs: 0 })
    await deliver({ text: '/new' })
    const session = ctx.sessions.list()[0]!
    const append = session.append.bind(session) as unknown as (
      type: string, data: unknown, intent?: { surfaceOp?: 'append' },
    ) => unknown
    feishu.cards.length = 0

    append('turn/start', { turn: 4 })
    // Exactly what the real session log holds: kind 'user', no `via`.
    append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'web 侧任务' }],
      source: { kind: 'user' } as never,
    }), { surfaceOp: 'append' })
    append('tool/call', { turn: 4, step: 1, callId: 'c1', name: 'bash', arguments: '{}' })

    await vi.waitFor(() => {
      const produced = feishu.cards.map(({ card }) => JSON.stringify(card)).join('\n')
      if (!produced.includes('bash') && !produced.includes('运行') && !produced.includes('思考中')) {
        throw new Error('a task without a `via` marker produced no progress card')
      }
    }, { timeout: 5_000, interval: 20 })
  })
  it('/ls does not offer a session that was created but never ran a turn', { timeout: 20_000 }, async () => {
    // Reported against the real GUI: /ls offered 8 sessions in one workspace
    // while the Web GUI showed 1. The 7 extra had never run a turn — their logs
    // hold only the context events every session starts with, no `turn/start`.
    // The GUI hides those (blankness clears at the first `turn/start`), but /ls
    // listed them, so a switch could offer a session with no task to report at
    // all — which is the confusing case this whole area is about.
    const { ctx, feishu, deliver, root, drain } = await mountBridge(new MockAdapter([]))
    const dir = await realpath(root)
    // Two sessions in ONE workspace: one used, one merely created.
    await ctx.agents.create({
      sessionId: 'used-session' as never,
      meta: { cwd: dir },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.agents.create({
      sessionId: 'never-used-session' as never,
      meta: { cwd: dir },
      agentOptions: { provider: 'mock', model: 'm' },
    })

    await deliver({ text: '/ls' })
    const listing = feishu.cards.findLast(item => JSON.stringify(item.card).includes(basename(dir)))!
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    const rendered = JSON.stringify(sessions.card)
    // Both would render as the same unnamed label, so count rows: exactly the
    // one that ran a turn may be offered.
    expect(rendered.split('未命名会话').length - 1).toBe(1)
  })

  it('/ls still offers an idle session whose turn already ran', { timeout: 20_000 }, async () => {
    // The blankness guard must not sweep away real sessions: an idle session
    // that DID run a turn is the normal case a switch exists to answer.
    const { ctx, feishu, deliver, root, drain } = await mountBridge(new MockAdapter([]))
    const dir = await realpath(root)
    await ctx.agents.create({
      sessionId: 'ran-then-stopped' as never,
      meta: { cwd: dir },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      ] as never,
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await deliver({ text: '/ls' })
    const listing = feishu.cards.findLast(item => JSON.stringify(item.card).includes(basename(dir)))!
    await feishu.clickCard(OWNER, listing.messageId, cardActionValue(listing.card, 'workspace'))
    await drain()
    const sessions = feishu.cards.findLast(item => item.messageId === listing.messageId)!
    expect(JSON.stringify(sessions.card).split('未命名会话').length - 1).toBe(1)
  })
})

/** The button style of each option on a question card, keyed by label. */
function pickStyles(card: object): Record<string, string> {
  const styles: Record<string, string> = {}
  for (const element of (card as { elements?: unknown[] }).elements ?? []) {
    const actions = (element as { actions?: unknown }).actions
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      const button = action as { tag?: string; type?: string; text?: { content?: string } }
      if (button.tag !== 'button' || button.text?.content === undefined) continue
      if (button.text.content === '确认' || button.text.content === '跳过') continue
      styles[button.text.content] = button.type ?? 'default'
    }
  }
  return styles
}
