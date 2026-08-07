// The single local database. Three stores, one authority each:
//   notes  — metadata mirror (title/parent/share/soft-delete), LWW by updatedAt
//   docs   — merged Yjs state per note body, rewritten as edits land
//   outbox — operations not yet accepted by the gateway
// Everything except the outbox and unsynced doc state is rebuildable from the
// server, and the app is fully usable if the outbox never drains.

export type Note = {
  id: string
  title: string
  // Empty string parents a note at the root of the tree.
  parentId: string
  // Empty string means private. Otherwise the shared_notes resource id this
  // note (and its subtree) belongs to.
  shareId: string
  // 0 means alive. Soft deletes are durable: they out-vote any older metadata
  // row a stale device may push later.
  deletedAt: number
  updatedAt: number
}

export type UpdateOp = { id: string; kind: 'update'; noteId: string; shareId: string; payload: string; createdAt: number }
// Note ops carry no data: the drain reads the current local row, so repeated
// edits coalesce into the one stable-keyed op. `rev` detects edits that land
// while a flush is in flight.
export type NoteOp = { id: string; kind: 'note'; noteId: string; rev: string; createdAt: number }
export type Op = UpdateOp | NoteOp

// A note's subtree is itself plus every note reachable through parentId.
// Deleting and sharing both operate on whole subtrees.
export function subtreeIds(notes: Note[], rootId: string) {
  const ids = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const note of notes) {
      if (!ids.has(note.id) && ids.has(note.parentId)) { ids.add(note.id); changed = true }
    }
  }
  return ids
}

// Why a move is allowed or not. Dropping a note inside its own subtree would
// detach that whole ring from the root, where nothing renders it and nothing
// can drag it back, so the check is a hard invariant rather than a UI nicety.
// Scope is checked here too: `shareId` belongs to a whole subtree, so a move
// across scopes is a join/leave, not a reparent.
export function moveBlockedBy(notes: Note[], noteId: string, parentId: string): 'none' | 'noop' | 'cycle' | 'scope' | 'missing' {
  const note = notes.find((candidate) => candidate.id === noteId)
  if (!note) return 'missing'
  const parent = parentId ? notes.find((candidate) => candidate.id === parentId) : null
  if (parentId && !parent) return 'missing'
  if (note.parentId === parentId) return 'noop'
  if ((parent?.shareId ?? '') !== note.shareId) return 'scope'
  if (parentId && subtreeIds(notes, noteId).has(parentId)) return 'cycle'
  return 'none'
}

const DATABASE_NAME = 'motion'

const asPromise = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error)
  transaction.onabort = () => reject(transaction.error ?? new Error('Local write was aborted.'))
})

export type LocalStore = Awaited<ReturnType<typeof openLocalStore>>

