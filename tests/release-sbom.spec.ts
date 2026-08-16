import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Enums, Models } from '@cyclonedx/cyclonedx-library'

const releaseSbom = await import('../scripts/release-sbom.mjs').catch(() => ({})) as Record<string, any>

function requireFunction(name: string) {
  expect(releaseSbom[name], `${name} must be exported`).toBeTypeOf('function')
  return releaseSbom[name]
}

const owners = [
  {
    name: '@deepseek-ai/dsh-api-remotes',
    version: '0.1.0-rc.5',
    purl: 'pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5',
    harness: true,
  },
  {
    name: 'zod',
    version: '4.4.3',
    purl: 'pkg:npm/zod@4.4.3',
    harness: false,
  },
]

function createRawBom() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    serialNumber: 'urn:uuid:must-be-removed',
    version: 1,
    metadata: {
      timestamp: '2026-08-16T00:00:00.000Z',
      tools: [{ name: 'tsdown', version: '0.22.14' }],
      component: {
        type: 'library',
        group: '@tingrudeng',
        name: 'dsh-feishu-bot',
        version: '0.1.0-rc.5',
        'bom-ref': 'pkg:npm/%40tingrudeng/dsh-feishu-bot@0.1.0-rc.5',
        purl: 'pkg:npm/%40tingrudeng/dsh-feishu-bot@0.1.0-rc.5',
      },
    },
    components: [
      {
        type: 'library',
        group: '@deepseek-ai',
        name: 'cordis',
        version: '4.0.1',
        'bom-ref': 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
        purl: 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
        scope: 'required',
        properties: [
          { name: 'dsh:release:peer-range', value: '^4.0.1' },
          { name: 'cdx:npm:package:bundled', value: 'false' },
        ],
      },
      {
        type: 'library',
        name: 'zod',
        version: '4.4.3',
        'bom-ref': 'pkg:npm/zod@4.4.3',
        purl: 'pkg:npm/zod@4.4.3',
        scope: 'required',
        properties: [{ name: 'cdx:npm:package:bundled', value: 'true' }],
      },
      {
        type: 'library',
        group: '@deepseek-ai',
        name: 'dsh-api-remotes',
        version: '0.1.0-rc.5',
        'bom-ref': 'pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5',
        purl: 'pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5',
        scope: 'required',
        properties: [{ name: 'cdx:npm:package:bundled', value: 'true' }],
      },
    ],
    dependencies: [
      { ref: 'pkg:npm/zod@4.4.3' },
      { ref: 'pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5' },
      { ref: 'pkg:npm/%40deepseek-ai/cordis@4.0.1' },
    ],
  }
}

