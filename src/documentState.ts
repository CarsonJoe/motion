import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { Page } from './db'

export const LOCAL_ORIGIN = Symbol('motion-local')
export const REMOTE_ORIGIN = Symbol('motion-remote')
export const INITIAL_ORIGIN = Symbol('motion-initial')
export const DOCUMENT_STORE_VERSION = 'v6'

export const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

export function patchYText(text: Y.Text, value: string) {
  const current = text.toString()
  if (current === value) return
  let start = 0
  const maxStart = Math.min(current.length, value.length)
  while (start < maxStart && current[start] === value[start]) start += 1
  let currentEnd = current.length
  let valueEnd = value.length
  while (currentEnd > start && valueEnd > start && current[currentEnd - 1] === value[valueEnd - 1]) {
    currentEnd -= 1
    valueEnd -= 1
  }
  if (currentEnd > start) text.delete(start, currentEnd - start)
  if (valueEnd > start) text.insert(start, value.slice(start, valueEnd))
}

export async function openLocalDocument(pageId: string) {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`motion-document-${DOCUMENT_STORE_VERSION}-${pageId}`, doc)
  await persistence.whenSynced
  return { doc, persistence, text: doc.getText('content'), meta: doc.getMap<string>('meta') }
}

export function seedDocument(doc: Y.Doc, text: Y.Text, meta: Y.Map<string>, page: Pick<Page, 'title' | 'parentId' | 'markdown'>) {
  doc.transact(() => {
    if (text.length === 0 && page.markdown) text.insert(0, page.markdown)
    if (!meta.has('title')) meta.set('title', page.title)
    if (!meta.has('parentId')) meta.set('parentId', page.parentId)
  }, INITIAL_ORIGIN)
}

export async function localDocumentSnapshot(page: Page) {
  const local = await openLocalDocument(page.id)
  seedDocument(local.doc, local.text, local.meta, page)
  const state = toBase64(Y.encodeStateAsUpdate(local.doc))
  const markdown = local.text.toString()
  const title = local.meta.get('title') ?? page.title
  const parentId = local.meta.get('parentId') ?? page.parentId
  local.persistence.destroy()
  local.doc.destroy()
  return { state, markdown, title, parentId }
}

export async function setLocalDocumentMetadata(page: Page, update: Partial<Pick<Page, 'title' | 'parentId'>>) {
  const local = await openLocalDocument(page.id)
  seedDocument(local.doc, local.text, local.meta, page)
  local.doc.transact(() => {
    if (update.title !== undefined) local.meta.set('title', update.title)
    if (update.parentId !== undefined) local.meta.set('parentId', update.parentId)
  }, LOCAL_ORIGIN)
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  local.persistence.destroy()
  local.doc.destroy()
}
