import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openLocalStore, subtreeIds, type Note, type NoteOp } from './local'

const note = (patch: Partial<Note>): Note => ({
  id: crypto.randomUUID(), title: '', parentId: '', shareId: '', deletedAt: 0, updatedAt: 0, ...patch
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

  it('never lets a private row replace a note that moved into a shared scope', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    await store.applyRemoteNote(note({ id, title: 'private', updatedAt: 10 }))
    // Sharing re-homes a note without editing it: equal timestamps must claim.
    expect(await store.applyRemoteNote(note({ id, title: 'shared', shareId, updatedAt: 10 }))).toBe(true)
    expect(await store.applyRemoteNote(note({ id, title: 'late private row', updatedAt: 30 }))).toBe(false)
    const current = store.getNote(id)
    expect(current?.shareId).toBe(shareId)
    expect(current?.title).toBe('shared')
  })

  it('drops the cached document body when a note is deleted remotely', async () => {
    const store = await openLocalStore()
    const id = crypto.randomUUID()
    await store.putDocState(id, 'state')
    await store.applyRemoteNote(note({ id, deletedAt: 5, updatedAt: 5 }))
    expect(await store.getDocState(id)).toBeNull()
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
    await store.enqueueUpdate('n1', '', 'a')
    await store.enqueueUpdate('n2', 's', 'b')
    const ops = await store.listOps()
    expect(ops).toHaveLength(2)
    await store.removeOps(ops.map((op) => op.id))
    expect(await store.countOps()).toBe(0)
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
    await store.enqueueUpdate(shared.id, shareId, 'x')
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

describe('subtreeIds', () => {
  it('collects a root and every transitive child', () => {
    const a = note({ id: 'a' })
    const b = note({ id: 'b', parentId: 'a' })
    const c = note({ id: 'c', parentId: 'b' })
    const other = note({ id: 'x' })
    expect([...subtreeIds([a, b, c, other], 'a')].sort()).toEqual(['a', 'b', 'c'])
  })
})
