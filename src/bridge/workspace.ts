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
