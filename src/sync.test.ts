import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import * as Y from 'yjs'

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
const { drainOutbox } = await import('./sync')
const { fromBase64, toBase64 } = await import('./codec')
import type { Note } from './local'
import type { TallpondClient } from './sync'

type Recorded = { scope: string; table: string; op: string; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> }

// A minimal stand-in for the SDK query builder: fluent, thenable, and
// scripted per-table with the rows the gateway would return.
function fakeClient(existingByTable: Record<string, Record<string, unknown> | null> = {}, updateHits: Record<string, Array<Record<string, unknown>>> = {}) {
  const calls: Recorded[] = []
  const makeQuery = (scope: string, table: string) => {
    const record: Recorded = { scope, table, op: 'select', filters: [] }
    const query: Record<string, unknown> = {
      select: () => query,
      insert: (values: Record<string, unknown>) => { record.op = 'insert'; record.values = values; return query },
      update: (values: Record<string, unknown>) => { record.op = 'update'; record.values = values; return query },
      delete: () => { record.op = 'delete'; return query },
      eq: (column: string, value: unknown) => { record.filters.push([column, 'eq', value]); return query },
      lte: (column: string, value: unknown) => { record.filters.push([column, 'lte', value]); return query },
      in: (column: string, value: unknown) => { record.filters.push([column, 'in', value]); return query },
      maybeSingle: () => { calls.push(record); return Promise.resolve(existingByTable[table] ?? null) },
      then: (resolve: (rows: unknown[]) => unknown) => {
        calls.push(record)
        return Promise.resolve(record.op === 'update' ? updateHits[table] ?? [] : []).then(resolve)
      }
    }
    return query
  }
  const client = {
    table: (name: string) => makeQuery('private', name),
    resource: (id: string) => ({ table: (name: string) => makeQuery(id, name) })
  } as unknown as TallpondClient
  return { client, calls }
}

const note = (patch: Partial<Note>): Note => ({
  id: crypto.randomUUID(), title: '', parentId: '', shareId: '', deletedAt: 0, updatedAt: 0, ...patch
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

const encodedInsert = (value: string) => {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, value)
  return toBase64(Y.encodeStateAsUpdate(doc))
}

describe('drainOutbox', () => {
  it('merges content updates per note into one insert against the right scope', async () => {
    const store = await openLocalStore()
    await store.enqueueUpdate('n1', '', encodedInsert('hello'))
    await store.enqueueUpdate('n1', '', encodedInsert('world'))
    await store.enqueueUpdate('n2', 'share-1', encodedInsert('shared'))

    const { client, calls } = fakeClient()
    await drainOutbox(client, store)

    const inserts = calls.filter((call) => call.op === 'insert')
    expect(inserts).toHaveLength(2)
    const privateInsert = inserts.find((call) => call.table === 'note_updates')!
    expect(privateInsert.scope).toBe('private')
    expect(privateInsert.values?.noteId).toBe('n1')
    const merged = new Y.Doc()
    Y.applyUpdate(merged, fromBase64(String(privateInsert.values?.payload)))
    const textValue = merged.getText('content').toString()
    expect(textValue).toContain('hello')
    expect(textValue).toContain('world')

    const sharedInsert = inserts.find((call) => call.table === 'member_note_updates')!
    expect(sharedInsert.scope).toBe('share-1')
    expect(await store.countOps()).toBe(0)
  })

  it('pushes metadata with an LWW guard and inserts only when the row is absent', async () => {
    const store = await openLocalStore()
    const fresh = note({ title: 'brand new', updatedAt: 50 })
    await store.putNote(fresh)
    await store.enqueueNote(fresh.id)

    const { client, calls } = fakeClient({ notes: null })
    await drainOutbox(client, store)

    const update = calls.find((call) => call.op === 'update' && call.table === 'notes')!
    expect(update.filters).toContainEqual(['noteId', 'eq', fresh.id])
    expect(update.filters).toContainEqual(['clientUpdatedAt', 'lte', 50])
    const insert = calls.find((call) => call.op === 'insert' && call.table === 'notes')!
    expect(insert.values).toMatchObject({ noteId: fresh.id, title: 'brand new', clientUpdatedAt: 50 })
    expect(await store.countOps()).toBe(0)
  })

  it('never inserts when a newer remote row already exists', async () => {
    const store = await openLocalStore()
    const stale = note({ title: 'stale', updatedAt: 10 })
    await store.putNote(stale)
    await store.enqueueNote(stale.id)

    // update() misses the LWW guard; the row exists — so no insert happens.
    const { client, calls } = fakeClient({ notes: { noteId: stale.id } })
    await drainOutbox(client, store)

    expect(calls.some((call) => call.op === 'insert' && call.table === 'notes')).toBe(false)
    expect(await store.countOps()).toBe(0)
  })

  it('drops metadata ops whose note no longer exists locally', async () => {
    const store = await openLocalStore()
    await store.enqueueNote('ghost')
    const { client, calls } = fakeClient()
    await drainOutbox(client, store)
    expect(calls).toHaveLength(0)
    expect(await store.countOps()).toBe(0)
  })
})
