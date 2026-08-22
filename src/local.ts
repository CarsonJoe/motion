// The single local database. Four stores, one authority each:
//   notes  — metadata mirror (title/parent/share/room/soft-delete), LWW by updatedAt
//   docs   — merged Yjs state per note body, rewritten as edits land
//   assets — local image blobs and their last uploaded placement
//   outbox — operations not yet accepted by the gateway
// Everything except the outbox and unsynced doc state is rebuildable from the
// server, and the app is fully usable if the outbox never drains.

export type Note = {
  id: string
  title: string
  // Durable author identity for creator-only onboarding. Undefined identifies
  // rows created before this metadata existed.
  creatorId?: string
  // Empty string parents a note at the root of the tree.
  parentId: string
  // Empty string means private. Otherwise the shared_notes resource id this
  // note belongs to.
  shareId: string
  // Empty string is the resource's default room (and is always used for private
  // notes). A nonempty id narrows this note to a per-note access scope.
  roomId: string
  // 0 means alive. Soft deletes are durable: they out-vote any older metadata
  // row a stale device may push later.
  deletedAt: number
  updatedAt: number
  // Local provenance only; never sent to Tallpond. Undefined is treated as
  // unknown for databases created before absence reconciliation existed.
  remoteKnown?: boolean
  // Per-user placement for a workspace root. Undefined means use canonical
  // placement; an empty string explicitly mounts it at this user's top level.
  localParentId?: string
}

export type LocalAsset = {
  path: string
  noteId: string
  blob: Blob
  contentType: string
  sizeBytes: number
  // `private`, `resource:<id>:default`, or `resource:<id>:<room>`.
  placement?: string
  ownerId?: string
  // Downloaded for offline display rather than authored on this device.
  cacheOnly?: boolean
}

export type UpdateOp = { id: string; kind: 'update'; noteId: string; shareId: string; roomId: string; payload: string; createdAt: number }
// Note ops carry no data: the drain reads the current local row, so repeated
// edits coalesce into the one stable-keyed op. `rev` detects edits that land
// while a flush is in flight.
export type NoteOp = { id: string; kind: 'note'; noteId: string; rev: string; createdAt: number }
export type Op = UpdateOp | NoteOp

// A note's subtree is itself plus every note reachable through parentId.
// Deleting and sharing both operate on whole subtrees.
// The canonical parent can be outside the viewer's accessible working set. In
// that case the first visible descendant is projected as a sidebar root; its
// stored parentId is untouched, so gaining access later fills the gap without
// reorganizing anything.
export function visibleParentId(note: Note, notes: readonly Note[]) {
  const parentId = note.localParentId ?? note.parentId
  return parentId && notes.some((candidate) => candidate.id === parentId && !candidate.deletedAt)
    ? parentId
    : ''
}

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
// Scope is checked here too: moving within one resource/room is canonical for
// every collaborator. Crossing either boundary is an access migration rather
// than an ordinary reparent.
export function workspaceMountBlockedBy(notes: Note[], noteId: string, parentId: string): 'none' | 'noop' | 'cycle' | 'scope' | 'missing' {
  const note = notes.find((candidate) => candidate.id === noteId)
  if (!note) return 'missing'
  const canonicalParent = note.parentId ? notes.find((candidate) => candidate.id === note.parentId) : null
  // Only the top boundary of a resource is personally placeable. Content
  // inside it retains one canonical structure for every collaborator.
  if (!note.shareId || canonicalParent?.shareId === note.shareId) return 'scope'
  const parent = parentId ? notes.find((candidate) => candidate.id === parentId) : null
  if (parentId && !parent) return 'missing'
  if (parent?.shareId) return 'scope'
  if ((note.localParentId ?? visibleParentId(note, notes)) === parentId) return 'noop'
  // A private child may canonically hang beneath the workspace root. Mounting
  // the root beneath that child would create a cycle in this user's projection.
  if (parentId && subtreeIds(notes, noteId).has(parentId)) return 'cycle'
  return 'none'
}

