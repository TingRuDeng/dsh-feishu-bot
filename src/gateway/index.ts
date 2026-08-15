/**
 * The `ctx.feishu` transport service: Feishu long-connection lifecycle,
 * inbound event dispatch, and per-chat FIFO text/card sending with retry.
 * Carries no business semantics — feishu-bridge owns those.
 *
 * Lifecycle: credentials resolve at init (fail-loud when unconfigured), but
 * WS intake starts only after the bridge registers its durable admission
 * handler and explicitly calls `startIntake()`. The SDK callback awaits that
 * handler; Feishu ACK therefore follows the bridge's durable commit point.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createHash } from 'node:crypto'
// Declaration-merge import: dsh-credentials contributes ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
import { auditHash, safeErrorFact } from '../audit.ts'
import { createCardMessageEnvelope } from './envelope.ts'

/** Gateway configuration: credential references only, no secrets. */
export interface Config {
  /** Credential reference for the Feishu app id. */
  appIdRef: string
  /** Credential reference for the Feishu app secret. */
  appSecretRef: string
  /** Base delay in milliseconds between send retries (exponential backoff). */
  sendRetryBaseMs: number
  /** Maximum send attempts per message before the send rejects. */
  sendMaxAttempts: number
  /** Per-chat cooldown after one message exhausts its retry budget. */
  sendCircuitCooldownMs: number
  /** Maximum time disposal waits for accepted sends to drain. */
  disposeDrainTimeoutMs: number
}

export const Config: z<Config> = z.object({
  appIdRef: z.string().required(),
  appSecretRef: z.string().required(),
  sendRetryBaseMs: z.natural().default(500),
  sendMaxAttempts: z.natural().default(4),
  sendCircuitCooldownMs: z.natural().default(30_000),
  disposeDrainTimeoutMs: z.natural().default(5_000),
})

export const name = 'feishu-gateway'
export const inject = ['credentials']

/** One inbound private-chat message event, normalized for the bridge. */
export interface FeishuInboundMessage {
  /** Feishu event id — the at-least-once idempotency key. */
  eventId: string
  /** Chat the message arrived in. */
  chatId: string
  /** Sender's app-scoped open id (`ou_…`). */
  senderOpenId: string
  /** `p2p` or `group`; the bridge only serves `p2p`. */
  chatType: string
  /** Feishu message id. */
  messageId: string
  /** Message creation time reported by Feishu (ms epoch). */
  createTimeMs: number
  /** Extracted plain text; undefined for non-text messages. */
  text: string | undefined
}

/** Stable identity of one logical outbound segment across process restarts. */
export interface FeishuDeliveryIdentity {
  deliveryId: string
  stage: string
  segmentIndex: number
}

/** Whether another request shape may safely replace a failed Feishu call. */
export type FeishuFailureKind = 'permanent' | 'retryable' | 'ambiguous'

/** Structured transport failure with no response body or message content. */
export class FeishuSendError extends Error {
  readonly feishuFailureKind: FeishuFailureKind
  readonly code: string | number | undefined
  readonly status: number | undefined

  constructor(
    kind: FeishuFailureKind,
    operation: string,
    facts: { code?: string | number; status?: number; cause?: unknown } = {},
  ) {
    const suffix = [
      facts.code === undefined ? undefined : `code=${String(facts.code)}`,
      facts.status === undefined ? undefined : `status=${facts.status}`,
    ].filter((value): value is string => value !== undefined).join(' ')
    super(`feishu-gateway: ${operation}${suffix === '' ? '' : ` (${suffix})`}`, {
      cause: facts.cause,
    })
    this.name = 'FeishuSendError'
    this.feishuFailureKind = kind
    this.code = facts.code
    this.status = facts.status
  }
}

const RETRYABLE_BUSINESS_CODES = new Set([99991400, 99991401, 99991402, 99991403])
const AMBIGUOUS_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
])
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND'])

function errorFact(error: unknown, key: string): unknown {
  try {
    if (typeof error === 'object' && error !== null && key in error) {
      return (error as Record<string, unknown>)[key]
    }
  } catch { /* hostile error object: classify as ambiguous below */ }
  return undefined
}

