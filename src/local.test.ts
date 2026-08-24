import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { adoptScope, ANON_SCOPE, discardScopeNotes, moveBlockedBy, openLocalStore, subtreeIds, surveyScope, SURVEY_TITLE_LIMIT, visibleParentId, workspaceMountBlockedBy, type Note, type NoteOp } from './local'

const note = (patch: Partial<Note>): Note => ({
  id: crypto.randomUUID(), title: '', parentId: '', shareId: '', roomId: '', deletedAt: 0, updatedAt: 0, ...patch
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('remote metadata apply', () => {
  it('is last-write-wins by client timestamp', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.putNote(note({ id, title: 'local', updatedAt: 20 }))
    expect(await store.applyRemoteNote(note({ id, title: 'older', updatedAt: 10 }))).toBe(false)
    expect(store.getNote(id)?.title).toBe('local')
    expect(await store.applyRemoteNote(note({ id, title: 'newer', updatedAt: 30 }))).toBe(true)
    expect(store.getNote(id)?.title).toBe('newer')
  })

  it('never lets an older row resurrect a soft-deleted note', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.applyRemoteNote(note({ id, title: 'alive', updatedAt: 10 }))
    await store.applyRemoteNote(note({ id, deletedAt: 20, updatedAt: 20 }))
    expect(await store.applyRemoteNote(note({ id, title: 'stale republish', updatedAt: 15 }))).toBe(false)
    expect(store.getNote(id)?.deletedAt).toBe(20)
  })

  it('accepts authoritative room placement without requiring a metadata edit', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    await store.applyRemoteNote(note({ id, shareId, roomId: '', updatedAt: 10 }))

    expect(await store.applyRemoteNote(note({ id, shareId, roomId: 'room-1', updatedAt: 10 }))).toBe(true)
    expect(store.getNote(id)?.roomId).toBe('room-1')
  })

  it('never lets a private row replace a note that moved into a shared scope', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    await store.applyRemoteNote(note({ id, title: 'private', updatedAt: 10 }))
    // Sharing re-homes a note without editing it. Older clients stamped the
    // private retirement later than the shared copy, so scope — not timestamp —
    // must decide which one wins on a fresh device.
    await store.applyRemoteNote(note({ id, title: 'private retirement', deletedAt: 30, updatedAt: 30 }))
    expect(await store.applyRemoteNote(note({ id, title: 'shared', shareId, updatedAt: 10 }))).toBe(true)
    expect(await store.applyRemoteNote(note({ id, title: 'late private row', updatedAt: 30 }))).toBe(false)
    const current = store.getNote(id)
    expect(current?.shareId).toBe(shareId)
    expect(current?.title).toBe('shared')
  })

  // This asserted the opposite until 2026-08-08. Dropping the body on a remote
  // tombstone meant a delete on one device destroyed the page's contents on
  // every other one, so `deletedAt` was reversible in the metadata and
  // irreversible in fact — a restore would return a title and a blank page.
  it('keeps the cached document body when a note is deleted remotely', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.putDocState(id, 'state')
    await store.applyRemoteNote(note({ id, deletedAt: 5, updatedAt: 5 }))
    expect(await store.getDocState(id)).toBe('state')
  })

  it('keeps the body through a delete and a later restore', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.putDocState(id, 'state')
    await store.applyRemoteNote(note({ id, title: 'Recipe', deletedAt: 5, updatedAt: 5 }))
    // A restore is an ordinary later write: nothing special-cases it, it just
    // out-votes the tombstone on timestamp.
    expect(await store.applyRemoteNote(note({ id, title: 'Recipe', updatedAt: 9 }))).toBe(true)
    expect(store.getNote(id)?.deletedAt).toBe(0)
    expect(await store.getDocState(id)).toBe('state')
  })
})

