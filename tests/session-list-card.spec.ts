import { describe, expect, it } from 'vitest'
import * as sessionCards from '../src/bridge/session-list-card.ts'

type Card = {
  schema?: string
  header: { title: { content: string }; template: string }
  body?: { elements: unknown[] }
}

function buttons(card: Card): Array<Record<string, unknown>> {
  return (card.body?.elements ?? []).filter((element): element is Record<string, unknown> => (
    typeof element === 'object' && element !== null && element.tag === 'button'
  ))
}

function buttonLabel(button: Record<string, unknown>): string {
  return (button.text as { content: string }).content
}

function buttonValue(button: Record<string, unknown>): Record<string, unknown> {
  return button.value as Record<string, unknown>
}

function sessionChoice(index: number): sessionCards.SessionListChoice {
  return {
    sessionId: `session-${index}`,
    title: `真实会话名称 ${index}`,
    workspace: 'project',
    timeLabel: `8月${index}日 08:00`,
    shortId: `session-${index}`,
  }
}

describe('session list CardKit 2.0 navigation', () => {
  it('renders workspace buttons with counts and token/index-only payloads', () => {
    const renderWorkspaceCard = (sessionCards as unknown as {
      renderSessionWorkspaceCard?: (input: {
        token: string
        workspaces: Array<{ name: string; sessionCount: number }>
        page: number
      }) => Card
    }).renderSessionWorkspaceCard

    expect(typeof renderWorkspaceCard).toBe('function')
    const card = renderWorkspaceCard!({
      token: 'snapshot-token',
      page: 0,
      workspaces: [
        { name: 'deepseek-harness', sessionCount: 12 },
        { name: 'dsh-feishu-bot', sessionCount: 3 },
      ],
    })

    expect(card.schema).toBe('2.0')
    expect(card.header.title.content).toBe('选择工作空间 · 1/1')
    expect(buttons(card).map(buttonLabel)).toEqual([
      '1. deepseek-harness（12 个会话）',
      '2. dsh-feishu-bot（3 个会话）',
    ])
    expect(buttonValue(buttons(card)[0]!)).toEqual({
      kind: 'session-list', action: 'workspace', token: 'snapshot-token', index: 0,
    })
    expect(JSON.stringify(card)).not.toContain('/Users/')
    expect(JSON.stringify(card)).not.toContain('sessionId')
  })

  it('renders the selected workspace page as direct title buttons with back navigation', () => {
    const card = sessionCards.renderSessionListCard({
      token: 'snapshot-token',
      workspaceIndex: 2,
      workspaceName: 'project',
      choices: Array.from({ length: 8 }, (_, index) => sessionChoice(index + 1)),
      page: 1,
    } as Parameters<typeof sessionCards.renderSessionListCard>[0]) as Card

    expect(card.schema).toBe('2.0')
    expect(card.header.title.content).toBe('project · 会话 · 2/2')
    expect(buttons(card).map(buttonLabel)).toEqual(['8. 【project】真实会话名称 8', '上一页', '← 返回工作空间'])
    expect(buttonValue(buttons(card)[0]!)).toEqual({
      kind: 'session-list', action: 'select', token: 'snapshot-token', workspaceIndex: 2, index: 7,
    })
    expect(buttonValue(buttons(card)[2]!)).toEqual({
      kind: 'session-list', action: 'back', token: 'snapshot-token',
    })
    expect(JSON.stringify(card)).not.toContain('session-8')
  })

  it('renders terminal selection states without stale buttons', () => {
    const selected = sessionChoice(1)
    const bound = sessionCards.renderSessionListStatusCard('bound', selected) as Card

    expect(bound.schema).toBe('2.0')
    expect(bound.header).toEqual({
      title: { tag: 'plain_text', content: '会话已绑定' },
      template: 'green',
    })
    expect(JSON.stringify(bound)).toContain('真实会话名称 1')
    expect(buttons(bound)).toEqual([])

    const failed = sessionCards.renderSessionListStatusCard('failed', selected, '会话已经归档') as Card
    expect(failed.header.template).toBe('red')
    expect(JSON.stringify(failed)).toContain('会话已经归档')
    expect(buttons(failed)).toEqual([])
  })

  it('keeps dynamic status facts inert inside the Markdown template', () => {
    const card = sessionCards.renderSessionListStatusCard('failed', {
      ...sessionChoice(1),
      title: 'Title\n[click](https://evil.example)',
      workspace: 'repo_#1',
    }, '1. fake\u2028- next `code` <admin> **bold**') as Card
    const content = (card.body!.elements[0] as { content: string }).content

    expect(content).toBe([
      '**【repo\\_\\#1】Title \\[click\\]\\(https://evil.example\\)**',
      '工作区：repo\\_\\#1',
      '1\\. fake \\- next ˋcodeˋ &lt;admin&gt; \\*\\*bold\\*\\*',
    ].join('\n'))
  })

  it('normalizes line breaks in user-derived button labels', () => {
    const card = sessionCards.renderSessionListCard({
      token: 'safe-token',
      workspaceIndex: 0,
      workspaceName: 'project\n伪造标题',
      page: 0,
      choices: [{
        sessionId: 'opaque',
        title: '标题\n伪造按钮',
        workspace: 'project',
        timeLabel: '8月15日 09:00',
        shortId: 'opaque',
      }],
    } as Parameters<typeof sessionCards.renderSessionListCard>[0]) as Card

    expect(card.header.title.content).toBe('project 伪造标题 · 会话 · 1/1')
    expect(buttonLabel(buttons(card)[0]!)).toBe('1. 【project 伪造标题】标题 伪造按钮')
  })
})
