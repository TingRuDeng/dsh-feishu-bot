import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const releasePath = join(process.cwd(), '.github/workflows/release.yml')
const previewPath = join(process.cwd(), '.github/workflows/release-preview.yml')
const releaseWorkflow = existsSync(releasePath) ? readFileSync(releasePath, 'utf8') : ''
const previewWorkflow = readFileSync(previewPath, 'utf8')

function requireContract(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function actionReferences(source: string) {
  return [...source.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gmu)].map(match => match[1])
}

function validateActionPins(source: string) {
  for (const reference of actionReferences(source)) {
    if (reference.startsWith('./')) continue
    requireContract(/^[^@\s]+@[0-9a-f]{40}$/u.test(reference), `Action is not pinned: ${reference}`)
  }
}

function jobBlock(source: string, name: string) {
  const marker = `  ${name}:\n`
  const start = source.indexOf(marker)
  requireContract(start >= 0, `release workflow is missing job: ${name}`)
  const rest = source.slice(start + marker.length)
  const next = rest.search(/^  [a-zA-Z][a-zA-Z0-9_]*:\n/mu)
  return source.slice(start, next < 0 ? source.length : start + marker.length + next)
}

function namedStepBlock(source: string, name: string) {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  requireContract(start >= 0, `workflow is missing step: ${name}`)
  const rest = source.slice(start + marker.length)
  const next = rest.search(/^      - (?:name:|uses:)/mu)
  return source.slice(start, next < 0 ? source.length : start + marker.length + next)
}

function requireExactPermissions(block: string, permissions: string[]) {
  const match = block.match(/^    permissions:\n((?:      [a-z-]+: (?:read|write|none)\n)+)/mu)
  requireContract(match !== null, 'job permissions are missing')
  const actual = match[1].trim().split('\n').map(permission => permission.trim()).sort()
  const expected = permissions.map(permission => `${permission}`).sort()
  requireContract(
    actual.length === expected.length && actual.every((permission, index) => permission === expected[index]),
    `unexpected job permissions: ${actual.join(', ')}`,
  )
}

