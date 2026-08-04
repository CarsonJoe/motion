import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import * as Y from 'yjs'
import { toBase64 } from './codec'
import { openLocalStore } from './local'
import { backlinkSources, extractLinks, forgetNote, indexNote, rebuildLinkIndex } from './links'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  // The index is a module singleton; clear whatever prior cases left behind.
  for (const id of ['a', 'b', 'c', 'n1', 'n2', 'n3']) forgetNote(id)
})

describe('extractLinks', () => {
  it('pulls internal ids and ignores external links', () => {
    const md = 'See [Roadmap](motion:abc) and [Home](motion:home) plus [Google](https://google.com).'
    expect(extractLinks(md).sort()).toEqual(['abc', 'home'])
  })

  it('dedupes repeated links to the same page', () => {
    expect(extractLinks('[x](motion:same) then [y](motion:same)')).toEqual(['same'])
  })

  it('decodes ids and returns nothing for plain text', () => {
    expect(extractLinks('[a](motion:a%20b)')).toEqual(['a b'])
    expect(extractLinks('no links here')).toEqual([])
  })
})

describe('backlink index', () => {
  it('reports which pages link to a target, excluding self-links', () => {
    indexNote('a', 'links to [b](motion:b) and itself [a](motion:a)')
    indexNote('c', 'also to [b](motion:b)')
    expect(backlinkSources('b').sort()).toEqual(['a', 'c'])
    expect(backlinkSources('a')).toEqual([]) // self-link only
  })

  it('updates when a body changes and drops emptied notes', () => {
    indexNote('a', '[b](motion:b)')
    expect(backlinkSources('b')).toEqual(['a'])
    indexNote('a', 'now points [c](motion:c) instead')
    expect(backlinkSources('b')).toEqual([])
    expect(backlinkSources('c')).toEqual(['a'])
    forgetNote('a')
    expect(backlinkSources('c')).toEqual([])
  })
})

describe('rebuildLinkIndex', () => {
  it('seeds the index from Yjs bodies stored locally', async () => {
    const store = await openLocalStore()
    const write = async (noteId: string, markdown: string) => {
      const doc = new Y.Doc()
      doc.getText('content').insert(0, markdown)
      await store.putDocState(noteId, toBase64(Y.encodeStateAsUpdate(doc)))
    }
    await write('n1', 'points at [n2](motion:n2)')
    await write('n3', 'also at [n2](motion:n2)')
    await rebuildLinkIndex(store)
    expect(backlinkSources('n2').sort()).toEqual(['n1', 'n3'])
  })
})
