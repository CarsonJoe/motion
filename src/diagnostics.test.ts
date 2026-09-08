import { beforeEach, describe, expect, it } from 'vitest'

const values = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }, configurable: true
})
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'Mozilla/5.0 Linux Chrome/120', serviceWorker: null }, configurable: true })
Object.defineProperty(globalThis, 'document', { value: { visibilityState: 'visible' }, configurable: true })
Object.defineProperty(globalThis, 'matchMedia', { value: () => ({ matches: false }), configurable: true })
Object.defineProperty(globalThis, '__PAD_BUILD__', { value: 'test-build', configurable: true })

const diagnostics = await import('./diagnostics')

beforeEach(() => diagnostics.clearDiagnostics())

describe('diagnostic reports', () => {
  it('redacts sensitive fields, URLs, credentials, ids, and emails', async () => {
    const uuid = '2db96ad2-4104-4a5e-853f-d2d45697b94e'
    diagnostics.diagnosticEvent('sync', 'fixture', {
      title: 'SECRET_TITLE',
      markdown: 'SECRET_MARKDOWN',
      payload: 'SECRET_PAYLOAD',
      token: 'tpt_abcdefghijklmnopqrstuvwxyz',
      url: 'https://example.test/private',
      note: diagnostics.diagnosticAlias('note', uuid),
      detail: `https://example.test/private ${uuid} person@example.test tpt_abcdefghijklmnopqrstuvwxyz`,
    })

    const report = await diagnostics.buildDiagnosticReport()
    expect(report).not.toContain('SECRET_TITLE')
    expect(report).not.toContain('SECRET_MARKDOWN')
    expect(report).not.toContain('SECRET_PAYLOAD')
    expect(report).not.toContain('example.test/private')
    expect(report).not.toContain(uuid)
    expect(report).not.toContain('person@example.test')
    expect(report).not.toContain('tpt_abcdefghijklmnopqrstuvwxyz')
    expect(report).toContain('note-')
  })

  it('deduplicates repeated events and caps the report', async () => {
    for (let index = 0; index < 3; index += 1) diagnostics.diagnosticWarn('sync', 'same-warning', { status: 503 })
    for (let index = 0; index < 500; index += 1) diagnostics.diagnosticWarn('network', `warning-${index}`, { detail: 'x'.repeat(180) })

    const report = await diagnostics.buildDiagnosticReport()
    expect(new Blob([report]).size).toBeLessThanOrEqual(16 * 1024)
    expect(report.match(/same-warning/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('aggregates request success and failure without response bodies', async () => {
    await diagnostics.diagnosticRequest('db.notes.select.private', async () => ({ secret: 'not inspected' }))
    await expect(diagnostics.diagnosticRequest('db.notes.select.private', async () => {
      throw Object.assign(new Error('Gateway unavailable'), { status: 503, requestId: 'req_safe' })
    })).rejects.toThrow('Gateway unavailable')

    const report = await diagnostics.buildDiagnosticReport()
    expect(report).toContain('db.notes.select.private n=2 err=1')
    expect(report).toContain('request=req_safe')
    expect(report).not.toContain('not inspected')
  })
})
