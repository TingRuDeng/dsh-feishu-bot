import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  patch: vi.fn(),
  start: vi.fn(async () => {}),
  close: vi.fn(),
  register: vi.fn(),
  handlers: undefined as Record<string, (data: unknown) => Promise<unknown>> | undefined,
  dispatcherOptions: undefined as Record<string, unknown> | undefined,
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
    constructor(options: Record<string, unknown>) {
      sdk.dispatcherOptions = options
    }
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

const contexts: Context[] = []

function testContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

async function waitForGatewayReady(): Promise<void> {
  await vi.waitFor(() => {
    expect(sdk.register).toHaveBeenCalledTimes(1)
    expect(sdk.handlers).toBeDefined()
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

beforeEach(() => {
  sdk.create.mockReset()
  sdk.patch.mockReset()
  sdk.start.mockClear()
  sdk.close.mockClear()
  sdk.register.mockClear()
  sdk.handlers = undefined
  sdk.dispatcherOptions = undefined
})

describe('FeishuGateway lifecycle and queue', () => {
  it('publishes one Bridge readiness latch to invariant consumers', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    const gateway = ctx.feishu
    let settled = false
    void gateway.whenBridgeReady().then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    gateway.markBridgeReady()
    gateway.markBridgeReady()
    await expect(gateway.whenBridgeReady()).resolves.toBeUndefined()

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('disposes cleanly before intake has ever started', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()

    await fiber.dispose()

    expect(sdk.start).toHaveBeenCalledTimes(0)
    expect(sdk.close).toHaveBeenCalledTimes(0)
    await ctx.fiber.dispose()
  })

  it('keeps WS closed until the bridge explicitly starts intake', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    const gateway = ctx.feishu as unknown as { startIntake?: () => Promise<void> }

    expect(sdk.start).toHaveBeenCalledTimes(0)
    expect(gateway.startIntake).toBeTypeOf('function')
    await gateway.startIntake!()
    await gateway.startIntake!()
    expect(sdk.start).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('makes intake stop idempotent and permits a later HMR restart', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    const gateway = ctx.feishu as unknown as {
      startIntake?: () => Promise<void>
      stopIntake?: () => Promise<void>
    }

    expect(gateway.startIntake).toBeTypeOf('function')
    expect(gateway.stopIntake).toBeTypeOf('function')
    await gateway.startIntake!()
    await gateway.stopIntake!()
    await gateway.stopIntake!()
    expect(sdk.start).toHaveBeenCalledTimes(1)
    expect(sdk.close).toHaveBeenCalledTimes(1)

    await gateway.startIntake!()
    expect(sdk.start).toHaveBeenCalledTimes(2)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('does not finish the SDK message callback before durable admission settles', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    let releaseAdmission!: () => void
    const admission = new Promise<void>(resolve => { releaseAdmission = resolve })
    const gateway = ctx.feishu as unknown as {
      handleInboundMessages?: (handler: (message: Gateway.FeishuInboundMessage) => Promise<void>) => void
      startIntake?: () => Promise<void>
    }

    expect(gateway.handleInboundMessages).toBeTypeOf('function')
    expect(gateway.startIntake).toBeTypeOf('function')
    gateway.handleInboundMessages!(() => admission)
    await gateway.startIntake!()
    const callback = sdk.handlers?.['im.message.receive_v1']?.({
      event_id: 'ev_admission',
      message: {
        message_id: 'om_admission', chat_id: 'oc_admission', chat_type: 'p2p',
        create_time: String(Date.now()), content: JSON.stringify({ text: 'durable first' }), message_type: 'text',
      },
      sender: { sender_id: { open_id: 'ou_owner' } },
    })
    expect(callback).toBeDefined()
    let settled = false
    void callback!.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseAdmission()
    await expect(callback).resolves.toBeUndefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('does not let a stale inbound unregister remove a newer generation of the same handler', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    const observed: string[] = []
    const handler = async (message: Gateway.FeishuInboundMessage): Promise<void> => {
      observed.push(message.messageId)
    }
    const firstUnregister = ctx.feishu.handleInboundMessages(handler)
    firstUnregister()
    const secondUnregister = ctx.feishu.handleInboundMessages(handler)
    firstUnregister()
    await ctx.feishu.startIntake()

    await expect(sdk.handlers?.['im.message.receive_v1']?.({
      event_id: 'ev_generation_2',
      message: {
        message_id: 'om_generation_2', chat_id: 'oc_generation', chat_type: 'p2p',
        create_time: String(Date.now()), content: JSON.stringify({ text: 'new generation' }), message_type: 'text',
      },
      sender: { sender_id: { open_id: 'ou_owner' } },
    })).resolves.toBeUndefined()
    expect(observed).toEqual(['om_generation_2'])

    secondUnregister()
    await expect(sdk.handlers?.['im.message.receive_v1']?.({
      event_id: 'ev_generation_removed',
      message: {
        message_id: 'om_generation_removed', chat_id: 'oc_generation', chat_type: 'p2p',
        create_time: String(Date.now()), content: JSON.stringify({ text: 'removed generation' }), message_type: 'text',
      },
      sender: { sender_id: { open_id: 'ou_owner' } },
    })).rejects.toThrow(/not registered/u)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('reuses a non-empty Feishu uuid when retrying one logical delivery', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    sdk.create
      .mockRejectedValueOnce(new Error('ambiguous timeout'))
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'card-ok' } })
    const gateway = ctx.feishu as unknown as {
      sendCard: (chatId: string, card: object, delivery: {
        deliveryId: string; stage: string; segmentIndex: number
      }) => Promise<string>
    }

    await expect(gateway.sendCard('oc_uuid', { elements: [] }, {
      deliveryId: 'session-1:42', stage: 'result-card', segmentIndex: 0,
    })).resolves.toBe('card-ok')
    const firstUuid = sdk.create.mock.calls[0]![0].data.uuid
    const retryUuid = sdk.create.mock.calls[1]![0].data.uuid
    expect(firstUuid).toEqual(expect.any(String))
    expect(firstUuid).not.toBe('')
    expect(retryUuid).toBe(firstUuid)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('derives the same Feishu uuid after a gateway restart for the same logical delivery', async () => {
    const logical = { deliveryId: 'session-restart:9', stage: 'result-card', segmentIndex: 1 }
    const observed: unknown[] = []
    for (let run = 1; run <= 2; run++) {
      const ctx = testContext()
      await ctx.plugin(StubCredentials)
      const fiber = ctx.plugin(Gateway, config)
      await fiber
      await vi.waitFor(() => { expect(sdk.register).toHaveBeenCalledTimes(run) })
      sdk.create.mockResolvedValueOnce({ code: 0, data: { message_id: `card-${run}` } })
      const gateway = ctx.feishu as unknown as {
        sendCard: (chatId: string, card: object, delivery: typeof logical) => Promise<string>
      }
      await gateway.sendCard('oc_uuid_restart', { elements: [] }, logical)
      observed.push(sdk.create.mock.calls.at(-1)![0].data.uuid)
      await fiber.dispose()
    }

    expect(observed[0]).toEqual(expect.any(String))
    expect(observed[0]).not.toBe('')
    expect(observed[1]).toBe(observed[0])
  })

  it('reuses one stable uuid when retrying a logical text delivery', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    sdk.create
      .mockRejectedValueOnce(Object.assign(new Error('timeout after write'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'text-ok' } })
    const gateway = ctx.feishu as unknown as {
      sendText: (chatId: string, text: string, delivery: {
        deliveryId: string; stage: string; segmentIndex: number
      }) => Promise<string>
    }

    await expect(gateway.sendText('oc_text_uuid', 'fallback text', {
      deliveryId: 'session-2:19', stage: 'result-text-fallback', segmentIndex: 0,
    })).resolves.toBe('text-ok')
    const firstUuid = sdk.create.mock.calls[0]![0].data.uuid
    const retryUuid = sdk.create.mock.calls[1]![0].data.uuid
    expect(firstUuid).toEqual(expect.any(String))
    expect(retryUuid).toBe(firstUuid)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('treats a resolved create response with a non-zero business code as permanent failure', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    sdk.create.mockResolvedValue({ code: 230001, msg: 'invalid card' })

    await expect(ctx.feishu.sendCard('oc_business_code', { elements: [] }))
      .rejects.toThrow(/230001/u)
    expect(sdk.create).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects a resolved card patch whose Feishu business code is non-zero', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    sdk.patch.mockResolvedValueOnce({ code: 230001, msg: 'invalid card' })

    await expect(ctx.feishu.patchCard('om_patch', { elements: [] }))
      .rejects.toThrow(/230001/u)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('waits for an accepted card patch before disposal completes', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()
    let releasePatch!: () => void
    sdk.patch.mockImplementationOnce(() => new Promise(resolve => {
      releasePatch = () => { resolve({ code: 0 }) }
    }))
    const patching = ctx.feishu.patchCard('om_patch_drain', { elements: [] })
    await vi.waitFor(() => { expect(sdk.patch).toHaveBeenCalledTimes(1) })
    const disposing = fiber.dispose()
    let disposed = false
    void disposing.then(() => { disposed = true })

    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(disposed).toBe(false)
    } finally {
      releasePatch()
      await patching
      await disposing
      await ctx.fiber.dispose()
    }
  })

  it('constructs EventDispatcher with an SDK logger that cannot emit raw bodies', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    await waitForGatewayReady()

    expect(sdk.dispatcherOptions?.logger).toMatchObject({
      error: expect.any(Function), warn: expect.any(Function),
      info: expect.any(Function), debug: expect.any(Function), trace: expect.any(Function),
    })
    const dispatcherLogger = sdk.dispatcherOptions?.logger as {
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
    }
    expect(() => {
      dispatcherLogger.error({ message: { content: 'raw inbound body' } })
      dispatcherLogger.warn('raw response body')
    }).not.toThrow()
    expect(dispatcherLogger).toBe(Gateway.silentSdkLogger)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('normalizes card callback chat and message identity for bridge authorization', async () => {
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    let captured: { operatorOpenId: string; chatId: string; messageId: string } | undefined
    const unregister = ctx.feishu.handleCardActions(async (action) => {
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
    unregister()
    captured = undefined
    await expect(sdk.handlers!['card.action.trigger']!({
      operator: { open_id: 'ou_late' },
      context: { open_chat_id: 'oc_late', open_message_id: 'om_late' },
      action: { value: {} },
    })).resolves.toEqual({})
    expect(captured).toBeUndefined()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('retries a card at the queue head before the next text send', async () => {
    const ctx = testContext()
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
    const ctx = testContext()
    await ctx.plugin(StubCredentials)
    const fiber = ctx.plugin(Gateway, config)
    await fiber
    const gateway = ctx.feishu
    await gateway.startIntake()
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
    const ctx = testContext()
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
