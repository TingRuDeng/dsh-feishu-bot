/**
 * Bridge-owned agent resolver (design §6.6): the Session persistence
 * semantics — live hit, subagent-ownership fence, cold resume, concurrent
 * dedup — with the ownership surface the Session Controller result omits:
 * `created-here` results carry the AgentHandle's dispose so a failed binding
 * commit can release the agent this call created, while `existing` results
 * must never be disposed by this operation.
 *
 * Inspection uses the current SessionPersistence service contract. The
 * ownership predicate is intentionally kept local because the latest public
 * Session Controller package does not export its internal helper.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup, AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** The current persistence backend has no materialized project-backed session. */
class BridgeSessionNotFound extends Error {}

/**
 * Mirror the Session Controller's public routing fence without importing its
 * private agent-controller module.
 */
function hasSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/** Read one project-backed persisted session through the current public service. */
async function inspectPersistedSession(
  ctx: Context,
  sessionId: SessionId,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
  }
  const listed = (await persistence.list()).find(candidate => candidate.id === sessionId)
  if (listed === undefined || listed.cwd === undefined) {
    throw new BridgeSessionNotFound(`session "${sessionId}" not found`)
  }
  const inspected = await persistence.inspect(sessionId)
  if (inspected.meta.cwd === undefined) {
    throw new BridgeSessionNotFound(`session "${sessionId}" not found`)
  }
  return { meta: inspected.meta, events: [...inspected.events] }
}

/** Match a cross-package persistence error without relying on instanceof. */
function isPersistenceNotFound(error: unknown): boolean {
  return error instanceof Error
    && error.name === 'SessionPersistenceNotFoundError'
}

/** Stable error codes mirrored from the upstream lookup result. */
export type ResolveErrorCode = 'session-not-found' | 'agent-busy' | 'internal'

/** One resolution outcome. */
export type ResolveResult =
  | {
    readonly agent: Agent
    /**
     * `existing`: a live agent this operation did not create — never dispose.
     * `created-here`: this call performed the resume; `dispose` releases it.
     */
    readonly ownership: 'existing' | 'created-here'
    readonly dispose?: () => Promise<void>
  }
  | { readonly error: { code: ResolveErrorCode; message: string } }

/**
 * Create the bridge resolver.
 * @param ctx - plugin context with `agents`, `sessions`, `sessionPersistence`.
 * @param agentOptions - per-agent defaults applied on cold resume.
 * @param installSelection - agent-scope setup applied before any caller setup
 * on cold resume only; live (`existing`) agents are never touched, so model
 * selection ownership stays with whichever frontend created the agent.
 * @returns resolve function; concurrent calls for one session share a resume,
 * and only the call that started it receives `created-here` + dispose.
 */
export function createBridgeAgentResolver(
  ctx: Context,
  agentOptions?: () => AgentOptions,
  installSelection?: (agentCtx: Context, sessionId: SessionId) => void,
): (sessionId: SessionId, setup?: AgentSetup) => Promise<ResolveResult> {
  const resumes = new Map<SessionId, Promise<ResolveResult>>()

  const fencedLive = (sessionId: SessionId): ResolveResult | undefined => {
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return undefined
    if (hasSubagentOwner(ctx, live.session, live)) {
      return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
    }
    return { agent: live, ownership: 'existing' }
  }

  const fencedAttached = (sessionId: SessionId): ResolveResult | undefined => {
    const attached = ctx.sessions.get(sessionId)
    if (attached === undefined || !hasSubagentOwner(ctx, attached, undefined)) return undefined
    return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
  }

  const assertNoSubagentOwner = (sessionId: SessionId): void => {
    const session = ctx.sessions.get(sessionId)
    const agent = ctx.agents.get(sessionId)
    if (session !== undefined && hasSubagentOwner(ctx, session, agent)) {
      throw new Error(`session "${sessionId}" is owned by subagent routing`)
    }
  }

  const fencedSetup = (sessionId: SessionId, setup?: AgentSetup): AgentSetup | undefined => {
    if (setup === undefined && installSelection === undefined) return undefined
    return async (agentCtx: Context): Promise<AgentSetupCommit> => {
      installSelection?.(agentCtx, sessionId)
      const setupCommit = await setup?.(agentCtx)
      return {
        commit: () => {
          // AgentLoop invokes this commit immediately before publication.
          assertNoSubagentOwner(sessionId)
          setupCommit?.commit()
          assertNoSubagentOwner(sessionId)
        },
      }
    }
  }

  return async (sessionId: SessionId, setup?: AgentSetup): Promise<ResolveResult> => {
    const fenced = fencedLive(sessionId)
    if (fenced !== undefined) return fenced
    const attached = fencedAttached(sessionId)
    if (attached !== undefined) return attached
    const inFlight = resumes.get(sessionId)
    if (inFlight !== undefined) {
      // Joining an in-flight resume: share the agent, not the ownership —
      // only the initiator may dispose.
      const settled = await inFlight
      return 'agent' in settled ? { agent: settled.agent, ownership: 'existing' } : settled
    }
    const resume = (async (): Promise<ResolveResult> => {
      try {
        const inspected = await inspectPersistedSession(ctx, sessionId)
        if (hasSubagentOwner(ctx, { header: inspected.meta }, undefined)) {
          return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
        }
        const publishedSession = ctx.sessions.get(sessionId)
        const publishedAgent = ctx.agents.get(sessionId)
        if (publishedSession !== undefined && hasSubagentOwner(ctx, publishedSession, publishedAgent)) {
          return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
        }
        const resumeSetup = fencedSetup(sessionId, setup)
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...agentOptions === undefined ? {} : { agentOptions: agentOptions() },
          ...resumeSetup === undefined ? {} : { setup: resumeSetup },
        })
        return {
          agent: handle.agent,
          ownership: 'created-here',
          dispose: () => handle.dispose(),
        }
      } catch (error: unknown) {
        if (error instanceof BridgeSessionNotFound || isPersistenceNotFound(error)) {
          return { error: { code: 'session-not-found', message: 'session not found' } }
        }
        // Lost a create/resume race to another frontend: the live agent is fine.
        const fencedRetry = fencedLive(sessionId)
        if (fencedRetry !== undefined) return fencedRetry
        const attachedRetry = fencedAttached(sessionId)
        if (attachedRetry !== undefined) return attachedRetry
        return { error: { code: 'internal', message: `resume failed for session "${sessionId}"` } }
      } finally {
        resumes.delete(sessionId)
      }
    })()
    resumes.set(sessionId, resume)
    return resume
  }
}
