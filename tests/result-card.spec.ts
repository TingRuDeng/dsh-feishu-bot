import { describe, expect, it } from 'vitest'
import {
  renderResultCard,
  resultCardEnvelopeBytes,
  segmentResultCards,
} from '../src/bridge/result-card.ts'

const RICH_MARKDOWN_RESULT = [
  '## 发布前审查结论：**暂不建议立即发布，当前为 No-Go**',
  '',
  '### 已通过的项目',
  '',
  '- Git 工作区干净',
  '- 当前提交：`bdfc47f`',
  '- 参考 [发布说明](https://example.com/releases)',
  '',
  '```sh',
  'npm test',
  '```',
].join('\n')

interface ResultCardShape {
  schema?: string
  config?: { update_multi?: boolean; wide_screen_mode?: boolean }
  header?: { title?: { tag?: string; content?: string }; template?: string }
  body?: {
    direction?: string
    elements?: { tag?: string; content?: string; text?: unknown }[]
  }
  elements?: unknown[]
}

function resultCardShape(card: object): ResultCardShape {
  return card as ResultCardShape
}

describe('result-card capacity preflight', () => {
  it('renders local Markdown links as readable paths while preserving web links', () => {
    const content = '请检查 [login.html](/home/debian/workspace/login.html:233)、[登录模板](</home/debian/My Project/login.html:3>)，并参考 [上游文档](https://example.com/docs) 与 [项目说明](docs/README.md)。'
    const [segment] = segmentResultCards('oc_test', 'workspace', content)

    expect(segment!.text).toBe('请检查 login.html（`/home/debian/workspace/login.html:233`）、登录模板（`/home/debian/My Project/login.html:3`），并参考 [上游文档](https://example.com/docs) 与 [项目说明](docs/README.md)。')
    expect(resultCardShape(segment!.card).body?.elements?.[1]?.content).toBe(segment!.text)
  })

  it('renders rich assistant Markdown through CardKit 2.0 markdown components', () => {
    const [segment] = segmentResultCards('oc_test', 'workspace', RICH_MARKDOWN_RESULT)
    const card = resultCardShape(segment!.card)

    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({ update_multi: true, wide_screen_mode: true })
    expect(card.header).toEqual({
      title: { tag: 'plain_text', content: 'workspace · 最终结果 · 1/1' },
      template: 'green',
    })
    expect(card.body).toEqual({
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: '**任务已完成 · 最终产出**' },
        { tag: 'markdown', content: RICH_MARKDOWN_RESULT },
      ],
    })
  })

  it('does not emit the legacy div/lark_md result-card structure', () => {
    const [segment] = segmentResultCards('oc_test', 'workspace', '完成了三项修改')
    const card = resultCardShape(segment!.card)

    expect(card.elements).toBeUndefined()
    expect(card.body?.elements?.every(element => element.tag === 'markdown')).toBe(true)
    expect(card.body?.elements?.every(element => element.text === undefined)).toBe(true)
  })

  it('normalizes a hostile workspace name in the plain-text header (S4)', () => {
    const [segment] = segmentResultCards('oc_test', '工作区\n[告警](http://evil.example)', '正文')
    expect(segment!.card.header.title.content)
      .toBe('工作区 [告警](http://evil.example) · 最终结果 · 1/1')
  })

  it('neutralizes backticks inside a local path so inline code stays balanced', () => {
    const [segment] = segmentResultCards('oc_test', 'workspace', '[奇怪文件](/tmp/a`b.txt)')

    expect(segment!.text).toBe('奇怪文件（`/tmp/aˋb.txt`）')
  })

  it('does not create a result card for an empty assistant body', () => {
    expect(segmentResultCards('oc_test', 'workspace', ' \n ')).toEqual([])
  })

  it('packs whole lines first and measures the full create-message envelope', () => {
    const first = '甲'.repeat(200)
    const second = '乙'.repeat(200)
    const segments = segmentResultCards('oc_test', 'workspace', `${first}\n${second}`, 1_200)

    expect(segments.map(segment => segment.text)).toEqual([first, second])
    expect(segments.map(segment => segment.card.header.title.content)).toEqual([
      'workspace · 最终结果 · 1/2',
      'workspace · 最终结果 · 2/2',
    ])
    for (const segment of segments) {
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(1_200)
    }
  })

  it('binary-splits one oversized Unicode line without losing content', () => {
    const text = `前缀${'🚀'.repeat(400)}后缀`
    const segments = segmentResultCards('oc_test', 'workspace', text, 700)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map(segment => segment.text).join('')).toBe(text)
    for (const segment of segments) {
      expect(segment.text).not.toBe('')
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(700)
    }
  })

  it('keeps every default-budget card below the 24KB soft limit', () => {
    const text = 'x'.repeat(30_000)
    const segments = segmentResultCards('oc_test', 'workspace', text)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.map(segment => segment.text).join('')).toBe(text)
    for (const segment of segments) {
      expect(resultCardEnvelopeBytes('oc_test', segment.card)).toBeLessThanOrEqual(24 * 1_024)
    }
  })

  it('accounts for the CardKit 2.0 envelope at the exact byte boundary', () => {
    const chatId = 'oc_boundary'
    const workspaceName = 'workspace'
    const text = '🚀'.repeat(300)
    const ordinalBound = [...text].length
    const exactBoundary = resultCardEnvelopeBytes(
      chatId,
      renderResultCard(workspaceName, text, ordinalBound, ordinalBound),
    )

    const atBoundary = segmentResultCards(chatId, workspaceName, text, exactBoundary)
    expect(atBoundary).toHaveLength(1)
    expect(resultCardEnvelopeBytes(chatId, atBoundary[0]!.card)).toBeLessThanOrEqual(exactBoundary)

    const belowBoundary = segmentResultCards(chatId, workspaceName, text, exactBoundary - 1)
    expect(belowBoundary.length).toBeGreaterThan(1)
    expect(belowBoundary.map(segment => segment.text).join('')).toBe(text)
    for (const segment of belowBoundary) {
      expect(resultCardEnvelopeBytes(chatId, segment.card)).toBeLessThanOrEqual(exactBoundary - 1)
    }
  })
})
