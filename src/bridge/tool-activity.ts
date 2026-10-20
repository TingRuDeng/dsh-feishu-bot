/**
 * Semantic description of what a tool call is DOING.
 *
 * A card that prints raw tool names ("bash… edit… read…") forces the operator
 * to translate implementation vocabulary before they can tell whether the agent
 * is reading, editing, or testing. The Web GUI solved the same problem in
 * `dsh-client-ui-chat` by classifying every tool name into a small set of
 * semantic activities and rendering only the activity phrase ("正在运行命令",
 * "正在读取文件"). This module ports that classifier so both frontends speak
 * the same language instead of each inventing its own.
 *
 * The classifier is the authority on WHICH activity a tool belongs to; the
 * phrase tables below are the Feishu-side wording. Keeping the mapping in one
 * place means a tool added upstream is classified here without a second table
 * drifting out of sync.
 */

/** The semantic activity a tool call belongs to. */
export type ToolActivity =
  | 'read'
  | 'readImage'
  | 'search'
  | 'write'
  | 'edit'
  | 'commands'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagents'
  | 'plan'
  | 'questions'
  | 'tools'

/**
 * Classify one tool name into its activity.
 *
 * Mirrors `dsh-client-ui-chat`'s `activity()` exactly, including the ordered
 * special cases and the prefix rules, so a tool the Web GUI calls "search" is
 * never described differently in Feishu. Unknown tools fall through to the
 * generic `tools` activity rather than being hidden.
 * @param name - the tool name from a `tool/call` event.
 * @returns the activity the call belongs to.
 */
export function toolActivityOf(name: string): ToolActivity {
  // Tool names are lowercase in the harness, but a preset or custom tool may
  // capitalize one. Classifying case-insensitively keeps such a call correct
  // instead of degrading it to the generic activity.
  const normalized = name.toLowerCase()
  if (normalized === 'read') return 'read'
  if (normalized === 'read_image') return 'readImage'
  if (normalized === 'grep' || normalized === 'glob' || normalized.endsWith('_inspect')) return 'search'
  if (normalized === 'write') return 'write'
  if (normalized === 'edit' || normalized === 'apply_patch') return 'edit'
  if ([
    'bash',
    'pwsh',
    'exec_command',
    'write_stdin',
  ].includes(normalized) || normalized.startsWith('terminal_')) return 'commands'
  if (normalized === 'run_code') return 'code'
  if (normalized === 'web_search') return 'webSearch'
  if (normalized === 'web_fetch') return 'webFetch'
  if (normalized === 'subagent' || normalized.startsWith('subagent_')) return 'subagents'
  if ([
    'todo_write',
    'create_goal',
    'update_goal',
    'get_goal',
  ].includes(normalized)) return 'plan'
  if (normalized === 'ask_user_question' || normalized === 'request_user_input') return 'questions'
  return 'tools'
}

/** Verb phrase for an activity that has finished. */
const DONE_COPY: Readonly<Record<ToolActivity, string>> = {
  read: '已读取文件',
  readImage: '已读取图片',
  search: '已搜索代码',
  write: '已写入文件',
  edit: '已编辑文件',
  commands: '已执行命令',
  code: '已运行代码',
  webSearch: '已搜索网页',
  webFetch: '已访问网页',
  subagents: '已协调子智能体',
  plan: '已更新计划',
  questions: '已向你提问',
  tools: '已调用工具',
}

