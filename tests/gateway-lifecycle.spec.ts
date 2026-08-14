import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  patch: vi.fn(),
  start: vi.fn(async () => {}),
  close: vi.fn(),
  register: vi.fn(),
  handlers: undefined as Record<string, (data: unknown) => Promise<unknown>> | undefined,
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { error: 'error' },
  Client: class {
    im = { v1: { message: { create: sdk.create, patch: sdk.patch } } }
  },
  WSClient: class {
    start = sdk.start
    close = sdk.close
  },
  EventDispatcher: class {
    register(handlers: Record<string, (data: unknown) => Promise<unknown>>) {
      sdk.register(handlers)
      sdk.handlers = handlers
      return this
    }
  },
}))

import * as Gateway from '../src/gateway/index.ts'

class StubCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials') }
  async resolve() { return { value: 'test-only-credential' } }
}

const config = {
  appIdRef: 'APP', appSecretRef: 'SECRET',
  sendRetryBaseMs: 1, sendMaxAttempts: 2,
}

beforeEach(() => {
  sdk.create.mockReset()
  sdk.patch.mockReset()
  sdk.start.mockClear()
  sdk.close.mockClear()
  sdk.register.mockClear()
  sdk.handlers = undefined
})

describe('FeishuGateway lifecycle and queue', () => {
  it('normalizes card callback chat and message identity for bridge authorization', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    let captured: { operatorOpenId: string; chatId: string; messageId: string } | undefined
    ctx.feishu.handleCardActions(async (action) => {
      captured = action
      return { toast: 'ok' }
    })

    await vi.waitFor(() => {
      expect(sdk.register).toHaveBeenCalledTimes(1)
      expect(sdk.handlers).toBeDefined()
    })
    await sdk.handlers?.['card.action.trigger']?.({
      operator: { open_id: 'ou_owner' },
      context: { open_chat_id: 'oc_origin', open_message_id: 'om_origin' },
      action: { value: { pendingId: 'pc_1', action: 'allow' } },
    })
    expect(captured).toMatchObject({
      operatorOpenId: 'ou_owner', chatId: 'oc_origin', messageId: 'om_origin',
    })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('retries a card at the queue head before the next text send', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    sdk.create
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ data: { message_id: 'card-ok' } })
      .mockResolvedValueOnce({ data: { message_id: 'text-ok' } })

    const card = ctx.feishu.sendCard('oc_same', { elements: [] })
    const text = ctx.feishu.sendText('oc_same', 'second')

    await expect(card).resolves.toBe('card-ok')
    await expect(text).resolves.toBe('text-ok')
    expect(sdk.create).toHaveBeenCalledTimes(3)
    expect(sdk.create.mock.calls[2]![0].data.msg_type).toBe('text')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('closes WS first and lets an accepted send drain before disposal completes', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    const gateway = ctx.feishu
    let release!: () => void
    sdk.create.mockImplementationOnce(() => new Promise(resolve => {
      release = () => { resolve({ data: { message_id: 'drained' } }) }
    }))
    const sending = gateway.sendText('oc_drain', 'accepted-before-dispose')

    const disposing = fiber.dispose()
    await vi.waitFor(() => { expect(sdk.close).toHaveBeenCalledTimes(1) })
    release()
    await expect(sending).resolves.toBe('drained')
    await disposing
    await expect(gateway.sendText('oc_drain', 'too-late')).rejects.toThrow(/disposed/u)
    await ctx.fiber.dispose()
  })

  it('opens a per-chat cooldown after retry exhaustion and preserves the queued send', async () => {
    const ctx = new Context()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, { ...config, sendCircuitCooldownMs: 25 })
    await fiber
    sdk.create
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce({ data: { message_id: 'after-cooldown' } })

    const startedAt = Date.now()
    const exhausted = ctx.feishu.sendText('oc_fused', 'first')
    const preserved = ctx.feishu.sendText('oc_fused', 'second')
    await expect(exhausted).rejects.toThrow(/after 2 attempts/u)
    await expect(preserved).resolves.toBe('after-cooldown')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
    expect(sdk.create).toHaveBeenCalledTimes(3)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
