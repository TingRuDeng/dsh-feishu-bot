/**
 * Assembled bridge behavior: full plugin mount over real SessionStore,
 * AgentRegistry, AgentLoop, JSONL persistence, and a JSON storage domain,
 * with a stub `feishu` transport capturing outbound sends. Covers the bridge
 * acceptance flows from M1 through M5: authorization and commands, durable
 * recovery, terminal projection, approvals, retention, and HMR readiness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import LlmRuntime, { createMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
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
}> {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
  if (existingRoot === undefined) dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(UserApproval)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const titleFromEvents = (events: readonly { type: string; data: unknown }[]): string | null => {
    const event = events.findLast(item => item.type === 'session/title')
    const title = (event?.data as { title?: unknown } | undefined)?.title
    return typeof title === 'string' && title.length > 0 ? title : null
  }
  ctx.provide('sessionProjections' as never, {
    snapshot: (session: { events: readonly { type: string; data: unknown }[]; seq: number }) => ({
      asOfSeq: session.seq - 1,
      values: { title: titleFromEvents(session.events) },
    }),
  } as never)
  ctx.provide('sessionProjectionCache' as never, {
    coldSnapshot: async (sessionId: string) => {
      const stored = await ctx.sessionPersistence.readFrom(sessionId as never, 0)
      return {
        asOfSeq: stored.events.at(-1)?.seq ?? -1,
        values: { title: titleFromEvents(stored.events) },
      }
    },
  } as never)
  const archivedSessionIds = new Set<string>()
  ctx.provide('agentDefaultModel', {
    currentSelection: defaultSelection ?? (() => ({ provider: 'mock', model: 'm' })),
  })
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archivedSessionIds] },
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

  it('full loop: /new binds, text reaches the model, reply reaches the chat', { timeout: 20_000 }, async () => {
    const { feishu, root, deliver } = await mountBridge(new MockAdapter([textResponse('模型的回答')]))
    await deliver({ text: '/new' })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('已创建并绑定')

    await deliver({ text: '请帮我做一件事' })
    const result = feishu.cards.find(c => JSON.stringify(c.card).includes('最终结果'))
    expect(result).toBeDefined()
    const card = result!.card as {
      header: { title: { content: string }; template: string }
      elements: { text: { content: string } }[]
    }
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: `${basename(root)} · 最终结果 · 1/1` },
      template: 'green',
    })
    expect(card.elements[0]!.text.content).toBe('模型的回答')
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
      const session = first.ctx.sessions.create(coldSessionId as never, {
        seed: [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ] as never,
        meta: { cwd: first.root },
      })
      await first.ctx.sessions.flush(session)
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
    expect(feishu.sent.some(message => message.text === '不能丢失的回答')).toBe(true)
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
    expect(finalJson).toContain('✅ 已允许（本次）')
    expect(finalJson).toContain('❌ 已拒绝')
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
      const { feishu, deliver, drain } = await mountBridge(new MockAdapter([]))
      await deliver({ text: '/new' })
      await deliver({ text: '/new' })
      await deliver({ text: '/release' })
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
    expect(feishu.sent.at(-1)!.text).toContain('未绑定')
    await deliver({ text: '/new' })
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定：')
    await deliver({ text: '/release' })
    expect(feishu.sent.at(-1)!.text).toContain('已解绑')
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('未绑定')
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
    const session = first.ctx.sessions.create(coldSessionId as never, {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(session)
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
    const session = first.ctx.sessions.create(coldSessionId as never, {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(session)
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
    const session = first.ctx.sessions.create(coldSessionId as never, {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(session)
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
    const session = first.ctx.sessions.create(coldSessionId as never, {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(session)
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
    const session = first.ctx.sessions.create(coldSessionId as never, {
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as never,
      meta: { cwd: first.root },
    })
    await first.ctx.sessions.flush(session)
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
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.agents.create({
      sessionId: 'newer-binding' as never,
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
      for (const event of agent.session.events) {
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
    const { feishu, root, deliver, drain } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new' })
    await deliver({ text: '/new' })          // two rows keep this workspace in navigation mode
    await deliver({ text: '/release' })
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
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    alphaHandle.agent.session.append('session/title' as never, {
      title: 'Alpha 的真实标题', messageSeqs: [], source: { kind: 'user' },
    } as never)
    const alphaSecond = await ctx.agents.create({
      sessionId: 'alpha-session-2' as never,
      meta: { cwd: alpha },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    alphaSecond.agent.session.append('session/title' as never, {
      title: 'Alpha 的第二个标题', messageSeqs: [], source: { kind: 'user' },
    } as never)
    const betaHandle = await ctx.agents.create({
      sessionId: 'beta-session' as never,
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
    const sessionValue = cardButtonValue(sessionCard.card, '1. Alpha 的真实标题')
      ?? cardButtonValue(sessionCard.card, '2. Alpha 的真实标题')
    expect(sessionValue).toMatchObject({
      action: 'select', workspaceIndex: (workspaceValue as { index: number }).index,
      index: expect.any(Number),
    })
  })

  it('/ls disambiguates duplicate workspace basenames without exposing parent paths', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    const left = join(root, 'left', 'shared')
    const right = join(root, 'right', 'shared')
    await mkdir(left, { recursive: true })
    await mkdir(right, { recursive: true })
    await ctx.agents.create({
      sessionId: 'left-shared-session' as never,
      meta: { cwd: left },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.agents.create({
      sessionId: 'right-shared-session' as never,
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
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    handle.agent.session.append('session/title' as never, {
      title: '排查飞书任务失败', messageSeqs: [], source: { kind: 'user' },
    } as never)
    await ctx.agents.create({
      sessionId: 'live-title-filler' as never,
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
    expect(cardButtonValue(sessions.card, '1. 排查飞书任务失败')
      ?? cardButtonValue(sessions.card, '2. 排查飞书任务失败')).toBeDefined()
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
    expect(feishu.sent.at(-1)?.text).toContain('[1] 卡片失败时仍可选择')
    expect(feishu.sent.at(-1)?.text).toContain('/use <编号>')
  })

  it('/ls does not send a text duplicate after an ambiguous card-create timeout', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: 'ambiguous-card-timeout' as never,
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
    expect(ctx.storageDomain.get('feishu_bot')!.table('bindings').get('oc_chat_1'))
      .toMatchObject({ sessionId: 'click-bind-target', status: 'active', boundBy: OWNER })
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
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([]), {
      allowedOpenIds: [OWNER, OTHER],
    })
    await deliver({ text: '/new' })
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
    expect(feishu.sent.at(-1)?.text).toBe('已绑定「必须收到终态的会话」。直接发送消息即可继续任务。')
  })

  it('/use <n> without a prior /ls explains the numbering is stale', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/use 3' })
    expect(feishu.sent.at(-1)!.text).toContain('/ls')
  })

  it('/ls lists only sessions under allowedWorkspaces (design §6.6)', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver } = await mountBridge(new MockAdapter([]))
    // A session whose cwd lies OUTSIDE the allowed roots must not be listed
    // and must not be bindable by number.
    const outside = await mkdtemp(join(tmpdir(), 'outside-ws-'))
    dirs.push(outside)
    const handle = await ctx.agents.create({
      sessionId: 'outside-session' as never,
      meta: { cwd: outside },
      agentOptions: { provider: 'mock', model: 'm' },
    })
    await ctx.sessions.flush(handle.agent.session)
    await deliver({ text: '/new' })   // one inside-workspace session
    await deliver({ text: '/release' })
    await deliver({ text: '/ls' })
    const listing = feishu.cards.find(item => JSON.stringify(item.card).includes('选择工作空间'))
    expect(listing).toBeDefined()
    const listingJson = JSON.stringify(listing!.card)
    expect(listingJson).not.toContain('outside-session')
    expect(listingJson).not.toContain(outside)
    expect(listingJson).toContain(basename(root))
  })

  it('/ls hides archived sessions', { timeout: 20_000 }, async () => {
    const { ctx, feishu, root, deliver, archiveSession } = await mountBridge(new MockAdapter([]))
    for (const sessionId of ['visible-session', 'archived-session']) {
      const handle = await ctx.agents.create({
        sessionId: sessionId as never,
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
        sessionProjections: { snapshot: () => ({ values: {} }) },
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
        sessionProjections: { snapshot: () => ({ values: {} }) },
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
                setupSignal = args[0]
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
          meta: { cwd: (await ctx.sessionPersistence.list())[0]?.cwd },
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
              const signal = args[0]
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
    expect(second.feishu.cards.some(card => JSON.stringify(card.card).includes('重启后续发'))).toBe(true)
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
    const existingHead = handle.agent.session.events.at(-1)!.seq

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
})
