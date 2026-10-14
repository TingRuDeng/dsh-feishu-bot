/**
 * Startup self-check companion for dsh-feishu-bot.
 *
 * Every active Feishu binding must name a session visible either in the live
 * SessionStore or in session persistence. The bridge repairs stale bindings
 * during startup; this companion catches regressions at startup and on every
 * later binding write.
 *
 * DSH removed the runtime invariant registry (`@deepseek-ai/dsh-invariants`
 * and `ctx.invariants`) in v0.2.0-rc.2, so this plugin owns its check and
 * reports a violation through its own channel: the failure is raised out of
 * plugin startup so the loader fails the row, exactly as the application
 * previously observed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ChatBinding } from './bridge/domain.ts'
import { auditHash } from './audit.ts'

export const name = 'feishu-bot-invariant'
export const inject = ['feishu', 'sessions', 'sessionPersistence', 'storageDomain']

/** Raised when an active binding points at a session that does not exist. */
export class BindingInvariantError extends Error {
  readonly code = 'FEISHU_BINDING_INVARIANT'

  constructor(message: string) {
    super(message)
    this.name = 'BindingInvariantError'
  }
}

const install = async (ctx: Context, fail: (reason: string) => never): Promise<void> => {
  await ctx.feishu.whenBridgeReady()
  const known = new Set([
    ...ctx.sessions.list().map(session => String(session.id)),
    ...(await ctx.sessionPersistence.list()).map(snapshot => String(snapshot.header.id)),
  ])
  const requireValid = (chatId: string, binding: ChatBinding): void => {
    if (binding.status === 'active' && !known.has(binding.sessionId)) {
      fail(`active binding ${auditHash(chatId)} points at missing session ${auditHash(binding.sessionId)}`)
    }
  }

  const domain = ctx.storageDomain.get('feishu_bot')
  if (domain === undefined) fail('feishu_bot domain is not open')
  for (const [chatId, raw] of domain.table('bindings').entries()) {
    requireValid(chatId, raw as ChatBinding)
  }

  ctx.on('session/created', (session) => { known.add(String(session.id)) }, { global: true })
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'feishu_bot' || change.table !== 'bindings' || change.operation !== 'put') return
    requireValid(change.key, change.value as ChatBinding)
  }, { global: true })
}

/** Run the binding self-check against `ctx`, reporting violations through `fail`. */
export async function checkBindings(ctx: Context, fail: (reason: string) => never): Promise<void> {
  await install(ctx, fail)
}

export const apply = (ctx: Context): Promise<() => void> => {
  const fail = (reason: string): never => { throw new BindingInvariantError(reason) }
  return checkBindings(ctx, fail).then(() => () => {})
}

