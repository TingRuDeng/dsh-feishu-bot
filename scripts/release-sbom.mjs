import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { Enums, Models } from '@cyclonedx/cyclonedx-library'
import sbomPlugin from 'rollup-plugin-sbom'

export const RELEASE_SBOM_METADATA_DIR = '.release-meta'
export const RELEASE_SBOM_RAW_FILENAME = 'sbom.json'
export const RELEASE_SBOM_OWNERS_FILENAME = 'bundle-owners.json'

const bundledProperty = 'cdx:npm:package:bundled'
const peerRangeProperty = 'dsh:release:peer-range'
const tarballProperty = 'dsh:release:tarball'
const forbiddenRuntimePackages = new Set([
  '@cyclonedx/cyclonedx-library',
  '@types/node',
  'rolldown',
  'rollup-plugin-sbom',
  'typescript',
  'vitest',
])

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function canonicalPurl(purl) {
  return purl.split('?')[0]
}

function packageNameParts(name) {
  if (!name.startsWith('@')) return { group: undefined, name }
  const slash = name.indexOf('/')
  if (slash <= 1 || slash === name.length - 1) throw new Error(`invalid scoped package name: ${name}`)
  return { group: name.slice(0, slash), name: name.slice(slash + 1) }
}

export function packagePurl(name, version) {
  const parts = packageNameParts(name)
  const path = parts.group === undefined
    ? encodeURIComponent(parts.name)
    : `${encodeURIComponent(parts.group)}/${encodeURIComponent(parts.name)}`
  return `pkg:npm/${path}@${encodeURIComponent(version)}`
}

function componentPackageName(component) {
  return component.group === undefined || component.group === ''
    ? component.name
    : `${component.group}/${component.name}`
}

