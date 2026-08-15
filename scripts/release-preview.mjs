#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertExportTargets,
  assertPortableManifest,
  assertTarballEntries,
  createReleaseManifest,
} from './release-preview-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')))
const args = new Set(process.argv.slice(2))
const allowDirty = args.delete('--allow-dirty')
const useExistingDeps = args.delete('--use-existing-deps')
const skipDshSmoke = args.delete('--skip-dsh-smoke')
if (args.size > 0) throw new Error(`unknown release arguments: ${[...args].join(', ')}`)

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

function assertSourceState() {
  const status = run('git', ['status', '--porcelain'], { capture: true }).trim()
  if (status !== '' && !allowDirty) {
    throw new Error('release source is dirty; commit/stash it or use --allow-dirty for a non-publishable local preview')
  }
  if (!useExistingDeps) run('pnpm', ['install', '--frozen-lockfile'])
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
  assertSourceState()
  const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!sourceManifest.version.includes('-')) {
    throw new Error(`preview package version must be a prerelease: ${sourceManifest.version}`)
  }

  const work = await mkdtemp(join(tmpdir(), 'dsh-feishu-release-'))
  const stage = join(work, 'stage')
  const installRoot = join(work, 'install')
  const dshHome = join(work, 'dsh-home')
  const npmCache = join(work, 'npm-cache')
  const artifacts = join(root, 'artifacts')
  try {
    await mkdir(stage, { recursive: true })
    await mkdir(artifacts, { recursive: true })

    run(join(root, 'node_modules/.bin/vitest'), ['run'])
    run(join(root, 'node_modules/.bin/tsc'), ['--noEmit'])
    run(join(root, 'node_modules/.bin/tsdown'), ['--config', 'tsdown.release.config.ts'], {
      env: { DSH_FEISHU_RELEASE_OUT_DIR: join(stage, 'lib') },
    })

    const releaseManifest = createReleaseManifest(sourceManifest)
    await Promise.all([
      writeFile(join(stage, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8'),
      cp(join(root, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml')),
      cp(join(root, 'LICENSE'), join(stage, 'LICENSE')),
      cp(join(root, 'README.md'), join(stage, 'README.md')),
    ])
    await assertExportTargets(stage, releaseManifest.exports)
    await assertRuntimeClosure(join(stage, 'lib'))

    const packed = JSON.parse(run('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', artifacts,
    ], { cwd: stage, capture: true, env: { npm_config_cache: npmCache } }))[0]
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
      "await import('dsh-feishu-bot')",
      "await import('dsh-feishu-bot/gateway')",
      "await import('dsh-feishu-bot/bridge')",
      "await import('dsh-feishu-bot/invariant')",
    ].join(';')], { cwd: installRoot })

    if (!skipDshSmoke) {
      const harnessRoot = resolve(process.env.DSH_RELEASE_HARNESS_ROOT ?? join(root, '../deepseek-harness'))
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
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const size = (await stat(tarball)).size
    await writeFile(join(artifacts, 'SHA256SUMS'), `${checksum}  ${packed.filename}\n`, 'utf8')
    if (!allowDirty) {
      const finalStatus = run('git', ['status', '--porcelain'], { capture: true }).trim()
      if (finalStatus !== '') throw new Error('release gate changed the clean source tree')
    }
    process.stdout.write(`${JSON.stringify({
      version: sourceManifest.version,
      tarball,
      size,
      sha256: checksum,
      sourceClean: !allowDirty,
      dshConfigSmoke: !skipDshSmoke,
      publishable: false,
    }, null, 2)}\n`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

await main()
