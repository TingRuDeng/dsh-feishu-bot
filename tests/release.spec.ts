import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const releaseModule = await import('../scripts/release-preview-lib.mjs')

const sourceManifest = {
  name: '@tingrudeng/dsh-feishu-bot',
  version: '0.1.0-rc.5',
  description: 'fixture',
  license: 'MIT',
  keywords: ['dsh-plugin'],
  repository: {
    type: 'git',
    url: 'git+https://github.com/TingRuDeng/dsh-feishu-bot.git',
  },
  homepage: 'https://github.com/TingRuDeng/dsh-feishu-bot#readme',
  bugs: { url: 'https://github.com/TingRuDeng/dsh-feishu-bot/issues' },
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
    tag: 'latest',
    provenance: true,
  },
  type: 'module',
  main: 'lib/index.js',
  types: 'lib/index.d.ts',
  exports: {
    '.': { types: './lib/index.d.ts', default: './lib/index.js' },
    './gateway': { types: './lib/gateway/index.d.ts', default: './lib/gateway/index.js' },
    './bridge': { types: './lib/bridge/index.d.ts', default: './lib/bridge/index.js' },
    './invariant': { types: './lib/invariant.d.ts', default: './lib/invariant.js' },
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  },
  files: ['lib', 'cordis.patch.yml'],
  scripts: { prepare: 'tsdown' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
  dependencies: {
    '@deepseek-ai/dsh-llm': 'link:../deepseek-harness/packages/llm/llm',
    '@larksuiteoapi/node-sdk': '^1.44.0',
    zod: '^4.4.3',
  },
  devDependencies: { vitest: '^3.0.0' },
  engines: { node: '^22.19 || >=24' },
}

