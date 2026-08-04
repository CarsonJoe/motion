import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

// sync.ts touches localStorage and the network config at import time, so the
// browser globals must exist before the module graph loads.
const localValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return localValues.size },
    key: (index: number) => [...localValues.keys()][index] ?? null,
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
    removeItem: (key: string) => localValues.delete(key)
  },
  configurable: true
})
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })

const { openLocalStore } = await import('./local')
const { openNoteDoc } = await import('./doc')
import type { Note } from './local'

const note = (patch: Partial<Note> = {}): Note => ({
  id: crypto.randomUUID(), title: '', parentId: '', shareId: '', deletedAt: 0, updatedAt: 0, ...patch
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('offline document durability', () => {
  it('renders local state immediately and survives close/reopen with the edit queued', async () => {
    const store = await openLocalStore()
    const target = note()

    const firstTexts: Array<{ value: string; source: string }> = []
    const first = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: (value, source) => firstTexts.push({ value, source }),
      onPresence: () => {}, onTransport: () => {},
      onError: (error) => { throw error }
    })
    expect(firstTexts[0]).toEqual({ value: '', source: 'initial' })
    first.setText('written while offline')
    await first.flushed()
    first.close()

    const secondTexts: string[] = []
    const second = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: (value) => secondTexts.push(value),
      onPresence: () => {}, onTransport: () => {},
      onError: (error) => { throw error }
    })
    expect(secondTexts[0]).toBe('written while offline')
    second.close()

    const ops = await store.listOps()
    expect(ops.some((op) => op.kind === 'update' && op.noteId === target.id)).toBe(true)
  })

  it('accumulates successive edits as mergeable updates in the outbox', async () => {
    const store = await openLocalStore()
    const target = note()
    const controller = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: () => {}, onPresence: () => {}, onTransport: () => {},
      onError: (error) => { throw error }
    })
    controller.setText('one')
    controller.setText('one two')
    controller.setText('one two three')
    await controller.flushed()
    controller.close()

    const updates = (await store.listOps()).filter((op) => op.kind === 'update')
    expect(updates.length).toBe(3)
  })
})