describe('outbox', () => {
  it('coalesces metadata ops per note and keeps ops revised mid-flight', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.enqueueNote(id)
    const [first] = await store.listOps() as NoteOp[]
    await store.enqueueNote(id)
    expect(await store.countOps()).toBe(1)

    // The first flush raced a new edit: its op must survive the removal.
    await store.removeNoteOpIfRev(first)
    expect(await store.countOps()).toBe(1)
    const [second] = await store.listOps() as NoteOp[]
    await store.removeNoteOpIfRev(second)
    expect(await store.countOps()).toBe(0)
  })

  it('orders ops by creation and removes by id', async () => {
    const store = await openLocalStore()
    await store.enqueueUpdate('n1', '', '', 'a')
    await store.enqueueUpdate('n2', 's', 'room-1', 'b')
    const ops = await store.listOps()
    expect(ops).toHaveLength(2)
    expect(ops.find((op) => op.noteId === 'n2')).toMatchObject({ shareId: 's', roomId: 'room-1' })
    await store.removeOps(ops.map((op) => op.id))
    expect(await store.countOps()).toBe(0)
  })
})

describe('room placement', () => {
  it('moves notes and their queued body updates together', async () => {
    const store = await openLocalStore()
    const first = note({ id: 'first', shareId: 'share-1' })
    const second = note({ id: 'second', shareId: 'share-1' })
    await store.putNote(first)
    await store.putNote(second)
    await store.enqueueNote(first.id)
    await store.enqueueUpdate(first.id, first.shareId, '', 'body')
    await store.enqueueUpdate(second.id, second.shareId, '', 'other')

    await store.moveNotesToRoom(new Set([first.id]), 'room-1')

    expect(store.getNote(first.id)?.roomId).toBe('room-1')
    expect(store.getNote(second.id)?.roomId).toBe('')
    const ops = await store.listOps()
    expect(ops.find((op) => op.kind === 'update' && op.noteId === first.id)).toMatchObject({ roomId: 'room-1' })
    expect(ops.find((op) => op.kind === 'update' && op.noteId === second.id)).toMatchObject({ roomId: '' })
  })
})

describe('leaving a share', () => {
  it('removes the share notes, their bodies, and their pending ops', async () => {
    const store = await openLocalStore()
    const shareId = crypto.randomUUID()
    const shared = note({ shareId, updatedAt: 1 })
    const kept = note({ updatedAt: 1 })
    await store.putNote(shared)
    await store.putNote(kept)
    await store.putDocState(shared.id, 'body')
    await store.enqueueUpdate(shared.id, shareId, '', 'x')
    await store.enqueueNote(shared.id)
    await store.enqueueNote(kept.id)

    await store.removeShare(shareId)
    expect(store.getNote(shared.id)).toBeNull()
    expect(store.getNote(kept.id)).not.toBeNull()
    expect(await store.getDocState(shared.id)).toBeNull()
    const ops = await store.listOps()
    expect(ops).toHaveLength(1)
    expect(ops[0].noteId).toBe(kept.id)
  })
})

describe('sharing race', () => {
  it('ignores the private soft-delete that sharing leaves behind', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    await store.putNote(note({ id, title: 'page', updatedAt: 10 }))
    await store.putDocState(id, 'body')

    // shareNoteTree re-homes locally first, then retires the private row.
    await store.putNote({ ...note({ id, title: 'page', updatedAt: 10 }), shareId })
    const retiredAt = Date.now()
    const applied = await store.applyRemoteNote(note({ id, deletedAt: retiredAt, updatedAt: retiredAt }))

    expect(applied).toBe(false)
    expect(store.getNote(id)?.deletedAt).toBe(0)
    expect(store.getNote(id)?.shareId).toBe(shareId)
    // The body must survive: it is the same note, only in a new scope.
    expect(await store.getDocState(id)).toBe('body')
  })
})