describe('release SBOM', () => {
  it('collects each actual package owner once and excludes project source files', async () => {
    const collectBundledPackages = requireFunction('collectBundledPackages')
    const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-sbom-test-'))
    const projectRoot = join(root, 'plugin')
    const harnessRoot = join(root, 'harness')
    const dshRoot = join(harnessRoot, 'packages/api/remotes')
    const zodRoot = join(projectRoot, 'node_modules/zod')
    try {
      await Promise.all([
        mkdir(join(projectRoot, 'src'), { recursive: true }),
        mkdir(join(dshRoot, 'lib'), { recursive: true }),
        mkdir(join(zodRoot, 'lib'), { recursive: true }),
      ])
      await Promise.all([
        writeFile(join(projectRoot, 'package.json'), JSON.stringify({
          name: '@tingrudeng/dsh-feishu-bot',
          version: '0.1.0-rc.5',
        })),
        writeFile(join(projectRoot, 'src/index.ts'), 'export {}\n'),
        writeFile(join(dshRoot, 'package.json'), JSON.stringify({
          name: '@deepseek-ai/dsh-api-remotes',
          version: '0.1.0-rc.5',
        })),
        writeFile(join(dshRoot, 'lib/index.js'), 'export {}\n'),
        writeFile(join(zodRoot, 'package.json'), JSON.stringify({ name: 'zod', version: '4.4.3' })),
        writeFile(join(zodRoot, 'lib/index.js'), 'export {}\n'),
      ])

      await expect(collectBundledPackages([
        join(projectRoot, 'src/index.ts'),
        join(dshRoot, 'lib/index.js'),
        `${join(dshRoot, 'lib/index.js')}?commonjs-entry`,
        join(zodRoot, 'lib/index.js'),
        '\0rolldown/runtime.js',
      ], { projectRoot, harnessRoot })).resolves.toEqual(owners)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds missing bundle owners and the external Cordis peer to the real BOM model', () => {
    const augmentReleaseBom = requireFunction('augmentReleaseBom')
    const root = new Models.Component(Enums.ComponentType.Library, 'dsh-feishu-bot', {
      group: '@tingrudeng',
      version: '0.1.0-rc.5',
      purl: 'pkg:npm/%40tingrudeng/dsh-feishu-bot@0.1.0-rc.5',
      bomRef: 'pkg:npm/%40tingrudeng/dsh-feishu-bot@0.1.0-rc.5',
    })
    const zod = new Models.Component(Enums.ComponentType.Library, 'zod', {
      version: '4.4.3',
      purl: 'pkg:npm/zod@4.4.3?vcs_url=https%3A%2F%2Fexample.test%2Fzod',
      bomRef: 'pkg:npm/zod@4.4.3?vcs_url=https%3A%2F%2Fexample.test%2Fzod',
    })
    const bom = new Models.Bom({ metadata: new Models.Metadata({ component: root }) })
    bom.components.add(zod)

    augmentReleaseBom(bom, {
      owners,
      harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
      cordis: { name: '@deepseek-ai/cordis', version: '4.0.1', range: '^4.0.1' },
      buildTool: { name: 'tsdown', version: '0.22.14' },
    })

    const components = [...bom.components]
    expect(components.map(component => component.purl?.split('?')[0]).sort()).toEqual([
      'pkg:npm/%40deepseek-ai/cordis@4.0.1',
      'pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5',
      'pkg:npm/zod@4.4.3',
    ])
    for (const component of components.filter(component => component.name !== 'cordis')) {
      expect(component.scope).toBe(Enums.ComponentScope.Required)
      expect([...component.properties]).toContainEqual(expect.objectContaining({
        name: 'cdx:npm:package:bundled',
        value: 'true',
      }))
    }
    const dsh = components.find(component => component.name === 'dsh-api-remotes')
    expect([...dsh.externalReferences]).toContainEqual(expect.objectContaining({
      type: Enums.ExternalReferenceType.VCS,
      url: 'https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a',
    }))
    expect(root.dependencies.size).toBe(3)
    expect([...bom.metadata.tools.tools]).toContainEqual(expect.objectContaining({
      name: 'tsdown',
      version: '0.22.14',
    }))
  })

  it('binds the root component to the tarball and marks only Cordis external', () => {
    const finalizeReleaseSbom = requireFunction('finalizeReleaseSbom')
    const output = finalizeReleaseSbom(createRawBom(), {
      owners,
      tarball: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
      sha256: 'a'.repeat(64),
      root: { name: '@tingrudeng/dsh-feishu-bot', version: '0.1.0-rc.5' },
      cordisPurl: 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
      requiredPackages: ['@deepseek-ai/dsh-api-remotes', 'zod'],
      requiredTools: ['tsdown'],
    })
    const bom = JSON.parse(output)

    expect(bom.serialNumber).toBeUndefined()
    expect(bom.metadata.timestamp).toBeUndefined()
    expect(bom.metadata.component.hashes).toEqual([{ alg: 'SHA-256', content: 'a'.repeat(64) }])
    expect(bom.metadata.component.isExternal).toBe(false)
    expect(bom.metadata.component.properties).toContainEqual({
      name: 'dsh:release:tarball',
      value: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
    })
    expect(bom.components.map((component: any) => [component.purl, component.isExternal])).toEqual([
      ['pkg:npm/%40deepseek-ai/cordis@4.0.1', true],
      ['pkg:npm/%40deepseek-ai/dsh-api-remotes@0.1.0-rc.5', false],
      ['pkg:npm/zod@4.4.3', false],
    ])
  })

  it('produces identical bytes regardless of component and dependency input order', () => {
    const finalizeReleaseSbom = requireFunction('finalizeReleaseSbom')
    const options = {
      owners,
      tarball: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
      sha256: 'b'.repeat(64),
      root: { name: '@tingrudeng/dsh-feishu-bot', version: '0.1.0-rc.5' },
      cordisPurl: 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
      requiredPackages: ['@deepseek-ai/dsh-api-remotes', 'zod'],
      requiredTools: ['tsdown'],
    }
    const first = createRawBom()
    const second = createRawBom()
    second.components.reverse()
    second.dependencies.reverse()

    expect(finalizeReleaseSbom(first, options)).toBe(finalizeReleaseSbom(second, options))
  })

  it.each([
    ['missing bundle owner', (bom: any) => bom.components.splice(1, 1), /bundle owner is missing/u],
    ['unexpected bundled component', (bom: any) => bom.components.push({
      type: 'library', name: 'vitest', version: '3.2.7',
      'bom-ref': 'pkg:npm/vitest@3.2.7', purl: 'pkg:npm/vitest@3.2.7',
      properties: [{ name: 'cdx:npm:package:bundled', value: 'true' }],
    }), /bundled component set does not match/u],
    ['local absolute path', (bom: any) => {
      bom.metadata.component.description = '/Users/example/private/source.ts'
    }, /local absolute path/u],
  ])('rejects %s', (_name, mutate, error) => {
    const finalizeReleaseSbom = requireFunction('finalizeReleaseSbom')
    const bom = createRawBom()
    mutate(bom)

    expect(() => finalizeReleaseSbom(bom, {
      owners,
      tarball: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
      sha256: 'c'.repeat(64),
      root: { name: '@tingrudeng/dsh-feishu-bot', version: '0.1.0-rc.5' },
      cordisPurl: 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
      requiredPackages: ['@deepseek-ai/dsh-api-remotes', 'zod'],
      requiredTools: ['tsdown'],
    })).toThrow(error)
  })

  it('rejects an SBOM without the declared build tool', () => {
    const finalizeReleaseSbom = requireFunction('finalizeReleaseSbom')
    const bom = createRawBom()
    bom.metadata.tools = []

    expect(() => finalizeReleaseSbom(bom, {
      owners,
      tarball: 'tingrudeng-dsh-feishu-bot-0.1.0-rc.5.tgz',
      sha256: 'd'.repeat(64),
      root: { name: '@tingrudeng/dsh-feishu-bot', version: '0.1.0-rc.5' },
      cordisPurl: 'pkg:npm/%40deepseek-ai/cordis@4.0.1',
      requiredPackages: ['@deepseek-ai/dsh-api-remotes', 'zod'],
      requiredTools: ['tsdown'],
    })).toThrow(/required build tool is missing/u)
  })
})
