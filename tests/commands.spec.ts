/**
 * Command parsing (design §6.2): `/`-prefixed private-chat commands.
 * Free text is not a command; unknown commands reject with help; argument
 * splitting is whitespace-based with the remainder joined for paths.
 */
import { describe, expect, it } from 'vitest'
import { parseCommand } from '../src/bridge/commands.ts'

describe('parseCommand', () => {
  it('free text is not a command', () => {
    expect(parseCommand('hello world')).toBeUndefined()
    expect(parseCommand('  leading spaces')).toBeUndefined()
  })

  it('slash-only or unknown command yields unknown with the given name', () => {
    expect(parseCommand('/frobnicate now')).toEqual({ kind: 'unknown', name: 'frobnicate' })
    expect(parseCommand('/')).toEqual({ kind: 'unknown', name: '' })
  })

  it('/new without cwd uses the default workspace marker', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new', cwd: undefined })
  })

  it('/new with a path captures the whole remainder (spaces allowed)', () => {
    expect(parseCommand('/new /a/b')).toEqual({ kind: 'new', cwd: '/a/b' })
    expect(parseCommand('/new /a/dir with spaces')).toEqual({ kind: 'new', cwd: '/a/dir with spaces' })
  })

  it('/use requires a session id', () => {
    expect(parseCommand('/use abc-123')).toEqual({ kind: 'use', sessionId: 'abc-123' })
    expect(parseCommand('/use')).toEqual({ kind: 'invalid', name: 'use', problem: 'missing-argument' })
    expect(parseCommand('/use a b')).toEqual({ kind: 'invalid', name: 'use', problem: 'extra-arguments' })
  })

  it('argument-less commands reject stray arguments', () => {
    expect(parseCommand('/ls')).toEqual({ kind: 'ls' })
    expect(parseCommand('/status')).toEqual({ kind: 'status' })
    expect(parseCommand('/release')).toEqual({ kind: 'release' })
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('/ls extra')).toEqual({ kind: 'invalid', name: 'ls', problem: 'extra-arguments' })
  })

  it('command names are case-sensitive lowercase; whitespace around is tolerated', () => {
    expect(parseCommand('  /ls  ')).toEqual({ kind: 'ls' })
    expect(parseCommand('/LS')).toEqual({ kind: 'unknown', name: 'LS' })
  })

  it('absolute paths are conversation, not commands (weclaw 2026-04-28)', () => {
    expect(parseCommand('/Users/dengtingru/a.ts 这个文件看一下')).toBeUndefined()
    expect(parseCommand('/tmp/build.log')).toBeUndefined()
    expect(parseCommand('/etc/hosts 里加一行')).toBeUndefined()
  })

  it('a bare unknown token without path separators stays an unknown command', () => {
    expect(parseCommand('/frobnicate')).toEqual({ kind: 'unknown', name: 'frobnicate' })
  })
})
