import { access } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const RELEASE_PACKAGE_NAME = '@tingrudeng/dsh-feishu-bot'
export const RELEASE_REPOSITORY = 'TingRuDeng/dsh-feishu-bot'
export const RELEASE_REPOSITORY_URL = `git+https://github.com/${RELEASE_REPOSITORY}.git`
export const RELEASE_WORKFLOW = '.github/workflows/release.yml'
export const RELEASE_HARNESS_COMMIT = '528c682e061696f5a160f363f236ecbf53cbd006'
export const RELEASE_NODE_VERSION = '24.18.1'
export const RELEASE_NPM_VERSION = '11.16.0'
const prereleaseSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const releaseCandidateSemver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:0|[1-9]\d*)$/u
const releaseCandidateParts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/u

const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

export function assertPortableManifest(manifest) {
  for (const field of dependencyFields) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (
        typeof spec !== 'string'
        || /^(?:link|file|workspace):/u.test(spec)
        || isAbsolute(spec)
      ) {
        throw new Error(`unsafe dependency spec: ${field}.${name}=${String(spec)}`)
      }
    }
  }
}

export function createReleaseManifest(source) {
  assertReleaseManifest(source)
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    keywords: source.keywords,
    repository: source.repository,
    homepage: source.homepage,
    bugs: source.bugs,
    publishConfig: source.publishConfig,
    type: source.type,
    main: source.main,
    types: source.types,
    exports: source.exports,
    files: source.files,
    dsh: source.dsh,
    peerDependencies: source.peerDependencies,
    engines: source.engines,
  }
  assertPortableManifest(manifest)
  return manifest
}

export function assertReleaseManifest(manifest) {
  if (manifest.name !== RELEASE_PACKAGE_NAME) {
    throw new Error(`unexpected release package name: ${String(manifest.name)}`)
  }
  if (typeof manifest.version !== 'string' || !manifest.version.includes('-')) {
    throw new Error(`release package version must be a prerelease: ${String(manifest.version)}`)
  }
  if (!prereleaseSemver.test(manifest.version)) {
    throw new Error(`release package version must be a valid semantic prerelease: ${manifest.version}`)
  }
  if (!releaseCandidateSemver.test(manifest.version)) {
    throw new Error(`release package version must use an rc identifier: ${manifest.version}`)
  }
  if (
    manifest.repository?.type !== 'git'
    || manifest.repository?.url !== RELEASE_REPOSITORY_URL
  ) {
    throw new Error(`unexpected release repository: ${String(manifest.repository?.url)}`)
  }
  if (manifest.publishConfig?.tag !== 'latest') {
    throw new Error('publishConfig.tag must be latest')
  }
  if (manifest.publishConfig?.access !== 'public') {
    throw new Error('publishConfig.access must be public')
  }
  if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    throw new Error('publishConfig.registry must be the public npm registry')
  }
  if (manifest.publishConfig?.provenance !== true) {
    throw new Error('publishConfig.provenance must be true')
  }
}

