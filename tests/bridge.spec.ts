/**
 * Assembled bridge behavior: full plugin mount over real SessionStore,
 * AgentRegistry, AgentLoop, JSONL persistence, and a JSON storage domain,
 * with a stub `feishu` transport capturing outbound sends. Covers the bridge
 * acceptance flows from M1 through M5: authorization and commands, durable
 * recovery, terminal projection, approvals, retention, and HMR readiness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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
  resultCardAttempts: object[] = []
  failResultCards = false
  failTexts = false
  constructor(ctx: Context) {
    super(ctx, 'feishu')
  }

  async sendText(chatId: string, text: string): Promise<string> {
    if (this.failTexts) throw new Error('simulated text failure')
    this.sent.push({ chatId, text })
    return `om_${this.sent.length}`
  }

  async sendCard(_chatId: string, card: object): Promise<string> {
    if (JSON.stringify(card).includes('最终结果')) {
      this.resultCardAttempts.push(card)
      if (this.failResultCards) throw new Error('simulated result-card failure')
    }
    const messageId = `card_${this.cards.length + 1}`
    this.cards.push({ messageId, card })
    return messageId
  }

  async patchCard(messageId: string, card: object): Promise<void> {
    this.cards.push({ messageId, card })
  }

  cardHandler: ((action: { operatorOpenId: string; chatId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>) | undefined

  handleCardActions(handler: (action: { operatorOpenId: string; chatId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>): void {
    this.cardHandler = handler
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

async function mountBridge(adapter: MockAdapter, configOverrides: object = {}, existingRoot?: string): Promise<{
  ctx: Context
  feishu: StubFeishu
  root: string
  bridgeFiber: { dispose: () => Promise<void> }
  deliver: (message: Partial<FeishuInboundMessage> & { text?: string }) => Promise<void>
  drain: () => Promise<void>
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
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(StubFeishu)
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
  await bridgeFiber.await()
  await vi.waitFor(() => {
    if (ctx.storageDomain.get('feishu_bot') === undefined) throw new Error('bridge domain not mounted yet')
  }, { timeout: 5_000, interval: 10 })
  await vi.waitFor(() => {
    if (ctx.get('feishuBridgeReady') === undefined) throw new Error('bridge startup recovery not settled yet')
  }, { timeout: 5_000, interval: 10 })
  const feishu = ctx.get('feishu') as unknown as StubFeishu
  void feishu

  let eventCounter = 0
  const deliver = async (message: Partial<FeishuInboundMessage> & { text?: string }): Promise<void> => {
    ctx.emit('feishu/message', {
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
      if (count === last) return
      last = count
    }
  }
  return { ctx, feishu, root, bridgeFiber, deliver, drain }
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

  it('result-card creation failure falls back to text without losing the answer', { timeout: 20_000 }, async () => {
    const { ctx, feishu, deliver } = await mountBridge(new MockAdapter([textResponse('不能丢失的回答')]))
    await deliver({ text: '/new' })
    feishu.failResultCards = true

    await deliver({ text: '请给出结果' })

    expect(feishu.resultCardAttempts).toHaveLength(1)
    expect(feishu.sent.some(message => message.text === '不能丢失的回答')).toBe(true)
    const domain = ctx.storageDomain.get('feishu_bot')
    const rows = [...domain!.table('outbound_segments').entries()]
      .map(([, row]) => row as { status: string; text: string; segmentCount: number })
    expect(rows).toEqual([{
      chatId: 'oc_chat_1',
      sessionId: expect.any(String),
      sourceEventSeq: expect.any(Number),
      segmentIndex: 0,
      segmentCount: 1,
      text: '',
      status: 'sent',
      attempts: 1,
      createdAt: expect.any(Number),
    }])
  })

  it('terminal projection uses byte-preflight result-card segments', { timeout: 20_000 }, async () => {
    const answer = 'x'.repeat(30_000)
    const { feishu, deliver } = await mountBridge(new MockAdapter([textResponse(answer)]))
    await deliver({ text: '/new' })

    await deliver({ text: '请返回长结果' })

    const resultCards = feishu.cards.filter(card => JSON.stringify(card.card).includes('最终结果'))
    expect(resultCards).toHaveLength(2)
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

  it('/use by ordinal rejects a stale listing snapshot (M4: TTL)', { timeout: 20_000 }, async () => {
    // Fake only Date: drain() and the per-chat queues need real timers.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { feishu, deliver } = await mountBridge(new MockAdapter([]))
      await deliver({ text: '/new' })
      await deliver({ text: '/release' })
      await deliver({ text: '/ls' })
      expect(feishu.sent.at(-1)!.text).toContain('[1]')
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

  it('/ls groups by workspace with numbers; /use <n> binds by number', { timeout: 20_000 }, async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ text: '/new' })          // create one session so /ls has a row
    await deliver({ text: '/release' })
    await deliver({ text: '/ls' })
    const listing = feishu.sent.at(-1)!.text
    expect(listing).toContain('[1]')          // numbered entry
    expect(listing).toContain('📁')           // workspace group header
    await deliver({ text: '/use 1' })
    expect(feishu.sent.at(-1)!.text).toContain('已绑定')
    await deliver({ text: '/status' })
    expect(feishu.sent.at(-1)!.text).toContain('绑定：')
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
    const listing = feishu.sent.at(-1)!.text
    expect(listing).not.toContain('outside-session')
    expect(listing).not.toContain(outside)
    expect(listing).toContain(root)
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
    await deliver({ eventId: 'ev_non_text', text: undefined })
    await deliver({ eventId: 'ev_non_text', text: undefined })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('非文本')
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
    }, { timeout: 5_000, interval: 10 })
    expect(row).toMatchObject({ status: 'sent', text: '', attempts: 1 })
    expect(second.feishu.cards.some(card => JSON.stringify(card.card).includes('重启后续发'))).toBe(true)
    expect(Object.values((recovered.global.get() as { watermarks: Record<string, number> }).watermarks))
      .toContain(7)
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
    expect(mounted.ctx.get('feishuBridgeReady')).toEqual({ domainName: 'feishu_bot' })

    await mounted.bridgeFiber.dispose()
    expect(mounted.ctx.storageDomain.get('feishu_bot')).toBeUndefined()
    expect(mounted.ctx.get('feishuBridgeReady')).toBeUndefined()
    await mounted.deliver({ text: '/help' })
    expect(mounted.feishu.sent).toHaveLength(sentBefore)
    await expect(mounted.ctx.approval.request({ agent, toolName: 'Bash' }))
      .resolves.toBe('unavailable')
    expect(mounted.feishu.cards.some(card => JSON.stringify(card.card).includes('审批请求'))).toBe(false)
  })
})
