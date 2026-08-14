/**
 * Outbound text segmentation (design §6.3). Deterministic: paragraph-first
 * packing, then hard character splits for oversized paragraphs, so replayed
 * projections regenerate byte-identical segment rows under the same key.
 */

/**
 * Split assistant text into send-sized segments.
 * @param text - full assistant message text.
 * @param maxLength - inclusive per-segment character budget (> 0).
 * @returns ordered segments; empty for blank input; every segment non-empty
 * and at most `maxLength` characters.
 */
export function segmentText(text: string, maxLength: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const segments: string[] = []
  let current = ''
  const flush = (): void => {
    if (current !== '') {
      segments.push(current)
      current = ''
    }
  }
  for (const paragraph of trimmed.split(/\n{2,}/u)) {
    const piece = paragraph.trim()
    if (piece === '') continue
    if (piece.length > maxLength) {
      flush()
      for (let i = 0; i < piece.length; i += maxLength) {
        segments.push(piece.slice(i, i + maxLength))
      }
      continue
    }
    const joined = current === '' ? piece : `${current}\n\n${piece}`
    if (joined.length <= maxLength) {
      current = joined
    } else {
      flush()
      current = piece
    }
  }
  flush()
  return segments
}