export function assertFormalReleaseContext({
  manifest,
  gitHead,
  gitTagHead,
  harnessClean,
  sourceClean,
  options,
  env,
}) {
  assertReleaseManifest(manifest)
  if (!sourceClean) throw new Error('formal release requires a clean source tree')
  if (!options.formal) throw new Error('formal release mode is required')
  if (options.allowDirty || options.useExistingDeps || options.skipDshSmoke) {
    throw new Error('formal release cannot relax release gates')
  }

  const expectedRef = `refs/tags/v${manifest.version}`
  const expectedWorkflowRef = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@${expectedRef}`
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('formal release requires GitHub Actions')
  }
  if (env.GITHUB_EVENT_NAME !== 'push') {
    throw new Error(`formal release requires a tag push event: ${String(env.GITHUB_EVENT_NAME)}`)
  }
  if (env.GITHUB_RUN_ATTEMPT !== '1') {
    throw new Error('formal release reruns are not allowed; create a new RC tag after a failed run')
  }
  if (env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY) {
    throw new Error(`unexpected GitHub repository: ${String(env.GITHUB_REPOSITORY)}`)
  }
  if (env.GITHUB_REF !== expectedRef) {
    throw new Error(`unexpected release ref: ${String(env.GITHUB_REF)}`)
  }
  if (env.GITHUB_SHA !== gitHead) {
    throw new Error(`GitHub SHA does not match Git HEAD: ${String(env.GITHUB_SHA)}`)
  }
  if (gitTagHead !== gitHead) {
    throw new Error(`release tag does not match Git HEAD: ${String(gitTagHead)}`)
  }
  if (env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    throw new Error(`unexpected release workflow: ${String(env.GITHUB_WORKFLOW_REF)}`)
  }
  if (env.DSH_RELEASE_RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('formal release requires a GitHub-hosted runner')
  }
  if (env.DSH_RELEASE_HARNESS_COMMIT !== RELEASE_HARNESS_COMMIT) {
    throw new Error(`unexpected Harness commit: ${String(env.DSH_RELEASE_HARNESS_COMMIT)}`)
  }
  if (!harnessClean) throw new Error('formal release requires clean Harness source')
  if (env.DSH_RELEASE_NODE_VERSION !== RELEASE_NODE_VERSION) {
    throw new Error(`unexpected Node version: ${String(env.DSH_RELEASE_NODE_VERSION)}`)
  }
  if (env.DSH_RELEASE_NPM_VERSION !== RELEASE_NPM_VERSION) {
    throw new Error(`unexpected npm version: ${String(env.DSH_RELEASE_NPM_VERSION)}`)
  }
}

export function assertNpmVersionAvailable(name, version, status) {
  if (status === 404) return
  if (status === 200) throw new Error(`${name}@${version} already exists on npm`)
  throw new Error(`npm registry returned ${status} for ${name}@${version}`)
}

export function selectStagedDraftRelease(pages, tag) {
  if (!Array.isArray(pages) || typeof tag !== 'string' || tag === '') {
    throw new Error('GitHub release listing response is invalid')
  }

  const matches = []
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('GitHub release listing page is invalid')
    for (const release of page) {
      if (
        release === null
        || typeof release !== 'object'
        || Array.isArray(release)
        || typeof release.tag_name !== 'string'
      ) {
        throw new Error('GitHub release listing record is invalid')
      }
      if (release.tag_name === tag) matches.push(release)
    }
  }

  if (matches.length !== 1) {
    throw new Error(`staged GitHub release must match exactly once: ${matches.length}`)
  }
  const [release] = matches
  if (release.draft !== true || release.prerelease !== true) {
    throw new Error('staged GitHub release state mismatch')
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error('staged GitHub release id is invalid')
  }
  return release
}

function parseReleaseCandidate(version, label) {
  const match = typeof version === 'string' ? releaseCandidateParts.exec(version) : null
  if (match === null) throw new Error(`npm latest ${label} must be an x.y.z-rc.n version: ${String(version)}`)
  return match.slice(1)
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function assertNpmLatestAdvances(name, candidateVersion, currentLatest) {
  const candidate = parseReleaseCandidate(candidateVersion, 'candidate')
  if (currentLatest === undefined) return
  const current = parseReleaseCandidate(currentLatest, 'value')
  for (let index = 0; index < candidate.length; index += 1) {
    const order = compareNumericIdentifier(candidate[index], current[index])
    if (order > 0) return
    if (order < 0) break
  }
  throw new Error(`npm latest for ${name} must advance beyond ${currentLatest}; candidate is ${candidateVersion}`)
}

export async function fetchNpmJsonWithRetry({
  url,
  label,
  isReady = () => true,
  fetchImpl = globalThis.fetch,
  wait = () => delay(5_000),
  attempts = 6,
}) {
  if (
    typeof url !== 'string'
    || url === ''
    || typeof label !== 'string'
    || label === ''
    || typeof isReady !== 'function'
    || typeof fetchImpl !== 'function'
    || typeof wait !== 'function'
    || !Number.isSafeInteger(attempts)
    || attempts <= 0
  ) {
    throw new Error('npm registry retry options are invalid')
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    })
    if (response?.ok === true) {
      const metadata = await response.json()
      if (isReady(metadata)) return metadata
      if (attempt === attempts) {
        throw new Error(`${label} did not become ready after ${attempts} attempts`)
      }
    } else if (response?.status !== 404 || attempt === attempts) {
      throw new Error(`${label} returned ${String(response?.status)}`)
    }
    await wait()
  }

  throw new Error(`${label} retry loop terminated unexpectedly`)
}

export function findBlockingReleaseRuns(runs, currentRunNumber) {
  if (!Array.isArray(runs)) throw new Error('GitHub workflow runs response must be an array')
  if (!Number.isSafeInteger(currentRunNumber) || currentRunNumber <= 0) {
    throw new Error(`invalid current GitHub run number: ${String(currentRunNumber)}`)
  }
  return runs.map(run => {
    if (
      run === null
      || typeof run !== 'object'
      || !Number.isSafeInteger(run.id)
      || run.id <= 0
      || !Number.isSafeInteger(run.run_number)
      || run.run_number <= 0
      || typeof run.status !== 'string'
      || run.status === ''
    ) {
      throw new Error('invalid GitHub workflow run record')
    }
    return run
  }).filter(run => run.run_number < currentRunNumber && run.status !== 'completed')
    .sort((left, right) => left.run_number - right.run_number || left.id - right.id)
}

export async function waitForReleaseTurn({
  currentRunNumber,
  listRuns,
  wait,
  onBlocked = () => undefined,
}) {
  if (typeof listRuns !== 'function' || typeof wait !== 'function' || typeof onBlocked !== 'function') {
    throw new Error('release queue callbacks are invalid')
  }
  while (true) {
    const blockers = findBlockingReleaseRuns(await listRuns(), currentRunNumber)
    if (blockers.length === 0) return
    await onBlocked(blockers)
    await wait()
  }
}

function assertArtifactFilename(filename, label) {
  if (typeof filename !== 'string' || filename === '' || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`${label} filename is invalid: ${String(filename)}`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} SHA-256 is invalid`)
  }
}

