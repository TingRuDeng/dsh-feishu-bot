import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const releaseModule = await import('../scripts/release-preview-lib.mjs').catch(() => undefined)

const sourceManifest = {
  name: 'dsh-feishu-bot',
  version: '0.1.0-rc.1',
  description: 'fixture',
  license: 'MIT',
  keywords: ['dsh-plugin'],
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
  it('keeps only portable runtime metadata and dependencies', () => {
    const manifest = releaseModule?.createReleaseManifest?.(sourceManifest)

    expect(manifest).toEqual({
      name: 'dsh-feishu-bot',
      version: '0.1.0-rc.1',
      description: 'fixture',
      license: 'MIT',
      keywords: ['dsh-plugin'],
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

    expect(() => releaseModule?.assertPortableManifest?.(manifest)).toThrow(/unsafe dependency spec/u)
  })

  it('rejects an undeclared file in the packed tarball', () => {
    expect(() => releaseModule?.assertTarballEntries?.([
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

      await expect(Promise.resolve(releaseModule?.assertExportTargets?.(root, {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      }))).rejects.toThrow(/missing export target: \.\/lib\/index\.d\.ts/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an export target outside the staged package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-release-test-'))
    try {
      await expect(releaseModule?.assertExportTargets?.(root, {
        '.': { default: '/Users/example/private.js' },
      })).rejects.toThrow(/unsafe export target: \/Users\/example\/private\.js/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
