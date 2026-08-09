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

// One database per identity. The unscoped name is the anonymous staging area:
// work typed before signing in lands here, and it is also where every database
// written before scoping existed still lives, so an upgrading user and a
// brand-new one present the identical "adopt this?" question on first sign-in.
// A signed-in scope is the user id, and nothing is ever read across scopes —
// that is the whole point: a second user on this browser starts empty.
export const ANON_SCOPE = 'anon'
const databaseName = (scope: string) => scope === ANON_SCOPE ? 'motion' : `motion:${scope}`

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

const createStores = (db: IDBDatabase) => {
  db.createObjectStore('notes', { keyPath: 'id' })
  db.createObjectStore('docs', { keyPath: 'noteId' })
  const outbox = db.createObjectStore('outbox', { keyPath: 'id' })
  outbox.createIndex('createdAt', 'createdAt')
  outbox.createIndex('noteId', 'noteId')
}

export async function openLocalStore(scope: string = ANON_SCOPE) {
  const db = await asPromise<IDBDatabase>((() => {
    const request = indexedDB.open(databaseName(scope), 1)
    request.onupgradeneeded = () => createStores(request.result)
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
    scope,
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
    //
    // A tombstone arriving here does NOT drop the body. It used to, which meant
    // a delete on one device destroyed the page's contents on every other one,
    // and there was no way back: a soft delete is reversible in the metadata
    // and was irreversible in fact. Bodies are dropped only by a purge or by
    // losing access to a share — the two places data really does go away.
    applyRemoteNote: async (remote: Note) => {
      const existing = cache.get(remote.id)
      if (existing) {
        if (existing.shareId && !remote.shareId) return false
        const claims = Boolean(remote.shareId) && !existing.shareId
        if (claims ? remote.updatedAt < existing.updatedAt : remote.updatedAt <= existing.updatedAt) return false
      }
      await writeNote(remote)
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

    // The hard delete, used only by the purge at the end of the retention
    // window. Everything about a note goes: the row, the body, and any op still
    // queued for it — an op outliving the note would push a row the purge just
    // removed and resurrect it.
    removeNote: async (noteId: string) => {
      const transaction = db.transaction(['notes', 'docs', 'outbox'], 'readwrite')
      transaction.objectStore('notes').delete(noteId)
      transaction.objectStore('docs').delete(noteId)
      const outbox = transaction.objectStore('outbox')
      const keys = outbox.index('noteId').getAllKeys(noteId)
      keys.onsuccess = () => { for (const key of keys.result) outbox.delete(key) }
      await done(transaction)
      cache.delete(noteId)
      emit()
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

// ---------------------------------------------------------------------------
// Adoption: moving a scope's contents into another scope. Used once, when a
// user signs in and the anonymous scope turns out to hold work.
// ---------------------------------------------------------------------------

type DocRow = { noteId: string; state: string }

// Opens a scope only if it already exists. `indexedDB.open` always creates, so
// a probe that finds nothing has to delete the empty database it just made —
// otherwise merely asking the question would leave a scope behind and the next
// probe would answer itself. `indexedDB.databases()` would be tidier but is not
// available everywhere this app runs.
async function openIfExists(scope: string) {
  let created = false
  const request = indexedDB.open(databaseName(scope), 1)
  request.onupgradeneeded = () => { created = true; createStores(request.result) }
  const db = await asPromise<IDBDatabase>(request)
  if (!created) return db
  db.close()
  await dropScope(scope)
  return null
}

// How many titles the prompt lists before it summarises the rest. Enough to
// recognise the work, few enough that the dialog stays a dialog.
export const SURVEY_TITLE_LIMIT = 8

export type ScopeSurvey = {
  notes: number
  // Deleted pages are counted but never listed. They are carried across so the
  // tombstones reach the server, and naming them would invite the user to
  // decide about pages they already threw away.
  deleted: number
  pending: number
  // Most recently touched first — the pages the user is most likely to be
  // thinking of when the question appears.
  titles: string[]
}

// What is sitting in a scope, in the terms the prompt has to use: pages the
// user would recognise, and whether any of it is still waiting to be pushed.
export async function surveyScope(scope: string): Promise<ScopeSurvey> {
  const db = await openIfExists(scope)
  if (!db) return { notes: 0, deleted: 0, pending: 0, titles: [] }
  try {
    const all = await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)
    const pending = await asPromise(db.transaction('outbox').objectStore('outbox').count())
    const live = all.filter((note) => !note.deletedAt)
    return {
      notes: live.length,
      deleted: all.length - live.length,
      pending,
      titles: [...live]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, SURVEY_TITLE_LIMIT)
        .map((note) => note.title.trim() || 'Untitled')
    }
  } finally { db.close() }
}

// Resolves on `blocked` as well as success. A delete blocked by a connection
// this tab no longer controls must not hang the sign-in it is part of — the
// data has already been copied out by then, so a source that outlives the drop
// costs a redundant prompt, never a loss.
export function dropScope(scope: string) {
  return new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName(scope))
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

// Copies one scope into an open store, then drops the source.
//
// The outbox is deliberately NOT copied. It is rebuilt from the adopted rows
// instead: ops in the source were addressed to whoever owned that scope, and
// for an upgrading user most of them had already drained, so replaying them
// would push the wrong history. Re-enqueueing from state pushes exactly what
// the adopted notes now are — the extra traffic is one-time, and both the
// metadata update (last-write-wins) and the CRDT payload (Yjs deduplicates)
// are idempotent, so a re-push of already-known rows is a no-op server-side.
//
// Safe to re-run: it is a merge, and the source is only dropped once every row
// has landed, so a crash halfway through leaves the source intact for a retry.
export async function adoptScope(
  fromScope: string,
  target: LocalStore,
  mergeDocStates: (states: string[]) => string
) {
  const db = await openIfExists(fromScope)
  if (!db) return { notes: 0 }
  let adopted = 0
  try {
    const notes = await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)
    const docs = await asPromise(db.transaction('docs').objectStore('docs').getAll() as IDBRequest<DocRow[]>)

    // Notes first, so a doc merged below always has a row to belong to. The
    // remote path is reused verbatim: it already resolves last-write-wins and
    // refuses to let a private row displace a note that has moved into a share.
    for (const note of notes) {
      if (await target.applyRemoteNote(note)) adopted += 1
    }

    // Bodies merge rather than overwrite. The target may already hold server
    // state for the same note — an upgrading user signing in on a device that
    // has since pulled the note down — and picking one side would discard the
    // other's edits. Yjs merges both without a conflict.
    for (const doc of docs) {
      if (!doc.state) continue
      const existing = await target.getDocState(doc.noteId)
      await target.putDocState(doc.noteId, existing ? mergeDocStates([existing, doc.state]) : doc.state)
    }

    // Tombstones are pushed too. Skipping them was a real bug: a delete that
    // had not yet drained would be adopted locally and never told to the
    // server, so the page stayed gone here and came back on the next device to
    // sync. A soft delete is durable state, not the absence of state.
    // Bodies are pushed for deleted notes too. They are kept now rather than
    // destroyed on delete, and a body that only ever existed in this scope is
    // the one copy there is — leaving it unpushed would mean the page could be
    // restored on this device and nowhere else.
    for (const note of notes) {
      const current = target.getNote(note.id)
      if (!current) continue
      await target.enqueueNote(note.id)
      const state = await target.getDocState(note.id)
      if (state) await target.enqueueUpdate(note.id, current.shareId, state)
    }
  } finally { db.close() }
  await dropScope(fromScope)
  return { notes: adopted }
}
