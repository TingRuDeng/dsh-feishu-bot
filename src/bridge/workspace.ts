/**
 * Workspace authorization for session-creating commands (design §6.7):
 * `/new [cwd]` may only target directories inside the configured
 * `allowedWorkspaces` roots. Requested paths are absolute or `~`-prefixed;
 * symlinks are resolved
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
 * @param cwd - requested working directory; absolute or `~`-prefixed.
 * @param allowedWorkspaces - configured roots (may use a leading `~`).
 * @returns the canonical realpath on success, or a stable rejection reason.
 */
export async function authorizeCwd(
  cwd: string,
  allowedWorkspaces: readonly string[],
): Promise<CwdAuthorization> {
  if (allowedWorkspaces.length === 0) return { ok: false, reason: 'no-workspaces-configured' }
  const expandedCwd = expandHome(cwd)
  if (!isAbsolute(expandedCwd)) return { ok: false, reason: 'not-absolute' }
  let canonical: string
  try {
    canonical = await realpath(expandedCwd)
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

/** Fail plugin startup when a configured default cwd is not authorized. */
export async function validateDefaultWorkspace(
  defaultWorkspace: string | undefined,
  allowedWorkspaces: readonly string[],
): Promise<void> {
  if (defaultWorkspace === undefined) return
  const authorization = await authorizeCwd(defaultWorkspace, allowedWorkspaces)
  if (!authorization.ok) {
    throw new Error(`feishu-bridge: defaultWorkspace is invalid (${authorization.reason})`)
  }
}

/**
 * Build a session-cwd workspace filter for `/ls` and `/use` (design §6.6:
 * only sessions under `allowedWorkspaces` are listable or bindable).
 *
 * Roots resolve through realpath once at build time; each recorded session
 * cwd is also resolved before comparison. This is intentionally asynchronous:
 * foreign sessions created by Web may retain a symlink spelling, which must
 * not let `/ls` or `/use` escape an allowed root. A cwd-less, relative,
 * missing, or unreadable header never passes. Fail-closed on an empty list.
 * @param allowedWorkspaces - configured roots (may use a leading `~`).
 * @returns a predicate over a session header's recorded cwd.
 */
export async function buildWorkspaceFilter(
  allowedWorkspaces: readonly string[],
): Promise<(cwd: string | undefined) => Promise<boolean>> {
  const roots: string[] = []
  for (const root of allowedWorkspaces) {
    const expanded = expandHome(root)
    try {
      roots.push(await realpath(expanded))
    } catch {
      // Nonexistent configured root: authorizes nothing, same as authorizeCwd.
    }
  }
  return async (cwd) => {
    if (cwd === undefined || !isAbsolute(cwd)) return false
    let canonical: string
    try {
      canonical = await realpath(cwd)
    } catch {
      return false
    }
    return roots.some(root => contains(root, canonical))
  }
}
