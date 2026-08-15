/**
 * Bridge-owned agent resolver (design §6.6): the upstream agent-lookup
 * semantics — live hit, subagent-ownership fence, cold resume, concurrent
 * dedup — with the ownership surface the upstream result type omits:
 * `created-here` results carry the AgentHandle's dispose so a failed binding
 * commit can release the agent this call created, while `existing` results
 * must never be disposed by this operation.
 *
 * Fence and inspection reuse the exported upstream helpers, so the rules
 * cannot drift from the Host resolver's.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  ApiRemoteSessionNotFound,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from '@deepseek-ai/dsh-api-remotes'

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
 * @returns resolve function; concurrent calls for one session share a resume,
 * and only the call that started it receives `created-here` + dispose.
 */
export function createBridgeAgentResolver(
  ctx: Context,
  agentOptions?: () => AgentOptions,
): (sessionId: SessionId, setup?: AgentSetup) => Promise<ResolveResult> {
  const resumes = new Map<SessionId, Promise<ResolveResult>>()

  const fencedLive = (sessionId: SessionId): ResolveResult | undefined => {
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return undefined
    if (hasApiRemoteSubagentOwner(ctx, live.session, live)) {
      return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
    }
    return { agent: live, ownership: 'existing' }
  }

  return async (sessionId: SessionId, setup?: AgentSetup): Promise<ResolveResult> => {
    const fenced = fencedLive(sessionId)
    if (fenced !== undefined) return fenced
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiRemoteSubagentOwner(ctx, attached, undefined)) {
      return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
    }
    const inFlight = resumes.get(sessionId)
    if (inFlight !== undefined) {
      // Joining an in-flight resume: share the agent, not the ownership —
      // only the initiator may dispose.
      const settled = await inFlight
      return 'agent' in settled ? { agent: settled.agent, ownership: 'existing' } : settled
    }
    const resume = (async (): Promise<ResolveResult> => {
      try {
        const inspected = await inspectApiRemoteSession(ctx, sessionId)
        if (hasApiRemoteSubagentOwner(ctx, { header: inspected.meta }, undefined)) {
          return { error: { code: 'agent-busy', message: `session "${sessionId}" is owned by subagent routing` } }
        }
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...agentOptions === undefined ? {} : { agentOptions: agentOptions() },
          ...setup === undefined ? {} : { setup },
        })
        return {
          agent: handle.agent,
          ownership: 'created-here',
          dispose: () => handle.dispose(),
        }
      } catch (error: unknown) {
        if (error instanceof ApiRemoteSessionNotFound) {
          return { error: { code: 'session-not-found', message: 'session not found' } }
        }
        // Lost a create/resume race to another frontend: the live agent is fine.
        const fencedRetry = fencedLive(sessionId)
        if (fencedRetry !== undefined) return fencedRetry
        return { error: { code: 'internal', message: `resume failed for session "${sessionId}"` } }
      } finally {
        resumes.delete(sessionId)
      }
    })()
    resumes.set(sessionId, resume)
    return resume
  }
}
