import { describe, expect, it } from 'vitest'

import { runReleaseQueue } from '../scripts/release-queue.mjs'

const repository = 'TingRuDeng/dsh-feishu-bot'

describe('release workflow queue', () => {
  it('waits until every earlier workflow run is completed', async () => {
    const responses = [
      [{ id: 10_001, run_number: 10, status: 'in_progress' }],
      [{ id: 10_001, run_number: 10, status: 'completed' }],
    ]
    const requests: Array<{ url: string, authorization: string | null }> = []
    let waits = 0
    const logs: string[] = []

    await runReleaseQueue({
      env: {
        GITHUB_REPOSITORY: repository,
        GH_TOKEN: 'synthetic-test-token',
        CURRENT_RUN_NUMBER: '11',
        CURRENT_RUN_ATTEMPT: '1',
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        requests.push({
          url: String(input),
          authorization: headers.get('authorization'),
        })
        return new Response(JSON.stringify({ workflow_runs: responses.shift() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      wait: async () => { waits += 1 },
      log: message => logs.push(message),
    })

    expect(waits).toBe(1)
    expect(logs).toEqual(['Waiting for 1 earlier RC workflow run(s).'])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual({
      url: 'https://api.github.com/repos/TingRuDeng/dsh-feishu-bot/actions/workflows/release.yml/runs?event=push&per_page=100&page=1',
      authorization: 'Bearer synthetic-test-token',
    })
  })

  it('rejects an unexpected repository before sending the job token', async () => {
    let requested = false

    await expect(runReleaseQueue({
      env: {
        GITHUB_REPOSITORY: 'attacker/fork',
        GH_TOKEN: 'synthetic-test-token',
        CURRENT_RUN_NUMBER: '11',
        CURRENT_RUN_ATTEMPT: '1',
      },
      fetchImpl: async () => {
        requested = true
        return new Response('{}', { status: 200 })
      },
      wait: async () => undefined,
      log: () => undefined,
    })).rejects.toThrow(/unexpected GitHub repository/u)
    expect(requested).toBe(false)
  })

  it('rejects a failed-jobs rerun before entering the release queue', async () => {
    let requested = false

    await expect(runReleaseQueue({
      env: {
        GITHUB_REPOSITORY: repository,
        GH_TOKEN: 'synthetic-test-token',
        CURRENT_RUN_NUMBER: '11',
        CURRENT_RUN_ATTEMPT: '2',
      },
      fetchImpl: async () => {
        requested = true
        return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
      },
      wait: async () => undefined,
      log: () => undefined,
    })).rejects.toThrow(/rerun/u)
    expect(requested).toBe(false)
  })
})
