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

describe('abort-to-notify: can the bridge retire the losing Web channel?', () => {
  it('bridge answer survives its own abort of the shared signal', async () => {
    // The Web client keeps its card until the request it awaits settles, so the
    // bridge must settle it. Aborting the shared signal is the only channel it
    // has, and this asserts that doing so cannot retract the answer the bridge
    // already produced.
    const ctx = new Context()
    const lifetime = new AbortController()
    let webSettled = false
    ctx.on('test/approve', async (tag, next) => {
      // The Web listener parks on its own lifetime, as the client panel does.
      try {
        return await new Promise<string>((resolve, reject) => {
          lifetime.signal.addEventListener('abort', () => {
            webSettled = true
            reject(new Error('delegated'))
          }, { once: true })
        })
      } catch (error) {
        if (String(error).includes('delegated')) return next()
        throw error
      }
    })
    ctx.on('test/approve', async (tag, next) => {
      const web = next()
      const feishu = Promise.resolve('feishu-approved')
      const raced = await Promise.race([feishu, web])
      // The bridge retires the Web card only AFTER its own outcome is fixed.
      lifetime.abort()
      return raced
    }, { prepend: true })

    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner')
    expect(result).toBe('feishu-approved')
    expect(webSettled).toBe(true)
  })

  it('aborting does not let the vetoing Web listener overwrite the answer', async () => {
    // Once the Web listener is retired it falls through to next(); the inner
    // fallback must not become the answer for a request already decided.
    const ctx = new Context()
    const lifetime = new AbortController()
    ctx.on('test/approve', async (tag, next) => {
      await new Promise<void>(resolve => lifetime.signal.addEventListener('abort', () => resolve(), { once: true }))
      return next()
    })
    ctx.on('test/approve', async (tag, next) => {
      const web = next()
      const raced = await Promise.race([Promise.resolve('feishu-approved'), web])
      lifetime.abort()
      return raced
    }, { prepend: true })

    const result = await ctx.waterfall('test/approve', 'x', async () => 'inner-fallback')
    expect(result).toBe('feishu-approved')
  })
})
