/**
 * M7.1 `/model` three-layer selection card rendering (design §5.3): provider
 * → model → effort. Pure functions only — the bridge orchestrates catalog
 * reads, token/TTL/operator checks and the switch itself.
 *
 * Every adapter/user-supplied fragment is passed through
 * `escapeLarkMarkdownLiteral` before interpolation (S4); the pagination
 * skeleton and button shape mirror `session-list-card.ts`.
 */
import type { LlmModelReasoningInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { escapeLarkMarkdownLiteral, normalizeLarkPlainText } from './lark-markdown.ts'

export const MODEL_PAGE_SIZE = 7

export interface ModelCardProvider {
  id: string
  name: string
}

export interface ModelCardModel {
  id: string
  name: string
  description?: string
}

export interface ModelCardEffort {
  id: ReasoningEffortId
  name: string
}

/** §5.4 revalidation verdict: keep, fall back to the route default, or clear. */
export type EffortRevalidation =
  | { changed: false; next: ReasoningEffortId | undefined }
  | { changed: true; next: ReasoningEffortId | undefined; reason: 'fallback-default' | 'cleared' }

/**
 * Revalidate the current effort against a (possibly new) route's metadata.
 * §5.4 three branches: keep when offered; fall back to defaultEffort when the
 * route declares one; otherwise clear (provider default applies).
 */
export function revalidateEffort(
  current: ReasoningEffortId | undefined,
  reasoning: LlmModelReasoningInfo | undefined,
): EffortRevalidation {
  if (current === undefined) return { changed: false, next: undefined }
  const efforts = reasoning?.efforts ?? []
  if (efforts.some(candidate => candidate.id === current)) return { changed: false, next: current }
  if (reasoning?.defaultEffort !== undefined) {
    return { changed: true, next: reasoning.defaultEffort, reason: 'fallback-default' }
  }
  return { changed: true, next: undefined, reason: 'cleared' }
}

function pageFacts(total: number, requestedPage: number): {
  page: number
  pageCount: number
  offset: number
} {
  const pageCount = Math.max(1, Math.ceil(total / MODEL_PAGE_SIZE))
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
  return { page, pageCount, offset: page * MODEL_PAGE_SIZE }
}

function button(content: string, value: Record<string, unknown>, primary = true): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content },
    ...(primary ? { type: 'primary' } : {}),
    value,
  }
}

function card(title: string, elements: unknown[], template = 'blue'): {
  schema: '2.0'
  config: { update_multi: boolean; wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  body: { direction: 'vertical'; elements: unknown[] }
} {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { direction: 'vertical', elements },
  }
}

function paginationButtons(input: {
  token: string
  page: number
  pageCount: number
  level: 'providers' | 'models' | 'efforts'
}): unknown[] {
  const result: unknown[] = []
  if (input.page > 0) {
    result.push(button('上一页', {
      kind: 'model', action: 'page', token: input.token,
      level: input.level, page: input.page - 1,
    }, false))
  }
  if (input.page + 1 < input.pageCount) {
    result.push(button('下一页', {
      kind: 'model', action: 'page', token: input.token,
      level: input.level, page: input.page + 1,
    }))
  }
  return result
}

/** Level 1: choose a provider. */
export function renderModelProviderCard(input: {
  token: string
  page: number
  providers: readonly ModelCardProvider[]
}): ReturnType<typeof card> {
  const { page, pageCount, offset } = pageFacts(input.providers.length, input.page)
  const elements: unknown[] = [{
    tag: 'markdown',
    content: '请选择 provider：',
    text_size: 'normal',
  }]
  input.providers.slice(offset, offset + MODEL_PAGE_SIZE).forEach((provider, localIndex) => {
    const name = escapeLarkMarkdownLiteral(normalizeLarkPlainText(provider.name) || provider.id)
    elements.push(button(`${offset + localIndex + 1}. ${name}`, {
      kind: 'model', action: 'provider', token: input.token, index: offset + localIndex,
    }))
  })
  const pagination = paginationButtons({ token: input.token, level: 'providers', page, pageCount })
  if (pagination.length > 0) elements.push({ tag: 'hr' }, ...pagination)
  return card(`选择模型 · Provider · ${page + 1}/${pageCount}`, elements)
}

