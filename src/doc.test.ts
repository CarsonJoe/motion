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

  // The app's ACTUAL navigation sequence. Every existing test above awaits
  // `flushed()` before closing, but App's effect cleanup does not — it calls
  // close() synchronously and reopens as soon as the user comes back. Reported
  // repro: type into a blank page offline, go to the mobile sidebar, come back,
  // and the text is gone.
  it('survives a close/reopen that does NOT await the persist chain', async () => {
    const store = await openLocalStore()
    const target = note()

    const first = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: () => {}, onPresence: () => {}, onTransport: () => {},
      onError: (error) => { throw error }
    })
    first.setText('typed offline')
    // No `await first.flushed()` here — that is the whole point.
    first.close()

    const texts: string[] = []
    const second = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: (value) => texts.push(value),
      onPresence: () => {}, onTransport: () => {},
      onError: (error) => { throw error }
    })
    second.close()
    expect(texts[0]).toBe('typed offline')
  })

  // The reopen now waits on the previous controller's writes, which means a
  // FAILED write must not be able to wedge the page shut. Settled is enough.
  it('still opens when a previous write rejected', async () => {
    const store = await openLocalStore()
    const target = note()
    const failing = { ...store, putDocState: async () => { throw new Error('disk full') } }

    const first = await openNoteDoc({
      note: target, store: failing, connected: false, writable: true,
      onText: () => {}, onPresence: () => {}, onTransport: () => {},
      onError: () => { throw new Error('onError itself throws') }
    })
    first.setText('doomed')
    first.close()

    const texts: string[] = []
    const second = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: (value) => texts.push(value),
      onPresence: () => {}, onTransport: () => {},
      onError: () => {}
    })
    second.close()
    expect(texts).toHaveLength(1)
  })

  // The reopen waits on the previous controller's writes. A write that never
  // settles (a blocked IndexedDB transaction) must not turn that wait into a
  // permanently blank page — the wait is bounded and gives up.
  it('still opens when a previous write never settles', async () => {
    const store = await openLocalStore()
    const target = note()
    const wedged = { ...store, putDocState: () => new Promise<void>(() => {}) }

    const first = await openNoteDoc({
      note: target, store: wedged, connected: false, writable: true,
      onText: () => {}, onPresence: () => {}, onTransport: () => {},
      onError: () => {}
    })
    first.setText('never lands')
    first.close()

    const started = Date.now()
    const second = await openNoteDoc({
      note: target, store, connected: false, writable: true,
      onText: () => {}, onPresence: () => {}, onTransport: () => {},
      onError: () => {}
    })
    second.close()
    // Opened at all, and by way of the deadline rather than a hung await.
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10000)

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
