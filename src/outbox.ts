import * as Y from 'yjs'
import type { Page } from './db'
import { fromBase64, toBase64 } from './documentState'

export type ContentOperation = {
  id: string
  kind: 'content'
  pageId: string
  shareId: string
  payload: string
  createdAt: number
}

export type MetadataOperation = {
  id: string
  revision: string
  kind: 'metadata'
  pageId: string
  shareId: string
  page: Page
  createdAt: number
}

export type DeleteOperation = {
  id: string
  kind: 'delete'
  pageId: string
  shareId: string
  page: Page
  removedPageIds: string[]
  createdAt: number
}

export type SyncOperation = ContentOperation | MetadataOperation | DeleteOperation

const DATABASE_NAME = 'motion-sync-v1'
const STORE_NAME = 'operations'

let databasePromise: Promise<IDBDatabase> | null = null

function database() {
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      store.createIndex('createdAt', 'createdAt')
      store.createIndex('pageId', 'pageId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return databasePromise
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('The local sync transaction was aborted.'))
  })
}

export async function enqueueContent(pageId: string, shareId: string, update: Uint8Array) {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  transaction.objectStore(STORE_NAME).put({
    id: crypto.randomUUID(), kind: 'content', pageId, shareId,
    payload: toBase64(update), createdAt: Date.now()
  } satisfies ContentOperation)
  await complete(transaction)
}

export async function enqueueMetadata(page: Page) {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  // Metadata is last-write-wins. A stable key coalesces intermediate titles
  // without delaying the local write or creating a timer.
  transaction.objectStore(STORE_NAME).put({
    id: `metadata:${page.id}`, revision: crypto.randomUUID(), kind: 'metadata', pageId: page.id,
    shareId: page.shareId, page, createdAt: Date.now()
  } satisfies MetadataOperation)
  await complete(transaction)
}

export async function enqueueDelete(page: Page, removedPageIds: string[] = [page.id]) {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const requests = removedPageIds.map((pageId) => store.index('pageId').getAllKeys(IDBKeyRange.only(pageId)))
  let remaining = requests.length
  const writeDelete = () => store.put({
      id: `delete:${page.id}`, kind: 'delete', pageId: page.id,
      shareId: page.shareId, page, removedPageIds, createdAt: Date.now()
    } satisfies DeleteOperation)
  if (!remaining) writeDelete()
  for (const request of requests) request.onsuccess = () => {
    for (const key of request.result) store.delete(key)
    remaining -= 1
    if (remaining === 0) writeDelete()
  }
  await complete(transaction)
}

export async function listOperations() {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readonly')
  const request = transaction.objectStore(STORE_NAME).index('createdAt').getAll()
  const rows = await new Promise<SyncOperation[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as SyncOperation[])
    request.onerror = () => reject(request.error)
  })
  await complete(transaction)
  return rows
}

export async function removeOperations(ids: string[]) {
  if (!ids.length) return
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  for (const id of ids) store.delete(id)
  await complete(transaction)
}

export async function removeMetadataIfUnchanged(operation: MetadataOperation) {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readwrite')
  const store = transaction.objectStore(STORE_NAME)
  const request = store.get(operation.id)
  request.onsuccess = () => {
    const current = request.result as MetadataOperation | undefined
    if (current?.revision === operation.revision) store.delete(operation.id)
  }
  await complete(transaction)
}

export async function outboxSize() {
  const db = await database()
  const transaction = db.transaction(STORE_NAME, 'readonly')
  const request = transaction.objectStore(STORE_NAME).count()
  const count = await new Promise<number>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await complete(transaction)
  return count
}

export async function pendingDeletedPageIds() {
  const operations = await listOperations()
  return new Set(operations.flatMap((operation) => operation.kind === 'delete' ? operation.removedPageIds ?? [operation.pageId] : []))
}

export function mergeContentOperations(operations: ContentOperation[]) {
  return toBase64(Y.mergeUpdates(operations.map((operation) => fromBase64(operation.payload))))
}
