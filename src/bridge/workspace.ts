/**
 * Workspace authorization for session-creating commands (design §6.7):
 * `/new [cwd]` may only target directories inside the configured
 * `allowedWorkspaces` roots. Absolute paths only; symlinks are resolved
 * through realpath BEFORE the ancestor check so a link cannot escape;
 * containment is segment-wise (`/a/bc` is not inside `/a/b`); an empty
 * allowlist rejects everything (fail-closed).
 */
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/** Authorization outcome; `realpath` is the canonical cwd to store and use. */
export type CwdAuthorization =
  | { ok: true; realpath: string }
  | { ok: false; reason: 'no-workspaces-configured' | 'not-absolute' | 'not-a-directory' | 'outside-workspaces' }

/** Expand a leading `~` against the invoking user's home directory. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith(`~${sep}`)) return resolve(homedir(), path.slice(2))
  return path
}

/** Segment-wise ancestor-or-self test over canonical absolute paths. */
function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Authorize a `/new` target directory against the workspace allowlist.
 * @param cwd - requested working directory; must be absolute.
 * @param allowedWorkspaces - configured roots (may use a leading `~`).
 * @returns the canonical realpath on success, or a stable rejection reason.
 */
export async function authorizeCwd(
  cwd: string,
  allowedWorkspaces: readonly string[],
): Promise<CwdAuthorization> {
  if (allowedWorkspaces.length === 0) return { ok: false, reason: 'no-workspaces-configured' }
  if (!isAbsolute(cwd)) return { ok: false, reason: 'not-absolute' }
  let canonical: string
  try {
    canonical = await realpath(cwd)
    const info = await stat(canonical)
    if (!info.isDirectory()) return { ok: false, reason: 'not-a-directory' }
  } catch {
    // realpath/stat reject: the path does not exist or is unreadable — both
    // are 'not-a-directory' to the caller; nothing else escapes those calls.
    return { ok: false, reason: 'not-a-directory' }
  }
  for (const root of allowedWorkspaces) {
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(expandHome(root))
    } catch {
      // A configured root that does not exist cannot authorize anything;
      // skip it rather than fail the whole check.
      continue
    }
    if (contains(canonicalRoot, canonical)) return { ok: true, realpath: canonical }
  }
  return { ok: false, reason: 'outside-workspaces' }
}

/**
 * Build a session-cwd workspace filter for `/ls` and `/use` (design §6.6:
 * only sessions under `allowedWorkspaces` are listable or bindable).
 *
 * Roots resolve through realpath ONCE at build time; the returned predicate
 * is synchronous and does not touch the filesystem, so a recorded session
 * cwd is compared as stored (canonical at creation via {@link authorizeCwd};
 * foreign sessions created by Web keep whatever the harness recorded).
 * A cwd-less header never passes. Fail-closed on an empty allowlist.
 * @param allowedWorkspaces - configured roots (may use a leading `~`).
 * @returns a predicate over a session header's recorded cwd.
 */
export async function buildWorkspaceFilter(
  allowedWorkspaces: readonly string[],
): Promise<(cwd: string | undefined) => boolean> {
  const roots: string[] = []
  for (const root of allowedWorkspaces) {
    const expanded = expandHome(root)
    try {
      roots.push(await realpath(expanded))
    } catch {
      // Nonexistent configured root: authorizes nothing, same as authorizeCwd.
    }
    // Also accept the pre-realpath spelling: harness session headers may
    // record the logical path (e.g. /Users/... vs /private/...) on macOS.
    if (isAbsolute(expanded) && !roots.includes(expanded)) roots.push(expanded)
  }
  return (cwd) => {
    if (cwd === undefined || !isAbsolute(cwd)) return false
    return roots.some(root => contains(root, cwd))
  }
}
