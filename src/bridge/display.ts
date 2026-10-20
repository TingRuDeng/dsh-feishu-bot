export type ProgressDetail = 'concise' | 'summary' | 'full'

/** Normalize the externally configurable progress-card detail tier. */
export function normalizeProgressDetail(value: string | undefined): ProgressDetail {
  if (value === 'concise' || value === 'full') return value
  return 'summary'
}

/** Add a workspace identity prefix without duplicating an existing one. */
export function formatSessionDisplayTitle(title: string, workspaceName: string): string {
  const cleanTitle = title.trim() || '未命名会话'
  const cleanWorkspace = workspaceName.trim() || '未知工作区'
  const prefix = `【${cleanWorkspace}】`
  return cleanTitle.startsWith(prefix) ? cleanTitle : `${prefix}${cleanTitle}`
}

/**
 * The title for one session choice inside a card that may already name the
 * workspace.
 *
 * A session page is titled with its workspace, so repeating it on every row
 * repeats information the operator just read and pushes the session title — the
 * part being chosen — out of the visible width. The prefix is only kept when the
 * page is NOT scoped to that workspace, where it is the only thing telling two
 * identically named sessions apart.
 *
 * The incoming title may ALREADY carry the prefix: the bridge stores choices
 * with `formatSessionDisplayTitle`, so callers that stack both helpers would
 * otherwise render the prefix twice. This function therefore strips an existing
 * prefix in the scoped case rather than merely declining to add one.
 * @param title - the session's title, with or without a workspace prefix.
 * @param workspaceName - the workspace the session belongs to.
 * @param pageWorkspace - the workspace the containing card is scoped to, if any.
 * @returns the title to render for this choice.
 */
export function sessionChoiceTitle(
  title: string, workspaceName: string, pageWorkspace: string | undefined,
): string {
  const cleanWorkspace = workspaceName.trim() || '未知工作区'
  const cleanTitle = title.trim() || '未命名会话'
  const scoped = pageWorkspace !== undefined
    && (pageWorkspace.trim() || '未知工作区') === cleanWorkspace
  if (!scoped) return formatSessionDisplayTitle(cleanTitle, workspaceName)
  const prefix = `【${cleanWorkspace}】`
  const bare = cleanTitle.startsWith(prefix) ? cleanTitle.slice(prefix.length).trim() : cleanTitle
  return bare || '未命名会话'
}