describe('losing access to a share', () => {
  it('removes every trace of a share the user is no longer a member of', async () => {
    const store = await openLocalStore()
    const goneShare = crypto.randomUUID()
    const keptShare = crypto.randomUUID()
    const orphan = note({ shareId: goneShare, title: 'deleted elsewhere', updatedAt: 1 })
    const kept = note({ shareId: keptShare, updatedAt: 1 })
    const privateNote = note({ updatedAt: 1 })
    for (const value of [orphan, kept, privateNote]) await store.putNote(value)
    await store.putDocState(orphan.id, 'body')
    await store.enqueueNote(orphan.id)

    // What fullSync does when the resource stops appearing in the list.
    await store.removeShare(goneShare)

    expect(store.getNote(orphan.id)).toBeNull()
    expect(await store.getDocState(orphan.id)).toBeNull()
    expect((await store.listOps()).some((op) => op.noteId === orphan.id)).toBe(false)
    expect(store.getNote(kept.id)).not.toBeNull()
    expect(store.getNote(privateNote.id)).not.toBeNull()
  })
})

describe('visible hierarchy', () => {
  it('projects a note with an inaccessible parent as a root without changing its canonical parent', () => {
    const child = note({ id: 'child', parentId: 'hidden-parent', shareId: 'resource' })
    expect(visibleParentId(child, [child])).toBe('')
    expect(child.parentId).toBe('hidden-parent')
  })

  it('uses a personal mount without changing the canonical parent', () => {
    const privateFolder = note({ id: 'mine' })
    const root = note({ id: 'shared', parentId: 'canonical', shareId: 'resource', localParentId: privateFolder.id })
    expect(visibleParentId(root, [privateFolder, root])).toBe(privateFolder.id)
    expect(root.parentId).toBe('canonical')
  })

  it('restores the canonical edge when the parent becomes visible', () => {
    const parent = note({ id: 'parent', shareId: 'resource' })
    const child = note({ id: 'child', parentId: parent.id, shareId: 'resource' })
    expect(visibleParentId(child, [parent, child])).toBe(parent.id)
  })
})

