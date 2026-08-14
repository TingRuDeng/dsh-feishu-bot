/**
 * The feishu-bridge plugin (design §6): chat↔session bindings, commands,
 * the inbound idempotent state machine with startup reconciliation, and the
 * outbound projection with per-chat FIFO delivery.
 *
 * Ordering: all inbound work for one chat runs on that chat's serial queue —
 * startup recovery enqueues onto the same queues, so recovered and fresh
 * events cannot interleave. Approval answering (M3) is not here yet.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { FeishuInboundMessage } from '../gateway/index.ts'
// Declaration-merge imports: storage-domain contributes ctx.storageDomain,
// session-persistence contributes ctx.sessionPersistence.
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  feishuBotDomain, outboundSegmentId,
  type ChatBinding, type FeishuChatId, type FeishuEventId, type FeishuOpenId,
  type InboundEvent, type InboundMessage, type SessionIdString,
} from './domain.ts'
import { parseCommand } from './commands.ts'
import { authorizeCwd } from './workspace.ts'
import { createBridgeAgentResolver, type ResolveResult } from './resolver.ts'
import { reconcileMessage } from './inbound.ts'
import { segmentText } from './outbound.ts'

/** Bridge configuration; every deployment-varying choice is a field here. */
export interface Config {
  /** Feishu open_ids allowed to interact; empty rejects everyone (fail-closed). */
  allowedOpenIds: string[]
  /** Workspace roots `/new` may create sessions under; empty rejects all `/new`. */
  allowedWorkspaces: string[]
  /** Default cwd for `/new`; must live under an allowed root. */
  defaultWorkspace?: string
  /** Inbound event freshness window in milliseconds. */
  freshnessMs: number
  /** Minimum interval between task-card updates in milliseconds (M2). */
  cardThrottleMs: number
  /** Per-segment character budget for outbound text. */
  segmentMaxChars: number
  /** LLM provider for sessions the bridge resumes or creates. */
  agentProvider: string
  /** LLM model for sessions the bridge resumes or creates. */
  agentModel: string
}

export const Config: z<Config> = z.object({
  allowedOpenIds: z.array(z.string()).default([]),
  allowedWorkspaces: z.array(z.string()).default([]),
  defaultWorkspace: z.string(),
  freshnessMs: z.natural().default(600_000),
  cardThrottleMs: z.natural().default(1_000),
  segmentMaxChars: z.natural().default(2_000),
  agentProvider: z.string().default('deepseek'),
  agentModel: z.string().default('deepseek-chat'),
})

export const name = 'feishu-bridge'
export const inject = ['feishu', 'agents', 'sessions', 'sessionPersistence', 'storageDomain']

type Tables = {
  bindings: Awaited<ReturnType<Context['storageDomain']['open']>> extends infer D
    ? D extends { table: (name: string) => infer T } ? T : never : never
}

