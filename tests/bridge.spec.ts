/**
 * Assembled bridge behavior: full plugin mount over real SessionStore,
 * AgentRegistry, AgentLoop, JSONL persistence, and a JSON storage domain,
 * with a stub `feishu` transport capturing outbound sends. Covers the M1
 * acceptance flows: allowlist, /help, /new authorization, /use + text
 * round-trip (assistant reply reaches the chat), /status, /release,
 * dedup, and non-p2p rejection.
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
  constructor(ctx: Context) {
    super(ctx, 'feishu')
  }

  async sendText(chatId: string, text: string): Promise<string> {
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

  cardHandler: ((action: { operatorOpenId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>) | undefined

  handleCardActions(handler: (action: { operatorOpenId: string; messageId: string; value: unknown }) => Promise<{ toast?: string } | undefined>): void {
    this.cardHandler = handler
  }

  /** Test hook: simulate a card button click. */
  async clickCard(operatorOpenId: string, messageId: string, value: unknown): Promise<{ toast?: string } | undefined> {
    if (this.cardHandler === undefined) throw new Error('no card handler registered')
    return this.cardHandler({ operatorOpenId, messageId, value })
  }
}

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const OWNER = 'ou_test_owner'

async function mountBridge(adapter: MockAdapter, configOverrides: object = {}): Promise<{
  ctx: Context
  feishu: StubFeishu
  root: string
  deliver: (message: Partial<FeishuInboundMessage> & { text?: string }) => Promise<void>
  drain: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-bridge-'))
  dirs.push(root)
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
  await ctx.plugin(bridge, {
    allowedOpenIds: [OWNER],
    allowedWorkspaces: [root],
    defaultWorkspace: root,
    freshnessMs: 600_000,
    cardThrottleMs: 1_000,
    agentProvider: 'mock',
    agentModel: 'm',
    ...configOverrides,
  })
  // Bridge mount is async behind apply(); give its domain open a beat.
  await new Promise(resolve => setTimeout(resolve, 50))
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
  return { ctx, feishu, root, deliver, drain }
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

  it('duplicate event ids are consumed once (at-least-once dedup)', async () => {
    const { feishu, deliver } = await mountBridge(new MockAdapter([]))
    await deliver({ eventId: 'ev_dup', text: '/help' })
    await deliver({ eventId: 'ev_dup', text: '/help' })
    expect(feishu.sent).toHaveLength(1)
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
    await deliver({ text: undefined })
    expect(feishu.sent).toHaveLength(1)
    expect(feishu.sent[0]!.text).toContain('非文本')
  })
})
