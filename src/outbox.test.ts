import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Page } from './db'
import { enqueueContent, enqueueDelete, enqueueMetadata, listOperations, mergeContentOperations, pendingDeletedPageIds, removeMetadataIfUnchanged, removeOperations } from './outbox'
import { fromBase64 } from './documentState'

const page = (id: string, title = 'First'): Page => ({
  id, title, parentId: '', shareId: '', markdown: '', updatedAt: Date.now()
})

describe('durable sync outbox', () => {
  it('coalesces metadata, merges CRDT updates, and makes deletion supersede queued writes', async () => {
    const first = page(crypto.randomUUID())
    await enqueueMetadata(first)
    await enqueueMetadata({ ...first, title: 'Latest', updatedAt: first.updatedAt + 1 })

    const source = new Y.Doc()
    const text = source.getText('content')
    const updates: Uint8Array[] = []
    source.on('update', (update) => updates.push(update))
    text.insert(0, 'hello')
    text.insert(5, '\nworld')
    for (const update of updates) await enqueueContent(first.id, '', update)

    const queued = await listOperations()
    expect(queued.filter((operation) => operation.kind === 'metadata')).toHaveLength(1)
    expect(queued.find((operation) => operation.kind === 'metadata')?.page.title).toBe('Latest')

    const inFlightMetadata = queued.find((operation) => operation.kind === 'metadata')!
    await enqueueMetadata({ ...first, title: 'Typed while uploading', updatedAt: first.updatedAt + 2 })
    if (inFlightMetadata.kind === 'metadata') await removeMetadataIfUnchanged(inFlightMetadata)
    expect((await listOperations()).find((operation) => operation.kind === 'metadata')?.page.title).toBe('Typed while uploading')

    const content = queued.filter((operation) => operation.kind === 'content')
    const target = new Y.Doc()
    Y.applyUpdate(target, fromBase64(mergeContentOperations(content)))
    expect(target.getText('content').toString()).toBe('hello\nworld')

    await removeOperations((await listOperations()).map((operation) => operation.id))
    expect(await listOperations()).toHaveLength(0)

    await enqueueMetadata(first)
    await enqueueContent(first.id, '', updates[0])
    await enqueueDelete(first, [first.id, 'child-page'])
    const afterDelete = await listOperations()
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].kind).toBe('delete')
    expect(await pendingDeletedPageIds()).toEqual(new Set([first.id, 'child-page']))
  })
})
