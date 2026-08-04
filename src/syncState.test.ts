import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { initDatabase } from './db'
import { applyPrivateRows, applySharedRows, applyTombstoneRows } from './tallpond'

describe('page discovery deletion barrier', () => {
  it('never allows a later page snapshot to resurrect a tombstoned page', async () => {
    const db = await initDatabase()
    const pageId = crypto.randomUUID()
    const row = {
      pageId, title: 'Deleted page', parentId: '', markdown: 'body',
      blocks: [], clientUpdatedAt: 10
    }

    await applyPrivateRows(db, [row])
    expect(await db.pages.findOne(pageId).exec()).not.toBeNull()

    await applyTombstoneRows(db, [{
      pageId, deleteRootId: pageId, deleteId: crypto.randomUUID(), deletedAt: 20
    }], 'private')
    expect(await db.pages.findOne(pageId).exec()).toBeNull()

    await applyPrivateRows(db, [{ ...row, title: 'Should stay deleted', clientUpdatedAt: 30 }])
    expect(await db.pages.findOne(pageId).exec()).toBeNull()
  })

  it('never lets a legacy private row replace the shared scope', async () => {
    const db = await initDatabase()
    const pageId = crypto.randomUUID()
    const shareId = crypto.randomUUID()
    await applyPrivateRows(db, [{ pageId, title: 'Private', parentId: '', markdown: '', blocks: [], clientUpdatedAt: 10 }])
    await applySharedRows(db, [{ pageId, title: 'Shared', parentId: '', markdown: '', blocks: [], clientUpdatedAt: 20 }], shareId)
    await applyPrivateRows(db, [{ pageId, title: 'Late private row', parentId: '', markdown: '', blocks: [], clientUpdatedAt: 30 }])

    const page = await db.pages.findOne(pageId).exec()
    expect(page?.shareId).toBe(shareId)
    expect(page?.title).toBe('Shared')
  })
})
