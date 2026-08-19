/**
 * Model selection registry unit tests (M7.3): refs are keyed by session id,
 * installed through the agent scope, and removed when that scope disposes —
 * so long-running processes cannot leak one entry per historical session.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createModelSelectionRegistry } from '../src/bridge/model-selection.ts'

const high = ReasoningEffortId('high')

describe('model selection registry', () => {
  it('installs a selection ref keyed by session and removes it on agent disposal', async () => {
    const registry = createModelSelectionRegistry(() => ({ provider: 'mock', model: 'm', reasoningEffort: high }))
    const agentCtx = new Context()
    registry.install(agentCtx, 's1' as never)
    expect(registry.get('s1' as never)?.current)
      .toEqual({ provider: 'mock', model: 'm', reasoningEffort: high })

    await agentCtx.fiber.dispose()
    expect(registry.get('s1' as never)).toBeUndefined()
  })

  it('keeps independent sessions independent across disposals', async () => {
    const registry = createModelSelectionRegistry(() => ({ provider: 'mock', model: 'm' }))
    const agentA = new Context()
    const agentB = new Context()
    registry.install(agentA, 'a' as never)
    registry.install(agentB, 'b' as never)
    expect(registry.get('a' as never)).toBeDefined()
    expect(registry.get('b' as never)).toBeDefined()

    await agentA.fiber.dispose()
    expect(registry.get('a' as never)).toBeUndefined()
    expect(registry.get('b' as never)).toBeDefined()

    await agentB.fiber.dispose()
    expect(registry.get('b' as never)).toBeUndefined()
  })
})
