import { defineConfig } from 'tsdown'

const outDir = process.env.DSH_FEISHU_RELEASE_OUT_DIR
if (outDir === undefined || outDir === '') {
  throw new Error('DSH_FEISHU_RELEASE_OUT_DIR is required for a release build')
}

export default defineConfig({
  entry: ['src/index.ts', 'src/gateway/index.ts', 'src/bridge/index.ts', 'src/invariant.ts'],
  format: 'esm',
  outDir,
  dts: true,
  clean: true,
  shims: true,
  external: ['@deepseek-ai/cordis'],
  noExternal: [/.*/u],
})
