import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feishuBotDomain } from '../src/bridge/domain.ts'
import * as FeishuInvariant from '../src/invariant.ts'

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(ready = true) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-invariant-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(InvariantRegistry)
  const domain = await ctx.storageDomain.open(feishuBotDomain)
  ctx.effect(() => () => domain.close())
  if (ready) ctx.provide('feishuBridgeReady', { domainName: 'feishu_bot' })
  return { ctx, domain }
}

describe('dsh-feishu-bot invariant companion', () => {
  it('waits for the bridge readiness service before inspecting its domain', async () => {
    const { ctx } = await setup(false)
    const fiber = ctx.plugin(FeishuInvariant)
    await fiber
    expect(fiber.state).toBe(0)

    ctx.provide('feishuBridgeReady', { domainName: 'feishu_bot' })
    await fiber
    expect(fiber.state).toBe(2)
  })

  it('rejects startup when an active binding points at no live or persisted session', async () => {
    const { ctx, domain } = await setup()
    const chatId = 'oc_sensitive_missing_chat'
    const sessionId = 's_sensitive_missing_session'
    await domain.table('bindings').put(chatId as never, {
      sessionId: sessionId as never, status: 'active', boundBy: 'ou_owner' as never, boundAt: 1,
    })

    let failure: unknown
    try {
      await ctx.plugin(FeishuInvariant)
    } catch (error: unknown) {
      failure = error
    }
    expect(String(failure)).toMatch(/active binding.*missing/u)
    expect(String(failure)).not.toContain(chatId)
    expect(String(failure)).not.toContain(sessionId)
  })

  it('accepts a binding to a live session and rejects a later dangling put event', async () => {
    const { ctx, domain } = await setup()
    ctx.sessions.create('known' as never)
    await domain.table('bindings').put('oc_known' as never, {
      sessionId: 'known' as never, status: 'active', boundBy: 'ou_owner' as never, boundAt: 1,
    })
    await ctx.plugin(FeishuInvariant)

    expect(() => ctx.emit('domain/changed', {
      domain: 'feishu_bot', table: 'bindings', key: 'oc_bad', operation: 'put',
      value: { sessionId: 'missing', status: 'active', boundBy: 'ou_owner', boundAt: 2 },
    })).toThrow(/active binding.*missing/u)
  })
})
