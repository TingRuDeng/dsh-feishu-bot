import { escapeLarkMarkdownLiteral, normalizeLarkPlainText } from './lark-markdown.ts'
import { formatSessionDisplayTitle } from './display.ts'

/** One session choice rendered on the Feishu `/ls` navigation card. */
export interface SessionListChoice {
  sessionId: string
  title: string
  workspace: string
  timeLabel: string
  shortId: string
}

/** One workspace group rendered on the first level of `/ls`. */
export interface SessionWorkspaceChoice {
  name: string
  sessionCount: number
}

/** Stable `/ls` snapshot facts needed by the session-level renderer. */
export interface SessionListCardInput {
  token: string
  workspaceIndex: number
  workspaceName: string
  choices: readonly SessionListChoice[]
  page: number
}

/** Stable `/ls` snapshot facts needed by the workspace-level renderer. */
export interface SessionWorkspaceCardInput {
  token: string
  workspaces: readonly SessionWorkspaceChoice[]
  page: number
}

/** Feishu CardKit 2.0 payload used for `/ls` navigation. */
export interface SessionListCard {
  schema: '2.0'
  config: { update_multi: boolean; wide_screen_mode: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  body: { direction: 'vertical'; elements: unknown[] }
}

export const SESSION_LIST_PAGE_SIZE = 7

function pageFacts(total: number, requestedPage: number): {
  page: number
  pageCount: number
  offset: number
} {
  const pageCount = Math.max(1, Math.ceil(total / SESSION_LIST_PAGE_SIZE))
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1)
  return { page, pageCount, offset: page * SESSION_LIST_PAGE_SIZE }
}

function button(content: string, value: Record<string, unknown>, primary = true): unknown {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content },
    ...(primary ? { type: 'primary' } : {}),
    value,
  }
}

function card(title: string, elements: unknown[], template = 'blue'): SessionListCard {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { direction: 'vertical', elements },
  }
}

function paginationButtons(input: {
  token: string
  level: 'workspaces' | 'sessions'
  page: number
  pageCount: number
  workspaceIndex?: number
}): unknown[] {
  const result: unknown[] = []
  if (input.page > 0) {
    result.push(button('上一页', {
      kind: 'session-list', action: 'page', token: input.token, level: input.level,
      page: input.page - 1, ...(input.workspaceIndex === undefined ? {} : { workspaceIndex: input.workspaceIndex }),
    }, false))
  }
  if (input.page + 1 < input.pageCount) {
    result.push(button('下一页', {
      kind: 'session-list', action: 'page', token: input.token, level: input.level,
      page: input.page + 1, ...(input.workspaceIndex === undefined ? {} : { workspaceIndex: input.workspaceIndex }),
    }))
  }
  return result
}

/** Render the first-level workspace choices from an immutable `/ls` snapshot. */
export function renderSessionWorkspaceCard(input: SessionWorkspaceCardInput): SessionListCard {
  const { page, pageCount, offset } = pageFacts(input.workspaces.length, input.page)
  const elements: unknown[] = [{
    tag: 'markdown',
    content: '请选择要继续的工作空间：',
    text_size: 'normal',
  }]
  input.workspaces.slice(offset, offset + SESSION_LIST_PAGE_SIZE).forEach((workspace, localIndex) => {
    const index = offset + localIndex
    const name = normalizeLarkPlainText(workspace.name) || '未命名工作空间'
    elements.push(button(`${index + 1}. ${name}（${workspace.sessionCount} 个会话）`, {
      kind: 'session-list', action: 'workspace', token: input.token, index,
    }))
  })
  const pagination = paginationButtons({ token: input.token, level: 'workspaces', page, pageCount })
  if (pagination.length > 0) elements.push({ tag: 'hr' }, ...pagination)
  return card(`选择工作空间 · ${page + 1}/${pageCount}`, elements)
}

/** Render one session page from the selected workspace snapshot. */
export function renderSessionListCard(input: SessionListCardInput): SessionListCard {
  const { page, pageCount, offset } = pageFacts(input.choices.length, input.page)
  const workspaceName = normalizeLarkPlainText(input.workspaceName) || '未命名工作空间'
  const elements: unknown[] = [{
    tag: 'markdown',
    content: '请选择要继续的会话：',
    text_size: 'normal',
  }]
  input.choices.slice(offset, offset + SESSION_LIST_PAGE_SIZE).forEach((choice, localIndex) => {
    const index = offset + localIndex
    const title = formatSessionDisplayTitle(normalizeLarkPlainText(choice.title) || '未命名会话', workspaceName)
    elements.push(button(`${index + 1}. ${title}`, {
      kind: 'session-list', action: 'select', token: input.token,
      workspaceIndex: input.workspaceIndex, index,
    }))
  })
  const pagination = paginationButtons({
    token: input.token,
    level: 'sessions',
    page,
    pageCount,
    workspaceIndex: input.workspaceIndex,
  })
  elements.push({ tag: 'hr' }, ...pagination, button('← 返回工作空间', {
    kind: 'session-list', action: 'back', token: input.token,
  }, false))
  return card(`${workspaceName} · 会话 · ${page + 1}/${pageCount}`, elements)
}

/** Render the accepted/completed state of one session selection click. */
export function renderSessionListStatusCard(
  status: 'binding' | 'bound' | 'failed',
  choice: SessionListChoice,
  detail?: string,
): SessionListCard {
  const presentation = {
    binding: { title: '正在绑定会话', template: 'blue', detail: '正在恢复并绑定，请稍候……' },
    bound: { title: '会话已绑定', template: 'green', detail: '绑定完成，直接发送消息即可继续任务。' },
    failed: { title: '绑定失败', template: 'red', detail: detail ?? '请重新发送 /ls 后再试。' },
  }[status]
  const title = escapeLarkMarkdownLiteral(formatSessionDisplayTitle(choice.title, choice.workspace))
  const workspace = escapeLarkMarkdownLiteral(choice.workspace)
  const detailText = escapeLarkMarkdownLiteral(presentation.detail)
  return card(presentation.title, [{
    tag: 'markdown',
    content: `**${title}**\n工作区：${workspace}\n${detailText}`,
    text_size: 'normal',
  }], presentation.template)
}
