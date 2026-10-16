import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import * as domains from '../src/bridge/domain.ts'
import { feishuBotDomain } from '../src/bridge/domain.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mountOldFixture(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-domain-compat-'))
  roots.push(root)
  await writeFile(join(root, 'feishu_bot.json'), `${JSON.stringify({
    unit: { name: 'feishu_bot', version: 1 },
    global: { watermarks: { '["oc_legacy","session-legacy"]': 7 } },
    tables: {
      bindings: {
        oc_legacy: {
          sessionId: 'session-legacy', status: 'active',
          boundBy: 'ou_legacy', boundAt: 1,
        },
      },
      inbound_events: {},
      pending_cards: {},
      outbound_segments: {},
    },
  }, null, 2)}\n`, 'utf8')

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return { ctx, root }
}

describe('M6 storage compatibility', () => {
  it('opens the existing feishu_bot v1 fixture without rewriting it', async () => {
    const { ctx } = await mountOldFixture()
    const domain = await ctx.storageDomain.open(feishuBotDomain)

    expect(domain.table('bindings').get('oc_legacy' as never)).toMatchObject({
      sessionId: 'session-legacy', status: 'active', boundBy: 'ou_legacy', boundAt: 1,
    })
    expect(domain.global.get().watermarks).toEqual({
      '["oc_legacy","session-legacy"]': 7,
    })
    await domain.close()
  })

  it('opens a separate delivery domain and leaves the old v1 binding readable', async () => {
    const { ctx } = await mountOldFixture()
    const old = await ctx.storageDomain.open(feishuBotDomain)
    await old.close()
    const deliverySpec = (domains as unknown as {
      feishuDeliveryDomain?: DomainSpec
    }).feishuDeliveryDomain

    expect(deliverySpec).toBeDefined()
    const delivery = await ctx.storageDomain.open(deliverySpec!)
    expect(delivery.name).toBe('feishu_bot_delivery')
    await delivery.close()

    const reopened = await ctx.storageDomain.open(feishuBotDomain)
    expect(reopened.table('bindings').get('oc_legacy' as never)).toMatchObject({
      sessionId: 'session-legacy', status: 'active',
    })
    await reopened.close()
  })

  it('adds the approval_audit table to an existing install without a version bump', async () => {
    // An upgrade must not require migrating the live unit. The table is new,
    // so an install that predates it simply starts with it empty and keeps
    // every existing row. A version bump here would make every deployed
    // feishu_bot_delivery unit unopenable.
    const { ctx, root } = await mountOldFixture()
    const deliverySpec = (domains as unknown as {
      feishuDeliveryDomain?: DomainSpec
    }).feishuDeliveryDomain
    expect(deliverySpec).toBeDefined()
    expect(deliverySpec!.version).toBe(1)

    const delivery = await ctx.storageDomain.open(deliverySpec!)
    expect(delivery.table('approval_audit').size).toBe(0)
    await delivery.table('approval_audit').put(
      domains.approvalAuditId('pc_legacy', 1_000),
      {
        chatId: 'oc_legacy' as never,
        sessionId: 'session-legacy' as never,
        toolName: 'Bash',
        action: 'withdrawn',
        cause: 'signal-abort',
        createdAt: 1_000,
      },
    )
    await delivery.close()

    // Reopening proves the row round-trips through the persisted medium.
    const reopened = await ctx.storageDomain.open(deliverySpec!)
    expect(reopened.table('approval_audit').get(
      domains.approvalAuditId('pc_legacy', 1_000),
    )).toMatchObject({ action: 'withdrawn', cause: 'signal-abort' })
    await reopened.close()

    // The unit on disk stayed at v1; the binding domain is still readable.
    expect(root).toBeDefined()
    const bot = await ctx.storageDomain.open(feishuBotDomain)
    expect(bot.table('bindings').get('oc_legacy' as never)).toMatchObject({
      sessionId: 'session-legacy',
    })
    await bot.close()
  })
})
