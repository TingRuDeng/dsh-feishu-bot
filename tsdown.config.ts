import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/gateway/index.ts', 'src/bridge/index.ts'],
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: true,
})
