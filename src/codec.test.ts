import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { fromBase64, mergeBase64Updates, patchYText, toBase64 } from './codec'

describe('base64 codec', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('merges encoded updates into one equivalent update', () => {
    const doc = new Y.Doc()
    const updates: string[] = []
    doc.on('update', (update: Uint8Array) => updates.push(toBase64(update)))
    doc.getText('content').insert(0, 'hello')
    doc.getText('content').insert(5, ' world')
    const replica = new Y.Doc()
    Y.applyUpdate(replica, fromBase64(mergeBase64Updates(updates)))
    expect(replica.getText('content').toString()).toBe('hello world')
  })
})

describe('patchYText', () => {
  const apply = (before: string, after: string) => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    if (before) text.insert(0, before)
    patchYText(text, after)
    return text.toString()
  }

  it('handles inserts, deletes and replacements at every position', () => {
    expect(apply('', 'abc')).toBe('abc')
    expect(apply('abc', '')).toBe('')
    expect(apply('abc', 'aXbc')).toBe('aXbc')
    expect(apply('abc', 'ac')).toBe('ac')
    expect(apply('abc', 'aQc')).toBe('aQc')
    expect(apply('same', 'same')).toBe('same')
  })

  it('keeps concurrent edits at different positions mergeable', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.getText('content').insert(0, 'hello world')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    // A edits the head, B edits the tail, both against the same base.
    patchYText(a.getText('content'), 'HELLO world')
    patchYText(b.getText('content'), 'hello world!')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))

    expect(a.getText('content').toString()).toBe('HELLO world!')
    expect(b.getText('content').toString()).toBe('HELLO world!')
  })
})
