/**
 * Semantic tool activity: the classifier ported from the Web GUI's
 * `activity()`, plus the per-activity subject extraction and grouping that
 * turns a pile of tool names into a readable progress line.
 *
 * The invariant that matters: a tool the Web GUI calls "search" must never be
 * described as something else in Feishu, and no unrecognized argument may ever
 * reach a card.
 */
import { describe, expect, it } from 'vitest'
import {
  activitySubjectOf,
  describeToolCall,
  groupActivityLines,
  toolActivityOf,
} from '../src/bridge/tool-activity.ts'

describe('toolActivityOf', () => {
  it('classifies the documented tool names exactly as the Web GUI does', () => {
    expect(toolActivityOf('read')).toBe('read')
    expect(toolActivityOf('read_image')).toBe('readImage')
    expect(toolActivityOf('grep')).toBe('search')
    expect(toolActivityOf('glob')).toBe('search')
    expect(toolActivityOf('write')).toBe('write')
    expect(toolActivityOf('edit')).toBe('edit')
    expect(toolActivityOf('apply_patch')).toBe('edit')
    expect(toolActivityOf('bash')).toBe('commands')
    expect(toolActivityOf('pwsh')).toBe('commands')
    expect(toolActivityOf('write_stdin')).toBe('commands')
    expect(toolActivityOf('run_code')).toBe('code')
    expect(toolActivityOf('web_search')).toBe('webSearch')
    expect(toolActivityOf('web_fetch')).toBe('webFetch')
    expect(toolActivityOf('subagent')).toBe('subagents')
    expect(toolActivityOf('todo_write')).toBe('plan')
    expect(toolActivityOf('ask_user_question')).toBe('questions')
  })

  it('honours the prefix rules rather than exact names only', () => {
    expect(toolActivityOf('terminal_ls')).toBe('commands')
    expect(toolActivityOf('subagent_fork')).toBe('subagents')
    expect(toolActivityOf('session_inspect')).toBe('search')
  })

  it('falls back to a generic activity instead of hiding an unknown tool', () => {
    expect(toolActivityOf('some_new_tool')).toBe('tools')
  })
})

describe('activitySubjectOf', () => {
  it('names a file read by its path', () => {
    expect(activitySubjectOf('read', '{"file_path":"src/bridge/index.ts"}')).toBe('src/bridge/index.ts')
  })

  it('names a command by the command itself, not by an unrelated field', () => {
    expect(activitySubjectOf('commands', '{"command":"pnpm test","description":"run tests"}'))
      .toBe('pnpm test')
  })

  it('names a search by what it looked for', () => {
    expect(activitySubjectOf('search', '{"pattern":"toolDetail","path":"src"}')).toBe('toolDetail')
  })

  it('joins a list of queries instead of dropping it', () => {
    expect(activitySubjectOf('search', '{"queries":["alpha","beta"]}')).toBe('alpha、beta')
  })

  it('never reads an unrecognized argument, even when it holds text', () => {
    // The whitelist is the privacy boundary: a credential in an unusual field
    // must not reach a chat card.
    expect(activitySubjectOf('tools', '{"apiKey":"sk-do-not-render"}')).toBeUndefined()
  })

  it('clips a long subject on a code-point boundary instead of splitting a surrogate pair', () => {
    const long = '😀'.repeat(200)
    const subject = activitySubjectOf('commands', JSON.stringify({ command: long }))!
    expect([...subject]).toHaveLength(60)
    expect(subject.endsWith('…')).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(subject)).toBe(false)
  })
})

describe('describeToolCall', () => {
  it('describes a running command with the command it runs', () => {
    expect(describeToolCall('bash', '{"command":"pnpm test"}', 'running')).toEqual({
      activity: 'commands',
      verb: '正在执行命令',
      subject: 'pnpm test',
    })
  })

  it('describes a finished read with the file it read', () => {
    expect(describeToolCall('read', '{"file_path":"a.ts"}', 'done')).toEqual({
      activity: 'read',
      verb: '已读取文件',
      subject: 'a.ts',
    })
  })

  it('still names an unknown tool when it exposes no subject', () => {
    expect(describeToolCall('mystery_tool', '{}', 'running')).toEqual({
      activity: 'tools',
      verb: '正在调用 mystery_tool',
    })
  })
})

describe('groupActivityLines', () => {
  it('collapses repeated activities into a count and keeps EVERY distinct subject', () => {
    // Keeping only the newest subject was the regression from the previous
    // round in a new dress: two `bash` calls would render as one command with
    // the other silently missing.
    const lines = [
      describeToolCall('read', '{"file_path":"a.ts"}', 'done'),
      describeToolCall('read', '{"file_path":"b.ts"}', 'done'),
      describeToolCall('bash', '{"command":"pnpm test"}', 'done'),
    ]
    expect(groupActivityLines(lines)).toEqual([
      { activity: 'read', verb: '已读取文件', count: 2, subjects: ['a.ts', 'b.ts'] },
      { activity: 'commands', verb: '已执行命令', count: 1, subjects: ['pnpm test'] },
    ])
  })

  it('collapses only when the activity actually repeats as one line per activity', () => {
    // Two calls to the same tool with the SAME subject need no second row.
    const lines = [
      describeToolCall('read', '{"file_path":"a.ts"}', 'done'),
      describeToolCall('read', '{"file_path":"a.ts"}', 'done'),
    ]
    expect(groupActivityLines(lines)).toEqual([
      { activity: 'read', verb: '已读取文件', count: 2, subjects: ['a.ts'] },
    ])
  })

  it('preserves first-seen order rather than sorting by category', () => {
    const lines = [
      describeToolCall('bash', '{"command":"x"}', 'done'),
      describeToolCall('read', '{"file_path":"a.ts"}', 'done'),
    ]
    expect(groupActivityLines(lines).map(group => group.activity)).toEqual(['commands', 'read'])
  })

  it('returns nothing for no lines', () => {
    expect(groupActivityLines([])).toEqual([])
  })
})