/**
 * Mount the bridge.
 * @param ctx - plugin context with the injected services.
 * @param config - validated bridge configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Service-like async init inside a plain plugin: hold work until ready.
  void mount(ctx, config).catch((error: unknown) => {
    ctx.logger.error('feishu-bridge mount failed: %s', String(error))
    throw error
  })
}

async function mount(ctx: Context, config: Config): Promise<void> {
  const domain = await ctx.storageDomain.open(feishuBotDomain)
  ctx.effect(() => () => domain.close(), 'feishuBridge.domainClose')
  const bindings = domain.table('bindings')
  const inboundEvents = domain.table('inbound_events')
  const outboundSegments = domain.table('outbound_segments')

  const agentOptions = (): AgentOptions =>
    ({ provider: config.agentProvider, model: config.agentModel })
  const resolve = createBridgeAgentResolver(ctx, agentOptions)

  /** Serial work queue per chat; recovery and fresh events share it. */
  const chatTails = new Map<string, Promise<void>>()
  const enqueueChatWork = (chatId: string, work: () => Promise<void>): Promise<void> => {
    const tail = chatTails.get(chatId) ?? Promise.resolve()
    const next = tail.then(work, work)
    chatTails.set(chatId, next.then(() => undefined, (error: unknown) => {
      ctx.logger.error('feishu-bridge chat %s work failed: %s', chatId, String(error))
    }))
    return next
  }

  /** Outbound: project one assistant message into durable segments, then send. */
  const projectAndSend = async (
    chatId: FeishuChatId, sessionId: SessionIdString, sourceEventSeq: number, text: string,
  ): Promise<void> => {
    const segments = segmentText(text, config.segmentMaxChars)
    for (const [index, segment] of segments.entries()) {
      const key = outboundSegmentId(chatId, sessionId, sourceEventSeq, index)
      if (outboundSegments.get(key)?.status === 'sent') continue
      await outboundSegments.put(key, {
        chatId, sessionId, sourceEventSeq,
        segmentIndex: index, segmentCount: segments.length,
        text: segment, status: 'pending', createdAt: Date.now(),
      })
      await ctx.feishu.sendText(chatId, segment)
      const row = outboundSegments.get(key)
      if (row !== undefined) await outboundSegments.put(key, { ...row, status: 'sent', text: '' })
    }
  }

  /** Live projection: assistant/message events of bound sessions → chat. */
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    for (const [chatId, binding] of bindings.entries()) {
      if (binding.status !== 'active' || (binding.sessionId as string) !== (session.id as string)) continue
      const text = extractAssistantText(event.data as { message?: { content?: unknown } })
      if (text === '') continue
      void enqueueChatWork(chatId, () =>
        projectAndSend(chatId as FeishuChatId, binding.sessionId, event.seq, text))
    }
  })

  const reply = (chatId: string, text: string): void => {
    void ctx.feishu.sendText(chatId, text).catch((error: unknown) => {
      ctx.logger.error('feishu-bridge reply to %s failed: %s', chatId, String(error))
    })
  }

  /** Route one deduplicated, authorized text message to the bound session. */
  const routeMessage = async (eventId: FeishuEventId, record: InboundMessage): Promise<void> => {
    const binding = bindings.get(record.chatId)
    if (binding === undefined || binding.status !== 'active') {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding' })
      reply(record.chatId, '当前没有绑定的会话。用 /ls 查看、/use <id> 绑定，或 /new 新建。')
      return
    }
    const resolved: ResolveResult = await resolve(binding.sessionId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: resolved.error.code })
      reply(record.chatId, `会话不可用（${resolved.error.code}）。用 /release 解绑后重新 /use 或 /new。`)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: record.text ?? '' }],
      source: { kind: 'plugin', plugin: 'feishu-bot' },
    })
    // Durable commit point BEFORE followup (crash window covered by recovery).
    await inboundEvents.put(eventId, {
      ...record,
      target: binding.sessionId,
      messageId: message.id as never,
    })
    resolved.agent.followup(message)
    await inboundEvents.put(eventId, {
      ...record,
      status: 'enqueued', text: undefined,
      target: binding.sessionId, messageId: message.id as never,
    })
  }

  const handleCommand = async (eventId: FeishuEventId, record: InboundEvent, text: string): Promise<void> => {
    const command = parseCommand(text)
    if (command === undefined) return
    const chatId = record.chatId
    const commit = async (result: string): Promise<void> => {
      await inboundEvents.put(eventId, { ...record, status: 'committed', result } as InboundEvent)
      reply(chatId, result)
    }
    switch (command.kind) {
      case 'help':
        await commit([
          '可用命令：',
          '/new [cwd] — 新建会话并绑定（cwd 须在允许的工作区内）',
          '/ls — 列出可绑定的会话',
          '/use <sessionId> — 绑定既有会话',
          '/status — 当前绑定状态',
          '/release — 解绑当前会话',
          '普通文本会作为消息发给绑定的会话。',
        ].join('\n'))
        return
      case 'ls': {
        const headers = await ctx.sessionPersistence.list()
        const rows = headers
          .filter(h => h.cwd !== undefined && h.origin !== 'subagent')
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 10)
          .map(h => `${h.id}  ${h.cwd ?? ''}`)
        await commit(rows.length === 0 ? '没有可绑定的会话。用 /new 新建。' : rows.join('\n'))
        return
      }
      case 'status': {
        const binding = bindings.get(chatId)
        await commit(binding === undefined
          ? '未绑定会话。'
          : `绑定：${binding.sessionId}（${binding.status}），由 ${binding.boundBy} 于 ${new Date(binding.boundAt).toLocaleString()} 绑定。模型提问需在 Web GUI 作答。`)
        return
      }
      case 'release': {
        const binding = bindings.get(chatId)
        if (binding === undefined) { await commit('当前没有绑定。'); return }
        await bindings.delete(chatId)
        await commit(`已解绑 ${binding.sessionId}。会话仍在运行，可随时 /use 重新绑定。`)
        return
      }
      case 'use': {
        const target = command.sessionId as unknown as SessionId
        const resolved = await resolve(target)
        if ('error' in resolved) { await commit(`无法绑定：${resolved.error.code}`); return }
        const binding: ChatBinding = {
          sessionId: command.sessionId as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        await bindings.put(chatId, binding)
        await commit(`已绑定 ${command.sessionId}。直接发消息即可对话。`)
        return
      }
      case 'new': {
        const cwdInput = command.cwd ?? config.defaultWorkspace
        if (cwdInput === undefined) { await commit('未配置默认工作区，且未提供 cwd。'); return }
        const authorized = await authorizeCwd(
          command.cwd === undefined ? cwdInput : command.cwd, config.allowedWorkspaces)
        if (!authorized.ok) { await commit(`目录不可用：${authorized.reason}`); return }
        const sessionId = `feishu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as unknown as SessionId
        const handle = await ctx.agents.create({
          sessionId,
          meta: { cwd: authorized.realpath },
          agentOptions: agentOptions(),
        })
        const binding: ChatBinding = {
          sessionId: sessionId as unknown as SessionIdString,
          status: 'active',
          boundBy: record.senderOpenId as FeishuOpenId,
          boundAt: Date.now(),
        }
        await bindings.put(chatId, binding)
        await ctx.sessions.flush(handle.agent.session)
        await commit(`已创建并绑定会话 ${String(sessionId)}（cwd: ${authorized.realpath}）。`)
        return
      }
      case 'invalid':
        await commit(`命令 /${command.name} 参数不正确（${command.problem}）。发送 /help 查看用法。`)
        return
      case 'unknown':
        await commit(`未知命令 /${command.name}。发送 /help 查看可用命令。`)
        return
    }
  }

  /** Inbound entry: allowlist → dedup → freshness → command/message. */
  ctx.on('feishu/message', (message: FeishuInboundMessage) => {
    void enqueueChatWork(message.chatId, async () => {
      if (message.chatType !== 'p2p') return
      if (!config.allowedOpenIds.includes(message.senderOpenId)) {
        ctx.logger.warn('feishu-bridge: rejected sender (allowlist), event %s', message.eventId)
        return
      }
      const eventId = message.eventId as FeishuEventId
      if (inboundEvents.get(eventId) !== undefined) return // at-least-once dedup
      if (Date.now() - message.createTimeMs > config.freshnessMs) {
        await inboundEvents.put(eventId, {
          kind: 'message',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'expired', reason: 'stale',
        })
        return
      }
      if (message.text === undefined) {
        reply(message.chatId, '暂不支持非文本消息。')
        return
      }
      const command = parseCommand(message.text)
      if (command !== undefined) {
        const record: InboundEvent = {
          kind: 'command',
          chatId: message.chatId as FeishuChatId,
          senderOpenId: message.senderOpenId as FeishuOpenId,
          receivedAt: Date.now(), status: 'received',
          command: command.kind,
          commandArgsHash: hashText(message.text),
        }
        await inboundEvents.put(eventId, record)
        await handleCommand(eventId, record, message.text)
        return
      }
      const record: InboundMessage = {
        kind: 'message',
        chatId: message.chatId as FeishuChatId,
        senderOpenId: message.senderOpenId as FeishuOpenId,
        receivedAt: Date.now(), status: 'received',
        text: message.text,
      }
      await inboundEvents.put(eventId, record)
      await routeMessage(eventId, record)
    })
  })

  await recoverInterrupted()
  ctx.logger.info('feishu-bridge mounted: %d user(s), %d workspace root(s), %d binding(s)',
    config.allowedOpenIds.length, config.allowedWorkspaces.length, bindings.size)

  /** Startup reconciliation (design §6.1/§6.2) on the same per-chat queues. */
  async function recoverInterrupted(): Promise<void> {
    for (const [eventId, record] of inboundEvents.entries()) {
      if (record.kind === 'message' && (record.status === 'received' || record.status === 'recovering')) {
        void enqueueChatWork(record.chatId, () => recoverMessage(eventId, record))
      } else if (record.kind === 'command' && record.status === 'received') {
        void enqueueChatWork(record.chatId, async () => {
          await inboundEvents.put(eventId, { ...record, status: 'rejected' })
          if (record.target !== undefined) {
            reply(record.chatId, `重启前有一条 /${record.command} 命令中断，可能已生效（目标 ${record.target}），请用 /status 核实。`)
          } else {
            reply(record.chatId, `重启前有一条 /${record.command} 命令未完成，未产生影响，请重发。`)
          }
        })
      }
    }
  }

  async function recoverMessage(eventId: FeishuEventId, record: InboundMessage): Promise<void> {
    await inboundEvents.put(eventId, { ...record, status: 'recovering' })
    const binding = bindings.get(record.chatId)
    const targetId = record.target ?? binding?.sessionId
    if (targetId === undefined) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: 'no-binding-at-recovery' })
      return
    }
    const resolved = await resolve(targetId as unknown as SessionId)
    if ('error' in resolved) {
      await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, reason: `recovery-${resolved.error.code}` })
      reply(record.chatId, `重启前有一条消息未能送达（${resolved.error.code}）。`)
      return
    }
    const verdict = reconcileMessage(record, resolved.agent.session.events)
    switch (verdict.action) {
      case 'enqueued':
        await inboundEvents.put(eventId, { ...record, status: 'enqueued', text: undefined, target: targetId })
        return
      case 'rejected':
        await inboundEvents.put(eventId, { ...record, status: 'rejected', text: undefined, target: targetId, reason: verdict.via })
        reply(record.chatId, '重启前有一条消息随任务取消被丢弃。')
        return
      case 'reroute':
      case 'refollowup': {
        if (record.text === undefined) {
          await inboundEvents.put(eventId, { ...record, status: 'rejected', target: targetId, reason: 'text-cleared-cannot-redeliver' })
          return
        }
        const message = createUserMessage({
          content: [{ type: 'text', text: record.text }],
          source: { kind: 'plugin', plugin: 'feishu-bot' },
        })
        await inboundEvents.put(eventId, { ...record, target: targetId, messageId: message.id as never })
        resolved.agent.followup(message)
        await inboundEvents.put(eventId, {
          ...record, status: 'enqueued', text: undefined, target: targetId, messageId: message.id as never,
        })
        return
      }
    }
  }
}

/** Extract concatenated text blocks from an assistant/message event payload. */
function extractAssistantText(data: { message?: { content?: unknown } }): string {
  const content = data.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('')
}

/** Stable non-reversible digest for command audit rows. */
function hashText(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}