describe('subtreeIds', () => {
  it('collects a root and every transitive child', () => {
    const a = note({ id: 'a' })
    const b = note({ id: 'b', parentId: 'a' })
    const c = note({ id: 'c', parentId: 'b' })
    const other = note({ id: 'x' })
    expect([...subtreeIds([a, b, c, other], 'a')].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('workspace root mounts', () => {
  const localFolder = note({ id: 'local' })
  const root = note({ id: 'root', parentId: 'hidden', shareId: 'resource' })
  const sharedChild = note({ id: 'shared-child', parentId: root.id, shareId: root.shareId })
  const privateChild = note({ id: 'private-child', parentId: root.id })
  const notes = [localFolder, root, sharedChild, privateChild]

  it('allows a workspace root beneath a private page or at top level', () => {
    expect(workspaceMountBlockedBy(notes, root.id, localFolder.id)).toBe('none')
    expect(workspaceMountBlockedBy(notes, root.id, '')).toBe('noop')
  })

  it('rejects shared targets, inner workspace pages, and projected cycles', () => {
    expect(workspaceMountBlockedBy(notes, root.id, sharedChild.id)).toBe('scope')
    expect(workspaceMountBlockedBy(notes, sharedChild.id, localFolder.id)).toBe('scope')
    expect(workspaceMountBlockedBy(notes, root.id, privateChild.id)).toBe('cycle')
  })
})

describe('moveBlockedBy', () => {
  const a = note({ id: 'a' })
  const b = note({ id: 'b', parentId: 'a' })
  const c = note({ id: 'c', parentId: 'b' })
  const other = note({ id: 'x' })
  const shared = note({ id: 's', shareId: 'resource' })
  const sharedChild = note({ id: 'sc', parentId: 's', shareId: 'resource' })
  const roomNote = note({ id: 'room-note', shareId: 'resource', roomId: 'private-room' })
  const notes = [a, b, c, other, shared, sharedChild, roomNote]

  it('allows a reparent onto an unrelated note or the root', () => {
    expect(moveBlockedBy(notes, 'b', 'x')).toBe('none')
    expect(moveBlockedBy(notes, 'c', '')).toBe('none')
  })
  it('refuses a drop into the note\'s own subtree, including onto itself', () => {
    expect(moveBlockedBy(notes, 'a', 'c')).toBe('cycle')
    expect(moveBlockedBy(notes, 'a', 'a')).toBe('cycle')
  })
  it('refuses a move that would cross a resource or room boundary', () => {
    expect(moveBlockedBy(notes, 'x', 's')).toBe('scope')
    expect(moveBlockedBy(notes, 's', 'x')).toBe('scope')
    expect(moveBlockedBy(notes, 'sc', '')).toBe('scope')
    expect(moveBlockedBy(notes, 'room-note', 's')).toBe('scope')
    expect(moveBlockedBy(notes, 's', 'room-note')).toBe('scope')
  })
  it('reports a move that changes nothing', () => {
    expect(moveBlockedBy(notes, 'b', 'a')).toBe('noop')
    expect(moveBlockedBy(notes, 'x', '')).toBe('noop')
  })
  it('reports a vanished note or parent', () => {
    expect(moveBlockedBy(notes, 'gone', 'a')).toBe('missing')
    expect(moveBlockedBy(notes, 'a', 'gone')).toBe('missing')
  })
})

describe('identity scoping', () => {
  it('gives each scope its own database', async () => {
    const first = await openLocalStore('user-a')
    await first.putNote(note({ id: 'a-note', title: 'user a private' }))
    first.close()

    // The whole point of A4: a second identity on this browser starts empty
    // rather than inheriting the first one's pages.
    const second = await openLocalStore('user-b')
    expect(second.getSnapshot()).toEqual([])
    expect(second.getNote('a-note')).toBeNull()
    second.close()

    const reopened = await openLocalStore('user-a')
    expect(reopened.getNote('a-note')?.title).toBe('user a private')
  })

  it('upgrades pre-asset databases without mistaking them for empty new scopes', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('motion', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('notes', { keyPath: 'id' }).put(note({ id: 'legacy', title: 'Keep me' }))
        request.result.createObjectStore('docs', { keyPath: 'noteId' })
        const outbox = request.result.createObjectStore('outbox', { keyPath: 'id' })
        outbox.createIndex('createdAt', 'createdAt')
        outbox.createIndex('noteId', 'noteId')
      }
      request.onsuccess = () => { request.result.close(); resolve() }
      request.onerror = () => reject(request.error)
    })

    const upgraded = await openLocalStore(ANON_SCOPE)
    expect(upgraded.getNote('legacy')?.title).toBe('Keep me')
    expect(await upgraded.allAssets()).toEqual([])
  })

  it('reports an upgrade blocked by an older tab instead of hanging', async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('motion', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    // Deliberately ignore versionchange, as a tab running the old bundle does.
    legacy.onversionchange = () => {}

    await expect(openLocalStore(ANON_SCOPE)).rejects.toThrow('Local data is open in another Pad tab')
    legacy.close()
  })

  it('closes its connection to let a newer schema version proceed', async () => {
    const store = await openLocalStore(ANON_SCOPE)
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('motion', 3)
      request.onupgradeneeded = () => {}
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('upgrade was blocked'))
    })
    upgraded.close()
    store.close()
  })

  it('keeps the anonymous scope separate from every signed-in scope', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'draft' }))
    anonymous.close()
    const scoped = await openLocalStore('user-a')
    expect(scoped.getNote('draft')).toBeNull()
  })
})

