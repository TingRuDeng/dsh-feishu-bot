#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertChecksumFile,
  assertExportTargets,
  assertFormalArtifactDirectoryEmpty,
  assertFormalArtifactSet,
  assertNpmVersionAvailable,
  assertPackedMetadata,
  assertPortableManifest,
  assertTarballEntries,
  createReleaseDescriptor,
  createReleaseManifest,
  runReleasePreflight,
} from './release-preview-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')))
const args = new Set(process.argv.slice(2))
const formal = args.delete('--formal')
const allowDirty = args.delete('--allow-dirty')
const useExistingDeps = args.delete('--use-existing-deps')
const skipDshSmoke = args.delete('--skip-dsh-smoke')
if (args.size > 0) throw new Error(`unknown release arguments: ${[...args].join(', ')}`)
const options = { formal, allowDirty, useExistingDeps, skipDshSmoke }
const cordisName = '@deepseek-ai/cordis'
const requiredSbomPackages = [
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-typert-protocol',
  '@larksuiteoapi/node-sdk',
  'zod',
]

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}${detail}`)
  }
  return result.stdout ?? ''
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readDirectoryEntries(path) {
  try {
    return await readdir(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function assertUnpublishedVersion(name, version) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  let response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    throw new Error(`npm registry lookup failed for ${name}@${version}`, { cause: error })
  }
  assertNpmVersionAvailable(name, version, response.status)
}

async function assertRuntimeClosure(libDir) {
  const files = run('find', [libDir, '-type', 'f', '-name', '*.js'], { capture: true })
    .split('\n').filter(Boolean)
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)/gu)) {
      const specifier = match[1]
      if (
        specifier.startsWith('.')
        || specifier.startsWith('node:')
        || nodeBuiltins.has(specifier)
        || specifier === '@deepseek-ai/cordis'
      ) continue
      throw new Error(`unbundled runtime import in ${file}: ${specifier}`)
    }
  }
}

async function main() {
  const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const releaseManifest = createReleaseManifest(sourceManifest)
  const harnessRoot = resolve(process.env.DSH_RELEASE_HARNESS_ROOT ?? join(root, '../deepseek-harness'))
  const sourceClean = run('git', ['status', '--porcelain'], { capture: true }).trim() === ''
  const gitHead = run('git', ['rev-parse', 'HEAD'], { capture: true }).trim()
  const expectedTagRef = `refs/tags/v${sourceManifest.version}`
  const gitTagHead = formal
    ? run('git', ['rev-parse', `${expectedTagRef}^{commit}`], { capture: true }).trim()
    : gitHead
  const harnessCommit = run('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot, capture: true }).trim()
  const harnessClean = run('git', ['status', '--porcelain'], { cwd: harnessRoot, capture: true }).trim() === ''
  const npmVersion = run('npm', ['--version'], { capture: true }).trim()
  const configuredArtifacts = process.env.DSH_RELEASE_ARTIFACT_DIR
  if (formal && (configuredArtifacts === undefined || configuredArtifacts === '')) {
    throw new Error('DSH_RELEASE_ARTIFACT_DIR is required for a formal release')
  }
  const artifacts = resolve(configuredArtifacts ?? join(root, 'artifacts'))
  if (formal) assertFormalArtifactDirectoryEmpty(await readDirectoryEntries(artifacts))

  await runReleasePreflight({
    manifest: sourceManifest,
    gitHead,
    gitTagHead,
    harnessClean,
    sourceClean,
    options,
    env: {
      ...process.env,
      DSH_RELEASE_HARNESS_COMMIT: harnessCommit,
      DSH_RELEASE_NODE_VERSION: process.versions.node,
      DSH_RELEASE_NPM_VERSION: npmVersion,
    },
    checkNpmVersion: assertUnpublishedVersion,
    installDependencies: () => run('pnpm', ['install', '--frozen-lockfile']),
  })

  const {
    finalizeReleaseSbom,
    packagePurl,
    RELEASE_SBOM_METADATA_DIR,
    RELEASE_SBOM_OWNERS_FILENAME,
    RELEASE_SBOM_RAW_FILENAME,
  } = await import('./release-sbom.mjs')

  await mkdir(artifacts, { recursive: true })
  if (formal) assertFormalArtifactDirectoryEmpty(await readdir(artifacts))

  const [cordisManifest, tsdownManifest] = await Promise.all([
    readFile(join(root, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'node_modules/tsdown/package.json'), 'utf8').then(JSON.parse),
  ])
  const cordisRange = releaseManifest.peerDependencies?.[cordisName]
  if (cordisManifest.name !== cordisName || typeof cordisManifest.version !== 'string') {
    throw new Error('installed Cordis package identity is invalid')
  }
  if (typeof cordisRange !== 'string' || cordisRange === '') {
    throw new Error('release manifest has no Cordis peer range')
  }
  if (
    tsdownManifest.name !== 'tsdown'
    || tsdownManifest.version !== sourceManifest.devDependencies?.tsdown
  ) {
    throw new Error(`installed tsdown does not match the release manifest: ${String(tsdownManifest.version)}`)
  }

  const work = await mkdtemp(join(tmpdir(), 'dsh-feishu-release-'))
  const stage = join(work, 'stage')
  const installRoot = join(work, 'install')
  const dshHome = join(work, 'dsh-home')
  const npmCache = join(work, 'npm-cache')
  try {
    await mkdir(stage, { recursive: true })

    run(join(root, 'node_modules/.bin/vitest'), ['run'])
    run(join(root, 'node_modules/.bin/tsc'), ['--noEmit'])
    run(join(root, 'node_modules/.bin/tsdown'), ['--config', 'tsdown.release.config.ts'], {
      env: {
        DSH_FEISHU_RELEASE_OUT_DIR: join(stage, 'lib'),
        DSH_RELEASE_HARNESS_ROOT: harnessRoot,
        DSH_RELEASE_HARNESS_COMMIT: harnessCommit,
        DSH_RELEASE_CORDIS_VERSION: cordisManifest.version,
        DSH_RELEASE_CORDIS_RANGE: cordisRange,
        DSH_RELEASE_TSDOWN_VERSION: tsdownManifest.version,
      },
    })

    const metadataDir = join(stage, 'lib', RELEASE_SBOM_METADATA_DIR)
    const [rawSbom, rawOwners] = await Promise.all([
      readFile(join(metadataDir, RELEASE_SBOM_RAW_FILENAME), 'utf8'),
      readFile(join(metadataDir, RELEASE_SBOM_OWNERS_FILENAME), 'utf8'),
    ])
    const owners = JSON.parse(rawOwners)
    if (!Array.isArray(owners)) throw new Error('release bundle owner descriptor must be an array')
    await rm(metadataDir, { recursive: true })

    await Promise.all([
      writeFile(join(stage, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8'),
      cp(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml')),
      cp(join(root, 'LICENSE'), join(stage, 'LICENSE')),
      cp(join(root, 'README.md'), join(stage, 'README.md')),
    ])
    await assertExportTargets(stage, releaseManifest.exports)
    await assertRuntimeClosure(join(stage, 'lib'))

    const packResult = JSON.parse(run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
    ], { cwd: stage, capture: true, env: { npm_config_cache: npmCache } }))
    if (!Array.isArray(packResult) || packResult.length !== 1) {
      throw new Error('npm pack must produce exactly one package result')
    }
    const packed = packResult[0]
    assertPackedMetadata(packed, releaseManifest)
    const tarball = join(artifacts, packed.filename)
    const entries = run('tar', ['-tzf', tarball], { capture: true }).split('\n').filter(Boolean)
    assertTarballEntries(entries)

    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked, { recursive: true })
    run('tar', ['-xzf', tarball, '-C', unpacked])
    const packedRoot = join(unpacked, 'package')
    const packedManifest = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'))
    assertPortableManifest(packedManifest)
    await assertExportTargets(packedRoot, packedManifest.exports)

    await mkdir(installRoot, { recursive: true })
    await writeFile(join(installRoot, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8')
    run('npm', [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', tarball,
    ], { cwd: installRoot, env: { npm_config_cache: npmCache } })
    run('node', ['--input-type=module', '--eval', [
      `await import('${releaseManifest.name}')`,
      `await import('${releaseManifest.name}/gateway')`,
      `await import('${releaseManifest.name}/bridge')`,
      `await import('${releaseManifest.name}/invariant')`,
    ].join(';')], { cwd: installRoot })

    if (!skipDshSmoke) {
      const cli = join(harnessRoot, 'apps/cli/src/bin.ts')
      const cliArgs = ['--import', 'tsx/esm', cli]
      const env = { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
      run('node', [...cliArgs, 'plugin', '--profile', 'web', 'add', tarball], {
        cwd: harnessRoot,
        env,
      })
      const dump = run('node', [...cliArgs, '--profile', 'web', '--dump-config'], {
        cwd: harnessRoot,
        env,
        capture: true,
      })
      for (const row of ['feishu-gateway', 'feishu-bridge', 'invariants', 'feishu-invariant']) {
        if (!dump.includes(`id: ${row}`)) throw new Error(`clean DSH profile is missing row: ${row}`)
      }
    }

    const bytes = await readFile(tarball)
    const checksum = sha256(bytes)
    const size = (await stat(tarball)).size
    if (size !== packed.size) throw new Error(`packed package size does not match the tarball: ${size}`)

    const checksumContent = `${checksum}  ${packed.filename}\n`
    assertChecksumFile(checksumContent, packed.filename, checksum)
    const sbomFilename = packed.filename.replace(/\.tgz$/u, '.cdx.json')
    const sbomContent = finalizeReleaseSbom(rawSbom, {
      owners,
      tarball: packed.filename,
      sha256: checksum,
      root: { name: releaseManifest.name, version: releaseManifest.version },
      cordisPurl: packagePurl(cordisName, cordisManifest.version),
      requiredPackages: requiredSbomPackages,
      requiredTools: ['tsdown'],
    })
    const descriptor = createReleaseDescriptor({
      manifest: releaseManifest,
      gitHead,
      harnessCommit,
      packed,
      sha256: checksum,
      checksumSha256: sha256(checksumContent),
      sbom: { filename: sbomFilename, sha256: sha256(sbomContent) },
      publishable: formal,
    })
    await Promise.all([
      writeFile(join(artifacts, 'SHA256SUMS'), checksumContent, 'utf8'),
      writeFile(join(artifacts, sbomFilename), sbomContent, 'utf8'),
      writeFile(join(artifacts, 'release.json'), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8'),
    ])
    if (formal) assertFormalArtifactSet(await readdir(artifacts), descriptor)

    if (!allowDirty) {
      const finalStatus = run('git', ['status', '--porcelain'], { capture: true }).trim()
      if (finalStatus !== '') throw new Error('release gate changed the clean source tree')
    }
    process.stdout.write(`${JSON.stringify({
      version: sourceManifest.version,
      tarball,
      sbom: join(artifacts, sbomFilename),
      descriptor: join(artifacts, 'release.json'),
      size,
      sha256: checksum,
      sourceClean,
      dshConfigSmoke: !skipDshSmoke,
      publishable: formal,
    }, null, 2)}\n`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

await main()