export function moveBlockedBy(notes: Note[], noteId: string, parentId: string): 'none' | 'noop' | 'cycle' | 'scope' | 'missing' {
  const note = notes.find((candidate) => candidate.id === noteId)
  if (!note) return 'missing'
  const parent = parentId ? notes.find((candidate) => candidate.id === parentId) : null
  if (parentId && !parent) return 'missing'
  if (note.parentId === parentId) return 'noop'
  if ((parent?.shareId ?? '') !== note.shareId || (parent?.roomId ?? '') !== note.roomId) return 'scope'
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
  if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' })
  if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'noteId' })
  if (!db.objectStoreNames.contains('assets')) {
    const assets = db.createObjectStore('assets', { keyPath: 'path' })
    assets.createIndex('noteId', 'noteId')
  }
  if (!db.objectStoreNames.contains('outbox')) {
    const outbox = db.createObjectStore('outbox', { keyPath: 'id' })
    outbox.createIndex('createdAt', 'createdAt')
    outbox.createIndex('noteId', 'noteId')
  }
}

export async function openLocalStore(scope: string = ANON_SCOPE) {
  const db = await asPromise<IDBDatabase>((() => {
    const request = indexedDB.open(databaseName(scope), 2)
    request.onupgradeneeded = () => createStores(request.result)
    return request
  })())

  const cache = new Map<string, Note>()
  for (const note of await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)) {
    // Databases written before room support have no roomId. Normalizing at the
    // boundary keeps their existing shared rows in Tallpond's default room.
    cache.set(note.id, { ...note, roomId: note.roomId ?? '' })
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
    // and a share row always claims a private copy. Promotion is one-way —
    // there is no unshare operation — and older clients retired the private
    // row with a newer timestamp than the shared copy. Requiring timestamp
    // order here made those pages look private/deleted on every new device.
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
        // Room placement is platform-managed rather than part of the client's
        // LWW metadata revision. A move therefore has to win even when title
        // and parent timestamps are unchanged.
        const changesRoom = Boolean(remote.shareId) && remote.shareId === existing.shareId && remote.roomId !== existing.roomId
        if (!claims && !changesRoom && remote.updatedAt <= existing.updatedAt) {
          // Even an older row proves this id exists remotely. Preserve the
          // newer local value while recording that provenance for a later
          // authoritative-absence check.
          if (!existing.remoteKnown) await writeNote({ ...existing, remoteKnown: true })
          return false
        }
      }
      await writeNote({ ...remote, ...(existing?.localParentId !== undefined ? { localParentId: existing.localParentId } : {}), remoteKnown: true })
      return true
    },

    setLocalParent: async (noteId: string, parentId: string | undefined) => {
      const note = cache.get(noteId)
      if (note) await writeNote({ ...note, localParentId: parentId })
    },

    markRemoteKnown: async (noteId: string, known = true) => {
      const note = cache.get(noteId)
      if (note && note.remoteKnown !== known) await writeNote({ ...note, remoteKnown: known })
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

    getAsset: async (path: string) => asPromise(db.transaction('assets').objectStore('assets').get(path) as IDBRequest<LocalAsset | undefined>),
    allAssets: async () => asPromise(db.transaction('assets').objectStore('assets').getAll() as IDBRequest<LocalAsset[]>),
    putAsset: async (asset: LocalAsset) => {
      const transaction = db.transaction('assets', 'readwrite')
      transaction.objectStore('assets').put(asset)
      await done(transaction)
    },
    removeAsset: async (path: string) => {
      const transaction = db.transaction('assets', 'readwrite')
      transaction.objectStore('assets').delete(path)
      await done(transaction)
    },

    enqueueUpdate: async (noteId: string, shareId: string, roomId: string, payload: string) => {
      const transaction = db.transaction('outbox', 'readwrite')
      transaction.objectStore('outbox').put({ id: crypto.randomUUID(), kind: 'update', noteId, shareId, roomId, payload, createdAt: Date.now() } satisfies UpdateOp)
      await done(transaction)
    },
    enqueueNote: async (noteId: string) => {
      const transaction = db.transaction('outbox', 'readwrite')
      transaction.objectStore('outbox').put({ id: `note:${noteId}`, kind: 'note', noteId, rev: crypto.randomUUID(), createdAt: Date.now() } satisfies NoteOp)
      await done(transaction)
    },
    listOps: async () => {
      const transaction = db.transaction('outbox')
      const ops = await asPromise(transaction.objectStore('outbox').index('createdAt').getAll() as IDBRequest<Op[]>)
      // As with notes, queued updates from pre-room databases target the default
      // room. Normalize without rewriting so merely opening offline stays cheap.
      return ops.map((op) => op.kind === 'update' ? { ...op, roomId: op.roomId ?? '' } : op)
    },
    countOps: async () => asPromise(db.transaction('outbox').objectStore('outbox').count()),
    removeOps: async (ids: string[]) => {
      if (!ids.length) return
      const transaction = db.transaction('outbox', 'readwrite')
      for (const id of ids) transaction.objectStore('outbox').delete(id)
      await done(transaction)
    },
    removeOpsForNote: async (noteId: string) => {
      const transaction = db.transaction('outbox', 'readwrite')
      const store = transaction.objectStore('outbox')
      const keys = store.index('noteId').getAllKeys(noteId)
      keys.onsuccess = () => { for (const key of keys.result) store.delete(key) }
      await done(transaction)
    },
    // Room placement is local routing state as well as remote access state.
    // Rewrite notes and queued body updates in one transaction so a restart can
    // never send an old-room operation after remembering the new placement.
    moveNotesToRoom: async (noteIds: ReadonlySet<string>, roomId: string) => {
      if (!noteIds.size) return
      const transaction = db.transaction(['notes', 'outbox'], 'readwrite')
      const notes = transaction.objectStore('notes')
      const outbox = transaction.objectStore('outbox')
      for (const id of noteIds) {
        const note = cache.get(id)
        if (note) notes.put({ ...note, roomId })
      }
      const queued = outbox.getAll()
      queued.onsuccess = () => {
        for (const op of queued.result as Op[]) {
          if (op.kind === 'update' && noteIds.has(op.noteId)) outbox.put({ ...op, roomId })
        }
      }
      await done(transaction)
      for (const id of noteIds) {
        const note = cache.get(id)
        if (note) cache.set(id, { ...note, roomId })
      }
      emit()
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
      const transaction = db.transaction(['notes', 'docs', 'assets', 'outbox'], 'readwrite')
      transaction.objectStore('notes').delete(noteId)
      transaction.objectStore('docs').delete(noteId)
      const assets = transaction.objectStore('assets')
      const assetKeys = assets.index('noteId').getAllKeys(noteId)
      assetKeys.onsuccess = () => { for (const key of assetKeys.result) assets.delete(key) }
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
      const transaction = db.transaction(['notes', 'docs', 'assets', 'outbox'], 'readwrite')
      const assets = transaction.objectStore('assets')
      const outbox = transaction.objectStore('outbox')
      for (const note of removed) {
        transaction.objectStore('notes').delete(note.id)
        transaction.objectStore('docs').delete(note.id)
        const assetKeys = assets.index('noteId').getAllKeys(note.id)
        assetKeys.onsuccess = () => { for (const key of assetKeys.result) assets.delete(key) }
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
  const request = indexedDB.open(databaseName(scope), 2)
  request.onupgradeneeded = (event) => { created = event.oldVersion === 0; createStores(request.result) }
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
// Remove a chosen set while preserving the pages that remain. Children whose
// parent leaves become roots so a partial decision can never make them vanish
// from the next review.
const removeScopeNotes = async (db: IDBDatabase, allNotes: Note[], selected: ReadonlySet<string>) => {
  const transaction = db.transaction(['notes', 'docs', 'assets', 'outbox'], 'readwrite')
  const sourceNotes = transaction.objectStore('notes')
  const sourceDocs = transaction.objectStore('docs')
  const sourceAssets = transaction.objectStore('assets')
  const sourceOutbox = transaction.objectStore('outbox')
  for (const note of allNotes) {
    if (selected.has(note.id)) {
      sourceNotes.delete(note.id)
      sourceDocs.delete(note.id)
      const assetKeys = sourceAssets.index('noteId').getAllKeys(note.id)
      assetKeys.onsuccess = () => { for (const key of assetKeys.result) sourceAssets.delete(key) }
    } else if (selected.has(note.parentId)) sourceNotes.put({ ...note, parentId: '' })
  }
  const queued = sourceOutbox.getAll()
  queued.onsuccess = () => {
    for (const op of queued.result as Op[]) if (selected.has(op.noteId)) sourceOutbox.delete(op.id)
  }
  await done(transaction)
}

export async function discardScopeNotes(scope: string, selectedIds: ReadonlySet<string>) {
  const db = await openIfExists(scope)
  if (!db) return { notes: 0, deleted: 0, pending: 0, titles: [] } satisfies ScopeSurvey
  let empty = false
  try {
    const allNotes = await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)
    const existingIds = new Set(allNotes.map((note) => note.id))
    const selected = new Set([...selectedIds].filter((id) => existingIds.has(id)))
    if (selected.size) await removeScopeNotes(db, allNotes, selected)
    empty = selected.size === allNotes.length
  } finally { db.close() }
  if (empty) await dropScope(scope)
  return surveyScope(scope)
}

// Safe to re-run: it is a merge, and the source is only dropped once every row
// has landed, so a crash halfway through leaves the source intact for a retry.
export async function adoptScope(
  fromScope: string,
  target: LocalStore,
  mergeDocStates: (states: string[]) => string,
  selectedIds?: ReadonlySet<string>
) {
  const db = await openIfExists(fromScope)
  if (!db) return { notes: 0 }
  let adopted = 0
  let sourceIsEmpty = true
  try {
    const allNotes = await asPromise(db.transaction('notes').objectStore('notes').getAll() as IDBRequest<Note[]>)
    const existingIds = new Set(allNotes.map((note) => note.id))
    const selected = selectedIds ? new Set([...selectedIds].filter((id) => existingIds.has(id))) : null
    const notes = selected ? allNotes.filter((note) => selected.has(note.id)) : allNotes
    const docs = (await asPromise(db.transaction('docs').objectStore('docs').getAll() as IDBRequest<DocRow[]>))
      .filter((doc) => !selected || selected.has(doc.noteId))
    const assets = (await asPromise(db.transaction('assets').objectStore('assets').getAll() as IDBRequest<LocalAsset[]>))
      .filter((asset) => !selected || selected.has(asset.noteId))
    sourceIsEmpty = !selected || selected.size === allNotes.length

    // Notes first, so a doc merged below always has a row to belong to. A page
    // selected without its parent becomes a root in the destination; otherwise
    // it would point at a row that intentionally stayed in the source scope.
    for (const sourceNote of notes) {
      const note = selected && sourceNote.parentId && !selected.has(sourceNote.parentId)
        ? { ...sourceNote, parentId: '' }
        : sourceNote
      if (await target.applyRemoteNote(note)) {
        adopted += 1
        // The source is another local scope, not proof of a server row. Newer
        // clients stamp false at creation; legacy anonymous rows are treated
        // the same way when adopted.
        await target.markRemoteKnown(note.id, note.remoteKnown ?? false)
      }
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
    for (const asset of assets) await target.putAsset({ ...asset, placement: undefined, ownerId: undefined })

    // Tombstones are pushed too. Skipping them was a real bug: a delete that
    // had not yet drained stayed local and came back on the next device.
    for (const note of notes) {
      const current = target.getNote(note.id)
      if (!current) continue
      await target.enqueueNote(note.id)
      const state = await target.getDocState(note.id)
      if (state) await target.enqueueUpdate(note.id, current.shareId, current.roomId, state)
    }

    // A selective merge consumes only the chosen rows. Keep everything else in
    // the anonymous scope for the next decision, promoting children whose
    // selected parent just left so they remain visible and independently safe.
    if (selected?.size) await removeScopeNotes(db, allNotes, selected)
  } finally { db.close() }
  if (sourceIsEmpty) await dropScope(fromScope)
  return { notes: adopted }
}