export function assertPackedMetadata(packed, manifest) {
  if (packed?.name !== manifest.name) {
    throw new Error(`unexpected packed package name: ${String(packed?.name)}`)
  }
  if (packed.version !== manifest.version) {
    throw new Error(`unexpected packed package version: ${String(packed.version)}`)
  }
  assertArtifactFilename(packed.filename, 'packed package')
  if (!packed.filename.endsWith('.tgz')) throw new Error(`packed package filename is invalid: ${packed.filename}`)
  if (!Number.isSafeInteger(packed.size) || packed.size <= 0) {
    throw new Error(`packed package size is invalid: ${String(packed.size)}`)
  }
  if (typeof packed.shasum !== 'string' || !/^[a-f0-9]{40}$/u.test(packed.shasum)) {
    throw new Error('packed package shasum is invalid')
  }
  if (typeof packed.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/u.test(packed.integrity)) {
    throw new Error('packed package integrity is invalid')
  }
}

export function assertChecksumFile(content, filename, sha256) {
  assertArtifactFilename(filename, 'checksum target')
  assertSha256(sha256, 'checksum target')
  if (content !== `${sha256}  ${filename}\n`) {
    throw new Error('checksum file must contain exactly the sole release tarball')
  }
}

export function createReleaseDescriptor({
  manifest,
  gitHead,
  harnessCommit,
  packed,
  sha256,
  checksumSha256,
  sbom,
  publishable,
}) {
  assertReleaseManifest(manifest)
  assertPackedMetadata(packed, manifest)
  if (!/^[a-f0-9]{40}$/u.test(gitHead)) throw new Error('release Git SHA is invalid')
  if (!/^[a-f0-9]{40}$/u.test(harnessCommit)) throw new Error('release Harness SHA is invalid')
  assertSha256(sha256, 'release tarball')
  assertSha256(checksumSha256, 'release checksum file')
  assertArtifactFilename(sbom.filename, 'release SBOM')
  if (!sbom.filename.endsWith('.cdx.json')) throw new Error('release SBOM filename must end in .cdx.json')
  assertSha256(sbom.sha256, 'release SBOM')
  if (typeof publishable !== 'boolean') throw new Error('release publishable state must be boolean')

  return {
    schemaVersion: 1,
    publishable,
    package: { name: manifest.name, version: manifest.version },
    source: {
      repository: RELEASE_REPOSITORY,
      gitSha: gitHead,
      tag: `v${manifest.version}`,
      workflow: RELEASE_WORKFLOW,
      harnessCommit,
    },
    artifacts: {
      tarball: {
        filename: packed.filename,
        size: packed.size,
        sha256,
        shasum: packed.shasum,
        integrity: packed.integrity,
      },
      checksums: { filename: 'SHA256SUMS', sha256: checksumSha256 },
      sbom: {
        filename: sbom.filename,
        sha256: sbom.sha256,
        format: 'CycloneDX',
        specVersion: '1.7',
      },
    },
  }
}

