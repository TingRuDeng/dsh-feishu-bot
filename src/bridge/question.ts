/**
 * User-question channel pieces: the card that presents an `ask_user_question`
 * call to a chat. Pure rendering only; the bridge owns registration, the
 * pending registry, and settling the waterfall.
 *
 * A question is not an approval: it may offer no options at all, may accept
 * several, and is answered by the operator's own words as readily as by a
 * button. The card therefore renders every question of one call, keeps the
 * caller's option labels verbatim (they are the answer encoding the model
 * receives back), and adds a confirm affordance only where a click cannot
 * already express the whole answer.
 */

import { escapeLarkMarkdownLiteral } from './lark-markdown.ts'

/** One selectable answer on a question card. */
export interface QuestionCardOption {
  label: string
  description?: string
}

/** One question of a request, as presented. */
export interface QuestionCardItem {
  id: string
  question: string
  /** Supporting detail kept out of the option labels. */
  detail?: string
  header?: string
  options?: readonly QuestionCardOption[]
  multiSelect?: boolean
}

/** Feishu interactive card with action buttons (msg_type `interactive`). */
export interface FeishuActionCard {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  elements: unknown[]
}

/**
 * Longest question or option text kept on a card before clipping. A card is a
 * prompt, not the transcript: a model that pastes a page into `question` must
 * not be able to push the buttons out of view.
 */
const TEXT_BYTE_BUDGET = 1_500
const OPTION_BYTE_BUDGET = 200

/** Button verbs; a click payload carries only the pending id and one of these. */
export const QUESTION_CLICK = {
  /** Pick (or, for a multi-select, toggle) the option named by `optionIndex`. */
  pick: 'q-pick',
  /** Settle the current selection. */
  confirm: 'q-confirm',
  /** Decline to answer; the tool call receives an abort. */
  skip: 'q-skip',
} as const

/** A card click that concerns a question, decoded from the button payload. */
export interface QuestionClickValue {
  kind: 'question'
  pendingId: string
  action: string
  optionIndex?: number
}

/**
 * One open question as the renderer needs it: the request's questions plus how
 * far the operator has got. Kept deliberately small so a re-render after every
 * click is cheap.
 */
export interface QuestionCardSpec {
  /** Durable pending id; the click payload's routing key. */
  pendingId: string
  questions: readonly QuestionCardItem[]
  /** Option indices picked so far, per question id (multi-select only). */
  picked: Readonly<Record<string, readonly number[]>>
  sessionTitle: string
  /** Web GUI base URL, so a richer interaction stays one click away. */
  webUrl: string
}

/**
 * Render one question request as a single card.
 *
 * Single-select options settle the question on click: the click IS the whole
 * answer, and demanding a second tap would be busywork. Multi-select options
 * accumulate and need an explicit confirm, because until then the operator is
 * still composing. A question with no options is answered by typing, which the
 * card says outright rather than leaving the operator staring at no controls.
 * @param spec - the pending question and its current selection.
 * @returns the card JSON for msg_type `interactive`.
 */
/**
 * Everything a question needs on screen, without a card around it.
 *
 * A question is answered by buttons, and those buttons used to get a message of
 * their own — one more card below the running task's, pushing the progress the
 * operator was watching further up the chat. They are appended to the task's
 * own card instead. Each button already carries its `pendingId`, so a click
 * resolves exactly as before wherever the buttons are rendered.
 */