function statusFact(error: unknown): number | undefined {
  const direct = errorFact(error, 'status')
  if (typeof direct === 'number') return direct
  const response = errorFact(error, 'response')
  const nested = errorFact(response, 'status')
  return typeof nested === 'number' ? nested : undefined
}

/** Classify a thrown transport fact without reading/logging its body. */
export function classifyFeishuFailure(error: unknown): FeishuFailureKind {
  if (error instanceof FeishuSendError) return error.feishuFailureKind
  const declared = errorFact(error, 'feishuFailureKind')
  if (declared === 'permanent' || declared === 'retryable' || declared === 'ambiguous') return declared
  const status = statusFact(error)
  if (status === 429) return 'retryable'
  if (status !== undefined && status >= 500) return 'ambiguous'
  if (status !== undefined && status >= 400) return 'permanent'
  const code = String(errorFact(error, 'code') ?? '')
  if (AMBIGUOUS_ERROR_CODES.has(code)) return 'ambiguous'
  if (RETRYABLE_ERROR_CODES.has(code)) return 'retryable'
  return 'ambiguous'
}

/** True only when Feishu definitively rejected the original request shape. */
export function isPermanentFeishuFailure(error: unknown): boolean {
  return classifyFeishuFailure(error) === 'permanent'
}

function deliveryUuid(identity: FeishuDeliveryIdentity | undefined): string | undefined {
  if (identity === undefined) return undefined
  return createHash('sha256')
    .update(JSON.stringify([identity.deliveryId, identity.stage, identity.segmentIndex]), 'utf8')
    .digest('hex')
    .slice(0, 32)
}

function assertBusinessSuccess(
  operation: string, response: { code?: number | string } | undefined,
): void {
  const code = response?.code
  if (code === undefined || code === 0 || code === '0') return
  const numeric = Number(code)
  const kind: FeishuFailureKind = Number.isFinite(numeric) && RETRYABLE_BUSINESS_CODES.has(numeric)
    ? 'retryable'
    : 'permanent'
  throw new FeishuSendError(kind, `${operation} business failure`, { code })
}

/** Event dispatch must never let the SDK print inbound event payloads. */
export const silentSdkLogger = Object.freeze({
  error: (..._args: unknown[]): void => {},
  warn: (..._args: unknown[]): void => {},
  info: (..._args: unknown[]): void => {},
  debug: (..._args: unknown[]): void => {},
  trace: (..._args: unknown[]): void => {},
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuGateway
  }
  interface Events {
    /** At-least-once inbound private-chat message delivery. @mode emit */
    'feishu/message'(message: FeishuInboundMessage): void
  }
}

