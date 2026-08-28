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
const { deleteNoteTree, drainOutbox, getSyncState, migrateNoteTreeToShare, moveNoteTreeToRoom, purgeExpiredLocalCopies, reconcileAuthoritativeAbsence, restoreNoteTree, saveNote, trashRoots, TRASH_RETENTION_MS } = await import('./sync')
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
    resource: (id: string) => ({
      table: (name: string) => makeQuery(id, name),
      room: (roomId: string) => ({ table: (name: string) => makeQuery(`${id}:${roomId}`, name) })
    })
  } as unknown as TallpondClient
  return { client, calls }
}

const note = (patch: Partial<Note>): Note => ({
  id: crypto.randomUUID(), title: '', parentId: '', shareId: '', roomId: '', deletedAt: 0, updatedAt: 0, ...patch
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

const encodedInsert = (value: string) => {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, value)
  return toBase64(Y.encodeStateAsUpdate(doc))
}

describe('share promotion', () => {
  it('durably re-homes the whole subtree before the first remote write can fail', async () => {
    const store = await openLocalStore('user-a')
    await store.putNote(note({ id: 'root', title: 'Plan' }))
    await store.putNote(note({ id: 'child', title: 'Details', parentId: 'root' }))
    await store.putDocState('root', encodedInsert('draft'))

    const failing = {
      resource: () => ({
        table: () => ({ insert: () => Promise.reject(new Error('network interrupted')) })
      })
    } as unknown as TallpondClient

    await expect(migrateNoteTreeToShare(failing, store, store.getNote('root')!, 'share-1')).rejects.toThrow('network interrupted')

    expect(store.getNote('root')).toMatchObject({ shareId: 'share-1', roomId: '', parentId: '', remoteKnown: false })
    expect(store.getNote('child')).toMatchObject({ shareId: 'share-1', roomId: '', parentId: 'root', remoteKnown: false })
    expect(await store.countOps()).toBeGreaterThan(0)
  })

  it('can share only the selected page without promoting its subpages', async () => {
    const store = await openLocalStore('user-a')
    await store.putNote(note({ id: 'root', title: 'Plan', updatedAt: 10 }))
    await store.putNote(note({ id: 'child', title: 'Private detail', parentId: 'root', updatedAt: 11 }))
    const { client, calls } = fakeClient()

    await migrateNoteTreeToShare(client, store, store.getNote('root')!, 'share-1', '', false)

    expect(store.getNote('root')?.shareId).toBe('share-1')
    expect(store.getNote('child')?.shareId).toBe('')
    expect(calls.filter((call) => call.scope === 'share-1' && call.table === 'member_notes' && call.op === 'insert')).toHaveLength(1)
  })

  it('preserves a private canonical parent when sharing a nested subtree', async () => {
    const store = await openLocalStore('user-a')
    await store.putNote(note({ id: 'private-parent', title: 'Work' }))
    await store.putNote(note({ id: 'root', title: 'Plan', parentId: 'private-parent', updatedAt: 10 }))
    const { client } = fakeClient()

    await migrateNoteTreeToShare(client, store, store.getNote('root')!, 'share-1')

    expect(store.getNote('root')).toMatchObject({ shareId: 'share-1', parentId: 'private-parent' })
    expect(store.getNote('private-parent')?.shareId).toBe('')
  })

  it('can inherit a parent room when sharing a private child', async () => {
    const store = await openLocalStore('user-a')
    await store.putNote(note({ id: 'parent', shareId: 'share-1', roomId: 'room-1' }))
    await store.putNote(note({ id: 'child', parentId: 'parent', updatedAt: 10 }))
    const { client, calls } = fakeClient()

    await migrateNoteTreeToShare(client, store, store.getNote('child')!, 'share-1', 'room-1')

    expect(store.getNote('child')).toMatchObject({ shareId: 'share-1', roomId: 'room-1', parentId: 'parent' })
    expect(calls.filter((call) => call.scope === 'share-1:room-1' && call.table === 'member_notes' && call.op === 'insert')).toHaveLength(1)
  })

  it('drains the promoted state before retiring the private rows', async () => {
    const store = await openLocalStore('user-a')
    await store.putNote(note({ id: 'root', title: 'Plan', updatedAt: 10 }))
    await store.putNote(note({ id: 'child', title: 'Details', parentId: 'root', updatedAt: 11 }))
    const { client, calls } = fakeClient()

    await migrateNoteTreeToShare(client, store, store.getNote('root')!, 'share-1')

    expect(await store.countOps()).toBe(0)
    expect(calls.filter((call) => call.scope === 'share-1' && call.table === 'member_notes' && call.op === 'insert')).toHaveLength(2)
    expect(calls.filter((call) => call.scope === 'private' && call.table === 'notes' && call.op === 'update')).toHaveLength(2)
  })
})

describe('room moves', () => {
  it('moves body rows before metadata and leaves nested room boundaries alone', async () => {
    const store = await openLocalStore('user-a')
    const root = note({ id: 'root', shareId: 'share-1' })
    const child = note({ id: 'child', parentId: root.id, shareId: root.shareId })
    const nested = note({ id: 'nested', parentId: child.id, shareId: root.shareId, roomId: 'existing-room' })
    for (const value of [root, child, nested]) await store.putNote(value)

    const rows = {
      member_notes: [
        { id: 'meta-root', noteId: root.id },
        { id: 'meta-child', noteId: child.id },
        { id: 'meta-nested', noteId: nested.id }
      ],
      member_note_updates: [
        { id: 'update-root', noteId: root.id },
        { id: 'update-child', noteId: child.id },
        { id: 'update-nested', noteId: nested.id }
      ]
    } as Record<string, Array<Record<string, unknown>>>
    const moves: Array<{ table: string; ids: string[]; destination: string }> = []
    const table = (name: string) => {
      let noteIds: string[] = []
      const query: Record<string, unknown> = {
        select: () => query,
        in: (column: string, values: string[]) => { if (column === 'noteId') noteIds = values; return query },
        after: () => query,
        limit: () => query,
        page: () => Promise.resolve({ rows: (rows[name] ?? []).filter((row) => noteIds.includes(String(row.noteId))), nextCursor: null }),
        moveRoom: (ids: string[], destination: string) => { moves.push({ table: name, ids, destination }); return Promise.resolve() }
      }
      return query
    }
    const client = {
      resource: () => ({
        table,
        room: () => ({ table })
      })
    } as unknown as TallpondClient

    await moveNoteTreeToRoom(client, store, root, 'room-1')

    expect(moves).toEqual([
      { table: 'member_note_updates', ids: ['update-root', 'update-child'], destination: 'room-1' },
      { table: 'member_notes', ids: ['meta-root', 'meta-child'], destination: 'room-1' }
    ])
    expect(store.getNote(root.id)?.roomId).toBe('room-1')
    expect(store.getNote(child.id)?.roomId).toBe('room-1')
    expect(store.getNote(nested.id)?.roomId).toBe('existing-room')
  })

  it('can change access for only the selected page', async () => {
    const store = await openLocalStore('user-a')
    const root = note({ id: 'root', shareId: 'share-1' })
    const child = note({ id: 'child', parentId: root.id, shareId: root.shareId })
    for (const value of [root, child]) await store.putNote(value)
    const rows = {
      member_notes: [{ id: 'meta-root', noteId: root.id }, { id: 'meta-child', noteId: child.id }],
      member_note_updates: [{ id: 'update-root', noteId: root.id }, { id: 'update-child', noteId: child.id }]
    } as Record<string, Array<Record<string, unknown>>>
    const moves: Array<{ table: string; ids: string[] }> = []
    const table = (name: string) => {
      let noteIds: string[] = []
      const query: Record<string, unknown> = {
        select: () => query,
        in: (_column: string, values: string[]) => { noteIds = values; return query },
        after: () => query,
        limit: () => query,
        page: () => Promise.resolve({ rows: rows[name].filter((row) => noteIds.includes(String(row.noteId))), nextCursor: null }),
        moveRoom: (ids: string[]) => { moves.push({ table: name, ids }); return Promise.resolve() }
      }
      return query
    }
    const client = { resource: () => ({ table, room: () => ({ table }) }) } as unknown as TallpondClient

    await moveNoteTreeToRoom(client, store, root, 'room-1', false)

    expect(moves.every((move) => move.ids.every((id) => id.endsWith('root')))).toBe(true)
    expect(store.getNote(root.id)?.roomId).toBe('room-1')
    expect(store.getNote(child.id)?.roomId).toBe('')
  })
})

describe('saveNote', () => {
  it('never lets a stale caller snapshot revert the note scope or a delete', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    const beforeSharing = note({ id, title: 'draft', updatedAt: 10 })
    await store.putNote(beforeSharing)
    // The note is shared and assigned to a room (and could equally have been
    // deleted) after the UI captured `beforeSharing` for a title edit.
    await store.putNote({ ...beforeSharing, shareId, roomId: 'room-1' })

    await saveNote(store, { ...beforeSharing, title: 'renamed', updatedAt: 20 })

    const current = store.getNote(id)
    expect(current?.title).toBe('renamed')
    expect(current?.shareId).toBe(shareId)
    expect(current?.roomId).toBe('room-1')
    expect(current?.deletedAt).toBe(0)
  })

  it('keeps a note deleted when a queued edit lands afterwards', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const live = note({ id, title: 'doomed', updatedAt: 10 })
    await store.putNote(live)
    await store.putNote({ ...live, deletedAt: 30, updatedAt: 30 })

    await saveNote(store, { ...live, title: 'edited', updatedAt: 40 })

    expect(store.getNote(id)?.deletedAt).toBe(30)
  })
})

