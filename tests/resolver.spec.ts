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
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf } from '@deepseek-ai/dsh-scope'
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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const agentOptions = { provider: 'mock', model: 'm' }

/**
 * Mount the real agent-preset registry with a `standard` preset that declares
 * real tool plugins, mirroring how the shipped web profile composes agents.
 * Tools reach an agent ONLY through such a preset, which is why a session
 * created without one has almost none.
 */
async function mountPresetRegistry(ctx: Context): Promise<void> {
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.plugin({
    inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.agentPresets.register({
        id: 'standard',
        plugins: [
          // `tool-todo` needs only `tools` + `sessionProjections`, both already
          // in this fixture; `tool-bash`/`tool-fs` additionally need `shell`/`fs`
          // services the fixture does not mount.
          {
            id: 'tool-todo',
            name: '@deepseek-ai/dsh-tool-todo',
            config: { allowParallelInProgress: true },
          },
        ],
      })
    },
  })
}

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
  // A resumable target is always project-backed: the persistence contract
  // rejects a cwd-less header as not-found. AgentLoop owns the stored handle,
  // so the session must be created through the agent registry.
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions,
    seed: balancedTurn(),
    meta: { cwd: root },
  })
  await handle.dispose()
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
      source: { kind: 'user' },
    })
    result.agent.followup(message)
    await result.agent.whenIdle()
    expect(result.agent.session.snapshotEvents().some(e => e.type === 'user/message'
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

  it('maps a latest persistence not-found race to session-not-found', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-persistence-not-found-race')
    const ctx = await mount(root, new MockAdapter([]))
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('session persistence was not mounted')
    vi.spyOn(persistence, 'list').mockResolvedValue([{
      header: { version: 0, id: sessionId, createdAt: 1, cwd: root },
      revision: 0,
    } as never])
    const notFound = new Error(`session "${sessionId}" not found`)
    notFound.name = 'SessionPersistenceNotFoundError'
    vi.spyOn(persistence, 'open').mockRejectedValue(notFound)

    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const result = await resolve(sessionId)

    if ('agent' in result) throw new Error('unexpected agent')
    expect(result.error.code).toBe('session-not-found')
  })

  it('subagent-origin session rejects with agent-busy (ownership fence)', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-subagent')
    const writer = await mount(root, new MockAdapter([]))
    const handle = await writer.agents.create({
      sessionId,
      agentOptions,
      seed: balancedTurn(),
      meta: { cwd: root, origin: 'subagent' },
    })
    await handle.dispose()
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

  it('rejects an attached subagent found after inspection before resuming', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-subagent-inspect-race')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const attached = ctx.sessions.prepare(sessionId, { seed: balancedTurn(), meta: { cwd: root, origin: 'subagent' } })
    const originalGet = ctx.sessions.get.bind(ctx.sessions)
    let published = false
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => (
      published && id === sessionId ? attached : originalGet(id)
    ))
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('session persistence was not mounted')
    const originalOpen = persistence.open.bind(persistence)
    vi.spyOn(persistence, 'open').mockImplementation(async (id, access) => {
      const handle = await originalOpen(id, access)
      published = true
      return handle
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await resolve(sessionId)

    if ('agent' in result) throw new Error('unexpected agent')
    expect(result.error.code).toBe('agent-busy')
    expect(resume).not.toHaveBeenCalled()
  })

  it('fences a subagent winner before setup publication commit', async () => {
    const root = await newRoot()
    const sessionId = SessionId('resolver-subagent-setup-commit')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)
    const attached = ctx.sessions.prepare(sessionId, { seed: balancedTurn(), meta: { cwd: root, origin: 'subagent' } })
    const originalGet = ctx.sessions.get.bind(ctx.sessions)
    let published = false
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => (
      published && id === sessionId ? attached : originalGet(id)
    ))
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async options => {
      if (options.setup === undefined) throw new Error('setup was not forwarded')
      const commit = await options.setup(ctx.extend())
      published = true
      commit?.commit()
      return {
        agent: { id: sessionId, session: attached, status: 'idle', ctx: ctx.extend() } as Agent,
        dispose: async () => {},
      }
    })

    const result = await resolve(sessionId, async () => {})

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

  it('the preset fixture itself supplies tools (control)', async () => {
    // Proves the fixture below is not measuring a broken preset: hand-mounting
    // the same preset on an agent that has nothing to do with the bridge must
    // add its declared tool. Without this, a green test would be no evidence.
    const root = await newRoot()
    const ctx = await mount(root, new MockAdapter([]))
    await mountPresetRegistry(ctx)
    const probe = await ctx.agents.create({ sessionId: SessionId('resolver-preset-control') })
    expect(ctx.tools.schemas(scopeOf(probe.agent.ctx)).map(s => s.name))
      .not.toContain('todo_write')
    await ctx.agentPresets.mount(probe.agent.ctx, 'standard')
    expect(ctx.tools.schemas(scopeOf(probe.agent.ctx)).map(s => s.name))
      .toContain('todo_write')
    await probe.dispose()
  })

  it('a bridge-resolved agent receives the profile preset\'s tools', async () => {
    // Tools are mounted by an AGENT PRESET, not by the profile patch: the Web
    // GUI composes agents through the preset registry, and a session created
    // without one gets only the base-scoped tools. A Feishu /new session could
    // read and change directory but not run a command or read a file, so the
    // bridge must mount the same preset the GUI would.
    const root = await newRoot()
    const sessionId = SessionId('resolver-preset-tools')
    await persistCold(root, sessionId)
    const ctx = await mount(root, new MockAdapter([]))
    await mountPresetRegistry(ctx)
    const resolve = createBridgeAgentResolver(ctx, () => agentOptions)

    const resolved = await resolve(sessionId)
    if ('error' in resolved) throw new Error(`unexpected ${resolved.error.code}`)

    // Read the tool surface the model would actually receive for this agent.
    const names = new Set(
      ctx.tools.schemas(scopeOf(resolved.agent.ctx)).map(schema => schema.name),
    )
    // The preset declares this; without mounting the preset it is absent.
    expect(names.has('todo_write')).toBe(true)
    await resolved.dispose!()
  })

})
