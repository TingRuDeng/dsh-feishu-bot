/**
 * Task-card rendering: snapshot → Feishu interactive-card JSON. Pure and
 * deterministic; the waiting placeholder, status colors, and completion
 * copy follow docs/weclaw-lessons.md (2026-08-07 single waiting hint,
 * 2026-07-07 no duplicate completion text, 2026-07-31 stopped ≠ failed).
 */
import { describe, expect, it } from 'vitest'
import { renderTaskCard } from '../src/bridge/task-card.ts'

const base = {
  turn: 1,
  toolCallCount: 0,
  durationMs: null,
  startedAt: 1000,
  recentTools: [],
  failureCode: null,
  retryCount: 0,
}

describe('renderTaskCard', () => {
  it('running with no tools shows the single waiting hint', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('思考中')
    // Single hint: exactly one occurrence.
    expect(json.split('思考中').length - 1).toBe(1)
  })

  it('running with no progress uses only a session-name plus thinking header', () => {
    const card = renderTaskCard(
      { ...base, status: 'running', currentTools: [] },
      undefined,
      { title: 'dsh-feishu-bot' },
    )
    expect(card.header.title.content).toBe('dsh-feishu-bot · 思考中.....')
    expect(card.elements).toEqual([])
    expect(JSON.stringify(card).split('思考中').length - 1).toBe(1)
  })
  it('running with tools names each activity and appends one active thinking hint', () => {
    // The card names what the calls DO, not the harness tool names: "bash" is
    // "executing a command", which is what the operator can actually read.
    const card = renderTaskCard({ ...base, status: 'running', currentTools: ['Bash', 'Read'], toolCallCount: 3 })
    const json = JSON.stringify(card)
    expect(json).toContain('正在执行命令')
    expect(json).toContain('正在读取文件')
    expect(json.split('思考中').length - 1).toBe(1)
    expect(card.elements[0]!.text.content.endsWith('思考中.....')).toBe(true)
  })

  it('shows what a running tool is DOING, not only its name', () => {
    // Reported: Feishu progress read like "bash… edit…", which says nothing
    // about the work. The Web GUI shows a one-line detail taken from the
    // call's arguments; the card must do the same.
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['Bash'],
      toolDetails: { Bash: '运行 pnpm test' },
      toolCallCount: 1,
    })
    const json = JSON.stringify(card)
    expect(json).toContain('运行 pnpm test')
    // The raw tool name must not be the whole story.
    expect(json).not.toContain('Bash …')
  })

  it('describes a running call by its ACTIVITY rather than its tool name', () => {
    // A raw argument fragment ("src/bridge/index.ts") never says whether the
    // agent is reading or writing it. Naming the activity is what makes the
    // card legible without opening the Web GUI.
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['read'],
      toolDetails: { read: 'src/bridge/index.ts' },
      toolCallCount: 1,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('正在读取文件')
    expect(body).toContain('src/bridge/index.ts')
  })

  it('describes a finished command by its activity and the command it ran', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: [],
      recentTools: ['bash'],
      recentToolDetails: { bash: 'pnpm test' },
      toolCallCount: 1,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('已执行命令')
    expect(body).toContain('pnpm test')
  })

  it('collapses repeated activities into one count instead of a wall of rows', () => {
    // Reading five files should read as one line, matching the Web GUI.
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: [],
      recentTools: ['read', 'read', 'read', 'read', 'read'],
      recentToolDetails: { read: 'e.ts' },
      toolCallCount: 5,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('已读取文件 5 个')
    // The newest example still says WHICH file.
    expect(body).toContain('e.ts')
  })

  it('concise detail shows the activity without the subject', () => {
    const card = renderTaskCard(
      {
        ...base,
        status: 'running',
        currentTools: ['read'],
        toolDetails: { read: 'secret-plan.md' },
        toolCallCount: 1,
      },
      undefined,
      { progressDetail: 'concise' },
    )
    const body = card.elements[0]!.text.content
    expect(body).toContain('正在读取文件')
    expect(body).not.toContain('secret-plan.md')
  })

  it('says which step failed, semantically, without copying provider text', () => {
    const card = renderTaskCard({
      ...base,
      status: 'failed',
      currentTools: [],
      recentTools: ['bash'],
      recentToolDetails: { bash: 'pnpm test' },
      toolCallCount: 1,
      failureCode: 'TIMEOUT',
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('失败原因')
    expect(body).toContain('模型请求超时')
    // The step that was in flight is named by its activity.
    expect(body).toContain('已执行命令')
  })

  it('still names the activity when a call exposes no useful argument', () => {
    // Without arguments the subject is unknown, but WHAT the call is remains
    // knowable from the tool name, so the card still says something useful.
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['Bash'],
      toolDetails: { Bash: undefined },
      toolCallCount: 1,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('正在执行命令')
    expect(body).not.toContain('Bash')
  })

  it('falls back to the raw tool name only for a tool it cannot classify', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['mystery_tool'],
      toolCallCount: 1,
    })
    const body = card.elements[0]!.text.content
    // Escaped by the Lark-markdown literal rule; the name still reaches the card.
    expect(body).toContain('正在调用')
    expect(body).toContain('mystery')
  })

  it('renders recent completed tools with their detail too', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: [],
      recentTools: ['Bash'],
      recentToolDetails: { Bash: '运行 ls -la' },
      toolCallCount: 1,
    })
    // The card escapes Lark markdown, so assert on the rendered body rather
    // than the raw JSON (a literal "-" arrives as "\-").
    expect(card.elements[0]!.text.content).toContain('运行 ls \\-la')
    expect(card.elements[0]!.text.content).not.toContain('✅ Bash')
  })

  it('renders each repeated tool call with its own detail instead of repeating one', () => {
    // Reported shape of the defect: two `bash` calls in one task rendered the
    // SAME detail twice, so the first command vanished from the card.
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: [],
      currentToolsList: [],
      recentTools: ['bash', 'bash'],
      recentToolDetailsList: [
        { name: 'bash', detail: 'ls -la' },
        { name: 'bash', detail: 'pnpm test' },
      ],
      toolCallCount: 2,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('ls \\-la')
    expect(body).toContain('pnpm test')
    expect(body.split('pnpm test').length - 1).toBe(1)
  })

  it('renders concurrent calls of the same tool name with their own details', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['bash', 'bash'],
      currentToolsList: [
        { name: 'bash', detail: 'ls -la' },
        { name: 'bash', detail: 'pnpm test' },
      ],
      recentTools: [],
      recentToolDetailsList: [],
      toolCallCount: 2,
    })
    const body = card.elements[0]!.text.content
    expect(body).toContain('ls \\-la')
    expect(body).toContain('pnpm test')
  })

  it('completed card carries no duplicate completion body text', () => {
    const card = renderTaskCard({ ...base, status: 'completed', currentTools: [], toolCallCount: 2, durationMs: 65_000 })
    const json = JSON.stringify(card)
    expect(json).toContain('已完成')
    expect(json.split('已完成').length - 1).toBe(1)
    expect(json).toContain('1分5秒')
  })

  it('stopped renders as its own state, not failure', () => {
    const card = renderTaskCard({ ...base, status: 'stopped', currentTools: [] })
    const json = JSON.stringify(card)
    expect(json).toContain('已停止')
    expect(json).not.toContain('失败')
  })

  it('failed renders failure state', () => {
    expect(JSON.stringify(renderTaskCard({ ...base, status: 'failed', currentTools: [] }))).toContain('失败')
  })

  it('failed card explains an allowlisted error code and retry count', () => {
    const card = renderTaskCard({
      ...base,
      status: 'failed',
      currentTools: [],
      failureCode: 'EMPTY_RESPONSE',
      retryCount: 2,
    })
    const body = card.elements[0]!.text.content

    expect(body).toContain('失败原因：模型未返回内容')
    expect(body).toContain('EMPTY_RESPONSE')
    expect(body).toContain('已重试 2 次')
  })

  it('failed card never renders an unrecognized provider error code', () => {
    const card = renderTaskCard({
      ...base,
      status: 'failed',
      currentTools: [],
      failureCode: 'LEAK_sensitive_provider_detail',
      retryCount: 0,
    })
    const body = card.elements[0]!.text.content

    expect(body).toContain('失败原因：未知错误')
    expect(body).not.toContain('LEAK_sensitive_provider_detail')
  })

  it('summary is the default: keeps duration but hides token usage', () => {
    const completed = { ...base, status: 'completed' as const, currentTools: [], durationMs: 65_000 }
    const json = JSON.stringify(renderTaskCard(completed, { totalTokens: 1234, anchored: true }))
    expect(json).toContain('1分5秒')
    expect(json).not.toContain('token')
    expect(json).not.toContain('1234')
  })

  it('concise hides both duration and token usage', () => {
    const completed = { ...base, status: 'completed' as const, currentTools: [], durationMs: 65_000 }
    const json = JSON.stringify(renderTaskCard(
      completed, { totalTokens: 1234, anchored: true }, { progressDetail: 'concise' },
    ))
    expect(json).not.toContain('耗时')
    expect(json).not.toContain('token')
  })

  it('token line: full tier shows usage-anchored count; estimates show 未知', () => {
    const running = { ...base, status: 'running' as const, currentTools: ['Bash'], toolCallCount: 1 }
    let json = JSON.stringify(renderTaskCard(running, { totalTokens: 1234, anchored: true }, { progressDetail: 'full' }))
    expect(json).toContain('1234')
    expect(json).toContain('token')
    // Estimated baseline: never show the number (no fake precision).
    json = JSON.stringify(renderTaskCard(running, { totalTokens: 999, anchored: false }, { progressDetail: 'full' }))
    expect(json).not.toContain('999')
    expect(json).toContain('未知')
    // No measurement available at all: omit the line entirely.
    json = JSON.stringify(renderTaskCard(running, undefined, { progressDetail: 'full' }))
    expect(json).not.toContain('token')
  })

  it('title uses the workspace name, never a round number (weclaw UX)', () => {
    const card = renderTaskCard({ ...base, status: 'running', currentTools: [] }, undefined, { title: 'dsh-feishu-bot' })
    const json = JSON.stringify(card)
    expect(json).toContain('dsh-feishu-bot')
    expect(json).not.toContain('第')
    expect(json).not.toContain('轮')
  })

  it('recent completed tools scroll in the body as activity progress (weclaw UX)', () => {
    const card = renderTaskCard({
      ...base, status: 'running', currentTools: ['Write'],
      recentTools: ['Bash', 'Read'], toolCallCount: 3,
    })
    const json = JSON.stringify(card)
    expect(json).toContain('✅ 已执行命令')
    expect(json).toContain('✅ 已读取文件')
    expect(json).toContain('正在写入文件')
    expect(json.split('思考中').length - 1).toBe(1)
  })

  it('keeps tool names inert inside the Markdown progress body', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['Write\u2028- injected\u0085[approve](https://evil.example)'],
      recentTools: ['Bash`spoof` <tag>\u2029- next'],
      toolCallCount: 2,
    })

    expect(card.elements[0]!.text.content).toBe([
      '✅ 已调用 Bashˋspoofˋ &lt;tag&gt; \\- next',
      '▸ 正在调用 Write \\- injected \\[approve\\]\\(https://evil.example\\) …',
      '已调用工具 2 次',
      '思考中.....',
    ].join('\n'))
    expect(card.elements[0]!.text.content).not.toContain('[approve](https://evil.example)')
  })

  it('terminal cards uniformly strip the active thinking hint', () => {
    for (const status of ['completed', 'stopped', 'failed'] as const) {
      const card = renderTaskCard({ ...base, status, currentTools: [], toolCallCount: 1 })
      expect(JSON.stringify(card)).not.toContain('思考中')
    }
  })

  it('deterministic: same snapshot → identical JSON', () => {
    const snap = { ...base, status: 'running' as const, currentTools: ['Bash'] }
    expect(JSON.stringify(renderTaskCard(snap))).toBe(JSON.stringify(renderTaskCard(snap)))
  })
})

