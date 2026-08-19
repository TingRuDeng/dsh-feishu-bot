/**
 * M7.0 runtime experiment (docs/m7-model-selection.md §6.1 / §9 未决问题 1):
 * does the Web side install a model selection ref on a Feishu-created agent,
 * and which ref wins the next request when both frontends hold one?
 *
 * The Web's install semantics are replayed VERBATIM from the api-proxy source
 * (deepseek-harness packages/host/apiproxy/src/api-proxy.ts, selectionFor):
 *   - the ref is installed lazily on the first `models`/`selectModel` RPC touch
 *     of ANY live agent (the agent registry is shared, so Feishu-created agents
 *     are reachable);
 *   - `current` is a getter: a picked value wins; otherwise it falls back to
 *     the session's request header config (the previous request's values), and
 *     only when no header exists yet to the agentDefaultModel default.
 * Everything else — the real Cordis runtime, AgentRegistry, AgentLoop, scoped
 * events, installModelSelection, the real agent/request waterfall — runs as
 * production code. The adapter is a stub only at the network boundary, and its
 * reasoning route mirrors a real adapter (efforts high/low/max, default max).
 *
 * Run: node scripts/m7-web-selection-experiment.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserApproval from '@deepseek-ai/dsh-user-approval'

const high = ReasoningEffortId('high')
const low = ReasoningEffortId('low')
const max = ReasoningEffortId('max')

/** Records every GenerateOptions it receives; reasoning route mirrors a real adapter. */
class StubAdapter extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: high, name: 'High' },
          { id: low, name: 'Low' },
          { id: max, name: 'Max' },
        ],
        defaultEffort: max,
      },
    })
  }

  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const results = []
const check = (label, got, want) => {
  const ok = got === want
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${ok ? '' : `, want ${JSON.stringify(want)}`}`)
}

/** Verbatim replay of api-proxy selectionFor (lazy install + getter fallback). */
function webSelectionFor(agent, defaults, selections) {
  const installed = selections.get(agent)
  if (installed !== undefined) return installed
  let picked
  const selection = {
    get current() {
      if (picked !== undefined) return picked
      const logged = agent.session.requestHeader()?.config
      if (logged === undefined) return defaults.currentSelection()
      return {
        provider: logged.provider,
        model: logged.model,
        ...logged.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: logged.reasoningEffort },
      }
    },
    set current(next) {
      picked = next
    },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  selections.set(agent, selection)
  return selection
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(UserApproval)

const defaults = {
  currentSelection: () => ({ provider: 'stub', model: 'm', reasoningEffort: high }),
}
ctx.provide('agentDefaultModel', defaults)

const adapter = new StubAdapter()
ctx.llm.registerAdapter(['stub'], adapter)

const mkBridgeRef = (effort) => ({
  current: { provider: 'stub', model: 'm', reasoningEffort: effort },
  assembled: undefined,
})

const createAgent = async (sessionId, setup) => {
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: 'stub', model: 'm' },
    setup,
  })
  const turn = async (text) => {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
  }
  return { handle, agent: handle.agent, turn }
}

const run = async (label, fn) => {
  try {
    await fn()
  } catch (error) {
    results.push(false)
    console.log(`FAIL  ${label}: threw ${String(error)}`)
  }
}

await run('scenario 1: fresh agent with two refs (bridge first, web second)', async () => {
  // Registration-order semantics in isolation: refA installed before refB.
  let refA
  const { handle, agent, turn } = await createAgent('exp-order', (agentCtx) => {
    refA = mkBridgeRef(low)
    installModelSelection(agentCtx, refA)
  })
  try {
    const selections = new Map()
    webSelectionFor(agent, defaults, selections)
    refA.current = { provider: 'stub', model: 'm', reasoningEffort: low }
    webSelectionFor(agent, defaults, selections).current = { provider: 'stub', model: 'm', reasoningEffort: max }
    await turn('t1')
    const got = adapter.requests.at(-1)?.reasoningEffort
    check('order test: two refs, bridge-first + web pick → winning effort', got, low)
  } finally {
    await handle.dispose()
  }
})

await run('scenario 2: Feishu-created agent, Web GUI touched later (bridge-first)', async () => {
  // This is the §6.1 scenario: bridge installs at setup, Web lazily installs
  // when the GUI touches the session, Feishu switches, then the Web user picks.
  const before = adapter.requests.length
  let bridgeRef
  const { handle, agent, turn } = await createAgent('exp-feishu-then-web', (agentCtx) => {
    bridgeRef = mkBridgeRef(high)
    installModelSelection(agentCtx, bridgeRef)
  })
  try {
    await turn('r1')
    check('r1 bridge-only first request effort', adapter.requests.at(-1)?.reasoningEffort, high)

    const selections = new Map()
    const webRef = webSelectionFor(agent, defaults, selections)
    bridgeRef.current = { provider: 'stub', model: 'm', reasoningEffort: low }
    await turn('r2')
    check('r2 after Web touch + Feishu switch: request effort', adapter.requests.at(-1)?.reasoningEffort, low)

    webRef.current = { provider: 'stub', model: 'm', reasoningEffort: max }
    await turn('r3')
    check('r3 after Web pick: request effort', adapter.requests.at(-1)?.reasoningEffort, low)
    if (adapter.requests.length !== before + 3) throw new Error(`unexpected request count ${adapter.requests.length}`)
  } finally {
    await handle.dispose()
  }
})

await run('scenario 3: Web-created agent, no bridge ref (replay fidelity control)', async () => {
  // The api-proxy setup installs the Web ref during setup; the models RPC
  // touch then returns the already-installed ref. Bridge plays no part.
  const { handle, agent, turn } = await createAgent('exp-web-alone', () => undefined)
  try {
    const selections = new Map()
    const webRef = webSelectionFor(agent, defaults, selections)
    await turn('w1')
    check('w1 web-only first request effort (header fallback)', adapter.requests.at(-1)?.reasoningEffort, high)
    webRef.current = { provider: 'stub', model: 'm', reasoningEffort: low }
    await turn('w2')
    check('w2 web-only after pick: request effort', adapter.requests.at(-1)?.reasoningEffort, low)
  } finally {
    await handle.dispose()
  }
})

await ctx.fiber.dispose()

if (results.every(Boolean)) {
  console.log('\nVERDICT: all checks passed. Order semantics: the FIRST-registered ref wins (Cordis waterfall shift-from-front + override-after-next). The Web lazily installs its ref on a Feishu-created agent when touched, but because the bridge installed first at setup, the Web ref loses — the Feishu value keeps winning and the Web pick is silently ignored.')
} else {
  console.log('\nVERDICT: check failures above — expectations did not hold at runtime.')
  process.exitCode = 1
}
