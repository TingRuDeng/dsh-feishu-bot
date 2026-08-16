/** Normalize external text before placing it in a compact Lark surface. */
export function normalizeLarkPlainText(value: string): string {
  return value.replace(/(?:\s|\u0085)+/gu, ' ').trim()
}

function escapeAtom(char: string, orderedListDot: boolean): string {
  if (char === '&') return '&amp;'
  if (char === '<') return '&lt;'
  if (char === '>') return '&gt;'
  if (char === '`') return 'ˋ'
  if (orderedListDot || /[-\\*_{}\[\]()#+!|~]/u.test(char)) return `\\${char}`
  return char
}

/**
 * Keep one dynamic literal inert when interpolating it into Lark Markdown.
 * When supplied, byteBudget applies to the escaped UTF-8 output and never
 * splits one HTML entity, Markdown escape, or Unicode code point.
 */
export function escapeLarkMarkdownLiteral(value: string, byteBudget?: number): string {
  const normalized = normalizeLarkPlainText(value)
  const orderedList = /^\d+\./u.exec(normalized)
  const orderedListDotIndex = orderedList === null ? -1 : orderedList[0].length - 1
  const atoms: string[] = []
  let bytes = 0
  let index = 0

  for (const char of normalized) {
    const atom = escapeAtom(char, index === orderedListDotIndex)
    index += char.length
    if (byteBudget !== undefined && bytes + Buffer.byteLength(atom, 'utf8') > byteBudget) {
      const ellipsisBytes = Buffer.byteLength('…', 'utf8')
      while (atoms.length > 0 && bytes + ellipsisBytes > byteBudget) {
        bytes -= Buffer.byteLength(atoms.pop()!, 'utf8')
      }
      return byteBudget >= ellipsisBytes ? `${atoms.join('')}…` : ''
    }
    atoms.push(atom)
    bytes += Buffer.byteLength(atom, 'utf8')
  }

  return atoms.join('')
}
