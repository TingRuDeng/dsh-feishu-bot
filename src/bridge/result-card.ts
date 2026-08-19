import type { FeishuCard } from './task-card.ts'
import { createCardMessageEnvelope, jsonUtf8Bytes } from '../gateway/envelope.ts'
import { normalizeLarkPlainText } from './lark-markdown.ts'

/** Leave headroom below Feishu's documented card size ceiling. */
export const RESULT_CARD_SOFT_LIMIT_BYTES = 24 * 1_024

export interface ResultCardSegment {
  text: string
  card: FeishuCard
}

const LOCAL_MARKDOWN_LINK = /\[([^\]\n]+)\]\(<?(\/[^)>\n]+)>?\)/gu

/** Replace non-portable absolute-path links with readable inline code. */
function rewriteFeishuLocalMarkdownLinks(content: string): string {
  return content.replace(LOCAL_MARKDOWN_LINK, (_match: string, label: string, path: string) => {
    const safePath = path.trim().replaceAll('`', 'ˋ')
    return `${label.trim()}（\`${safePath}\`）`
  })
}

/** Render one durable assistant-result segment as a green Feishu card. */
export function renderResultCard(
  workspaceName: string, text: string, segmentIndex: number, segmentCount: number,
): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `${normalizeLarkPlainText(workspaceName) || '未知工作区'} · 最终结果 · ${segmentIndex}/${segmentCount}`,
      },
      template: 'green',
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  }
}

/** Measure the exact create-message envelope for a rendered result card. */
export function resultCardEnvelopeBytes(chatId: string, card: FeishuCard): number {
  // Canonical result cards always carry a 32-character deterministic UUID.
  return jsonUtf8Bytes(createCardMessageEnvelope(chatId, card, '0'.repeat(32)))
}

/** Split one line into maximal Unicode-safe prefixes that fit the card budget. */
function splitOversizedLine(line: string, fits: (body: string) => boolean): string[] {
  const codePoints = [...line]
  const pieces: string[] = []
  let offset = 0
  while (offset < codePoints.length) {
    let low = 1
    let high = codePoints.length - offset
    let best = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = codePoints.slice(offset, offset + middle).join('')
      if (fits(candidate)) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (best === 0) throw new RangeError('result-card byte budget cannot fit one Unicode code point')
    pieces.push(codePoints.slice(offset, offset + best).join(''))
    offset += best
  }
  return pieces
}

/**
 * Split assistant Markdown into cards under a full-envelope byte budget.
 * Whole lines are packed first; only a line that cannot fit alone is cut.
 */
export function segmentResultCards(
  chatId: string,
  workspaceName: string,
  text: string,
  maxEnvelopeBytes = RESULT_CARD_SOFT_LIMIT_BYTES,
): ResultCardSegment[] {
  const normalized = rewriteFeishuLocalMarkdownLinks(text.trim())
  if (normalized === '') return []

  // One code point per card is a strict upper bound on the final count.
  // Rendering that widest possible i/N title makes packing conservative;
  // the actual final titles can only be the same size or smaller.
  const ordinalBound = Math.max(1, [...normalized].length)
  const fits = (body: string): boolean => resultCardEnvelopeBytes(
    chatId,
    renderResultCard(workspaceName, body, ordinalBound, ordinalBound),
  ) <= maxEnvelopeBytes
  if (!fits('')) throw new RangeError('result-card byte budget is smaller than the empty card envelope')

  const chunks: string[] = []
  let current: string | undefined
  const flush = (): void => {
    if (current !== undefined) chunks.push(current)
    current = undefined
  }

  for (const line of normalized.split('\n')) {
    const candidate = current === undefined ? line : `${current}\n${line}`
    if (fits(candidate)) {
      current = candidate
      continue
    }
    flush()
    if (fits(line)) {
      current = line
    } else {
      chunks.push(...splitOversizedLine(line, fits))
    }
  }
  flush()

  const count = chunks.length
  return chunks.map((body, index) => {
    const card = renderResultCard(workspaceName, body, index + 1, count)
    if (resultCardEnvelopeBytes(chatId, card) > maxEnvelopeBytes) {
      throw new RangeError('result-card envelope exceeded the byte budget after final numbering')
    }
    return { text: body, card }
  })
}
