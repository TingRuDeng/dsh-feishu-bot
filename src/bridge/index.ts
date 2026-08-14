/**
 * The feishu-bridge plugin: chat↔session bindings, commands, inbound
 * idempotent state machine, outbound projection, and approval answering.
 *
 * M0 skeleton: validates config and confirms injected services exist;
 * business logic lands milestone by milestone (see the implementation plan).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Bridge configuration; every deployment-varying choice is a field here. */
export interface Config {
  /** Feishu open_ids allowed to interact; empty rejects everyone (fail-closed). */
  allowedOpenIds: string[]
  /** Workspace roots `/new` may create sessions under; empty rejects all `/new`. */
  allowedWorkspaces: string[]
  /** Default cwd for `/new` and the `/ls` view; must live under an allowed root. */
  defaultWorkspace?: string
  /** Inbound event freshness window in milliseconds. */
  freshnessMs: number
  /** Minimum interval between task-card updates in milliseconds. */
  cardThrottleMs: number
}

export const Config: z<Config> = z.object({
  allowedOpenIds: z.array(z.string()).default([]),
  allowedWorkspaces: z.array(z.string()).default([]),
  defaultWorkspace: z.string(),
  freshnessMs: z.natural().default(600_000),
  cardThrottleMs: z.natural().default(1_000),
})

export const name = 'feishu-bridge'
export const inject = ['feishu', 'agents', 'sessions', 'storageDomain', 'logger']

/**
 * Mount the bridge.
 * @param ctx - plugin context with the injected services.
 * @param config - validated bridge configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.logger.info(
    'feishu-bridge skeleton mounted: %d allowlisted user(s), %d workspace root(s)',
    config.allowedOpenIds.length, config.allowedWorkspaces.length,
  )
}
