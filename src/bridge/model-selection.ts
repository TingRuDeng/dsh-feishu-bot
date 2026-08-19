/**
 * Bridge-owned per-session model selection registry (M7.3, design §4.1):
 * one `ModelSelectionRef` per session the bridge created or cold-resumed,
 * keyed by session id so read-only commands (`/status`) and later switching
 * commands (`/effort` `/model`) can retrieve the live selection.
 *
 * Entries are owned by the agent scope: when the agent disposes, the effect
 * cleanup removes the map entry alongside the waterfall listeners, so a
 * long-running bridge cannot leak one entry per historical session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  installModelSelection,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'

/** Read/write surface over the bridge's per-session selections. */
export interface ModelSelectionRegistry {
  /**
   * Install a fresh selection ref in the agent scope. Call only from agent
   * setup (before publication), and only for agents this bridge created or
   * cold-resumed — never for live agents another frontend owns.
   */
  install(agentCtx: Context, sessionId: SessionId): void
  /** The live selection for a bridge-owned agent, if it is still installed. */
  get(sessionId: SessionId): ModelSelectionRef | undefined
}

/**
 * Create the bridge's per-session selection registry.
 * @param defaultSelection - the complete default selection (provider, model,
 * and optional reasoning effort) captured at install time; a selection is
 * process-lifetime interaction state, not a durable fact (design §4.3).
 * @returns the registry; entries die with their agent scope.
 */
export function createModelSelectionRegistry(
  defaultSelection: () => ModelSelection,
): ModelSelectionRegistry {
  const refs = new Map<SessionId, ModelSelectionRef>()
  return {
    install(agentCtx, sessionId) {
      const selection: ModelSelectionRef = {
        current: defaultSelection(),
        assembled: undefined,
      }
      refs.set(sessionId, selection)
      agentCtx.effect(() => {
        const dispose = installModelSelection(agentCtx, selection)
        return () => {
          refs.delete(sessionId)
          dispose()
        }
      }, `feishuBridge.modelSelection(${String(sessionId)})`)
    },
    get(sessionId) {
      return refs.get(sessionId)
    },
  }
}
