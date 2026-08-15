import { access } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

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
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    keywords: source.keywords,
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
