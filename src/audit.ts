import { createHash } from 'node:crypto'

const SAFE_ERROR_CODE = /^[A-Z0-9_.-]{1,64}$/u

/**
 * Produce a stable truncated SHA-256 label for correlating audit events.
 * This is deliberately not used for security decisions.
 */
export function auditHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/** Keep operational logs useful without copying transport response bodies. */
export function safeErrorFact(error: unknown): string {
  let name = 'Error'
  let candidate = ''
  try {
    if (error instanceof Error && SAFE_ERROR_CODE.test(error.name)) name = error.name
  } catch { /* hostile proxy/getter: keep the safe default */ }
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) candidate = String(error.code)
  } catch { /* hostile proxy/getter: keep UNKNOWN */ }
  const code = SAFE_ERROR_CODE.test(candidate) ? candidate : 'UNKNOWN'
  return `${name}:${code}`
}
