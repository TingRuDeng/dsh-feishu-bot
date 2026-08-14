import { describe, expect, it } from 'vitest'
import { auditHash, safeErrorFact } from '../src/audit.ts'

describe('audit privacy helpers', () => {
  it('hashes identifiers without preserving their source value', () => {
    const raw = 'oc_sensitive_chat_identifier'
    const hashed = auditHash(raw)
    expect(hashed).not.toContain(raw)
    expect(hashed).toMatch(/^[0-9a-f]+$/u)
    expect(auditHash(raw)).toBe(hashed)
  })

  it('keeps only error class and code, never the error message body', () => {
    const error = Object.assign(new Error('response included 机密正文'), { code: 'RATE_LIMIT' })
    const fact = safeErrorFact(error)
    expect(fact).toContain('Error')
    expect(fact).toContain('RATE_LIMIT')
    expect(fact).not.toContain('机密正文')
    expect(fact).not.toContain('response included')
  })

  it('does not let a hostile error code getter break the logging path', () => {
    const error = new Error('secret transport body')
    Object.defineProperty(error, 'code', {
      get: () => { throw new Error('getter exploded with secret transport body') },
    })
    expect(safeErrorFact(error)).toBe('Error:UNKNOWN')
  })
})
