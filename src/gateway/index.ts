/**
 * The `ctx.feishu` transport service: Feishu long-connection lifecycle,
 * inbound event dispatch, and per-chat FIFO text/card sending with retry.
 * Carries no business semantics — feishu-bridge owns those.
 *
 * Lifecycle: credentials resolve at init (fail-loud when unconfigured), the
 * WS client starts once, and dispose stops intake before the send queues
 * drain. Inbound events fan out through the `feishu/message` cordis event;
 * business listeners must treat delivery as at-least-once (Feishu redelivers
 * unacknowledged events).
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as Lark from '@larksuiteoapi/node-sdk'
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
  /** Tail promise per chat: sends within one chat are strictly FIFO. */
  private sendTails = new Map<string, Promise<void>>()
  /** Chat circuit opening timestamp after an exhausted retry budget. */
  private circuitOpenUntil = new Map<string, number>()
  /** Timers owned by retry/cooldown waits, released on forced shutdown. */
  private sleepers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private accepting = true
  private disposed = false

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'feishu')
  }

  protected async [Service.init](): Promise<void> {
    const appId = await this.requireCredential(this.config.appIdRef)
    const appSecret = await this.requireCredential(this.config.appSecretRef)
    // The SDK's error formatter logs the failed request's config.data —
    // the full message body. Route SDK logs through a redactor that strips
    // body-bearing fields before they reach the process log.
    const logger = redactingSdkLogger(this.ctx)
    this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error, logger })
    this.wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error, logger })
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        this.dispatchInbound(data)
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
    this.wsClient.start({ eventDispatcher: dispatcher })
    this.ctx.logger.info('feishu-gateway: long connection started')
    this.ctx.effect(() => () => this.shutdown(), 'feishu.connectionShutdown')
  }

  private async requireCredential(ref: string): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(ref as never)
    if (resolved === undefined) {
      throw new Error(`feishu-gateway: credential "${ref}" is not configured (set it in ~/.dsh/.credentials.yaml)`)
    }
    return resolved.value
  }

  private dispatchInbound(data: {
    event_id?: string
    message: { message_id: string; chat_id: string; chat_type: string; create_time: string; content: string; message_type: string }
    sender: { sender_id?: { open_id?: string } }
  }): void {
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
    this.ctx.emit('feishu/message', {
      eventId: data.event_id ?? data.message.message_id,
      chatId: data.message.chat_id,
      senderOpenId: data.sender.sender_id?.open_id ?? '',
      chatType: data.message.chat_type,
      messageId: data.message.message_id,
      createTimeMs: Number(data.message.create_time),
      text,
    })
  }

  private cardActionHandler: ((action: FeishuCardAction) => Promise<{ toast?: string } | undefined>) | undefined

  /**
   * Register the card-button click handler (single slot; the business
   * plugin owns all card semantics). The returned effect unregisters.
   * @param handler - receives operator open_id, card message id, and the button's value payload; may return a toast.
   */
  handleCardActions(handler: (action: FeishuCardAction) => Promise<{ toast?: string } | undefined>): void {
    this.cardActionHandler = handler
    this.ctx.effect(() => () => {
      if (this.cardActionHandler === handler) this.cardActionHandler = undefined
    }, 'feishu.cardActionHandler')
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
        lastError = error
      }
    }
    this.circuitOpenUntil.set(chatId, Date.now() + this.config.sendCircuitCooldownMs)
    this.ctx.logger.warn('feishu-audit action=send-circuit-open chat=%s attempts=%d cooldownMs=%d',
      auditHash(chatId), maxAttempts, this.config.sendCircuitCooldownMs)
    throw new Error(`feishu-gateway: send failed after ${maxAttempts} attempts (${safeErrorFact(lastError)})`)
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
    try {
      this.wsClient?.close({ force: true })
    } catch (error: unknown) {
      this.ctx.logger.warn('feishu-gateway WS close failed: %s', safeErrorFact(error))
    }
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
    this.cardActionHandler = undefined
    this.wsClient = undefined
    this.client = undefined
  }

  /**
   * Send a plain text message, FIFO within the chat, with bounded retry.
   * @param chatId - destination chat id.
   * @param text - message text.
   * @returns the sent Feishu message id.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    const run = async (): Promise<string> => {
      const client = this.client
      if (client === undefined || this.disposed) throw new Error('feishu-gateway: disposed')
      return this.retrySend(chatId, async () => {
          const response = await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
          })
          const messageId = response?.data?.message_id
          if (messageId === undefined) throw new Error(`send returned no message_id (code ${String(response?.code)})`)
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
  async sendCard(chatId: string, card: object): Promise<string> {
    const run = async (): Promise<string> => {
      const client = this.client
      if (client === undefined || this.disposed) throw new Error('feishu-gateway: disposed')
      return this.retrySend(chatId, async () => {
        const response = await client.im.v1.message.create(createCardMessageEnvelope(chatId, card))
        const messageId = response?.data?.message_id
        if (messageId === undefined) throw new Error(`card send returned no message_id (code ${String(response?.code)})`)
        return messageId
      })
    }
    return this.enqueueSend(chatId, run)
  }

  /**
   * Replace a sent card's content in place. Progress updates are droppable
   * (design §6.3: non-terminal card state is disposable), so no retry and
   * no queueing — a failed patch surfaces to the caller, who decides.
   * @param messageId - the card message id returned by {@link sendCard}.
   * @param card - the full replacement card JSON.
   */
  async patchCard(messageId: string, card: object): Promise<void> {
    const client = this.client
    if (client === undefined || !this.accepting || this.disposed) throw new Error('feishu-gateway: disposed')
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })
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