/** Level 2: choose a model inside one provider. */
export function renderModelCard(input: {
  token: string
  page: number
  providerId: string
  providerName: string
  models: readonly ModelCardModel[]
}): ReturnType<typeof card> {
  const { page, pageCount, offset } = pageFacts(input.models.length, input.page)
  const providerName = normalizeLarkPlainText(input.providerName) || input.providerId
  const elements: unknown[] = [{
    tag: 'markdown',
    content: `请选择 ${escapeLarkMarkdownLiteral(providerName)} 的模型：`,
    text_size: 'normal',
  }]
  input.models.slice(offset, offset + MODEL_PAGE_SIZE).forEach((model, localIndex) => {
    const name = escapeLarkMarkdownLiteral(model.name)
    const description = model.description === undefined
      ? ''
      : `\n${escapeLarkMarkdownLiteral(model.description)}`
    elements.push({
      tag: 'markdown',
      content: `**${offset + localIndex + 1}. ${name}**${description}`,
      text_size: 'normal',
    })
    elements.push(button('选择此模型', {
      kind: 'model', action: 'model', token: input.token, index: offset + localIndex,
    }, false))
  })
  const pagination = paginationButtons({ token: input.token, level: 'models', page, pageCount })
  elements.push({ tag: 'hr' }, ...pagination, button('← 返回 Provider', {
    kind: 'model', action: 'back', token: input.token,
  }, false))
  return card(`选择模型 · ${escapeLarkMarkdownLiteral(providerName)} · ${page + 1}/${pageCount}`, elements)
}

/** Level 3: choose an effort for one exact model route. */
export function renderModelEffortCard(input: {
  token: string
  page: number
  providerName: string
  modelName: string
  efforts: readonly ModelCardEffort[]
  currentEffortName?: string
}): ReturnType<typeof card> {
  const { page, pageCount, offset } = pageFacts(input.efforts.length, input.page)
  const elements: unknown[] = [{
    tag: 'markdown',
    content: `为 ${escapeLarkMarkdownLiteral(input.modelName)} 选择档位：`,
    text_size: 'normal',
  }]
  if (input.currentEffortName !== undefined) {
    elements.push(button(`保持当前：${escapeLarkMarkdownLiteral(input.currentEffortName)}`, {
      kind: 'model', action: 'keep-current', token: input.token,
    }, false))
  }
  input.efforts.slice(offset, offset + MODEL_PAGE_SIZE).forEach(effort => {
    elements.push(button(escapeLarkMarkdownLiteral(effort.name), {
      kind: 'model', action: 'effort', token: input.token, effortId: String(effort.id),
    }))
  })
  elements.push({ tag: 'hr' })
  elements.push(button('恢复默认（跟随 provider 默认档）', {
    kind: 'model', action: 'clear', token: input.token,
  }, false))
  const pagination = paginationButtons({ token: input.token, level: 'efforts', page, pageCount })
  if (pagination.length > 0) elements.push(...pagination)
  elements.push(button('← 返回模型', {
    kind: 'model', action: 'back', token: input.token,
  }, false))
  return card(`选择档位 · ${escapeLarkMarkdownLiteral(input.providerName)}/${escapeLarkMarkdownLiteral(input.modelName)} · ${page + 1}/${pageCount}`, elements)
}

/** Terminal state after an applied/failed/in-flight switch. */
export function renderModelStatusCard(
  status: 'applying' | 'applied' | 'failed',
  detail?: string,
): ReturnType<typeof card> {
  const presentation = {
    applying: { title: '正在切换模型', template: 'blue', detail: '正在更新会话选择，请稍候……' },
    applied: { title: '模型已切换', template: 'green', detail: detail ?? '下一轮生效。' },
    failed: { title: '切换失败', template: 'red', detail: detail ?? '请重新发送 /model 后再试。' },
  }[status]
  return card(presentation.title, [{
    tag: 'markdown',
    content: escapeLarkMarkdownLiteral(presentation.detail),
    text_size: 'normal',
  }], presentation.template)
}
