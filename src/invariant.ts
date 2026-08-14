/**
 * Runtime invariant companion for dsh-feishu-bot.
 *
 * Every active Feishu binding must name a session visible either in the live
 * SessionStore or in session persistence. The bridge repairs stale bindings
 * during startup; this companion catches regressions at startup and on every
 * later binding write.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ChatBinding } from './bridge/domain.ts'
import { auditHash } from './audit.ts'

const PACKAGE_NAME = 'dsh-feishu-bot'

export const name = 'feishu-bot-invariant'
export const inject = ['invariants', 'feishuBridgeReady']

const install: InvariantInstaller = Object.assign(async (ctx: Context, fail: InvariantFailure) => {
  const known = new Set([
    ...ctx.sessions.list().map(session => String(session.id)),
    ...(await ctx.sessionPersistence.list()).map(header => String(header.id)),
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
}, { inject: ['sessions', 'sessionPersistence', 'storageDomain'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
