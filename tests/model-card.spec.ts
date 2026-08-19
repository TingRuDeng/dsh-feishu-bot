/**
 * M7.1 `/model` three-layer card pure-function tests: adversarial escaping,
 * pagination, effort-revalidation three-branch rule (§5.4), and terminal
 * status rendering.
 */
import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  revalidateEffort,
  renderModelCard,
  renderModelEffortCard,
  renderModelProviderCard,
  renderModelStatusCard,
} from '../src/bridge/model-card.ts'

const high = ReasoningEffortId('high')
const max = ReasoningEffortId('max')

/** Collect every button payload rendered by a card body. */
function buttonValues(card: unknown): Array<Record<string, unknown>> {
  const elements = (card as { body: { elements: unknown[] } }).body.elements
  return elements
    .filter((element): element is { value: Record<string, unknown> } =>
      (element as { tag?: string }).tag === 'button')
    .map(element => element.value)
}

describe('revalidateEffort (§5.4 three branches)', () => {
  it('keeps the current effort when the new route offers it', () => {
    expect(revalidateEffort(high, { efforts: [{ id: high }, { id: max }], defaultEffort: max }))
      .toEqual({ changed: false, next: high })
  })

  it('falls back to the route default when the current effort is absent', () => {
    expect(revalidateEffort(high, { efforts: [{ id: max }], defaultEffort: max }))
      .toEqual({ changed: true, next: max, reason: 'fallback-default' })
  })

  it('clears the effort when it is absent and the route has no default', () => {
    expect(revalidateEffort(high, { efforts: [{ id: max }] }))
      .toEqual({ changed: true, next: undefined, reason: 'cleared' })
  })

  it('clears when the route exposes no reasoning metadata at all', () => {
    expect(revalidateEffort(high, undefined))
      .toEqual({ changed: true, next: undefined, reason: 'cleared' })
  })

  it('is a no-op when no effort is currently selected', () => {
    expect(revalidateEffort(undefined, { efforts: [{ id: high }], defaultEffort: high }))
      .toEqual({ changed: false, next: undefined })
    expect(revalidateEffort(undefined, undefined))
      .toEqual({ changed: false, next: undefined })
  })
})

/** Concatenate every rendered text/markdown fragment in a card body. */
function bodyTexts(card: unknown): string {
  const elements = (card as { body: { elements: Array<{ content?: string; text?: { content: string } }> } })
    .body.elements
  return elements.map(element => element.content ?? element.text?.content ?? '').join('\n')
}

describe('renderModelProviderCard', () => {
  it('escapes adversarial provider names and paginates', () => {
    const card = renderModelProviderCard({
      token: 'tok', page: 0,
      providers: [{ id: 'mock', name: 'Mock[1](快)' }],
    })
    expect(card.header.title.content).toContain('选择模型')
    const texts = bodyTexts(card)
    expect(texts).toContain('Mock\\[1\\]\\(快\\)')
    expect(texts).not.toContain('Mock[1](快)')
    expect(buttonValues(card).every(value => value.kind === 'model')).toBe(true)
  })
})

describe('renderModelCard', () => {
  it('escapes adversarial model names and descriptions', () => {
    const card = renderModelCard({
      token: 'tok', page: 0, providerId: 'mock', providerName: 'Mock',
      models: [{ id: 'm', name: 'Model**强**', description: '描述[链接](https://e)' }],
    })
    const texts = bodyTexts(card)
    expect(texts).toContain('Model\\*\\*强\\*\\*')
    expect(texts).not.toContain('Model**强**')
    expect(texts).toContain('描述\\[链接\\]\\(https://e\\)')
  })

  it('offers a back button to the provider level', () => {
    const card = renderModelCard({
      token: 'tok', page: 0, providerId: 'mock', providerName: 'Mock',
      models: [{ id: 'm', name: 'M' }],
    })
    expect(buttonValues(card).some(value => value.action === 'back')).toBe(true)
  })
})

describe('renderModelEffortCard', () => {
  it('escapes adversarial effort names and includes keep-current plus clear', () => {
    const card = renderModelEffortCard({
      token: 'tok', page: 0, providerName: 'Mock', modelName: 'M',
      efforts: [{ id: high, name: 'High[1]' }],
      currentEffortName: 'High[1]',
    })
    const values = buttonValues(card)
    const texts = bodyTexts(card)
    expect(texts).toContain('High\\[1\\]')
    expect(texts).not.toContain('High[1]')
    expect(values.some(value => value.action === 'keep-current')).toBe(true)
    expect(values.some(value => value.action === 'clear')).toBe(true)
  })

  it('omits keep-current when nothing is selected yet', () => {
    const card = renderModelEffortCard({
      token: 'tok', page: 0, providerName: 'Mock', modelName: 'M',
      efforts: [{ id: high, name: 'High' }],
      currentEffortName: undefined,
    })
    expect(buttonValues(card).some(value => value.action === 'keep-current')).toBe(false)
  })
})

describe('renderModelStatusCard', () => {
  it('renders applied/failed/applying shapes distinctly', () => {
    expect(JSON.stringify(renderModelStatusCard('applied', '已选择 mock/m')))
      .toContain('模型已切换')
    expect(JSON.stringify(renderModelStatusCard('failed', '失败原因')))
      .toContain('切换失败')
    expect(JSON.stringify(renderModelStatusCard('applying'))).toContain('正在切换')
  })

  it('escapes the applied detail', () => {
    const card = renderModelStatusCard('applied', 'mock/m（档位：High[1]）')
    const text = bodyTexts(card)
    expect(text).toContain('High\\[1\\]')
    expect(text).not.toContain('High[1]')
  })
})