describe('preview release manifest', () => {
  it('keeps the repository manifest on the releasable scoped RC contract', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))

    expect(() => releaseModule.assertReleaseManifest(manifest)).not.toThrow()
  })

  it('keeps only portable runtime metadata and dependencies', () => {
    const manifest = releaseModule.createReleaseManifest(sourceManifest)

    expect(manifest).toEqual({
      name: '@tingrudeng/dsh-feishu-bot',
      version: '0.1.0-rc.5',
      description: 'fixture',
      license: 'MIT',
      keywords: ['dsh-plugin'],
      repository: sourceManifest.repository,
      homepage: sourceManifest.homepage,
      bugs: sourceManifest.bugs,
      publishConfig: sourceManifest.publishConfig,
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/index.d.ts',
      exports: sourceManifest.exports,
      files: ['lib', 'cordis.patch.yml'],
      dsh: sourceManifest.dsh,
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
      engines: { node: '^22.19 || >=24' },
    })
  })

  it.each([
    ['link dependency', { dependencies: { unsafe: 'link:../private' } }],
    ['file dependency', { dependencies: { unsafe: 'file:../private.tgz' } }],
    ['workspace dependency', { dependencies: { unsafe: 'workspace:*' } }],
    ['absolute dependency', { dependencies: { unsafe: '/Users/example/private' } }],
  ])('rejects %s in a packed manifest', (_name, patch) => {
    const manifest = { ...sourceManifest, ...patch }

    expect(() => releaseModule.assertPortableManifest(manifest)).toThrow(/unsafe dependency spec/u)
  })

  it('rejects an undeclared file in the packed tarball', () => {
    expect(() => releaseModule.assertTarballEntries([
      'package/package.json',
      'package/cordis.patch.yml',
      'package/lib/index.js',
      'package/private-debug.log',
    ])).toThrow(/unexpected tarball entry: package\/private-debug\.log/u)
  })

  it('requires every JavaScript and type export target in the staged package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-release-test-'))
    try {
      await mkdir(join(root, 'lib'), { recursive: true })
      await writeFile(join(root, 'lib/index.js'), 'export default {}\n', 'utf8')

      await expect(Promise.resolve(releaseModule.assertExportTargets(root, {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      }))).rejects.toThrow(/missing export target: \.\/lib\/index\.d\.ts/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an export target outside the staged package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-release-test-'))
    try {
      await expect(releaseModule.assertExportTargets(root, {
        '.': { default: '/Users/example/private.js' },
      })).rejects.toThrow(/unsafe export target: \/Users\/example\/private\.js/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['unscoped package name', { name: 'dsh-feishu-bot' }, /unexpected release package name/u],
    ['stable version', { version: '0.1.0' }, /must be a prerelease/u],
    ['malformed prerelease', { version: 'release-candidate' }, /valid semantic prerelease/u],
    ['non-RC prerelease', { version: '0.1.0-beta.1' }, /must use an rc identifier/u],
    ['wrong repository', { repository: { type: 'git', url: 'https://example.invalid/repo.git' } }, /unexpected release repository/u],
    ['next publish tag', { publishConfig: { ...sourceManifest.publishConfig, tag: 'next' } }, /publishConfig\.tag must be latest/u],
    ['private package access', { publishConfig: { ...sourceManifest.publishConfig, access: 'restricted' } }, /publishConfig\.access must be public/u],
    ['alternate registry', { publishConfig: { ...sourceManifest.publishConfig, registry: 'https://registry.example.invalid/' } }, /public npm registry/u],
    ['disabled provenance', { publishConfig: { ...sourceManifest.publishConfig, provenance: false } }, /publishConfig\.provenance must be true/u],
  ])('rejects %s before building', (_name, patch, error) => {
    const manifest = { ...sourceManifest, ...patch }

    expect(() => releaseModule.assertReleaseManifest(manifest)).toThrow(error)
  })

  it('accepts only the exact trusted tag context for a formal build', () => {
    const gitHead = '0123456789abcdef0123456789abcdef01234567'

    expect(() => releaseModule.assertFormalReleaseContext({
      manifest: sourceManifest,
      gitHead,
      gitTagHead: gitHead,
      harnessClean: true,
      sourceClean: true,
      options: {
        formal: true,
        allowDirty: false,
        useExistingDeps: false,
        skipDshSmoke: false,
      },
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'TingRuDeng/dsh-feishu-bot',
        GITHUB_REF: 'refs/tags/v0.1.0-rc.5',
        GITHUB_SHA: gitHead,
        GITHUB_WORKFLOW_REF: 'TingRuDeng/dsh-feishu-bot/.github/workflows/release.yml@refs/tags/v0.1.0-rc.5',
        DSH_RELEASE_RUNNER_ENVIRONMENT: 'github-hosted',
        DSH_RELEASE_HARNESS_COMMIT: releaseModule.RELEASE_HARNESS_COMMIT,
        DSH_RELEASE_NODE_VERSION: releaseModule.RELEASE_NODE_VERSION,
        DSH_RELEASE_NPM_VERSION: releaseModule.RELEASE_NPM_VERSION,
      },
    })).not.toThrow()
  })

  it.each([
    ['dirty source', { sourceClean: false }, /clean source/u],
    ['preview mode', { options: { formal: false, allowDirty: false, useExistingDeps: false, skipDshSmoke: false } }, /formal release mode/u],
    ['relaxed dependency install', { options: { formal: true, allowDirty: false, useExistingDeps: true, skipDshSmoke: false } }, /cannot relax release gates/u],
    ['skipped DSH smoke', { options: { formal: true, allowDirty: false, useExistingDeps: false, skipDshSmoke: true } }, /cannot relax release gates/u],
    ['non-Actions execution', { env: { GITHUB_ACTIONS: 'false' } }, /GitHub Actions/u],
    ['workflow dispatch', { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }, /tag push event/u],
    ['rerun attempt', { env: { GITHUB_RUN_ATTEMPT: '2' } }, /rerun/u],
    ['untrusted repository', { env: { GITHUB_REPOSITORY: 'attacker/fork' } }, /unexpected GitHub repository/u],
    ['branch ref', { env: { GITHUB_REF: 'refs/heads/master' } }, /unexpected release ref/u],
    ['different commit', { env: { GITHUB_SHA: 'fedcba9876543210fedcba9876543210fedcba98' } }, /does not match Git HEAD/u],
    ['tag pointing at another commit', { gitTagHead: 'fedcba9876543210fedcba9876543210fedcba98' }, /tag does not match Git HEAD/u],
    ['dirty Harness source', { harnessClean: false }, /clean Harness source/u],
    ['different workflow', { env: { GITHUB_WORKFLOW_REF: 'TingRuDeng/dsh-feishu-bot/.github/workflows/release-preview.yml@refs/tags/v0.1.0-rc.5' } }, /unexpected release workflow/u],
    ['self-hosted runner', { env: { DSH_RELEASE_RUNNER_ENVIRONMENT: 'self-hosted' } }, /GitHub-hosted runner/u],
    ['unpinned Harness commit', { env: { DSH_RELEASE_HARNESS_COMMIT: 'fedcba9876543210fedcba9876543210fedcba98' } }, /unexpected Harness commit/u],
    ['different Node version', { env: { DSH_RELEASE_NODE_VERSION: '24.18.0' } }, /unexpected Node version/u],
    ['different npm version', { env: { DSH_RELEASE_NPM_VERSION: '11.15.0' } }, /unexpected npm version/u],
  ])('rejects formal build with %s', (_name, patch, error) => {
    const gitHead = '0123456789abcdef0123456789abcdef01234567'
    const base = {
      manifest: sourceManifest,
      gitHead,
      gitTagHead: gitHead,
      harnessClean: true,
      sourceClean: true,
      options: {
        formal: true,
        allowDirty: false,
        useExistingDeps: false,
        skipDshSmoke: false,
      },
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'TingRuDeng/dsh-feishu-bot',
        GITHUB_REF: 'refs/tags/v0.1.0-rc.5',
        GITHUB_SHA: gitHead,
        GITHUB_WORKFLOW_REF: 'TingRuDeng/dsh-feishu-bot/.github/workflows/release.yml@refs/tags/v0.1.0-rc.5',
        DSH_RELEASE_RUNNER_ENVIRONMENT: 'github-hosted',
        DSH_RELEASE_HARNESS_COMMIT: releaseModule.RELEASE_HARNESS_COMMIT,
        DSH_RELEASE_NODE_VERSION: releaseModule.RELEASE_NODE_VERSION,
        DSH_RELEASE_NPM_VERSION: releaseModule.RELEASE_NPM_VERSION,
      },
    }

    expect(() => releaseModule.assertFormalReleaseContext({
      ...base,
      ...patch,
      options: { ...base.options, ...patch.options },
      env: { ...base.env, ...patch.env },
    })).toThrow(error)
  })

  it('rejects an untrusted formal context before dependency installation', async () => {
    const gitHead = '0123456789abcdef0123456789abcdef01234567'
    let installStarted = false

    await expect(releaseModule.runReleasePreflight({
      manifest: sourceManifest,
      gitHead,
      gitTagHead: gitHead,
      harnessClean: true,
      sourceClean: true,
      options: {
        formal: true,
        allowDirty: false,
        useExistingDeps: false,
        skipDshSmoke: false,
      },
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'attacker/fork',
        GITHUB_REF: 'refs/tags/v0.1.0-rc.5',
        GITHUB_SHA: gitHead,
        GITHUB_WORKFLOW_REF: 'TingRuDeng/dsh-feishu-bot/.github/workflows/release.yml@refs/tags/v0.1.0-rc.5',
        DSH_RELEASE_RUNNER_ENVIRONMENT: 'github-hosted',
        DSH_RELEASE_HARNESS_COMMIT: releaseModule.RELEASE_HARNESS_COMMIT,
        DSH_RELEASE_NODE_VERSION: releaseModule.RELEASE_NODE_VERSION,
        DSH_RELEASE_NPM_VERSION: releaseModule.RELEASE_NPM_VERSION,
      },
      checkNpmVersion: async () => undefined,
      installDependencies: async () => {
        installStarted = true
      },
    })).rejects.toThrow(/unexpected GitHub repository/u)
    expect(installStarted).toBe(false)
  })

  it('checks npm version availability before dependency installation', async () => {
    const gitHead = '0123456789abcdef0123456789abcdef01234567'
    let installStarted = false

    await expect(releaseModule.runReleasePreflight({
      manifest: sourceManifest,
      gitHead,
      gitTagHead: gitHead,
      harnessClean: true,
      sourceClean: true,
      options: {
        formal: true,
        allowDirty: false,
        useExistingDeps: false,
        skipDshSmoke: false,
      },
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: 'TingRuDeng/dsh-feishu-bot',
        GITHUB_REF: 'refs/tags/v0.1.0-rc.5',
        GITHUB_SHA: gitHead,
        GITHUB_WORKFLOW_REF: 'TingRuDeng/dsh-feishu-bot/.github/workflows/release.yml@refs/tags/v0.1.0-rc.5',
        DSH_RELEASE_RUNNER_ENVIRONMENT: 'github-hosted',
        DSH_RELEASE_HARNESS_COMMIT: releaseModule.RELEASE_HARNESS_COMMIT,
        DSH_RELEASE_NODE_VERSION: releaseModule.RELEASE_NODE_VERSION,
        DSH_RELEASE_NPM_VERSION: releaseModule.RELEASE_NPM_VERSION,
      },
      checkNpmVersion: async () => {
        throw new Error('version occupied')
      },
      installDependencies: async () => {
        installStarted = true
      },
    })).rejects.toThrow(/version occupied/u)
    expect(installStarted).toBe(false)
  })

  it.each([
    [404, undefined],
    [200, /already exists on npm/u],
    [500, /npm registry returned 500/u],
  ])('interprets npm version lookup status %i fail closed', (status, error) => {
    const verify = () => releaseModule.assertNpmVersionAvailable(
      sourceManifest.name,
      sourceManifest.version,
      status,
    )

    if (error === undefined) expect(verify).not.toThrow()
    else expect(verify).toThrow(error)
  })

  it('selects the exact staged draft from paginated GitHub release listings', () => {
    const expected = {
      id: 102,
      tag_name: 'v0.1.0-rc.6',
      draft: true,
      prerelease: true,
      assets: [],
    }

    expect(releaseModule.selectStagedDraftRelease([
      [{ id: 101, tag_name: 'v0.1.0-rc.5', draft: true, prerelease: true, assets: [] }],
      [expected],
    ], 'v0.1.0-rc.6')).toEqual(expected)
  })

  it.each([
    ['no matching release', [[{ id: 101, tag_name: 'v0.1.0-rc.5', draft: true, prerelease: true }]]],
    ['duplicate matching releases', [[
      { id: 102, tag_name: 'v0.1.0-rc.6', draft: true, prerelease: true },
    ], [
      { id: 103, tag_name: 'v0.1.0-rc.6', draft: true, prerelease: true },
    ]]],
    ['published release', [[{ id: 102, tag_name: 'v0.1.0-rc.6', draft: false, prerelease: true }]]],
    ['non-prerelease draft', [[{ id: 102, tag_name: 'v0.1.0-rc.6', draft: true, prerelease: false }]]],
    ['invalid release id', [[{ id: 0, tag_name: 'v0.1.0-rc.6', draft: true, prerelease: true }]]],
  ])('rejects staged draft lookup with %s', (_name, pages) => {
    expect(() => releaseModule.selectStagedDraftRelease(pages, 'v0.1.0-rc.6'))
      .toThrow(/staged GitHub release/u)
  })

  it.each([
    ['non-array response', {}],
    ['non-array page', [{}]],
    ['malformed release record', [[null]]],
  ])('rejects staged draft lookup with %s', (_name, pages) => {
    expect(() => releaseModule.selectStagedDraftRelease(pages, 'v0.1.0-rc.6'))
      .toThrow(/GitHub release listing/u)
  })

  it.each([
    [undefined, '0.1.0-rc.5'],
    ['0.1.0-rc.4', '0.1.0-rc.5'],
    ['0.1.99-rc.999', '0.2.0-rc.0'],
    ['0.1.0-rc.99999999999999999998', '0.1.0-rc.99999999999999999999'],
  ])('allows npm latest %s to advance to %s', (currentLatest, candidate) => {
    expect(() => releaseModule.assertNpmLatestAdvances(
      sourceManifest.name,
      candidate,
      currentLatest,
    )).not.toThrow()
  })

  it.each([
    ['0.1.0-rc.5', '0.1.0-rc.5'],
    ['0.1.0-rc.6', '0.1.0-rc.5'],
    ['0.2.0-rc.0', '0.1.99-rc.999'],
    ['0.1.0-beta.1', '0.1.0-rc.5'],
  ])('rejects npm latest %s moving to %s', (currentLatest, candidate) => {
    expect(() => releaseModule.assertNpmLatestAdvances(
      sourceManifest.name,
      candidate,
      currentLatest,
    )).toThrow(/npm latest/u)
  })

  it('retries a transient npm registry 404 before returning ready JSON', async () => {
    const responses = [
      new Response('not found', { status: 404 }),
      Response.json({ 'dist-tags': { latest: '0.1.0-rc.8' } }),
    ]
    let waits = 0
    let requestOptions

    const result = await releaseModule.fetchNpmJsonWithRetry({
      url: 'https://registry.npmjs.org/%40tingrudeng%2Fdsh-feishu-bot',
      label: 'npm package verification',
      fetchImpl: async (_url, options) => {
        requestOptions = options
        return responses.shift()
      },
      wait: async () => { waits += 1 },
      isReady: metadata => metadata['dist-tags']?.latest === '0.1.0-rc.8',
    })

    expect(result).toEqual({ 'dist-tags': { latest: '0.1.0-rc.8' } })
    expect(waits).toBe(1)
    expect(requestOptions).toEqual({
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    })
  })

  it('retries successful npm JSON until its required metadata is ready', async () => {
    const responses = [
      Response.json({ dist: {} }),
      Response.json({ dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } }),
    ]
    let waits = 0

    const result = await releaseModule.fetchNpmJsonWithRetry({
      url: 'https://registry.npmjs.org/%40tingrudeng%2Fdsh-feishu-bot/0.1.0-rc.8',
      label: 'npm version verification',
      fetchImpl: async () => responses.shift(),
      wait: async () => { waits += 1 },
      isReady: metadata => metadata.dist?.attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1',
    })

    expect(result.dist.attestations.provenance.predicateType).toBe('https://slsa.dev/provenance/v1')
    expect(waits).toBe(1)
  })

  it('fails immediately on a non-retryable npm registry status', async () => {
    let requests = 0

    await expect(releaseModule.fetchNpmJsonWithRetry({
      url: 'https://registry.npmjs.org/%40tingrudeng%2Fdsh-feishu-bot',
      label: 'npm package verification',
      fetchImpl: async () => {
        requests += 1
        return new Response('unavailable', { status: 503 })
      },
      wait: async () => undefined,
    })).rejects.toThrow(/npm package verification returned 503/u)
    expect(requests).toBe(1)
  })

  it('fails closed when npm registry metadata never becomes ready', async () => {
    let requests = 0
    let waits = 0

    await expect(releaseModule.fetchNpmJsonWithRetry({
      url: 'https://registry.npmjs.org/%40tingrudeng%2Fdsh-feishu-bot',
      label: 'npm package verification',
      attempts: 3,
      fetchImpl: async () => {
        requests += 1
        return Response.json({ 'dist-tags': { latest: '0.1.0-rc.7' } })
      },
      wait: async () => { waits += 1 },
      isReady: metadata => metadata['dist-tags']?.latest === '0.1.0-rc.8',
    })).rejects.toThrow(/npm package verification did not become ready after 3 attempts/u)
    expect(requests).toBe(3)
    expect(waits).toBe(2)
  })

  it('orders each release behind every earlier incomplete workflow run', async () => {
    const active = [
      { id: 41_002, run_number: 41, status: 'queued' },
      { id: 40_002, run_number: 40, status: 'in_progress' },
      { id: 39_002, run_number: 39, status: 'completed' },
      { id: 42_002, run_number: 42, status: 'in_progress' },
      { id: 43_002, run_number: 43, status: 'waiting' },
    ]

    expect(releaseModule.findBlockingReleaseRuns(active, 42).map(run => run.id))
      .toEqual([40_002, 41_002])

    const snapshots = [active, active.map(run => ({ ...run, status: 'completed' }))]
    let reads = 0
    let waits = 0
    await releaseModule.waitForReleaseTurn({
      currentRunNumber: 42,
      listRuns: async () => snapshots[reads++],
      wait: async () => { waits += 1 },
    })
    expect(reads).toBe(2)
    expect(waits).toBe(1)
  })

  it('accepts only npm pack metadata for the expected package and RC', () => {
    expect(releaseModule.assertPackedMetadata).toBeTypeOf('function')
    const packed = {
      name: sourceManifest.name,
      version: sourceManifest.version,
      filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
      size: 403_496,
      shasum: '1'.repeat(40),
      integrity: `sha512-${'YQ=='.repeat(16)}`,
    }

    expect(() => releaseModule.assertPackedMetadata(packed, sourceManifest)).not.toThrow()
    expect(() => releaseModule.assertPackedMetadata({ ...packed, name: 'attacker/package' }, sourceManifest))
      .toThrow(/packed package name/u)
    expect(() => releaseModule.assertPackedMetadata({ ...packed, version: '0.1.0-rc.4' }, sourceManifest))
      .toThrow(/packed package version/u)
    expect(() => releaseModule.assertPackedMetadata({ ...packed, integrity: undefined }, sourceManifest))
      .toThrow(/packed package integrity/u)
  })

  it('requires an exact one-line checksum for the sole tarball', () => {
    expect(releaseModule.assertChecksumFile).toBeTypeOf('function')
    const filename = 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz'
    const sha256 = 'a'.repeat(64)

    expect(() => releaseModule.assertChecksumFile(`${sha256}  ${filename}\n`, filename, sha256)).not.toThrow()
    expect(() => releaseModule.assertChecksumFile(`${sha256}  old.tgz\n`, filename, sha256))
      .toThrow(/checksum file/u)
    expect(() => releaseModule.assertChecksumFile(`${sha256}  ${filename}\n${sha256}  old.tgz\n`, filename, sha256))
      .toThrow(/checksum file/u)
  })

  it('creates a path-independent descriptor for one immutable build', () => {
    expect(releaseModule.createReleaseDescriptor).toBeTypeOf('function')
    const descriptor = releaseModule.createReleaseDescriptor({
      manifest: sourceManifest,
      gitHead: '0123456789abcdef0123456789abcdef01234567',
      harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
      packed: {
        name: sourceManifest.name,
        version: sourceManifest.version,
        filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
        size: 403_496,
        shasum: '1'.repeat(40),
        integrity: 'sha512-fixture',
      },
      sha256: '2'.repeat(64),
      checksumSha256: '3'.repeat(64),
      sbom: {
        filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.cdx.json',
        sha256: '4'.repeat(64),
      },
      publishable: true,
    })

    expect(descriptor).toEqual({
      schemaVersion: 1,
      publishable: true,
      package: { name: sourceManifest.name, version: sourceManifest.version },
      source: {
        repository: 'TingRuDeng/dsh-feishu-bot',
        gitSha: '0123456789abcdef0123456789abcdef01234567',
        tag: 'v0.1.0-rc.5',
        workflow: '.github/workflows/release.yml',
        harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
      },
      artifacts: {
        tarball: {
          filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
          size: 403_496,
          sha256: '2'.repeat(64),
          shasum: '1'.repeat(40),
          integrity: 'sha512-fixture',
        },
        checksums: { filename: 'SHA256SUMS', sha256: '3'.repeat(64) },
        sbom: {
          filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.cdx.json',
          sha256: '4'.repeat(64),
          format: 'CycloneDX',
          specVersion: '1.7',
        },
      },
    })
    expect(JSON.stringify(descriptor)).not.toMatch(/\/Users\/|\/private\/|\\Users\\/u)
  })

  it('rejects stale or extra files in a formal artifact directory', () => {
    expect(releaseModule.assertFormalArtifactSet).toBeTypeOf('function')
    const descriptor = {
      artifacts: {
        tarball: { filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz' },
        checksums: { filename: 'SHA256SUMS' },
        sbom: { filename: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.cdx.json' },
      },
    }
    const expected = [
      'SHA256SUMS',
      'release.json',
      'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.cdx.json',
      'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
    ]

    expect(() => releaseModule.assertFormalArtifactSet(expected, descriptor)).not.toThrow()
    expect(() => releaseModule.assertFormalArtifactSet([...expected, 'old-rc.tgz'], descriptor))
      .toThrow(/formal artifact set/u)
    expect(() => releaseModule.assertFormalArtifactSet(expected.filter(name => name !== 'SHA256SUMS'), descriptor))
      .toThrow(/formal artifact set/u)
  })

  it('requires a fresh empty artifact directory before a formal build', () => {
    expect(releaseModule.assertFormalArtifactDirectoryEmpty).toBeTypeOf('function')
    expect(() => releaseModule.assertFormalArtifactDirectoryEmpty([])).not.toThrow()
    expect(() => releaseModule.assertFormalArtifactDirectoryEmpty([
      'tingrudeng-dsh-feishu-bot-0.1.0-rc.4.tgz',
    ])).toThrow(/must start empty/u)
  })
})
