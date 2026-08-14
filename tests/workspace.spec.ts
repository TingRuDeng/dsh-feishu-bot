/**
 * Workspace authorization for `/new [cwd]` (design §6.7): absolute-path-only,
 * realpath-ancestor allowlist check, fail-closed on empty allowlist.
 * `/a/bc` is NOT inside `/a/b` — containment is path-segment-wise.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeCwd, buildWorkspaceFilter, validateDefaultWorkspace } from '../src/bridge/workspace.ts'

describe('authorizeCwd', () => {
  it('fail-closed: empty allowlist rejects everything', async () => {
    await expect(authorizeCwd('/anywhere', [])).resolves.toEqual({
      ok: false, reason: 'no-workspaces-configured',
    })
  })

  it('relative path rejects without touching the filesystem', async () => {
    await expect(authorizeCwd('relative/path', ['/tmp'])).resolves.toEqual({
      ok: false, reason: 'not-absolute',
    })
  })

  it('path inside an allowed root passes and returns the realpath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-'))
    const inside = join(root, 'proj')
    await mkdir(inside)
    const result = await authorizeCwd(inside, [root])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.realpath.endsWith('/proj')).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('the allowed root itself passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-'))
    const result = await authorizeCwd(root, [root])
    expect(result.ok).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('sibling with shared prefix rejects: /a/bc is not inside /a/b', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ws-'))
    const allowed = join(base, 'b')
    const sibling = join(base, 'bc')
    await mkdir(allowed)
    await mkdir(sibling)
    await expect(authorizeCwd(sibling, [allowed])).resolves.toEqual({
      ok: false, reason: 'outside-workspaces',
    })
    await rm(base, { recursive: true, force: true })
  })

  it('nonexistent path rejects (realpath fails)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-'))
    await expect(authorizeCwd(join(root, 'nope'), [root])).resolves.toEqual({
      ok: false, reason: 'not-a-directory',
    })
    await rm(root, { recursive: true, force: true })
  })

  it('a file (not directory) rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-'))
    const file = join(root, 'f.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'x')
    await expect(authorizeCwd(file, [root])).resolves.toEqual({
      ok: false, reason: 'not-a-directory',
    })
    await rm(root, { recursive: true, force: true })
  })

  it('symlink escaping the allowlist rejects (realpath resolves the escape)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ws-'))
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const link = join(allowed, 'escape')
    await symlink(outside, link)
    await expect(authorizeCwd(link, [allowed])).resolves.toEqual({
      ok: false, reason: 'outside-workspaces',
    })
    await rm(base, { recursive: true, force: true })
  })

  it('session visibility rejects a recorded cwd that is a symlink escape', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ws-'))
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    const link = join(allowed, 'escaped-session')
    await symlink(outside, link)

    const visible = await buildWorkspaceFilter([allowed])
    await expect(visible(link)).resolves.toBe(false)
    await rm(base, { recursive: true, force: true })
  })

  it('~ expansion applies to allowlist roots', async () => {
    // The config uses ~/Desktop/mycode; the check must expand it.
    const { homedir } = await import('node:os')
    const result = await authorizeCwd(homedir(), ['~'])
    expect(result.ok).toBe(true)
  })

  it('~ expansion also applies to the requested cwd', async () => {
    await expect(authorizeCwd('~', ['~'])).resolves.toMatchObject({ ok: true })
  })

  it('rejects plugin configuration whose defaultWorkspace is outside the allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ws-'))
    await expect(validateDefaultWorkspace('/etc', [root]))
      .rejects.toThrow('defaultWorkspace is invalid (outside-workspaces)')
    await rm(root, { recursive: true, force: true })
  })
})
