/**
 * Equivalence contract for the bounded paged session reader.
 *
 * The bridge's delivery catch-up used to read a live session through the
 * deprecated `session.snapshotEvents()`. It moved to explicit asynchronous
 * pagination because it needs a historical window, not current state. That
 * makes the paged reader load-bearing, so its output must equal the in-memory
 * history slice it replaced — including page boundaries, which is where an
 * off-by-one would silently drop or duplicate a delivery.
 *
 * `snapshotEvents()` is deprecated for production callers but explicitly
 * allowed in test files, which is what makes it usable as the oracle here.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { SESSION_READ_PAGE, readSessionEventsFrom } from '../src/bridge/session-read.ts'
import { foldFeishuTaskResults } from '../src/bridge/task-card.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const dirs: string[] = []
const roots: Context[] = []
async function mount(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-paged-'))
  dirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('填充回复'), textResponse('页尾的最终结果')]))
  return { ctx, root }
}

/** Append `count` balanced turns so the session has a long, real log. */
function appendTurns(session: { append: (type: string, data: unknown) => unknown }, count: number): void {
  for (let turn = 1; turn <= count; turn++) {
    session.append('turn/start', { turn })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

async function dispose(): Promise<void> {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}

describe('bounded paged session reader', () => {
  it('reads a whole log across several pages', async () => {
    const { ctx } = await mount()
    const sessionId = SessionId('paged-multi')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'm' } })
    const session = handle.agent.session
    // More events than one page, so the loop must iterate.
    appendTurns(session, SESSION_READ_PAGE)
    await ctx.sessions.flush(session)

    const expected = session.snapshotEvents()
    expect(expected.length).toBeGreaterThan(SESSION_READ_PAGE)

    const read = await readSessionEventsFrom(
      id => ctx.sessionPersistence.open(id, 'read'), sessionId, 0)
    expect(read.map(event => event.seq)).toEqual(expected.map(event => event.seq))
    expect(read.map(event => event.type)).toEqual(expected.map(event => event.type))
    await dispose()
  })

  it('starts at fromSeq and matches the equivalent in-memory slice', async () => {
    const { ctx } = await mount()
    const sessionId = SessionId('paged-from')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'm' } })
    const session = handle.agent.session
    appendTurns(session, 3)
    await ctx.sessions.flush(session)

    const all = session.snapshotEvents()
    for (const fromSeq of [0, 1, 2, 3, all.length - 1, all.length, all.length + 50]) {
      const expected = all.filter(event => event.seq >= fromSeq)
      const read = await readSessionEventsFrom(
        id => ctx.sessionPersistence.open(id, 'read'), sessionId, fromSeq)
      expect(read.map(event => event.seq), `fromSeq=${fromSeq}`).toEqual(expected.map(event => event.seq))
    }
    await dispose()
  })

  it('a task starting beyond the first page still reaches the delivery fold', async () => {
    // The reason paging the stored log matters: delivery catch-up folds the
    // window it reads. If a read stopped after the first page, a task whose
    // start lies past that page would never be folded and never be delivered.
    // This drives the real fold over a paged read of a real long log.
    const { ctx } = await mount()
    const sessionId = SessionId('paged-fold')
    const handle = await ctx.agents.create({
      sessionId, agentOptions: { provider: 'mock', model: 'm' },
    })
    const session = handle.agent.session
    // Commit real turns through the loop so the log is a valid event sequence.
    for (let round = 0; round < 130; round++) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: '填充' }],
        source: { kind: 'user', via: 'feishu' } as never,
      }))
      await handle.agent.whenIdle()
    }
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '页尾的最终结果' }],
      source: { kind: 'user', via: 'feishu' } as never,
    }))
    await handle.agent.whenIdle()
    await ctx.sessions.flush(session)

    const all = session.snapshotEvents()
    expect(all.length).toBeGreaterThan(SESSION_READ_PAGE)

    const read = await readSessionEventsFrom(
      id => ctx.sessionPersistence.open(id, 'read'), sessionId, 0)
    // The paged read must carry every event the fold needs, including the
    // decisive task that begins past the first page.
    expect(read.map(event => event.seq)).toEqual(all.map(event => event.seq))
    const inMemory = foldFeishuTaskResults(all as never, 0)
    const paged = foldFeishuTaskResults(read as never, 0)
    expect(paged.results).toEqual(inMemory.results)
    expect(JSON.stringify(paged.results)).toContain('页尾的最终结果')
    await dispose()
  })

  it('returns exactly one full page without dropping the next', async () => {
    // A page-aligned log is the off-by-one case: a loop that stops on
    // `events.length === PAGE` instead of a short/empty page is still correct
    // here, but a loop that stops on `>=` would loop forever. Both are pinned.
    const { ctx } = await mount()
    const sessionId = SessionId('paged-exact')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'm' } })
    const session = handle.agent.session
    appendTurns(session, SESSION_READ_PAGE / 2)
    await ctx.sessions.flush(session)

    const all = session.snapshotEvents()
    expect(all.length).toBe(SESSION_READ_PAGE)
    const read = await readSessionEventsFrom(
      id => ctx.sessionPersistence.open(id, 'read'), sessionId, 0)
    expect(read).toHaveLength(all.length)
    expect(read.map(event => event.seq)).toEqual(all.map(event => event.seq))
    await dispose()
  })

  it('an empty session reads as empty', async () => {
    const { ctx } = await mount()
    const sessionId = SessionId('paged-empty')
    const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'm' } })
    await ctx.sessions.flush(handle.agent.session)

    const read = await readSessionEventsFrom(
      id => ctx.sessionPersistence.open(id, 'read'), sessionId, 0)
    expect(read).toEqual([])
    await dispose()
  })

  it('closes its handle even when a read rejects', async () => {
    let closed = false
    await expect(readSessionEventsFrom(async () => ({
      read: async () => { throw new Error('read failed') },
      close: async () => { closed = true },
    }), SessionId('paged-fail'), 0)).rejects.toThrow('read failed')
    expect(closed).toBe(true)
  })

  it('does not fetch a further page once a short page ends the log', async () => {
    const pages: number[] = []
    const read = await readSessionEventsFrom(async () => ({
      read: async (offset = 0) => {
        pages.push(offset)
        // Three events total, well under one page.
        const events = Array.from({ length: Math.max(0, 3 - offset) }, (_, i) => ({
          seq: offset + i, time: 0, type: 'turn/start', data: { turn: 1 },
        }))
        return { events }
      },
      close: async () => {},
    }), SessionId('paged-short'), 0)
    expect(read.map(event => event.seq)).toEqual([0, 1, 2])
    expect(pages).toEqual([0])
  })

  it('terminates when the log is an exact multiple of the page size', async () => {
    const pages: number[] = []
    const read = await readSessionEventsFrom(async () => ({
      read: async (offset = 0) => {
        pages.push(offset)
        // Two full pages then the end: the loop must issue one final read.
        const remaining = Math.max(0, SESSION_READ_PAGE * 2 - offset)
        const events = Array.from({ length: Math.min(SESSION_READ_PAGE, remaining) }, (_, i) => ({
          seq: offset + i, time: 0, type: 'turn/start', data: { turn: 1 },
        }))
        return { events }
      },
      close: async () => {},
    }), SessionId('paged-multiple'), 0)
    expect(read).toHaveLength(SESSION_READ_PAGE * 2)
    expect(pages).toEqual([0, SESSION_READ_PAGE, SESSION_READ_PAGE * 2])
  })
})