export async function openLocalStore() {
  const db = await asPromise<IDBDatabase>((() => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('notes', { keyPath: 'id' })
      request.result.createObjectStore('docs', { keyPath: 'noteId' })
      const outbox = request.result.createObjectStore('outbox', { keyPath: 'id' })
      outbox.createIndex('createdAt', 'createdAt')
      outbox.createIndex('noteId', 'noteId')
    }
    return request
  })())

  const cache = new Map<string, Note>()
  for (const note of await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)) {
    cache.set(note.id, note)
  }

  let snapshot: Note[] | null = null
  const listeners = new Set<() => void>()
  const emit = () => {
    snapshot = null
    for (const listener of listeners) listener()
  }

  const writeNote = async (note: Note) => {
    const transaction = db.transaction('notes', 'readwrite')
    transaction.objectStore('notes').put(note)
    await done(transaction)
    cache.set(note.id, note)
    emit()
  }

  const deleteDocState = async (noteId: string) => {
    const transaction = db.transaction('docs', 'readwrite')
    transaction.objectStore('docs').delete(noteId)
    await done(transaction)
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => {
      snapshot ??= [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      return snapshot
    },
    getNote: (id: string) => cache.get(id) ?? null,

    putNote: writeNote,

    // Remote rows apply last-write-wins, with two standing invariants:
    // a private row never overrides a note that has moved into a shared scope,
    // and a share row may claim a private note at an equal timestamp (sharing
    // re-homes the note without editing it).
    applyRemoteNote: async (remote: Note) => {
      const existing = cache.get(remote.id)
      if (existing) {
        if (existing.shareId && !remote.shareId) return false
        const claims = Boolean(remote.shareId) && !existing.shareId
        if (claims ? remote.updatedAt < existing.updatedAt : remote.updatedAt <= existing.updatedAt) return false
      }
      await writeNote(remote)
      if (remote.deletedAt) await deleteDocState(remote.id)
      return true
    },

    getDocState: async (noteId: string) => {
      const row = await asPromise(db.transaction('docs').objectStore('docs').get(noteId) as IDBRequest<{ noteId: string; state: string } | undefined>)
      return row?.state ?? null
    },
    // Every locally-held body, used to seed the backlink index. Only notes
    // this device has opened have a row here, so the index is complete for the
    // working set, not necessarily for pages that only live on other devices.
    allDocStates: async () => asPromise(db.transaction('docs').objectStore('docs').getAll() as IDBRequest<Array<{ noteId: string; state: string }>>),
    putDocState: async (noteId: string, state: string) => {
      const transaction = db.transaction('docs', 'readwrite')
      transaction.objectStore('docs').put({ noteId, state })
      await done(transaction)
    },
    deleteDocState,

    enqueueUpdate: async (noteId: string, shareId: string, payload: string) => {
      const transaction = db.transaction('outbox', 'readwrite')
      transaction.objectStore('outbox').put({ id: crypto.randomUUID(), kind: 'update', noteId, shareId, payload, createdAt: Date.now() } satisfies UpdateOp)
      await done(transaction)
    },
    enqueueNote: async (noteId: string) => {
      const transaction = db.transaction('outbox', 'readwrite')
      transaction.objectStore('outbox').put({ id: `note:${noteId}`, kind: 'note', noteId, rev: crypto.randomUUID(), createdAt: Date.now() } satisfies NoteOp)
      await done(transaction)
    },
    listOps: async () => {
      const transaction = db.transaction('outbox')
      return asPromise(transaction.objectStore('outbox').index('createdAt').getAll() as IDBRequest<Op[]>)
    },
    countOps: async () => asPromise(db.transaction('outbox').objectStore('outbox').count()),
    removeOps: async (ids: string[]) => {
      if (!ids.length) return
      const transaction = db.transaction('outbox', 'readwrite')
      for (const id of ids) transaction.objectStore('outbox').delete(id)
      await done(transaction)
    },
    // A note op only leaves the outbox if no edit bumped its revision while
    // the flush that pushed it was in flight. Reports whether it left, so the
    // drain can tell a completed push from one that has to be repeated.
    removeNoteOpIfRev: async (op: NoteOp) => {
      const transaction = db.transaction('outbox', 'readwrite')
      const store = transaction.objectStore('outbox')
      const request = store.get(op.id)
      let removed = false
      request.onsuccess = () => {
        const current = request.result as NoteOp | undefined
        if (current?.rev === op.rev) { store.delete(op.id); removed = true }
      }
      await done(transaction)
      return removed
    },

    // Leaving a shared resource removes its notes outright — membership ended,
    // so there is nothing to tombstone and nothing left to sync.
    removeShare: async (shareId: string) => {
      const removed = [...cache.values()].filter((note) => note.shareId === shareId)
      if (!removed.length) return
      const transaction = db.transaction(['notes', 'docs', 'outbox'], 'readwrite')
      const outbox = transaction.objectStore('outbox')
      for (const note of removed) {
        transaction.objectStore('notes').delete(note.id)
        transaction.objectStore('docs').delete(note.id)
        const keys = outbox.index('noteId').getAllKeys(note.id)
        keys.onsuccess = () => { for (const key of keys.result) outbox.delete(key) }
      }
      await done(transaction)
      for (const note of removed) cache.delete(note.id)
      emit()
    },

    close: () => db.close()
  }
}
