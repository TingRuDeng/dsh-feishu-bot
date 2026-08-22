/**
 * Bridge resolver behavior against the assembled runtime (design §6.6):
 * live hit never carries dispose authority; cold resume does; concurrent
 * resolutions share one resume with single dispose authority; a disposed
 * created-here agent leaves the registry; missing sessions and
 * subagent-owned sessions reject with stable codes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { createBridgeAgentResolver } from '../src/bridge/resolver.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function mount(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const agentOptions = { provider: 'mock', model: 'm' }

function balancedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-resolver-'))
  dirs.push(root)
  return root
}

/** Persist a cold resumable session then drop the writing context. */
async function persistCold(root: string, sessionId: SessionId): Promise<void> {
  const ctx = await mount(root, new MockAdapter([]))
  // A resumable target is always project-backed: inspectApiRemoteSession
  // rejects a cwd-less header as not-found (api/remotes/agent-lookup.ts:103).
  const session = ctx.sessions.create(sessionId, { seed: balancedTurn(), meta: { cwd: root } })
  await ctx.sessions.flush(session)
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
}

describe('bridge agent resolver (assembled)', () => {
  it('live agent resolves as existing without dispose authority', async () => {
    const ctx = await mount(await newRoot(), new MockAdapter([]))
    const sessionId = SessionId('resolver-live')
    await ctx.agents.create({ sessionId, agentOptions })
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)

    const result = await resolve(sessionId)
    if ('error' in result) throw new Error(`unexpected: ${result.error.code}`)
    expect(result.ownership).toBe('existing')
    expect(result.dispose).toBeUndefined()
    expect(result.agent.session.id).toBe(sessionId)
  })

  it('cold session resumes as created-here; dispose releases it', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-cold')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([textResponse('hi')]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)

    const result = await resolve(sessionId)
    if ('error' in result) throw new Error(`unexpected: ${result.error.code}`)
    expect(result.ownership).toBe('created-here')
    expect(ctx.agents.get(sessionId)).toBe(result.agent)

    // The resumed agent is functional: a followup is consumed normally.
    const message = createUserMessage({
      content: [{ type: 'text', text: 'after resume' }],
      source: { kind: 'plugin', plugin: 'feishu-bot' },
    })
    result.agent.followup(message)
    await result.agent.whenIdle()
    expect(result.agent.session.events.some(e => e.type === 'user/message'
      && (e.data as { id: string }).id === message.id)).toBe(true)

    await result.dispose!()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('concurrent resolutions share one resume; only the initiator holds dispose', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-race')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)

    const [first, second] = await Promise.all([resolve(sessionId), resolve(sessionId)])
    if ('error' in first || 'error' in second) throw new Error('unexpected error')
    expect(first.agent).toBe(second.agent)
    const owners = [first, second].filter(r => r.ownership === 'created-here')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.dispose).toBeDefined()
  })

  it('missing session rejects with session-not-found', async () => {
    const ctx = await mount(await newRoot(), new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const result = await resolve(SessionId('resolver-missing'))
    if ('agent' in result) throw new Error('unexpected agent')
    expect(result.error.code).toBe('session-not-found')
  })

  it('subagent-origin session rejects with agent-busy (ownership fence)', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-subagent')
    const writer = await mount(root, new MockAdapter([]))
    const session = writer.sessions.create(sessionId, {
      seed: balancedTurn(),
      meta: { cwd: root, origin: 'subagent' },
    })
    await writer.sessions.flush(session)
    await writer.fiber.dispose()
    contexts.splice(contexts.indexOf(writer), 1)

    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const result = await resolve(sessionId)
    if ('agent' in result) throw new Error('unexpected agent')
    expect(result.error.code).toBe('agent-busy')
  })

  it('reclassifies a failed resume after a subagent session wins publication', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-subagent-resume-race')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const attached = ctx.sessions.prepare(sessionId, { seed: balancedTurn(), meta: { cwd: root, origin: 'subagent' } })
    const originalGet = ctx.sessions.get.bind(ctx.sessions)
    let published = false
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => (
      published && id === sessionId ? attached : originalGet(id)
    ))
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
      published = true
      throw new Error('session id already published')
    })

    const result = await resolve(sessionId)

    expect(resume).toHaveBeenCalledOnce()
    if ('agent' in result) throw new Error('unexpected agent')
    expect(result.error.code).toBe('agent-busy')
  })

  it('after the created-here agent is disposed, a new resolve resumes again', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-rebind')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)

    const first = await resolve(sessionId)
    if ('error' in first) throw new Error('unexpected')
    await first.dispose!()
    const second = await resolve(sessionId)
    if ('error' in second) throw new Error('unexpected')
    expect(second.ownership).toBe('created-here')
    expect(second.agent).not.toBe(first.agent)
    await second.dispose!()
  })
})