describe('deleteNoteTree', () => {
  // Regression: the delete used to destroy every body in the subtree, so the
  // soft delete was reversible in the metadata and irreversible in fact. Any
  // trash or archive has to be able to hand the contents back.
  it('keeps every body in the subtree so the delete can be undone', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'root', title: 'Trip' }))
    await store.putNote(note({ id: 'child', title: 'Packing', parentId: 'root' }))
    // Held as values: each call to `encodedInsert` mints a fresh Yjs client id,
    // so two encodings of the same text are not byte-identical.
    const rootBody = encodedInsert('itinerary')
    const childBody = encodedInsert('socks')
    await store.putDocState('root', rootBody)
    await store.putDocState('child', childBody)

    await deleteNoteTree(store, 'root')

    expect(store.getNote('root')?.deletedAt).toBeGreaterThan(0)
    expect(store.getNote('child')?.deletedAt).toBeGreaterThan(0)
    expect(await store.getDocState('root')).toBe(rootBody)
    expect(await store.getDocState('child')).toBe(childBody)
  })

  // The shared timestamp is what identifies one deletion as a single undoable
  // operation, and what keeps an earlier, separate deletion out of it.
  it('stamps the subtree with one timestamp and leaves earlier deletions alone', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'root' }))
    await store.putNote(note({ id: 'kept', parentId: 'root' }))
    await store.putNote(note({ id: 'gone-already', parentId: 'root', deletedAt: 5, updatedAt: 5 }))

    await deleteNoteTree(store, 'root')

    expect(store.getNote('root')?.deletedAt).toBe(store.getNote('kept')?.deletedAt)
    expect(store.getNote('gone-already')?.deletedAt).toBe(5)
  })
})

