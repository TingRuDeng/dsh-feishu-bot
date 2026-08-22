import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('local checkout build', () => {
  it('emits the JavaScript and declaration files declared by package exports', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-local-build-'))
    try {
      await execFileAsync(join(process.cwd(), 'node_modules/.bin/tsdown'), [
        '--config',
        join(process.cwd(), 'tsdown.config.ts'),
        '--out-dir',
        join(outputRoot, 'lib'),
        '--logLevel',
        'error',
      ], { cwd: process.cwd() })

      for (const file of [
        'lib/index.js',
        'lib/gateway/index.js',
        'lib/bridge/index.js',
        'lib/invariant.js',
        'lib/index.d.ts',
        'lib/gateway/index.d.ts',
        'lib/bridge/index.d.ts',
        'lib/invariant.d.ts',
      ]) {
        await expect(readFile(join(outputRoot, file))).resolves.toBeInstanceOf(Buffer)
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })
})
