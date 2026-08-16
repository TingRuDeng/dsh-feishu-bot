import { defineConfig } from 'tsdown'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseSbomPlugins } from './scripts/release-sbom.mjs'

function requiredEnv(name: string) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required for a release build`)
  return value
}

const outDir = requiredEnv('DSH_FEISHU_RELEASE_OUT_DIR')
const projectRoot = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(requiredEnv('DSH_RELEASE_HARNESS_ROOT'))
const cordisName = '@deepseek-ai/cordis'
const nodeBuiltins = new Set(builtinModules.map(name => name.replace(/^node:/u, '')))

export default defineConfig({
  entry: ['src/index.ts', 'src/gateway/index.ts', 'src/bridge/index.ts', 'src/invariant.ts'],
  format: 'esm',
  outDir,
  dts: true,
  clean: true,
  shims: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [cordisName],
    alwaysBundle(id) {
      const packageName = id.replace(/^node:/u, '')
      return !nodeBuiltins.has(packageName)
        && id !== cordisName
        && !id.startsWith(`${cordisName}/`)
    },
    onlyBundle: false,
  },
  plugins: createReleaseSbomPlugins({
    projectRoot,
    harnessRoot,
    harnessCommit: requiredEnv('DSH_RELEASE_HARNESS_COMMIT'),
    cordis: {
      name: cordisName,
      version: requiredEnv('DSH_RELEASE_CORDIS_VERSION'),
      range: requiredEnv('DSH_RELEASE_CORDIS_RANGE'),
    },
    buildTool: {
      name: 'tsdown',
      version: requiredEnv('DSH_RELEASE_TSDOWN_VERSION'),
    },
  }),
})