async function findPackageOwner(moduleId) {
  const cleanId = moduleId.split('?', 1)[0]
  if (!isAbsolute(cleanId)) return undefined

  let directory = dirname(cleanId)
  const filesystemRoot = parse(directory).root
  while (directory !== filesystemRoot) {
    try {
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        return { directory, manifest }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  return undefined
}

export async function collectBundledPackages(moduleIds, { projectRoot, harnessRoot }) {
  const absoluteProjectRoot = resolve(projectRoot)
  const absoluteHarnessRoot = resolve(harnessRoot)
  const records = new Map()

  for (const moduleId of new Set(moduleIds)) {
    const owner = await findPackageOwner(moduleId)
    if (owner === undefined || owner.directory === absoluteProjectRoot) continue
    const { name, version } = owner.manifest
    const purl = packagePurl(name, version)
    records.set(purl, {
      name,
      version,
      purl,
      harness: isWithin(absoluteHarnessRoot, owner.directory),
    })
  }

  return [...records.values()].sort((left, right) => left.purl.localeCompare(right.purl))
}

function addModelProperty(component, name, value) {
  for (const property of component.properties) {
    if (property.name !== name) continue
    property.value = value
    return
  }
  component.properties.add(new Models.Property(name, value))
}

function addHarnessReference(component, harnessCommit) {
  const url = `https://github.com/deepseek-ai/deepseek-harness/tree/${harnessCommit}`
  for (const reference of component.externalReferences) {
    if (reference.type === Enums.ExternalReferenceType.VCS && String(reference.url) === url) return
  }
  component.externalReferences.add(new Models.ExternalReference(url, Enums.ExternalReferenceType.VCS))
}

function createModelComponent(record) {
  const parts = packageNameParts(record.name)
  return new Models.Component(Enums.ComponentType.Library, parts.name, {
    group: parts.group,
    version: record.version,
    purl: record.purl,
    bomRef: record.purl,
    scope: Enums.ComponentScope.Required,
  })
}

export function augmentReleaseBom(bom, { owners, harnessCommit, cordis, buildTool }) {
  if (!/^[0-9a-f]{40}$/u.test(harnessCommit)) {
    throw new Error(`invalid Harness commit for SBOM: ${String(harnessCommit)}`)
  }
  const ownerByPurl = new Map(owners.map(owner => [owner.purl, owner]))
  const componentByPurl = new Map()
  for (const component of bom.components) {
    if (typeof component.purl !== 'string') throw new Error(`SBOM component has no purl: ${componentPackageName(component)}`)
    const purl = canonicalPurl(component.purl)
    if (componentByPurl.has(purl)) throw new Error(`duplicate SBOM component purl: ${purl}`)
    componentByPurl.set(purl, component)
  }

  for (const [purl, component] of componentByPurl) {
    if (!ownerByPurl.has(purl)) throw new Error(`SBOM component is absent from the final bundle: ${purl}`)
    const owner = ownerByPurl.get(purl)
    component.scope = Enums.ComponentScope.Required
    addModelProperty(component, bundledProperty, 'true')
    if (owner.harness) addHarnessReference(component, harnessCommit)
  }

  for (const owner of owners) {
    let component = componentByPurl.get(owner.purl)
    if (component === undefined) {
      component = createModelComponent(owner)
      bom.components.add(component)
      componentByPurl.set(owner.purl, component)
    }
    component.scope = Enums.ComponentScope.Required
    addModelProperty(component, bundledProperty, 'true')
    if (owner.harness) addHarnessReference(component, harnessCommit)
  }

  const cordisRecord = {
    name: cordis.name,
    version: cordis.version,
    purl: packagePurl(cordis.name, cordis.version),
    harness: false,
  }
  let cordisComponent = componentByPurl.get(cordisRecord.purl)
  if (cordisComponent === undefined) {
    cordisComponent = createModelComponent(cordisRecord)
    bom.components.add(cordisComponent)
  }
  cordisComponent.scope = Enums.ComponentScope.Required
  addModelProperty(cordisComponent, bundledProperty, 'false')
  addModelProperty(cordisComponent, peerRangeProperty, cordis.range)

  const root = bom.metadata.component
  if (root === undefined) throw new Error('release SBOM has no root component')
  for (const component of bom.components) root.dependencies.add(component.bomRef)

  const existingTool = [...bom.metadata.tools.tools].find(tool => tool.name === buildTool.name)
  if (existingTool !== undefined && existingTool.version !== buildTool.version) {
    throw new Error(`unexpected ${buildTool.name} build tool version: ${String(existingTool.version)}`)
  }
  if (existingTool === undefined) {
    bom.metadata.tools.tools.add(new Models.Tool({
      name: buildTool.name,
      version: buildTool.version,
    }))
  }
}

function getRawProperty(component, name) {
  return component.properties?.find(property => property.name === name)?.value
}

function setRawProperty(component, name, value) {
  component.properties ??= []
  const property = component.properties.find(candidate => candidate.name === name)
  if (property === undefined) component.properties.push({ name, value })
  else property.value = value
}

function sortComponent(component) {
  component.properties?.sort((left, right) => (
    left.name.localeCompare(right.name) || left.value.localeCompare(right.value)
  ))
  component.hashes?.sort((left, right) => (
    left.alg.localeCompare(right.alg) || left.content.localeCompare(right.content)
  ))
  component.externalReferences?.sort((left, right) => (
    left.type.localeCompare(right.type)
    || String(left.url).localeCompare(String(right.url))
    || String(left.comment ?? '').localeCompare(String(right.comment ?? ''))
  ))
  component.licenses?.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function sortBom(bom) {
  sortComponent(bom.metadata.component)
  bom.metadata.tools?.sort((left, right) => (
    String(left.name ?? '').localeCompare(String(right.name ?? ''))
    || String(left.version ?? '').localeCompare(String(right.version ?? ''))
  ))
  for (const tool of bom.metadata.tools ?? []) sortComponent(tool)
  for (const component of bom.components) sortComponent(component)
  bom.components.sort((left, right) => (
    String(left.purl ?? left['bom-ref']).localeCompare(String(right.purl ?? right['bom-ref']))
  ))
  for (const dependency of bom.dependencies ?? []) dependency.dependsOn?.sort()
  bom.dependencies?.sort((left, right) => left.ref.localeCompare(right.ref))
}

function assertNoLocalAbsolutePath(value) {
  const serialized = JSON.stringify(value)
  if (
    /(?:^|[^A-Za-z0-9])\/(?:Users|home|private|tmp|workspace|__w)(?:\/|\\)/u.test(serialized)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:\\(?:Users|home|workspace|__w)\\/u.test(serialized)
    || /file:\/\//u.test(serialized)
  ) {
    throw new Error('release SBOM contains a local absolute path')
  }
}

function assertRawReleaseSbom(bom, {
  owners,
  root,
  cordisPurl,
  requiredPackages,
  requiredTools = [],
}) {
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.7') {
    throw new Error('release SBOM must use CycloneDX 1.7 JSON')
  }
  const rootComponent = bom.metadata?.component
  if (rootComponent === undefined) throw new Error('release SBOM has no root component')
  if (componentPackageName(rootComponent) !== root.name || rootComponent.version !== root.version) {
    throw new Error('release SBOM root component does not match the package manifest')
  }

  const components = new Map()
  for (const component of bom.components ?? []) {
    if (typeof component.purl !== 'string') throw new Error(`release SBOM component has no purl: ${componentPackageName(component)}`)
    const purl = canonicalPurl(component.purl)
    if (components.has(purl)) throw new Error(`duplicate release SBOM component: ${purl}`)
    components.set(purl, component)
  }

  const ownerPurls = new Set(owners.map(owner => owner.purl))
  for (const purl of ownerPurls) {
    if (!components.has(purl)) throw new Error(`bundle owner is missing from the release SBOM: ${purl}`)
  }
  const bundledPurls = new Set([...components]
    .filter(([, component]) => getRawProperty(component, bundledProperty) === 'true')
    .map(([purl]) => purl))
  if (
    bundledPurls.size !== ownerPurls.size
    || [...bundledPurls].some(purl => !ownerPurls.has(purl))
  ) {
    throw new Error('bundled component set does not match the final bundle owner set')
  }

  const external = components.get(cordisPurl)
  if (external === undefined || external.isExternal !== true || getRawProperty(external, bundledProperty) !== 'false') {
    throw new Error('Cordis must be the single external release SBOM component')
  }
  for (const [purl, component] of components) {
    if (purl !== cordisPurl && component.isExternal !== false) {
      throw new Error(`bundled release SBOM component is not marked internal: ${purl}`)
    }
    if (forbiddenRuntimePackages.has(componentPackageName(component))) {
      throw new Error(`dev-only package is present in release SBOM components: ${componentPackageName(component)}`)
    }
  }
  for (const name of requiredPackages) {
    if (![...components.values()].some(component => componentPackageName(component) === name)) {
      throw new Error(`required package is missing from release SBOM: ${name}`)
    }
  }
  const buildTools = new Set((bom.metadata.tools ?? []).map(tool => tool.name))
  for (const name of requiredTools) {
    if (!buildTools.has(name)) throw new Error(`required build tool is missing from release SBOM: ${name}`)
  }
  assertNoLocalAbsolutePath(bom)
}

export function finalizeReleaseSbom(input, options) {
  const bom = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input))
  if (!/^[a-f0-9]{64}$/u.test(options.sha256)) throw new Error('release tarball SHA-256 is invalid')
  if (!/^[^/\\]+\.tgz$/u.test(options.tarball)) throw new Error('release tarball name is invalid')

  delete bom.serialNumber
  delete bom.metadata.timestamp
  const root = bom.metadata.component
  root.isExternal = false
  root.hashes = [
    ...(root.hashes ?? []).filter(hash => hash.alg !== 'SHA-256'),
    { alg: 'SHA-256', content: options.sha256 },
  ]
  setRawProperty(root, tarballProperty, options.tarball)

  for (const component of bom.components ?? []) {
    component.isExternal = canonicalPurl(component.purl) === options.cordisPurl
  }
  sortBom(bom)
  assertRawReleaseSbom(bom, options)
  return `${JSON.stringify(bom, null, 2)}\n`
}