describe('scope survey', () => {
  const empty = { notes: 0, deleted: 0, pending: 0, titles: [] }

  it('reports nothing for a scope that has never been written', async () => {
    expect(await surveyScope('never-used')).toEqual(empty)
  })

  // Probing must not be what creates the thing being probed, or the prompt
  // would start answering itself.
  it('does not bring a scope into existence by asking about it', async () => {
    await surveyScope('never-used')
    const store = await openLocalStore('never-used')
    expect(store.getSnapshot()).toEqual([])
    store.close()
    expect(await surveyScope('never-used')).toEqual(empty)
  })

  it('counts live and deleted pages separately, alongside queued work', async () => {
    const store = await openLocalStore(ANON_SCOPE)
    await store.putNote(note({ id: 'alive', title: 'Groceries' }))
    await store.putNote(note({ id: 'gone', title: 'Thrown away', deletedAt: 5 }))
    await store.enqueueNote('alive')
    store.close()
    // Deleted pages are counted so the prompt can mention them, but never
    // named: the user already decided about those.
    expect(await surveyScope(ANON_SCOPE)).toEqual({ notes: 1, deleted: 1, pending: 1, titles: ['Groceries'] })
  })

  it('lists page titles most-recent first, standing in for an empty title', async () => {
    const store = await openLocalStore(ANON_SCOPE)
    await store.putNote(note({ id: 'old', title: 'Older', updatedAt: 10 }))
    await store.putNote(note({ id: 'new', title: 'Newer', updatedAt: 20 }))
    await store.putNote(note({ id: 'blank', title: '   ', updatedAt: 15 }))
    store.close()
    expect((await surveyScope(ANON_SCOPE)).titles).toEqual(['Newer', 'Untitled', 'Older'])
  })

  it('caps the listed titles so the dialog cannot grow without bound', async () => {
    const store = await openLocalStore(ANON_SCOPE)
    for (let index = 0; index < SURVEY_TITLE_LIMIT + 5; index += 1) {
      await store.putNote(note({ title: `Page ${index}`, updatedAt: index }))
    }
    store.close()
    const survey = await surveyScope(ANON_SCOPE)
    expect(survey.notes).toBe(SURVEY_TITLE_LIMIT + 5)
    expect(survey.titles).toHaveLength(SURVEY_TITLE_LIMIT)
  })
})