/** Transport-only Feishu service; see the design doc for the send/queue rules. */
export class FeishuGateway extends Service {
  private client: Lark.Client | undefined
  private wsClient: Lark.WSClient | undefined
  private dispatcher: Lark.EventDispatcher | undefined
  private wsOptions: {
    appId: string
    appSecret: string
    loggerLevel: Lark.LoggerLevel
    logger: ReturnType<typeof redactingSdkLogger>
  } | undefined
  /** Serializes start/stop so concurrent HMR transitions cannot cross. */
  private intakeTail: Promise<void> = Promise.resolve()
  private inboundMessageHandler: ((message: FeishuInboundMessage) => Promise<void>) | undefined
  private inboundMessageGeneration = 0
  /** Tail promise per chat: sends within one chat are strictly FIFO. */
  private sendTails = new Map<string, Promise<void>>()
  /** Chat circuit opening timestamp after an exhausted retry budget. */
  private circuitOpenUntil = new Map<string, number>()
  /** Timers owned by retry/cooldown waits, released on forced shutdown. */
  private sleepers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private accepting = true
  private disposed = false
  private bridgeReadinessSettled = false
  private resolveBridgeReady!: () => void
  private rejectBridgeReady!: (reason: unknown) => void
  private readonly bridgeReady = new Promise<void>((resolve, reject) => {
    this.resolveBridgeReady = resolve
    this.rejectBridgeReady = reject
  })

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'feishu')
    // A disabled invariant companion must not turn a Bridge startup failure
    // into an unhandled rejection; consumers still observe the original.
    void this.bridgeReady.catch(() => {})
  }

  /** Wait until the business bridge has finished local recovery and opened intake. */
  whenBridgeReady(): Promise<void> {
    return this.bridgeReady
  }

  /** Resolve the one-shot startup latch after Bridge readiness is durable. */
  markBridgeReady(): void {
    if (this.bridgeReadinessSettled) return
    this.bridgeReadinessSettled = true
    this.resolveBridgeReady()
  }

  /** Reject the startup latch with the same cause when Bridge mount fails. */
  markBridgeFailed(error: unknown): void {
    if (this.bridgeReadinessSettled) return
    this.bridgeReadinessSettled = true
    this.rejectBridgeReady(error)
  }

  protected async [Service.init](): Promise<void> {
    const appId = await this.requireCredential(this.config.appIdRef)
    const appSecret = await this.requireCredential(this.config.appSecretRef)
    // The SDK's error formatter logs the failed request's config.data —
    // the full message body. Route SDK logs through a redactor that strips
    // body-bearing fields before they reach the process log.
    const logger = redactingSdkLogger(this.ctx)
    this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error, logger })
    this.wsOptions = { appId, appSecret, loggerLevel: Lark.LoggerLevel.error, logger }
    this.dispatcher = new Lark.EventDispatcher({ logger: silentSdkLogger }).register({
      'im.message.receive_v1': async (data) => {
        await this.dispatchInbound(data)
      },
      // Card button clicks. The handler slot is read at call time so the
      // business plugin can (re)register across HMR without a reconnect.
      'card.action.trigger': async (data: {
        operator?: { open_id?: string }
        event?: { operator?: { open_id?: string } }
        action?: { value?: unknown }
        context?: { open_message_id?: string; open_chat_id?: string }
        open_message_id?: string
        open_chat_id?: string
      }) => {
        if (!this.accepting || this.disposed) return {}
        const chatId = data.context?.open_chat_id ?? data.open_chat_id ?? ''
        const messageId = data.context?.open_message_id ?? data.open_message_id ?? ''
        // Receipt log first: live diagnosis needs to distinguish "click
        // never arrived" (console callback not enabled) from "handler
        // rejected the payload".
        this.ctx.logger.info('feishu-audit action=card-click-received operator=%s chat=%s message=%s',
          auditHash(data.operator?.open_id ?? data.event?.operator?.open_id ?? ''),
          auditHash(chatId), auditHash(messageId))
        const handler = this.cardActionHandler
        if (handler === undefined) return {}
        const operatorOpenId = data.operator?.open_id ?? data.event?.operator?.open_id ?? ''
        const action: FeishuCardAction = {
          operatorOpenId,
          chatId,
          messageId,
          value: data.action?.value,
        }
        try {
          const result = await handler(action)
          return result?.toast === undefined ? {} : { toast: { type: 'info', content: result.toast } }
        } catch (error: unknown) {
          this.ctx.logger.error('feishu-gateway card action handler failed: %s', safeErrorFact(error))
          return { toast: { type: 'error', content: '处理失败，请稍后重试' } }
        }
      },
      // Subscribed read-status events need explicit no-op handlers; an
      // unhandled subscription makes the SDK log `not found handler` on
      // every read receipt (weclaw production lesson).
      'im.message.message_read_v1': async () => {},
    })
    this.ctx.effect(() => () => this.shutdown(), 'feishu.connectionShutdown')
  }

  private async requireCredential(ref: string): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(ref as never)
    if (resolved === undefined) {
      throw new Error(`feishu-gateway: credential "${ref}" is not configured (set it in ~/.dsh/.credentials.yaml)`)
    }
    return resolved.value
  }

  private async dispatchInbound(data: {
    event_id?: string
    message: { message_id: string; chat_id: string; chat_type: string; create_time: string; content: string; message_type: string }
    sender: { sender_id?: { open_id?: string } }
  }): Promise<void> {
    if (!this.accepting || this.disposed) return
    let text: string | undefined
    if (data.message.message_type === 'text') {
      try {
        text = (JSON.parse(data.message.content) as { text?: string }).text
      } catch {
        // Malformed content JSON from the wire: treat as non-text; the bridge
        // replies with the unsupported-content notice.
        text = undefined
      }
    }
    const message: FeishuInboundMessage = {
      eventId: data.event_id ?? data.message.message_id,
      chatId: data.message.chat_id,
      senderOpenId: data.sender.sender_id?.open_id ?? '',
      chatType: data.message.chat_type,
      messageId: data.message.message_id,
      createTimeMs: Number(data.message.create_time),
      text,
    }
    const handler = this.inboundMessageHandler
    if (handler === undefined) {
      throw new Error('feishu-gateway: inbound admission handler is not registered')
    }
    await handler(message)
  }

  /** Register the single durable admission owner. Returns an HMR-safe unregister function. */
  handleInboundMessages(handler: (message: FeishuInboundMessage) => Promise<void>): () => void {
    if (this.inboundMessageHandler !== undefined && this.inboundMessageHandler !== handler) {
      throw new Error('feishu-gateway: inbound admission handler is already registered')
    }
    const generation = ++this.inboundMessageGeneration
    this.inboundMessageHandler = handler
    return () => {
      if (this.inboundMessageGeneration === generation) this.inboundMessageHandler = undefined
    }
  }

  /** Queue one intake lifecycle transition; the internal tail always settles. */
  private enqueueIntake(work: () => Promise<void>): Promise<void> {
    const result = this.intakeTail.then(work, work)
    this.intakeTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Start the long connection after the bridge's admission boundary is ready. Idempotent. */
  startIntake(): Promise<void> {
    return this.enqueueIntake(async () => {
      if (!this.accepting || this.disposed) throw new Error('feishu-gateway: disposed')
      if (this.wsClient !== undefined) return
      const options = this.wsOptions
      const dispatcher = this.dispatcher
      if (options === undefined || dispatcher === undefined) {
        throw new Error('feishu-gateway: not initialized')
      }
      const client = new Lark.WSClient(options)
      this.wsClient = client
      try {
        await Promise.resolve(client.start({ eventDispatcher: dispatcher }))
        this.ctx.logger.info('feishu-gateway: long connection started')
      } catch (error: unknown) {
        if (this.wsClient === client) this.wsClient = undefined
        try { client.close({ force: true }) } catch { /* failed start owns no usable connection */ }
        throw error
      }
    })
  }

  /** Stop the current long connection without disabling outbound sends. Idempotent and restartable. */
  stopIntake(): Promise<void> {
    return this.enqueueIntake(async () => {
      const client = this.wsClient
      if (client === undefined) return
      this.wsClient = undefined
      try {
        client.close({ force: true })
        this.ctx.logger.info('feishu-gateway: long connection stopped')
      } catch (error: unknown) {
        this.ctx.logger.warn('feishu-gateway WS close failed: %s', safeErrorFact(error))
      }
    })
  }

  private cardActionHandler: ((action: FeishuCardAction) => Promise<{ toast?: string } | undefined>) | undefined
  private cardActionGeneration = 0

  /**
   * Register the card-button click handler (single slot; the business
   * plugin owns all card semantics). The returned effect unregisters.
   * @param handler - receives operator open_id, card message id, and the button's value payload; may return a toast.
   */
  handleCardActions(
    handler: (action: FeishuCardAction) => Promise<{ toast?: string } | undefined>,
  ): () => void {
    const generation = ++this.cardActionGeneration
    this.cardActionHandler = handler
    const unregister = (): void => {
      if (this.cardActionGeneration === generation) this.cardActionHandler = undefined
    }
    this.ctx.effect(() => unregister, 'feishu.cardActionHandler')
    return unregister
  }

  /** Managed delay whose timer can be released after a drain timeout. */
  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise(resolve => {
      const finish = (): void => {
        clearTimeout(timer)
        this.sleepers.delete(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.sleepers.set(timer, finish)
    })
  }

  /** Wait out this chat's fuse before attempting the queued head. */
  private async waitForCircuit(chatId: string): Promise<void> {
    const until = this.circuitOpenUntil.get(chatId) ?? 0
    if (until > Date.now()) await this.delay(until - Date.now())
    if (this.disposed) throw new Error('feishu-gateway: disposed')
  }

  /** Shared retry budget for text and card create-message calls. */
  private async retrySend<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    await this.waitForCircuit(chatId)
    let lastError: unknown
    const maxAttempts = Math.max(1, this.config.sendMaxAttempts)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.disposed) throw new Error('feishu-gateway: disposed')
      if (attempt > 0) await this.delay(this.config.sendRetryBaseMs * 2 ** (attempt - 1))
      try {
        const result = await operation()
        this.circuitOpenUntil.delete(chatId)
        return result
      } catch (error: unknown) {
        const kind = classifyFeishuFailure(error)
        const classified = error instanceof FeishuSendError
          ? error
          : new FeishuSendError(kind, 'send attempt failed', {
              code: errorFact(error, 'code') as string | number | undefined,
              status: statusFact(error),
              cause: error,
            })
        if (kind === 'permanent') throw classified
        lastError = classified
      }
    }
    this.circuitOpenUntil.set(chatId, Date.now() + this.config.sendCircuitCooldownMs)
    this.ctx.logger.warn('feishu-audit action=send-circuit-open chat=%s attempts=%d cooldownMs=%d',
      auditHash(chatId), maxAttempts, this.config.sendCircuitCooldownMs)
    const finalKind = classifyFeishuFailure(lastError)
    throw new FeishuSendError(finalKind, `send failed after ${maxAttempts} attempts`, {
      code: errorFact(lastError, 'code') as string | number | undefined,
      status: statusFact(lastError),
      cause: lastError,
    })
  }

  /** Add one operation to the destination FIFO and remove idle tails. */
  private enqueueSend<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    if (!this.accepting || this.disposed) return Promise.reject(new Error('feishu-gateway: disposed'))
    const tail = this.sendTails.get(chatId) ?? Promise.resolve()
    const send = tail.then(run, run)
    const settled = send.then(() => undefined, () => undefined)
    this.sendTails.set(chatId, settled)
    void settled.then(() => {
      if (this.sendTails.get(chatId) === settled) this.sendTails.delete(chatId)
    })
    return send
  }

  /** Stop intake/WS, drain accepted sends up to the configured deadline, then release. */
  private async shutdown(): Promise<void> {
    if (this.disposed) return
    this.accepting = false
    await this.stopIntake()
    const tails = [...this.sendTails.values()]
    if (tails.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(tails),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, this.config.disposeDrainTimeoutMs)
        }),
      ])
      if (timeout !== undefined) clearTimeout(timeout)
    }
    this.disposed = true
    for (const finish of [...this.sleepers.values()]) finish()
    this.sendTails.clear()
    this.circuitOpenUntil.clear()
    this.inboundMessageHandler = undefined
    this.cardActionHandler = undefined
    this.wsClient = undefined
    this.dispatcher = undefined
    this.wsOptions = undefined
    this.client = undefined
  }

  /**
   * Send a plain text message, FIFO within the chat, with bounded retry.
   * @param chatId - destination chat id.
   * @param text - message text.
   * @returns the sent Feishu message id.
   */
  async sendText(
    chatId: string, text: string, delivery?: FeishuDeliveryIdentity,
  ): Promise<string> {
    const uuid = deliveryUuid(delivery)
    const run = async (): Promise<string> => {
      const client = this.client
      if (client === undefined || this.disposed) throw new Error('feishu-gateway: disposed')
      return this.retrySend(chatId, async () => {
          const response = await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text }),
              ...(uuid === undefined ? {} : { uuid }),
            },
          })
          assertBusinessSuccess('text create', response)
          const messageId = response?.data?.message_id
          if (messageId === undefined) {
            throw new FeishuSendError('ambiguous', 'text create returned no message_id', {
              code: response?.code,
            })
          }
          return messageId
      })
    }
    return this.enqueueSend(chatId, run)
  }

  /**
   * Send an interactive card, FIFO within the chat (shared queue with text).
   * @param chatId - destination chat id.
   * @param card - the card JSON (msg_type `interactive` content).
   * @returns the sent Feishu message id (needed for later patches).
   */
  async sendCard(
    chatId: string, card: object, delivery?: FeishuDeliveryIdentity,
  ): Promise<string> {
    const uuid = deliveryUuid(delivery)
    const run = async (): Promise<string> => {
      const client = this.client
      if (client === undefined || this.disposed) throw new Error('feishu-gateway: disposed')
      return this.retrySend(chatId, async () => {
        const response = await client.im.v1.message.create(createCardMessageEnvelope(chatId, card, uuid))
        assertBusinessSuccess('card create', response)
        const messageId = response?.data?.message_id
        if (messageId === undefined) {
          throw new FeishuSendError('ambiguous', 'card create returned no message_id', {
            code: response?.code,
          })
        }
        return messageId
      })
    }
    return this.enqueueSend(chatId, run)
  }

  /**
   * Replace a sent card's content in place. A patch is serialized per card
   * and participates in shutdown draining. Progress updates remain
   * droppable (no retry); a failed patch surfaces to the caller, who decides.
   * @param messageId - the card message id returned by {@link sendCard}.
   * @param card - the full replacement card JSON.
   */
  async patchCard(messageId: string, card: object): Promise<void> {
    const run = async (): Promise<void> => {
      const client = this.client
      if (client === undefined || this.disposed) throw new Error('feishu-gateway: disposed')
      const response = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      assertBusinessSuccess('card patch', response)
    }
    return this.enqueueSend(`card:${messageId}`, run)
  }
}

