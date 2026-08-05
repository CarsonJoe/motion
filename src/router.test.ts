import { afterEach, describe, expect, it } from 'vitest'
import { pageUrl, readRoute } from './router'

const setHash = (hash: string) => {
  ;(globalThis as unknown as { window: unknown }).window = { location: { hash, pathname: '/', search: '' } }
}
afterEach(() => { delete (globalThis as unknown as { window?: unknown }).window })

describe('pageUrl', () => {
  it('builds a bare page url', () => { expect(pageUrl('abc')).toBe('#/p/abc') })
  it('includes the resource id when shared', () => { expect(pageUrl('abc', 'res1')).toBe('#/p/abc?r=res1') })
  it('omits the resource id when absent', () => { expect(pageUrl('abc', null)).toBe('#/p/abc') })
  it('encodes ids', () => { expect(pageUrl('a b')).toBe('#/p/a%20b') })
})

describe('readRoute', () => {
  it('parses a bare page route', () => { setHash('#/p/abc'); expect(readRoute()).toEqual({ noteId: 'abc', resourceId: null }) })
  it('parses note + resource', () => { setHash('#/p/abc?r=res1'); expect(readRoute()).toEqual({ noteId: 'abc', resourceId: 'res1' }) })
  it('decodes ids', () => { setHash('#/p/a%20b'); expect(readRoute()).toEqual({ noteId: 'a b', resourceId: null }) })
  it('is empty for the home route', () => { setHash('#/'); expect(readRoute()).toEqual({ noteId: null, resourceId: null }) })
  it('is empty for no hash', () => { setHash(''); expect(readRoute()).toEqual({ noteId: null, resourceId: null }) })
})