describe('scope adoption', () => {
  // Adoption re-enqueues from state rather than copying the source outbox, so
  // everything adopted is pushed under the new identity.
  const concat = (states: string[]) => states.join('+')

  it('moves pages and bodies into the target and drops the source', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'draft', title: 'typed before signing in', updatedAt: 10 }))
    await anonymous.putDocState('draft', 'body')
    anonymous.close()

    const target = await openLocalStore('user-a')
    expect(await adoptScope(ANON_SCOPE, target, concat)).toEqual({ notes: 1 })
    expect(target.getNote('draft')?.title).toBe('typed before signing in')
    expect(await target.getDocState('draft')).toBe('body')
    expect(await target.countOps()).toBeGreaterThan(0)

    // Source is gone, so the prompt does not come back.
    expect(await surveyScope(ANON_SCOPE)).toEqual({ notes: 0, deleted: 0, pending: 0, titles: [] })
  })

  // Regression: tombstones used to be adopted locally but never enqueued, so a
  // delete that had not yet drained stayed local and the page came back on the
  // next device to sync.
  it('carries a soft-deleted page across and queues the tombstone for push', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'trashed', title: 'Thrown away', deletedAt: 40, updatedAt: 40 }))
    anonymous.close()

    const target = await openLocalStore('user-a')
    await adoptScope(ANON_SCOPE, target, concat)
    expect(target.getNote('trashed')?.deletedAt).toBe(40)
    const ops = await target.listOps()
    expect(ops.filter((op) => op.noteId === 'trashed' && op.kind === 'note')).toHaveLength(1)
    // Nothing to push as a body — the delete already dropped it.
    expect(ops.filter((op) => op.noteId === 'trashed' && op.kind === 'update')).toHaveLength(0)
  })

  it('moves only selected pages and leaves the remaining source pages reviewable', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'parent', title: 'Selected parent' }))
    await anonymous.putNote(note({ id: 'child', title: 'Remaining child', parentId: 'parent' }))
    await anonymous.putNote(note({ id: 'other', title: 'Remaining root' }))
    await anonymous.putDocState('parent', 'selected body')
    await anonymous.putDocState('child', 'remaining body')
    await anonymous.putAsset({ path: 'notes/parent/selected.png', noteId: 'parent', blob: new Blob(['selected']), contentType: 'image/png', sizeBytes: 8, placement: 'private', ownerId: 'anonymous' })
    await anonymous.putAsset({ path: 'notes/child/remaining.png', noteId: 'child', blob: new Blob(['remaining']), contentType: 'image/png', sizeBytes: 9 })
    anonymous.close()

    const target = await openLocalStore('user-a')
    await adoptScope(ANON_SCOPE, target, concat, new Set(['parent']))
    expect(target.getNote('parent')?.title).toBe('Selected parent')
    expect(target.getNote('child')).toBeNull()
    expect(await target.getDocState('parent')).toBe('selected body')
    expect(await (await target.getAsset('notes/parent/selected.png'))?.blob.text()).toBe('selected')
    expect((await target.getAsset('notes/parent/selected.png'))?.placement).toBeUndefined()

    const remaining = await openLocalStore(ANON_SCOPE)
    expect(remaining.getNote('parent')).toBeNull()
    expect(remaining.getNote('child')?.parentId).toBe('')
    expect(await remaining.getDocState('child')).toBe('remaining body')
    expect(await (await remaining.getAsset('notes/child/remaining.png'))?.blob.text()).toBe('remaining')
    expect(await remaining.getAsset('notes/parent/selected.png')).toBeUndefined()
    remaining.close()
    expect((await surveyScope(ANON_SCOPE)).notes).toBe(2)
  })

  it('deletes only selected source pages and leaves the rest reviewable', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'discard', title: 'Discard me' }))
    await anonymous.putNote(note({ id: 'keep', title: 'Keep reviewing', parentId: 'discard' }))
    await anonymous.putDocState('discard', 'discarded body')
    await anonymous.putDocState('keep', 'remaining body')
    await anonymous.putAsset({ path: 'notes/discard/gone.png', noteId: 'discard', blob: new Blob(['gone']), contentType: 'image/png', sizeBytes: 4 })
    anonymous.close()

    expect((await discardScopeNotes(ANON_SCOPE, new Set(['discard']))).notes).toBe(1)
    const remaining = await openLocalStore(ANON_SCOPE)
    expect(remaining.getNote('discard')).toBeNull()
    expect(remaining.getNote('keep')?.parentId).toBe('')
    expect(await remaining.getDocState('discard')).toBeNull()
    expect(await remaining.getDocState('keep')).toBe('remaining body')
    expect(await remaining.getAsset('notes/discard/gone.png')).toBeUndefined()
  })

  it('promotes a selected child to a root when its parent is not selected', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'parent' }))
    await anonymous.putNote(note({ id: 'child', parentId: 'parent' }))
    anonymous.close()

    const target = await openLocalStore('user-a')
    await adoptScope(ANON_SCOPE, target, concat, new Set(['child']))
    expect(target.getNote('child')?.parentId).toBe('')
    expect(target.getNote('parent')).toBeNull()
  })

  it('does not let an adopted tombstone be undone by the page it replaces', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'both', deletedAt: 40, updatedAt: 40 }))
    anonymous.close()

    const target = await openLocalStore('user-a')
    await target.putNote(note({ id: 'both', title: 'still alive here', updatedAt: 10 }))
    await adoptScope(ANON_SCOPE, target, concat)
    expect(target.getNote('both')?.deletedAt).toBe(40)
  })

  it('merges a body rather than letting either side win', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'shared-id', updatedAt: 10 }))
    await anonymous.putDocState('shared-id', 'local')
    anonymous.close()

    const target = await openLocalStore('user-a')
    await target.putNote(note({ id: 'shared-id', updatedAt: 20 }))
    await target.putDocState('shared-id', 'server')
    await adoptScope(ANON_SCOPE, target, concat)
    expect(await target.getDocState('shared-id')).toBe('server+local')
  })

  it('does not let an older adopted row overwrite a newer one already here', async () => {
    const anonymous = await openLocalStore(ANON_SCOPE)
    await anonymous.putNote(note({ id: 'both', title: 'stale', updatedAt: 10 }))
    anonymous.close()

    const target = await openLocalStore('user-a')
    await target.putNote(note({ id: 'both', title: 'current', updatedAt: 99 }))
    await adoptScope(ANON_SCOPE, target, concat)
    expect(target.getNote('both')?.title).toBe('current')
  })

  it('is a no-op when there is nothing to adopt', async () => {
    const target = await openLocalStore('user-a')
    expect(await adoptScope(ANON_SCOPE, target, concat)).toEqual({ notes: 0 })
    expect(await target.countOps()).toBe(0)
  })
})
