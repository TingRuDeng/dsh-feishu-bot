/**
 * Private-chat command parsing (design §6.2). A message is a command only
 * when its trimmed text starts with `/`; everything else is conversation.
 * `/new`'s remainder is one path (may contain spaces); other commands take
 * zero or one whitespace-delimited argument.
 */

/** Parsed command union; `invalid` keeps the name for the error reply. */
export type ParsedCommand =
  | { kind: 'new'; cwd: string | undefined }
  | { kind: 'use'; sessionId: string }
  | { kind: 'effort'; effortId: string }
  | { kind: 'ls' }
  | { kind: 'status' }
  | { kind: 'release' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'invalid'; name: string; problem: 'missing-argument' | 'extra-arguments' }
  | { kind: 'unknown'; name: string }

/**
 * Parse one inbound text as a command.
 * @param text - raw message text.
 * @returns the parsed command, or undefined when the text is conversation.
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const [head = '', ...rest] = trimmed.slice(1).split(/\s+/u)
  // A leading token with a path separator is an absolute path, not a command
  // (macOS/Linux paths like /Users/... arrive as ordinary conversation).
  if (head.includes('/')) return undefined
  const remainder = trimmed.slice(1 + head.length).trim()
  switch (head) {
    case 'new':
      return { kind: 'new', cwd: remainder === '' ? undefined : remainder }
    case 'use':
      if (rest.length === 0) return { kind: 'invalid', name: 'use', problem: 'missing-argument' }
      if (rest.length > 1) return { kind: 'invalid', name: 'use', problem: 'extra-arguments' }
      return { kind: 'use', sessionId: rest[0]! }
    case 'effort':
      if (rest.length === 0) return { kind: 'invalid', name: 'effort', problem: 'missing-argument' }
      if (rest.length > 1) return { kind: 'invalid', name: 'effort', problem: 'extra-arguments' }
      return { kind: 'effort', effortId: rest[0]! }
    case 'ls':
    case 'status':
    case 'release':
    case 'stop':
    case 'help':
      if (rest.length > 0) return { kind: 'invalid', name: head, problem: 'extra-arguments' }
      return { kind: head }
    default:
      return { kind: 'unknown', name: head }
  }
}