function validateReleaseWorkflow(source: string) {
  requireContract(/\non:\n  push:\n    tags:\n      - 'v\*-rc\.\*'\n/u.test(`\n${source}`), 'release trigger is not tag-only')
  for (const forbidden of [
    'workflow_call:',
    'workflow_dispatch:',
    'pull_request:',
    'pull_request_target:',
    'repository_dispatch:',
    'schedule:',
    'branches:',
  ]) {
    requireContract(!source.includes(forbidden), `release workflow contains forbidden trigger: ${forbidden}`)
  }
  requireContract(!/^\s*concurrency:/mu.test(source), 'release workflow must not use the lossy native concurrency queue')

  const jobs = ['build', 'build_attest', 'stage_draft', 'publish_npm', 'finalize_release']
  const jobsSource = source.slice(source.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const actualJobs = [...jobsSource.matchAll(/^  ([a-zA-Z][a-zA-Z0-9_]*):\n/gmu)].map(match => match[1])
  requireContract(
    actualJobs.length === jobs.length && actualJobs.every((job, index) => job === jobs[index]),
    `release workflow has unexpected jobs: ${actualJobs.join(', ')}`,
  )
  const positions = jobs.map(job => source.indexOf(`  ${job}:`))
  requireContract(positions.every(position => position >= 0), 'release workflow is missing a required job')
  requireContract(positions.every((position, index) => index === 0 || position > positions[index - 1]), 'release jobs are out of order')
  const buildJob = jobBlock(source, 'build')
  const attestJob = jobBlock(source, 'build_attest')
  const draftJob = jobBlock(source, 'stage_draft')
  const publishJob = jobBlock(source, 'publish_npm')
  const finalizeJob = jobBlock(source, 'finalize_release')
  requireContract(attestJob.includes('needs: build'), 'attestation job must consume build')
  requireContract(draftJob.includes('needs: build_attest'), 'draft job must consume build_attest')
  requireContract(publishJob.includes('needs: stage_draft'), 'npm job must consume stage_draft')
  requireContract(finalizeJob.includes('needs: publish_npm'), 'finalize job must consume publish_npm')
  requireExactPermissions(buildJob, ['contents: read'])
  requireExactPermissions(attestJob, ['attestations: write', 'contents: read', 'id-token: write'])
  requireExactPermissions(draftJob, ['contents: write'])
  requireExactPermissions(publishJob, ['actions: read', 'contents: read', 'id-token: write'])
  requireExactPermissions(finalizeJob, ['contents: write'])
  for (const [name, block] of [
    ['attestation', attestJob],
    ['draft', draftJob],
    ['finalize', finalizeJob],
  ] as const) {
    requireContract(
      block.includes('steps:\n      - name: Reject release workflow reruns'),
      `${name} job must reject reruns before any other step`,
    )
    const rerunGuard = namedStepBlock(block, 'Reject release workflow reruns')
    requireContract(rerunGuard.includes('CURRENT_RUN_ATTEMPT: ${{ github.run_attempt }}'), `${name} rerun guard is missing its attempt`)
    requireContract(rerunGuard.includes('[ "$CURRENT_RUN_ATTEMPT" != "1" ]'), `${name} rerun guard does not fail closed`)
  }

  validateActionPins(source)
  requireContract((source.match(/actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/gu) ?? []).length === 2, 'release workflow must create two pinned attestations')
  requireContract(source.includes('predicate-type: https://cyclonedx.org/bom'), 'release workflow must attest the CycloneDX predicate')
  requireContract(buildJob.includes('pnpm release:formal'), 'build job must call the formal release gate')
  requireContract(buildJob.includes('DSH_RELEASE_ARTIFACT_DIR:'), 'formal gate must receive an isolated artifact directory')
  requireContract(!buildJob.includes('id-token: write'), 'build job must not hold OIDC authority')
  requireContract((attestJob.match(/gh attestation verify/gu) ?? []).length === 5, 'attestation job must verify every provenance subject and the SBOM predicate')
  for (const policy of ['--signer-workflow', '--signer-digest', '--source-ref', '--source-digest', '--deny-self-hosted-runners']) {
    requireContract(attestJob.includes(policy), `GitHub attestation verification is missing ${policy}`)
  }
  requireContract(!/\b(?:npm|pnpm)\s+pack\b/u.test(source), 'release workflow must not create a second tarball')
  requireContract(!source.includes('*.tgz'), 'release workflow must use the descriptor tarball, not a glob')

  const publishCommands = source.match(/npm publish "\$TGZ" --tag next --access public --provenance/gu) ?? []
  requireContract(publishCommands.length === 2, 'bootstrap and OIDC must each publish the descriptor tarball to next')
  const allPublishCommands = source.match(/^[ \t]+(?:run:[ \t]+)?(?:env[^\n]*[ \t]+)?npm publish\b[^\n]*$/gmu) ?? []
  requireContract(allPublishCommands.length === 2, 'release workflow must have exactly two mutually exclusive publish commands')
  requireContract(
    !/(?:--tag(?:=|\s+)latest\b|npm\s+dist-tag\b[^\n]*\blatest\b|npm\s+config\s+set\s+tag\s+latest\b)/iu.test(source),
    'release workflow must not move latest',
  )
  requireContract(!/npm publish\s+(?:\.|\.\/|"?\$ARTIFACT_DIR)/u.test(source), 'release workflow must not publish a directory')
  requireContract(source.includes("vars.NPM_AUTH_MODE == 'bootstrap'"), 'bootstrap publish branch is missing')
  requireContract(source.includes("vars.NPM_AUTH_MODE == 'oidc'"), 'OIDC publish branch is missing')
  requireContract(source.includes('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'), 'bootstrap token must be scoped to its publish step')
  requireContract((source.match(/\$\{\{ secrets\./gu) ?? []).length === 1, 'bootstrap token must be the only workflow secret')
  requireContract(
    publishJob.includes('run: env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish "$TGZ" --tag next --access public --provenance'),
    'OIDC publish must remove token variables',
  )
  requireContract(
    publishJob.includes('BOOTSTRAP_GIT_SHA: ${{ vars.NPM_BOOTSTRAP_GIT_SHA }}'),
    'bootstrap must pin one authorized commit',
  )
  requireContract(publishJob.includes('bootstrap is only allowed before the package exists'), 'bootstrap must be impossible after first publication')
  requireContract(publishJob.includes('OIDC publishing requires an existing package'), 'OIDC mode must require a bootstrapped package')
  requireContract(publishJob.includes('path: release-source'), 'npm job must check out the exact release queue implementation')
  requireContract(publishJob.includes('ref: ${{ github.sha }}'), 'release queue checkout must use the triggering commit')
  requireContract(publishJob.includes('persist-credentials: false'), 'release queue checkout must not persist Git credentials')
  const queueStep = namedStepBlock(publishJob, 'Wait for earlier RC workflows')
  requireContract(queueStep.includes('node release-source/scripts/release-queue.mjs'), 'npm job must run the durable RC queue')
  requireContract(queueStep.includes('GH_TOKEN: ${{ github.token }}'), 'release queue must receive the job-scoped GitHub token')
  requireContract(queueStep.includes('CURRENT_RUN_NUMBER: ${{ github.run_number }}'), 'release queue must order by GitHub run number')
  requireContract(queueStep.includes('CURRENT_RUN_ATTEMPT: ${{ github.run_attempt }}'), 'release queue must reject partial workflow reruns')
  requireContract(
    publishJob.indexOf('Wait for earlier RC workflows') < publishJob.indexOf('Verify payload and registry preconditions'),
    'release queue must complete before registry preflight',
  )
  requireContract(publishJob.includes('assertNpmNextAdvances('), 'npm preflight must reject a non-increasing next tag')
  const registryPreflightStep = namedStepBlock(publishJob, 'Verify payload and registry preconditions')
  const registryVerificationStep = namedStepBlock(publishJob, 'Verify the published registry tarball and dist-tags')
  requireContract(registryPreflightStep.includes("cache: 'no-store'"), 'npm next preflight must bypass stale registry caches')
  requireContract(registryVerificationStep.includes("cache: 'no-store'"), 'npm post-publish verification must bypass stale registry caches')
  requireContract(publishJob.includes('staged draft changed before npm publish'), 'npm job must reverify the staged release id before publishing')
  for (const [name, block] of [
    ['draft', draftJob],
    ['npm', publishJob],
    ['finalize', finalizeJob],
  ] as const) {
    const expectedCalls = name === 'draft' ? 2 : 1
    requireContract(
      block.includes('release tag does not resolve to GITHUB_SHA'),
      `${name} job must bind the remote tag to GITHUB_SHA`,
    )
    requireContract(
      block.includes('repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG')
        && block.includes('repos/$GITHUB_REPOSITORY/git/tags/$object_sha'),
      `${name} job must peel lightweight and annotated release tags`,
    )
    requireContract(
      block.includes('[ "$object_type" != "commit" ] || [ "$object_sha" != "$GITHUB_SHA" ]'),
      `${name} job must compare the peeled tag commit with GITHUB_SHA`,
    )
    requireContract(
      (block.match(/^\s+verify_release_tag$/gmu) ?? []).length === expectedCalls,
      `${name} job does not call its remote tag verifier at every required boundary`,
    )
  }
  requireContract(publishJob.includes('npm audit signatures --json --include-attestations'), 'npm provenance signature verification is missing')
  requireContract(publishJob.includes('npm registry provenance descriptor is missing'), 'registry provenance must exist before npm verification completes')
  requireContract(publishJob.includes("workflow?.path !== '.github/workflows/release.yml'"), 'npm provenance workflow identity is not constrained')
  requireContract(publishJob.includes('dependency.digest?.gitCommit === process.env.GITHUB_SHA'), 'npm provenance source digest is not constrained')
  requireContract(publishJob.includes('gh attestation verify "$TARBALL"'), 'npm provenance certificate identity verification is missing')
  requireContract(publishJob.includes('--digest-alg sha512'), 'npm provenance must verify the registry SHA-512 subject')
  const npmProvenanceStep = namedStepBlock(publishJob, 'Verify npm provenance signature and workflow identity')
  requireContract(
    npmProvenanceStep.includes('TARBALL: ${{ github.workspace }}/release-payload/${{ needs.stage_draft.outputs.tarball }}'),
    'npm provenance certificate verification is missing its tarball input',
  )
  requireContract(
    npmProvenanceStep.includes('SIGNER_WORKFLOW: ${{ github.repository }}/.github/workflows/release.yml'),
    'npm provenance certificate verification is missing its signer identity',
  )
  requireContract(
    npmProvenanceStep.includes("writeFileSync('npm-provenance.bundle.json'"),
    'npm provenance certificate verification is missing its Sigstore bundle',
  )
  for (const policy of ['--signer-workflow', '--signer-digest', '--source-ref', '--source-digest', '--deny-self-hosted-runners']) {
    requireContract(publishJob.includes(policy), `npm provenance certificate verification is missing ${policy}`)
  }

  requireContract(draftJob.includes('release_id: ${{ steps.stage_release.outputs.release_id }}'), 'draft job must export the immutable release id')
  requireContract(finalizeJob.includes('RELEASE_ID: ${{ needs.publish_npm.outputs.release_id }}'), 'finalize job must consume the staged release id')
  requireContract(finalizeJob.includes("method: 'PATCH'"), 'finalize job must publish by release id')
  requireContract(finalizeJob.includes('GitHub release asset changed'), 'finalize job must reverify every staged asset')

  requireContract(!/^\s+continue-on-error:/mu.test(source), 'release workflow must not weaken a step with continue-on-error')
  requireContract(!/\balways\s*\(/u.test(source), 'release workflow must not run publication after failure')
  for (const forbidden of ['|| true', 'set +e']) {
    requireContract(!source.includes(forbidden), `release workflow can hide failure with ${forbidden}`)
  }
}

describe('release workflow contract', () => {
  it('keeps preview read-only and every external Action immutable', () => {
    expect(previewWorkflow).toMatch(/^permissions:\n  contents: read$/mu)
    expect(previewWorkflow).not.toMatch(/(?:id-token|attestations): write|contents: write|npm publish/u)
    expect(() => validateActionPins(previewWorkflow)).not.toThrow()
  })

  it('implements the trusted RC release sequence', () => {
    expect(() => validateReleaseWorkflow(releaseWorkflow)).not.toThrow()
  })

  it.each([
    ['movable Action tag', (source: string) => source.replace(/actions\/checkout@[0-9a-f]{40}/u, 'actions/checkout@v4')],
    ['second pack', (source: string) => source.replace('pnpm release:formal', 'pnpm release:formal\n          npm pack')],
    ['latest dist-tag', (source: string) => source.replace('--tag next', '--tag latest')],
    ['latest equals syntax', (source: string) => source.replace('--tag next', '--tag=latest')],
    ['directory publish', (source: string) => source.replace('npm publish "$TGZ"', 'npm publish .')],
    ['extra publish', (source: string) => source.replace('npm publish "$TGZ"', 'npm publish "$TGZ"\n          npm publish "$TGZ"')],
    ['branch trigger', (source: string) => source.replace("tags:\n      - 'v*-rc.*'", "branches:\n      - master")],
    ['lossy native release concurrency', (source: string) => source.replace('permissions: {}', 'permissions: {}\n\nconcurrency:\n  group: dsh-feishu-bot-release\n  cancel-in-progress: false')],
    ['privileged rerun guard removed', (source: string) => source.replace('      - name: Reject release workflow reruns', '      - name: Allow release workflow reruns')],
    ['build OIDC authority', (source: string) => source.replace('  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read', '  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write')],
    ['bootstrap without commit pin', (source: string) => source.replace('NPM_BOOTSTRAP_GIT_SHA', 'UNPINNED_BOOTSTRAP_SHA')],
    ['missing durable release queue', (source: string) => source.replace('node release-source/scripts/release-queue.mjs', 'echo queue-disabled')],
    ['missing npm next monotonicity guard', (source: string) => source.replace('assertNpmNextAdvances(', 'allowNpmNextRegression(')],
    ['stale npm next preflight', (source: string) => source.replace("cache: 'no-store'", "cache: 'default'")],
    ['staged draft not reverified', (source: string) => source.replace('staged draft changed before npm publish', 'unchecked draft')],
    ['missing GitHub attestation verification', (source: string) => source.replace('gh attestation verify', 'gh attestation inspect')],
    ['missing npm provenance verification', (source: string) => source.replace('npm audit signatures --json --include-attestations', 'npm view')],
    ['missing npm certificate identity verification', (source: string) => source.replace('gh attestation verify "$TARBALL"', 'gh attestation inspect "$TARBALL"')],
    ['missing remote tag binding', (source: string) => source.replace('          verify_release_tag\n          gh release create', '          gh release create')],
    ['detached remote tag comparison', (source: string) => source.replace('"$object_sha" != "$GITHUB_SHA"', '"$object_sha" != "$object_sha"')],
    ['finalize by tag instead of release id', (source: string) => source.replace('RELEASE_ID: ${{ needs.publish_npm.outputs.release_id }}', 'RELEASE_ID: ${{ github.ref_name }}')],
    ['expression continue-on-error', (source: string) => source.replace('  build:\n    runs-on:', '  build:\n    continue-on-error: ${{ true }}\n    runs-on:')],
    ['expression always', (source: string) => source.replace('      - name: Publish the verified GitHub prerelease', '      - name: Publish the verified GitHub prerelease\n        if: ${{ always() }}')],
    ['extra privileged job', (source: string) => `${source}\n  early_finalize:\n    needs: stage_draft\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: gh release edit "$GITHUB_REF_NAME" --draft=false\n`],
    ['OIDC token retention', (source: string) => source.replace(
      'run: env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish "$TGZ" --tag next --access public --provenance',
      'run: npm publish "$TGZ" --tag next --access public --provenance',
    )],
  ])('rejects %s regression', (_name, mutate) => {
    expect(() => validateReleaseWorkflow(mutate(releaseWorkflow))).toThrow()
  })
})