describe('trashRoots', () => {
  it('lists the top of each deletion, not every page it took with it', () => {
    const at = 1000
    const notes = [
      note({ id: 'root', deletedAt: at, updatedAt: at }),
      note({ id: 'child', parentId: 'root', deletedAt: at, updatedAt: at }),
      note({ id: 'alive' }),
      note({ id: 'separate', deletedAt: 500, updatedAt: 500 })
    ]
    expect(trashRoots(notes).map((n) => n.id)).toEqual(['root', 'separate'])
  })

  // A page deleted on its own is its own root even if its parent is also in the
  // trash, because the two were separate decisions.
  it('treats a page deleted separately from its parent as its own entry', () => {
    const notes = [
      note({ id: 'parent', deletedAt: 900, updatedAt: 900 }),
      note({ id: 'child', parentId: 'parent', deletedAt: 400, updatedAt: 400 })
    ]
    expect(trashRoots(notes).map((n) => n.id)).toEqual(['parent', 'child'])
  })
})

describe('restoreNoteTree', () => {
  it('brings back everything removed by the same deletion', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'root', title: 'Trip' }))
    await store.putNote(note({ id: 'child', parentId: 'root' }))
    await deleteNoteTree(store, 'root')

    await restoreNoteTree(store, 'root')

    expect(store.getNote('root')?.deletedAt).toBe(0)
    expect(store.getNote('child')?.deletedAt).toBe(0)
    expect(store.getNote('child')?.parentId).toBe('root')
  })

  it('leaves a page deleted earlier in the trash', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'root' }))
    await store.putNote(note({ id: 'earlier', parentId: 'root', deletedAt: 5, updatedAt: 5 }))
    await deleteNoteTree(store, 'root')

    await restoreNoteTree(store, 'root')

    expect(store.getNote('root')?.deletedAt).toBe(0)
    expect(store.getNote('earlier')?.deletedAt).toBe(5)
  })

  // The tree renders by walking parentId from the root, so a restored page
  // still pointing at a deleted parent would be invisible and unreachable.
  it('re-homes a restored page whose parent is still deleted', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'parent' }))
    await store.putNote(note({ id: 'child', parentId: 'parent' }))
    // Two separate deletions: the child first, then the parent.
    await deleteNoteTree(store, 'child')
    await deleteNoteTree(store, 'parent')

    await restoreNoteTree(store, 'child')

    expect(store.getNote('child')?.deletedAt).toBe(0)
    expect(store.getNote('child')?.parentId).toBe('')
    expect(store.getNote('parent')?.deletedAt).toBeGreaterThan(0)
  })

  it('keeps a parent that is alive', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'parent' }))
    await store.putNote(note({ id: 'child', parentId: 'parent' }))
    await deleteNoteTree(store, 'child')

    await restoreNoteTree(store, 'child')

    expect(store.getNote('child')?.parentId).toBe('parent')
  })

  it('queues the restore for push and keeps the body', async () => {
    const store = await openLocalStore()
    const body = encodedInsert('itinerary')
    await store.putNote(note({ id: 'root' }))
    await store.putDocState('root', body)
    await deleteNoteTree(store, 'root')
    await store.removeOps((await store.listOps()).map((op) => op.id))

    await restoreNoteTree(store, 'root')

    expect((await store.listOps()).some((op) => op.noteId === 'root')).toBe(true)
    expect(await store.getDocState('root')).toBe(body)
  })

  it('does nothing for a page that is not deleted', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'alive', updatedAt: 7 }))
    await restoreNoteTree(store, 'alive')
    expect(store.getNote('alive')?.updatedAt).toBe(7)
  })

  it('uses a retention window long enough to outlast a device being away', () => {
    expect(TRASH_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('authoritative absence', () => {
  it('hard-deletes a previously synced stale cache with no local work', async () => {
    const store = await openLocalStore()
    await store.applyRemoteNote(note({ id: 'gone', title: 'old server copy' }))

    await reconcileAuthoritativeAbsence(store, new Map([['', new Set()]]))

    expect(store.getNote('gone')).toBeNull()
    expect(getSyncState().deletedElsewhere).toBeNull()
  })

  it('pauses a previously synced page that has queued local changes', async () => {
    const store = await openLocalStore()
    await store.applyRemoteNote(note({ id: 'changed', title: 'draft' }))
    await store.enqueueNote('changed')

    await reconcileAuthoritativeAbsence(store, new Map([['', new Set()]]))

    expect(store.getNote('changed')).not.toBeNull()
    expect(await store.countOps()).toBe(1)
    expect(getSyncState().deletedElsewhere).toEqual({ notes: 1, titles: ['draft'], ids: ['changed'] })
  })

  it('does not mistake a never-uploaded local page for a remote purge', async () => {
    const store = await openLocalStore()
    await store.putNote(note({ id: 'new-local', title: 'offline creation', remoteKnown: false }))
    await store.enqueueNote('new-local')

    await reconcileAuthoritativeAbsence(store, new Map([['', new Set()]]))

    expect(store.getNote('new-local')).not.toBeNull()
    expect(await store.countOps()).toBe(1)
    expect(getSyncState().deletedElsewhere).toBeNull()
  })

  it('keeps an unexpired local trash copy without re-uploading its tombstone', async () => {
    const store = await openLocalStore()
    await store.applyRemoteNote(note({ id: 'trashed', deletedAt: Date.now(), updatedAt: Date.now() }))
    await store.enqueueNote('trashed')

    await reconcileAuthoritativeAbsence(store, new Map([['', new Set()]]))

    expect(store.getNote('trashed')?.deletedAt).toBeGreaterThan(0)
    expect(store.getNote('trashed')?.remoteKnown).toBe(false)
    expect(await store.countOps()).toBe(0)
  })

  it('expires a server-purged trash copy locally without a connection', async () => {
    const store = await openLocalStore()
    const deletedAt = Date.now() - TRASH_RETENTION_MS - 1
    await store.putNote(note({ id: 'expired-local-copy', deletedAt, updatedAt: deletedAt, remoteKnown: false }))
    await store.putDocState('expired-local-copy', 'body')

    await purgeExpiredLocalCopies(store)

    expect(store.getNote('expired-local-copy')).toBeNull()
    expect(await store.getDocState('expired-local-copy')).toBeNull()
  })
})

describe('drainOutbox', () => {
  it('leaves blocked notes queued while draining unrelated work', async () => {
    const store = await openLocalStore()
    const blocked = note({ id: 'blocked', title: 'local edits' })
    const allowed = note({ id: 'allowed', title: 'send me' })
    await store.putNote(blocked)
    await store.putNote(allowed)
    await store.enqueueNote(blocked.id)
    await store.enqueueNote(allowed.id)
    const { client, calls } = fakeClient({ notes: null })

    await drainOutbox(client, store, new Set([blocked.id]))

    expect(calls.some((call) => call.values?.noteId === blocked.id)).toBe(false)
    expect(calls.some((call) => call.values?.noteId === allowed.id)).toBe(true)
    expect((await store.listOps()).map((op) => op.noteId)).toEqual([blocked.id])
  })

  it('merges content updates per note into one insert against the right scope', async () => {
    const store = await openLocalStore()
    await store.enqueueUpdate('n1', '', '', encodedInsert('hello'))
    await store.enqueueUpdate('n1', '', '', encodedInsert('world'))
    await store.enqueueUpdate('n2', 'share-1', 'room-1', encodedInsert('shared'))

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
    expect(sharedInsert.scope).toBe('share-1:room-1')
    expect(await store.countOps()).toBe(0)
  })

  it('routes shared metadata writes to the note room', async () => {
    const store = await openLocalStore()
    const shared = note({ id: 'room-note', shareId: 'share-1', roomId: 'room-1', updatedAt: 50 })
    await store.putNote(shared)
    await store.enqueueNote(shared.id)

    const { client, calls } = fakeClient({ member_notes: null })
    await drainOutbox(client, store)

    expect(calls.filter((call) => call.table === 'member_notes').every((call) => call.scope === 'share-1:room-1')).toBe(true)
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

  it('stops after a pass that dequeues nothing instead of spinning on it', async () => {
    const store = await openLocalStore()
    const typing = note({ title: 'being typed', updatedAt: 10 })
    await store.putNote(typing)
    await store.enqueueNote(typing.id)

    // Every push races an edit that re-stamps the op's revision, so the op can
    // never leave the outbox. The drain has to hand the work back to the next
    // flush rather than loop on it — one round trip, not one per keystroke.
    const stubborn = { ...store, removeNoteOpIfRev: async () => false }
    const { client, calls } = fakeClient({ notes: { noteId: typing.id } })
    await drainOutbox(client, stubborn)

    expect(calls.filter((call) => call.table === 'notes')).toHaveLength(2)
    expect(await store.countOps()).toBe(1)
  })

  // Regression: a 403 used to fall through to removeOps, so a stale cached role
  // silently destroyed the user's writing. The edit exists nowhere else — the
  // server has never seen it — so it has to survive a rejection.
  it('keeps a permanently rejected content update queued instead of discarding it', async () => {
    const store = await openLocalStore()
    await store.enqueueUpdate('n1', 'share-1', '', encodedInsert('precious'))

    const rejecting = {
      table: () => { throw new Error('private table not expected') },
      resource: () => ({
        table: () => {
          const query: Record<string, unknown> = {
            select: () => query, insert: () => query, eq: () => query,
            then: (_: unknown, reject: (error: unknown) => unknown) =>
              Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 })).catch(reject)
          }
          return query
        }
      })
    } as unknown as TallpondClient

    await drainOutbox(rejecting, store)

    expect(await store.countOps()).toBe(1)
    const [remaining] = await store.listOps()
    expect(remaining.kind).toBe('update')
  })

  it('still clears a content update the gateway accepts', async () => {
    const store = await openLocalStore()
    await store.enqueueUpdate('n1', 'share-1', '', encodedInsert('sent'))
    const { client } = fakeClient()
    await drainOutbox(client, store)
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