export function questionBodyElements(spec: QuestionCardSpec): unknown[] {
  const count = spec.questions.length
  const elements: unknown[] = []
  spec.questions.forEach((question, index) => {
    if (index > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: questionLines(question, count) } })
    const options = question.options ?? []
    if (options.length === 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '（直接回复本条消息即可作答）' },
      })
    } else {
      const picked = spec.picked[question.id] ?? []
      elements.push({
        tag: 'action',
        actions: options.map((option, optionIndex) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: escapeLarkMarkdownLiteral(option.label, OPTION_BYTE_BUDGET) },
          // A multi-select shows its accumulated choice by styling the picked
          // buttons primary. An UNPICKED button omits `type` entirely rather
          // than sending `default`: that is what every other card in this
          // codebase does, and a literal `default` was observed live to leave
          // the button unmarked, so the selection appeared to be forgotten.
          ...(question.multiSelect === true && !picked.includes(optionIndex)
            ? {}
            : { type: 'primary' as const }),
          value: {
            kind: 'question',
            pendingId: spec.pendingId,
            action: QUESTION_CLICK.pick,
            optionIndex,
          } satisfies QuestionClickValue,
        })),
      })
      if (question.multiSelect === true) {
        elements.push({
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '确认' },
              type: 'primary',
              value: {
                kind: 'question',
                pendingId: spec.pendingId,
                action: QUESTION_CLICK.confirm,
              } satisfies QuestionClickValue,
            },
            skipButton(spec.pendingId),
          ],
        })
      }
    }
  })
  // Every question needs an escape hatch. Without options there is nothing to
  // click, and the operator must still be able to decline rather than being
  // forced to type an answer to a question they cannot answer.
  const hasClickableOptions = spec.questions.some(question => (question.options ?? []).length > 0)
  const needsFooter = spec.questions.some(question => (question.options ?? []).length > 0
    && question.multiSelect !== true)
  if (needsFooter || !hasClickableOptions) {
    elements.push({ tag: 'action', actions: [skipButton(spec.pendingId)] })
  }
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**会话**：${escapeLarkMarkdownLiteral(spec.sessionTitle)}` },
  })
  if (spec.webUrl !== '') {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `[在 Web GUI 中查看](${spec.webUrl})` } })
  }
  return elements
}

/** A standalone question card, for a question with no task card to join. */
export function renderQuestionCard(spec: QuestionCardSpec): FeishuActionCard {
  return {
    config: { wide_screen_mode: true },
    header: questionHeader(),
    elements: questionBodyElements(spec),
  }
}

/** The header a standalone question card carries. */
export function questionHeader(): FeishuActionCard['header'] {
  return { title: { tag: 'plain_text', content: '需要你的回答' }, template: 'blue' }
}

function skipButton(pendingId: string): unknown {
  // No `type`: the neutral style is the ABSENCE of the key (see the option
  // buttons above), not the literal string `default`.
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '跳过' },
    value: { kind: 'question', pendingId, action: QUESTION_CLICK.skip } satisfies QuestionClickValue,
  }
}

/** One question's lines: heading, text, detail, and each option's description. */
function questionLines(question: QuestionCardItem, total: number): string {
  const lines: string[] = []
  const heading = question.header ?? (total > 1 ? `问题 ${String(questionNumber(question))}` : undefined)
  if (heading !== undefined && heading !== '') {
    lines.push(`**${escapeLarkMarkdownLiteral(heading, OPTION_BYTE_BUDGET)}**`)
  }
  lines.push(escapeLarkMarkdownLiteral(question.question, TEXT_BYTE_BUDGET))
  if (question.detail !== undefined && question.detail !== '') {
    lines.push(escapeLarkMarkdownLiteral(question.detail, TEXT_BYTE_BUDGET))
  }
  if (question.multiSelect === true) lines.push('（可多选，选好后点“确认”）')
  // A description explains a CHOICE, so it stays attached to its option rather
  // than becoming a separate paragraph the operator has to match up.
  for (const option of question.options ?? []) {
    if (option.description === undefined || option.description === '') continue
    lines.push(`· ${escapeLarkMarkdownLiteral(option.label, OPTION_BYTE_BUDGET)}：${
      escapeLarkMarkdownLiteral(option.description, TEXT_BYTE_BUDGET)}`)
  }
  return lines.join('\n')
}

/**
 * The number shown for a question lacking a `header`. Position is cosmetic
 * only; the answer always echoes the caller's `id`, never this.
 */
function questionNumber(question: QuestionCardItem): number {
  const parsed = Number.parseInt(question.id, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

/**
 * The card shown once the question is settled: the question stays visible so
 * the operator can see what was answered, with the answer recorded beneath it.
 * @param spec - the question that was pending.
 * @param answer - one line per question describing what the operator chose.
 * @returns the card JSON for msg_type `interactive`.
 */
export function renderAnsweredQuestionCard(
  spec: Pick<QuestionCardSpec, 'questions' | 'sessionTitle'>,
  answer: string,
): FeishuActionCard {
  const elements: unknown[] = []
  spec.questions.forEach((question, index) => {
    if (index > 0) elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: escapeLarkMarkdownLiteral(question.question, TEXT_BYTE_BUDGET) },
    })
  })
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `✅ ${escapeLarkMarkdownLiteral(answer)}` } })
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '已回答' }, template: 'green' },
    elements,
  }
}