/** Verb phrase for an activity that is still running. */
const RUNNING_COPY: Readonly<Record<ToolActivity, string>> = {
  read: '正在读取文件',
  readImage: '正在读取图片',
  search: '正在搜索代码',
  write: '正在写入文件',
  edit: '正在编辑文件',
  commands: '正在执行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * The object an activity acts on, when a tool exposes one.
 *
 * Some activities read more naturally with the subject attached: "正在读取
 * 文件 · index.ts" tells the operator which file, while "正在读取文件" alone
 * could be any of a dozen files. Others (running a command) are best served by
 * the command itself, so the key order differs per activity rather than being
 * one global list.
 */
const ACTIVITY_SUBJECT_KEYS: Readonly<Record<ToolActivity, readonly string[]>> = {
  // A file-oriented activity is named by the path it touched.
  read: ['file_path', 'path', 'target', 'url', 'uri'],
  readImage: ['file_path', 'path', 'target'],
  write: ['file_path', 'path', 'target'],
  edit: ['file_path', 'path', 'target', 'pattern'],
  // A search is named by what it looked for, then where.
  search: ['pattern', 'queries', 'query', 'path', 'glob'],
  // A command is named by the command, then its description.
  commands: ['command', 'cmd', 'title', 'description'],
  // Code is named by its declared purpose, falling back to the language.
  code: ['title', 'description', 'objective', 'language'],
  webSearch: ['query', 'queries', 'pattern'],
  webFetch: ['url', 'uri', 'target'],
  // Coordination is named by what it is delegating.
  subagents: ['title', 'description', 'objective', 'task', 'task_name', 'message', 'prompt'],
  plan: ['title', 'description', 'objective', 'task', 'task_name'],
  questions: ['question', 'questions', 'header'],
  // An unknown tool can only describe itself through its own argument text.
  tools: ['title', 'description', 'objective', 'command', 'cmd', 'path', 'file_path', 'pattern', 'query'],
}

/** Longest subject kept on a card; longer values are clipped with an ellipsis. */
export const ACTIVITY_SUBJECT_MAX_CHARS = 60

/**
 * Pick the subject one activity should be described by.
 *
 * Deliberately a WHITELIST per activity: an unrecognized argument is never
 * rendered, so a tool that carries a credential in an unusual field cannot leak
 * it onto a chat card. Only the first key carrying text wins, so the result
 * stays a single readable fragment rather than a concatenation.
 * @param activity - the call's activity, which decides the key order.
 * @param args - the call's arguments, as sent by the model.
 * @returns the subject text, or undefined when the call exposes none.
 */
export function activitySubjectOf(activity: ToolActivity, args: unknown): string | undefined {
  // The card path already collapses a call's arguments into one detail string
  // during the fold, so a plain string IS the subject. Treating it as an
  // unparseable argument would discard the very text the card should show.
  if (typeof args === 'string') {
    const parsed = parseArgs(args)
    if (parsed === undefined) return clipSubject(args)
    return subjectFromRecord(activity, parsed)
  }
  const record = parseArgs(args)
  if (record === undefined) return undefined
  return subjectFromRecord(activity, record)
}

/** Pick the first whitelisted key of one activity that carries readable text. */
function subjectFromRecord(
  activity: ToolActivity, record: Record<string, unknown>,
): string | undefined {
  for (const key of ACTIVITY_SUBJECT_KEYS[activity]) {
    const value = record[key]
    if (typeof value === 'string') {
      const clipped = clipSubject(value)
      if (clipped !== undefined) return clipped
      continue
    }
    // A list of queries/patterns reads better joined than omitted; only the
    // first few entries are kept so one huge array cannot fill the card.
    if (Array.isArray(value)) {
      const parts = value.filter((entry): entry is string => typeof entry === 'string')
      if (parts.length === 0) continue
      const joined = clipSubject(parts.slice(0, 3).join('、'))
      if (joined !== undefined) return joined
    }
  }
  return undefined
}

/** Parse an argument payload that may arrive as JSON text or as an object. */
function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'string') {
    const parsed = args.trim()
    if (parsed === '') return undefined
    try {
      return parseArgs(JSON.parse(parsed))
    } catch {
      // A non-JSON argument string is the detail itself; callers decide that.
      return undefined
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  return args as Record<string, unknown>
}

/** Collapse whitespace and clip to the card budget on a code-point boundary. */
function clipSubject(value: string): string | undefined {
  const normalized = value.replace(/(?:\s|\u0085)+/gu, ' ').trim()
  if (normalized === '') return undefined
  const points = [...normalized]
  if (points.length <= ACTIVITY_SUBJECT_MAX_CHARS) return normalized
  return `${points.slice(0, ACTIVITY_SUBJECT_MAX_CHARS - 1).join('').trimEnd()}…`
}

/** One line of card progress: what the activity was, and the subject it acted on. */
export interface ActivityLine {
  /** The activity, kept for aggregation and tests. */
  activity: ToolActivity
  /** DONE or RUNNING verb phrase for that activity. */
  verb: string
  /** The subject, when the call exposed one. */
  subject?: string
}

/**
 * Describe one finished or running call as a single card line.
 * @param name - the tool name.
 * @param args - that call's arguments.
 * @param phase - whether the call is running or finished.
 * @returns the activity plus its rendered phrases.
 */
export function describeToolCall(
  name: string, args: unknown, phase: 'running' | 'done',
): ActivityLine {
  const activity = toolActivityOf(name)
  const subject = activitySubjectOf(activity, args)
  // An unknown tool with no usable argument still has to say something: its
  // own name is the only honest description available.
  const verb = activity === 'tools' && subject === undefined
    ? (phase === 'running' ? `正在调用 ${name}` : `已调用 ${name}`)
    : (phase === 'running' ? RUNNING_COPY[activity] : DONE_COPY[activity])
  return subject === undefined ? { activity, verb } : { activity, verb, subject }
}

/**
 * Group finished calls into one line per activity.
 *
 * A task that reads ten files and runs three commands should not print
 * thirteen rows: the operator wants "已读取文件 10 个 / 已执行命令 3 条", which
 * is what the Web GUI shows.
 *
 * Every DISTINCT subject is kept, not just the latest one. Collapsing to a
 * single example reintroduced the exact defect fixed in the previous round —
 * two `bash` calls rendered as one command with the other silently gone. A
 * caller that only has room for one example can read `subjects[0]`; a caller
 * with room shows them all.
 * @param lines - finished calls in chronological order.
 * @returns one entry per activity, in first-seen order.
 */
export function groupActivityLines(lines: readonly ActivityLine[]): {
  activity: ToolActivity
  verb: string
  count: number
  /** Distinct subjects in first-seen order; empty when the calls exposed none. */
  subjects: readonly string[]
}[] {
  const order: ToolActivity[] = []
  const groups = new Map<ToolActivity, { verb: string; count: number; subjects: string[] }>()
  for (const line of lines) {
    const existing = groups.get(line.activity)
    if (existing === undefined) {
      order.push(line.activity)
      groups.set(line.activity, {
        verb: line.verb,
        count: 1,
        subjects: line.subject === undefined ? [] : [line.subject],
      })
      continue
    }
    existing.count += 1
    if (line.subject !== undefined && !existing.subjects.includes(line.subject)) {
      existing.subjects.push(line.subject)
    }
  }
  return order.map((activity) => ({ activity, ...groups.get(activity)! }))
}
