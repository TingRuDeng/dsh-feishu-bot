/**
 * The `ctx.feishu` transport service: Feishu long-connection lifecycle,
 * inbound event dispatch, outbound send/card FIFO with retry. Carries no
 * business semantics — feishu-bridge owns those.
 *
 * M0 skeleton: registers the service surface and logs a mount line;
 * the real SDK wiring lands in M1.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Gateway configuration: credential references only, no secrets. */
export interface Config {
  /** Credential reference for the Feishu app id. */
  appIdRef: string
  /** Credential reference for the Feishu app secret. */
  appSecretRef: string
}

export const Config: z<Config> = z.object({
  appIdRef: z.string().required(),
  appSecretRef: z.string().required(),
})

export const name = 'feishu-gateway'
export const inject = ['logger']

declare module '@deepseek-ai/cordis' {
  interface Context {
    feishu: FeishuGateway
  }
}

/** Transport-only Feishu service; see the design doc for the full contract. */
export class FeishuGateway extends Service {
  constructor(ctx: Context, private config: Config) {
    super(ctx, 'feishu')
    ctx.logger.info('feishu-gateway skeleton mounted (SDK wiring lands in M1)')
  }
}

/**
 * Mount the gateway service.
 * @param ctx - plugin context.
 * @param config - validated gateway configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(FeishuGateway, config)
}