export function assertFormalArtifactSet(entries, descriptor) {
  const filenames = [
    descriptor?.artifacts?.tarball?.filename,
    descriptor?.artifacts?.checksums?.filename,
    descriptor?.artifacts?.sbom?.filename,
    'release.json',
  ]
  for (const filename of filenames) assertArtifactFilename(filename, 'formal artifact')
  if (new Set(filenames).size !== filenames.length) throw new Error('formal artifact filenames must be unique')
  const actual = [...entries].sort()
  const expected = [...filenames].sort()
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`formal artifact set is not exact: ${actual.join(', ')}`)
  }
}

export function assertFormalArtifactDirectoryEmpty(entries) {
  if (entries.length !== 0) {
    throw new Error(`formal artifact directory must start empty: ${entries.join(', ')}`)
  }
}

export async function runReleasePreflight({
  manifest,
  gitHead,
  gitTagHead,
  harnessClean,
  sourceClean,
  options,
  env,
  checkNpmVersion,
  installDependencies,
}) {
  assertReleaseManifest(manifest)
  if (options.formal) {
    assertFormalReleaseContext({
      manifest,
      gitHead,
      gitTagHead,
      harnessClean,
      sourceClean,
      options,
      env,
    })
    await checkNpmVersion(manifest.name, manifest.version)
  } else if (!sourceClean && !options.allowDirty) {
    throw new Error('release source is dirty; commit/stash it or use --allow-dirty for a non-publishable local preview')
  }

  if (!options.useExistingDeps) await installDependencies()
}

export function assertTarballEntries(entries) {
  for (const entry of entries) {
    if (
      entry === 'package/package.json'
      || entry === 'package/cordis.patch.yml'
      || entry === 'package/LICENSE'
      || entry === 'package/README.md'
      || entry.startsWith('package/lib/')
    ) continue
    throw new Error(`unexpected tarball entry: ${entry}`)
  }
}

export async function assertExportTargets(root, exportsMap) {
  const absoluteRoot = resolve(root)
  for (const target of Object.values(exportsMap).flatMap((entry) => (
    typeof entry === 'string' ? [entry] : Object.values(entry)
  ))) {
    if (typeof target !== 'string') continue
    if (!target.startsWith('./')) throw new Error(`unsafe export target: ${target}`)
    const absoluteTarget = resolve(root, target)
    if (!absoluteTarget.startsWith(`${absoluteRoot}${sep}`)) {
      throw new Error(`unsafe export target: ${target}`)
    }
    try {
      await access(absoluteTarget)
    } catch {
      throw new Error(`missing export target: ${target}`)
    }
  }
}