export function createReleaseSbomPlugins({
  projectRoot,
  harnessRoot,
  harnessCommit,
  cordis,
  buildTool,
  metadataDir = RELEASE_SBOM_METADATA_DIR,
}) {
  if (isAbsolute(metadataDir) || metadataDir.includes('..')) {
    throw new Error(`unsafe release SBOM metadata directory: ${metadataDir}`)
  }
  let owners = []
  const collector = {
    name: 'dsh-release-bundle-owners',
    generateBundle: {
      order: 'pre',
      async handler(_outputOptions, bundle) {
        const moduleIds = Object.values(bundle).flatMap(output => (
          output.type === 'chunk' ? output.moduleIds : []
        ))
        owners = await collectBundledPackages(moduleIds, { projectRoot, harnessRoot })
        this.emitFile({
          type: 'asset',
          fileName: `${metadataDir}/${RELEASE_SBOM_OWNERS_FILENAME}`,
          source: `${JSON.stringify(owners, null, 2)}\n`,
        })
      },
    },
  }
  const generator = sbomPlugin({
    specVersion: '1.7',
    rootComponentType: 'library',
    outDir: metadataDir,
    outFilename: 'sbom',
    outFormats: ['json'],
    saveTimestamp: false,
    generateSerial: false,
    includeWellKnown: false,
    collectLicenseEvidence: false,
    afterCollect(bom) {
      augmentReleaseBom(bom, { owners, harnessCommit, cordis, buildTool })
    },
  })
  return [collector, generator]
}
