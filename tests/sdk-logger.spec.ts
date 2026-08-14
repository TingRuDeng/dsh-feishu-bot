/**
 * SDK log redaction: the Feishu SDK logs config.data (full outbound message
 * bodies) on HTTP failures; the gateway's logger must strip every `data`
 * field while keeping diagnostic facts.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { redactingSdkLogger } from '../src/gateway/index.ts'

describe('redactingSdkLogger', () => {
  const capture = (): { ctx: Context; lines: string[] } => {
    const ctx = new Context()
    const lines: string[] = []
    // Route the plugin logger's error channel into an array.
    const original = ctx.logger
    void original
    ;(ctx as unknown as { logger: unknown }).logger = {
      error: (_fmt: string, line: string) => { lines.push(line) },
      warn: (_fmt: string, line: string) => { lines.push(line) },
      info: (_fmt: string, line: string) => { lines.push(line) },
    }
    return { ctx, lines }
  }

  it('replaces config.data and response.data with length markers', () => {
    const { ctx, lines } = capture()
    const logger = redactingSdkLogger(ctx)
    logger.error({
      message: 'Request failed with status code 400',
      config: { data: '{"receive_id":"oc_x","content":"{\\"text\\":\\"机密正文\\"}"}', url: '/im/v1/messages', method: 'post' },
      response: { data: { code: 230001, msg: 'param invalid' }, status: 400 },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('机密正文')
    expect(lines[0]).toContain('[redacted')
    expect(lines[0]).toContain('/im/v1/messages')
    expect(lines[0]).toContain('400')
  })

  it('keeps plain string arguments and nested arrays intact minus data fields', () => {
    const { ctx, lines } = capture()
    const logger = redactingSdkLogger(ctx)
    logger.warn('reconnecting', [{ data: 'secret body', status: 502 }])
    expect(lines[0]).toContain('reconnecting')
    expect(lines[0]).not.toContain('secret body')
    expect(lines[0]).toContain('502')
  })

  it('contains circular SDK values without throwing or exposing their data body', () => {
    const { ctx, lines } = capture()
    const logger = redactingSdkLogger(ctx)
    const circular: { data: string; self?: unknown } = { data: 'circular secret body' }
    circular.self = circular
    expect(() => logger.error(circular)).not.toThrow()
    expect(lines.join('\n')).not.toContain('circular secret body')
  })

  it('redacts the duplicated response body emitted by the SDK formatErrors bundle', () => {
    const { ctx, lines } = capture()
    const logger = redactingSdkLogger(ctx)
    logger.error([
      {
        message: 'Request failed with status code 400',
        config: { data: 'outbound message secret', url: '/im/v1/messages', method: 'post' },
        response: { data: 'response body secret', status: 400 },
      },
      'response body secret',
    ])
    logger.error([
      {
        message: 'Request failed with status code 400',
        response: { data: { code: 230001, msg: 'object response secret' }, status: 400 },
      },
      { code: 230001, msg: 'object response secret' },
    ])

    const output = lines.join('\n')
    expect(output).not.toContain('outbound message secret')
    expect(output).not.toContain('response body secret')
    expect(output).not.toContain('object response secret')
    expect(output).toContain('/im/v1/messages')
    expect(output).toContain('400')
    expect(output).toContain('[redacted sdk response body]')
  })
})
