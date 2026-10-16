/**
 * Question-card rendering: a pending user question → Feishu interactive-card
 * JSON. Pure and deterministic. The card is a PROMPT, so these tests pin the
 * things an operator needs to answer without opening the Web GUI: the question
 * text, one button per offered option (labels verbatim — they are the answer
 * encoding the model receives), a way out of a question with no options, and
 * never a live control on a settled card.
 */
import { describe, expect, it } from 'vitest'
import { renderAnsweredQuestionCard, renderQuestionCard, QUESTION_CLICK } from '../src/bridge/question.ts'

const base = { pendingId: 'p1', picked: {}, sessionTitle: 'demo', webUrl: '' }

describe('renderQuestionCard', () => {
  it('shows the question text and one button per offered option', () => {
    const card = renderQuestionCard({
      ...base,
      questions: [{ id: 'q1', question: '要用哪个数据库？', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    })
    const json = JSON.stringify(card)
    expect(json).toContain('要用哪个数据库')
    const buttons = collectButtons(card)
    // Option buttons come first; the card also carries one escape hatch, so
    // assert on the option buttons specifically rather than on every button.
    const optionButtons = buttons.filter(button => button.value.action === QUESTION_CLICK.pick)
    expect(optionButtons.map(button => button.text.content)).toEqual(['Postgres', 'SQLite'])
    expect(buttons.map(button => button.value.action)).toContain(QUESTION_CLICK.skip)
  })

  it('keeps option labels byte-for-byte so the answer matches the caller id', () => {
    // The model receives the LABEL back; escaping or trimming it would answer
    // with a choice the asker never offered.
    const card = renderQuestionCard({
      ...base,
      questions: [{ id: 'q1', question: 'q', options: [{ label: 'a (Recommended)' }] }],
    })
    expect(JSON.stringify(card)).toContain('a \\\\(Recommended\\\\)')
  })

  it('offers a way out of a question with no options, which cannot be clicked', () => {
    // Free-text questions render no option buttons; without a skip the operator
    // would have no control at all and the card would look broken.
    const card = renderQuestionCard({ ...base, questions: [{ id: 'q1', question: '项目叫什么？' }] })
    expect(JSON.stringify(card)).toContain('直接回复本条消息即可作答')
    expect(collectButtons(card).map(button => button.value.action)).toContain(QUESTION_CLICK.skip)
  })

  it('makes a multi-select wait for an explicit confirm', () => {
    const card = renderQuestionCard({
      ...base,
      questions: [{ id: 'q1', question: '要哪些检查？', multiSelect: true, options: [{ label: 'lint' }] }],
    })
    const verbs = collectButtons(card).map(button => button.value.action)
    expect(verbs).toContain(QUESTION_CLICK.confirm)
    // A pick must not settle the question: the operator is still composing.
    expect(verbs).toContain(QUESTION_CLICK.pick)
  })

  it('marks the accumulated picks of a multi-select before confirmation', () => {
    const card = renderQuestionCard({
      ...base,
      picked: { q1: [1] },
      questions: [{
        id: 'q1',
        question: '要哪些检查？',
        multiSelect: true,
        options: [{ label: 'lint' }, { label: 'typecheck' }],
      }],
    })
    const buttons = collectButtons(card)
    expect(buttons[0]!.type).toBe('default')
    expect(buttons[1]!.type).toBe('primary')
  })

  it('shows a question header only when the caller supplied one', () => {
    const withHeader = renderQuestionCard({
      ...base,
      questions: [{ id: 'q1', header: '确认', question: '继续吗？' }],
    })
    expect(JSON.stringify(withHeader)).toContain('确认')
  })

  it('renders every question of a multi-question request', () => {
    const card = renderQuestionCard({
      ...base,
      questions: [{ id: 'q1', question: '第一个？' }, { id: 'q2', question: '第二个？' }],
    })
    const json = JSON.stringify(card)
    expect(json).toContain('第一个？')
    expect(json).toContain('第二个？')
  })

  it('never carries a live control on a settled card', () => {
    const card = renderAnsweredQuestionCard(
      { questions: [{ id: 'q1', question: '要用哪个数据库？' }], sessionTitle: 'demo' },
      '要用哪个数据库？ → Postgres',
    )
    expect(JSON.stringify(card)).toContain('Postgres')
    expect(collectButtons(card)).toEqual([])
  })
})

/** Every button on a card, in render order (the shapes Feishu accepts). */
function collectButtons(card: { elements: unknown[] }): {
  text: { content: string }
  type: string
  value: { action: string; optionIndex?: number }
}[] {
  const buttons: { text: { content: string }; type: string; value: { action: string } }[] = []
  for (const element of card.elements) {
    const actions = (element as { actions?: unknown }).actions
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      const button = action as {
        tag?: string
        text?: { content?: string }
        type?: string
        value?: { action?: string; optionIndex?: number }
      }
      if (button.tag !== 'button' || button.text?.content === undefined) continue
      buttons.push({
        text: { content: button.text.content },
        type: button.type ?? 'default',
        value: { action: button.value?.action ?? '', optionIndex: button.value?.optionIndex },
      })
    }
  }
  return buttons
}