/**
 * SDK logger that removes message bodies before logging.
 *
 * The SDK's `formatErrors` includes `config.data` (the outbound JSON body,
 * i.e. full chat text) and `response.data` in every logged HTTP failure.
 * This logger deep-walks each argument and replaces any `data` field with a
 * length marker. The SDK also duplicates `response.data` as later entries in
 * its `formatErrors` array; those entries are replaced wholesale while the
 * first entry retains status/url facts needed for diagnostics.
 * @param ctx - context whose logger receives the redacted lines.
 * @returns a logger in the SDK's expected error/warn/info/debug/trace form.
 */
export function redactingSdkLogger(ctx: Context): {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
} {
  const redact = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value !== 'object' || value === null) return value
    if (depth > 6) return '[truncated object]'
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) {
      const first = value[0]
      const isSdkErrorBundle = typeof first === 'object' && first !== null
        && ('config' in first || 'request' in first || 'response' in first)
      if (isSdkErrorBundle) {
        return [
          redact(first, depth + 1, seen),
          ...value.slice(1).map(() => '[redacted sdk response body]'),
        ]
      }
      return value.map(item => redact(item, depth + 1, seen))
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'data') {
        let length: number | '?' = '?'
        try {
          length = typeof entry === 'string' ? entry.length : JSON.stringify(entry ?? '').length
        } catch { /* circular/proxy body: length is optional diagnostic metadata */ }
        out[key] = `[redacted ${length} chars]`
      } else {
        out[key] = redact(entry, depth + 1, seen)
      }
    }
    return out
  }
  const line = (args: unknown[]): string => {
    const seen = new WeakSet<object>()
    return args.map(arg => {
      try {
        const cleaned = redact(arg, 0, seen)
        return typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
      } catch {
        return '[unserializable redacted value]'
      }
    }).join(' ')
  }
  return {
    error: (...args) => ctx.logger.error('feishu-sdk: %s', line(args)),
    warn: (...args) => ctx.logger.warn('feishu-sdk: %s', line(args)),
    info: (...args) => ctx.logger.info('feishu-sdk: %s', line(args)),
    debug: () => {},
    trace: () => {},
  }
}

/** One card-button click, normalized for the business plugin. */
export interface FeishuCardAction {
  /** The clicking user's open_id (may be empty when Feishu omits it). */
  operatorOpenId: string
  /** Chat in which the action happened; used to reject forwarded cards. */
  chatId: string
  /** The card's message id (patch target). */
  messageId: string
  /** The clicked button's value payload, verbatim. */
  value: unknown
}

/**
 * Mount the gateway service.
 * @param ctx - plugin context.
 * @param config - validated gateway configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(FeishuGateway, config)
}
