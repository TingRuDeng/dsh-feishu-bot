#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  RELEASE_REPOSITORY,
  waitForReleaseTurn,
} from './release-preview-lib.mjs'

const releaseWorkflow = 'release.yml'
const pollIntervalMs = 30_000
const pageSize = 100
const maxPages = 100

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid ${label}: ${String(value)}`)
  return parsed
}

export async function listReleaseWorkflowRuns({ repository, token, fetchImpl = fetch }) {
  const runs = []
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `/repos/${repository}/actions/workflows/${releaseWorkflow}/runs`,
      'https://api.github.com',
    )
    url.searchParams.set('event', 'push')
    url.searchParams.set('per_page', String(pageSize))
    url.searchParams.set('page', String(page))
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    })
    if (!response.ok) throw new Error(`GitHub release queue lookup returned ${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body?.workflow_runs)) throw new Error('GitHub release queue response is invalid')
    runs.push(...body.workflow_runs)
    if (body.workflow_runs.length < pageSize) return runs
  }
  throw new Error(`GitHub release queue exceeded ${maxPages * pageSize} workflow runs`)
}

export async function runReleaseQueue({
  env = process.env,
  fetchImpl = fetch,
  wait = () => delay(pollIntervalMs),
  log = message => console.log(message),
} = {}) {
  if (env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY) {
    throw new Error(`unexpected GitHub repository: ${String(env.GITHUB_REPOSITORY)}`)
  }
  if (typeof env.GH_TOKEN !== 'string' || env.GH_TOKEN === '') {
    throw new Error('GH_TOKEN is required for the release queue')
  }
  if (positiveInteger(env.CURRENT_RUN_ATTEMPT, 'GitHub run attempt') !== 1) {
    throw new Error('release workflow reruns are not allowed; create a new RC tag after a failed run')
  }
  const currentRunNumber = positiveInteger(env.CURRENT_RUN_NUMBER, 'GitHub run number')
  await waitForReleaseTurn({
    currentRunNumber,
    listRuns: () => listReleaseWorkflowRuns({
      repository: env.GITHUB_REPOSITORY,
      token: env.GH_TOKEN,
      fetchImpl,
    }),
    wait,
    onBlocked: blockers => log(`Waiting for ${blockers.length} earlier RC workflow run(s).`),
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseQueue()
}
