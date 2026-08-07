import { describe, expect, it } from 'vitest'
import { exportFileName, fromImportMarkdown, toExportMarkdown } from './markdown'

const BLANK = '\u200B'
const noShares = () => null

// Export addresses pages through `window.location`, exactly as the router and
// the share sheet do. The suite runs in node, so give it one rather than
// weakening the module with a fallback that production would never take.
const ORIGIN = 'https://motion.example'
globalThis.window = { location: { origin: ORIGIN, pathname: '/' } } as unknown as Window & typeof globalThis

describe('toExportMarkdown', () => {
  it('strips the blank-line markers and collapses what they held open', () => {
    const exported = toExportMarkdown(`one\n\n${BLANK}\n\n${BLANK}\n\ntwo`, noShares)
    expect(exported).toBe('one\n\ntwo\n')
    expect(exported).not.toContain(BLANK)
  })

  it('rewrites page links to absolute urls, carrying the resource id for shared pages', () => {
    const exported = toExportMarkdown('see [Notes](motion:abc) and [Shared](motion:def)', (id) => id === 'def' ? 'res-1' : null)
    expect(exported).toContain(`${ORIGIN}/#/p/abc`)
    expect(exported).toContain('#/p/def?r=res-1')
    expect(exported).not.toContain('motion:')
  })

  it('leaves external links alone', () => {
    expect(toExportMarkdown('[site](https://example.com)', noShares)).toBe('[site](https://example.com)\n')
  })

  it('ends with exactly one trailing newline', () => {
    expect(toExportMarkdown('body\n\n\n', noShares)).toBe('body\n')
  })
})

describe('fromImportMarkdown', () => {
  it('takes the title from a leading h1 and drops it from the body', () => {
    expect(fromImportMarkdown('# Title\n\nbody text', 'whatever.md')).toEqual({ title: 'Title', body: 'body text' })
  })

  it('falls back to the file name when there is no leading heading', () => {
    expect(fromImportMarkdown('just body', 'Meeting Notes.md')).toEqual({ title: 'Meeting Notes', body: 'just body' })
  })

  it('does not mistake a lower-level heading for the title', () => {
    const { title, body } = fromImportMarkdown('## Section\n\nbody', 'file.md')
    expect(title).toBe('file')
    expect(body).toBe('## Section\n\nbody')
  })

  it('normalizes crlf and refuses to carry markers in from outside', () => {
    expect(fromImportMarkdown(`# T\r\n\r\na${BLANK}b`, 'f.md').body).toBe('ab')
  })

  it('round-trips this app\'s own export', () => {
    const title = 'My Page'
    const exported = toExportMarkdown('one\n\ntwo', noShares)
    expect(fromImportMarkdown(`# ${title}\n\n${exported}`, 'x.md')).toEqual({ title, body: 'one\n\ntwo\n' })
  })
})

describe('exportFileName', () => {
  it('strips characters that are illegal in a file name', () => {
    expect(exportFileName('Q3: plans / drafts?')).toBe('Q3- plans - drafts-.md')
  })

  it('falls back for an untitled page', () => {
    expect(exportFileName('   ')).toBe('Untitled.md')
  })
})
