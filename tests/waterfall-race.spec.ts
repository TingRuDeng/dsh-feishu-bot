/**
 * M0 runtime experiment: waterfall mechanics for the approval plan α
 * ("prepend + next() parallel race", design §6.4), verified against the
 * published cordis the skeleton depends on (same version as vendored).
 *
 * Verifies, in order:
 * 1. listener order is registration order, outermost-first;
 * 2. `prepend: true` puts a late registration at the outermost position;
 * 3. a listener that returns without `next()` vetoes the rest of the chain;
 * 4. plan α's race: the prepended listener calls `next()` immediately,
 *    races its own channel against the delegated chain, and the loser's
 *    late resolution settles without effect.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/** Test-only event map entry; mirrors approval/request's waterfall shape. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'test/approve': (tag: string, next: () => Promise<string>) => Promise<string>
  }
}

describe('waterfall mechanics for plan α', () => {
  it('runs listeners in registration order, outermost first', async () => {
    const ctx = new Context()
    const seen: string[] = []
    ctx.on('test/approve', async (tag, next) => {
      seen.push('first')
      return next()
    })
    ctx.on('test/approve', async (tag, next) => {
      seen.push('second')
      return next()
    })
    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(seen).toEqual(['first', 'second'])
    expect(result).toBe('inner')
  })

  it('prepend puts a late registration outermost', async () => {
    const ctx = new Context()
    const seen: string[] = []
    ctx.on('test/approve', async (tag, next) => {
      seen.push('web')
      return next()
    })
    ctx.on('test/approve', async (tag, next) => {
      seen.push('bridge')
      return next()
    }, { prepend: true })
    await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(seen).toEqual(['bridge', 'web'])
  })

  it('claiming without next() vetoes the rest of the chain', async () => {
    const ctx = new Context()
    const seen: string[] = []
    ctx.on('test/approve', async () => {
      seen.push('claimer')
      return 'claimed'
    })
    ctx.on('test/approve', async (tag, next) => {
      seen.push('never')
      return next()
    })
    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(result).toBe('claimed')
    expect(seen).toEqual(['claimer'])
  })

  it('plan α: prepended racer wins over a hung delegated chain', async () => {
    const ctx = new Context()
    // The "Web" listener models apiproxy: claims by registering a pending
    // request and suspending (never resolves unless its remote answers).
    let webSettled = false
    let resolveWeb: (value: string) => void = () => {}
    ctx.on('test/approve', () => new Promise<string>((resolve) => {
      resolveWeb = (value) => {
        webSettled = true
        resolve(value)
      }
    }))
    // The bridge listener: prepend, delegate immediately, race its own channel.
    ctx.on('test/approve', async (tag, next) => {
      const web = next()
      const feishu = Promise.resolve('feishu-approved')
      return Promise.race([feishu, web])
    }, { prepend: true })

    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(result).toBe('feishu-approved')
    expect(webSettled).toBe(false)
    // The loser's late resolution settles without effect on the outcome.
    resolveWeb('web-late')
    await Promise.resolve()
    expect(result).toBe('feishu-approved')
  })

  it('plan α: delegated chain wins when the bridge channel stays silent', async () => {
    const ctx = new Context()
    ctx.on('test/approve', async () => 'web-approved')
    ctx.on('test/approve', async (tag, next) => {
      const web = next()
      const feishu = new Promise<string>(() => {}) // card never clicked
      return Promise.race([feishu, web])
    }, { prepend: true })
    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(result).toBe('web-approved')
  })
})