describe('a card recovered after a restart', () => {
  const running = {
    turn: 3,
    status: 'running' as const,
    currentTools: ['bash'],
    recentTools: [],
    toolCallCount: 1,
    durationMs: null,
    startedAt: 0,
    failureCode: null,
    retryCount: 0,
  }

  it('says it was recovered, because it cannot know the task is still current', () => {
    const card = renderTaskCard(running, undefined, { resumed: true })
    expect(JSON.stringify(card)).toContain('已从重启前的记录恢复')
  })

  it('does not claim a live card was recovered', () => {
    const card = renderTaskCard(running, undefined, {})
    expect(JSON.stringify(card)).not.toContain('已从重启前的记录恢复')
  })

  it('still reports the progress it does know about', () => {
    const card = renderTaskCard(running, undefined, { resumed: true })
    const body = JSON.stringify(card)
    expect(body).toContain('已从重启前的记录恢复')
    // The marker adds a line; it must not replace the actual progress.
    expect(body).toContain('正在执行命令')
    expect(body).toContain('已调用工具 1 次')
  })
})

describe('task card size ceiling', () => {
  /**
   * A card that exceeds Feishu's create-message ceiling makes `patchCard`
   * reject. The card actor then freezes the tracker, so the chat's progress
   * card stops updating for the rest of the task — the failure is silent and
   * permanent. Trimming keeps it updating instead.
   */
  const hugeSnapshot = (count: number) => {
    const tools = Array.from({ length: count }, (_, index) => `bash`)
    return {
      turn: 1,
      status: 'running' as const,
      currentTools: tools,
      currentToolsList: tools.map((name, index) => ({
        name,
        detail: `command-number-${index}-${'x'.repeat(60)}`,
      })),
      recentTools: [],
      recentToolDetailsList: [],
      toolCallCount: count,
      durationMs: null,
      startedAt: null,
      failureCode: null,
      retryCount: 0,
    }
  }

  it('keeps a pathological card under the Feishu ceiling', () => {
    const card = renderTaskCard(hugeSnapshot(400) as never, undefined, { progressDetail: 'summary' })
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
    expect(bytes).toBeLessThanOrEqual(24 * 1024)
  })

  it('says how much progress it hid, instead of dropping it silently', () => {
    const card = renderTaskCard(hugeSnapshot(400) as never, undefined, { progressDetail: 'summary' })
    const body = card.elements[0]!.text.content
    // The operator must be able to tell the view is abbreviated.
    expect(body).toMatch(/还有 \d+ (个|项|条)/u)
  })

  it('leaves a normal card exactly as it was', () => {
    const card = renderTaskCard({
      ...base,
      status: 'running',
      currentTools: ['read'],
      currentToolsList: [{ name: 'read', detail: 'a.ts' }],
      toolCallCount: 1,
    } as never, undefined, { progressDetail: 'summary' })
    const body = card.elements[0]!.text.content
    expect(body).toContain('正在读取文件')
    expect(body).toContain('a.ts')
    expect(body).not.toMatch(/还有/u)
  })
})
