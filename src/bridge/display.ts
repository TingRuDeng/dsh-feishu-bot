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
