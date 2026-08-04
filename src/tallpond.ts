import { createClient, type InvitationInfo, type MemberInfo, type Row, type Session, type TableQuery } from '@tallpond/sdk'
import { ROOT_PAGE_ID, type MotionDatabase, type Page } from './db'
import { localDocumentSnapshot, setLocalDocumentMetadata } from './documentState'
import { listOperations, mergeContentOperations, pendingDeletedPageIds, removeMetadataIfUnchanged, removeOperations, type ContentOperation } from './outbox'

// Tallpond sessions are cookie-backed. The developer credential created by the CLI
// is deliberately never bundled into this app.
const clientId = import.meta.env.VITE_TALLPOND_CLIENT_ID as string | undefined
export const tallpond = (() => {
  try {
    // Tallpond injects this configuration on its hosted origin. Local Vite
    // development needs the two variables in .env.local instead.
    return clientId ? createClient({ gatewayUrl: import.meta.env.VITE_TALLPOND_GATEWAY_URL || 'https://api.tallpond.com', clientId }) : createClient()
  } catch { return null }
})()

let sessionCheckPromise: Promise<Session> | null = null

export async function getTallpondSession(force = false) {
  if (!tallpond) return null
  // Deduplicate concurrent checks, but never guess that an old credential is
  // still valid. The SDK/gateway is the session authority.
  if (!force && sessionCheckPromise) return sessionCheckPromise
  sessionCheckPromise ??= tallpond.auth.getSession().finally(() => { sessionCheckPromise = null })
  return sessionCheckPromise
}

export async function ensureTallpondSession(force = false) {
  return Boolean((await getTallpondSession(force))?.authenticated)
}

export function invalidateTallpondSession() {
  sessionCheckPromise = null
}

type TombstoneRow = { pageId: string; deleteRootId: string; deleteId: string; deletedAt: number }
async function selectAllRows(build: (cursor?: string) => TableQuery) {
  const rows: Row[] = []
  let cursor: string | undefined
  do {
    const page = await build(cursor).page()
    rows.push(...page.rows)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

function subtreeIds(rows: Array<{ pageId?: unknown; id?: unknown; parentId?: unknown }>, rootId: string) {
  const ids = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      const pageId = String(row.pageId ?? row.id ?? '')
      const parentId = String(row.parentId ?? '')
      if (pageId && !ids.has(pageId) && ids.has(parentId)) { ids.add(pageId); changed = true }
    }
  }
  return [...ids]
}

function normalizeTombstone(row: Record<string, unknown>): TombstoneRow {
  return { pageId: String(row.pageId), deleteRootId: String(row.deleteRootId || row.pageId), deleteId: String(row.deleteId), deletedAt: Number(row.deletedAt) }
}

async function locallyDeletedPageIds(db: MotionDatabase, scope: string, pageIds: string[]) {
  if (!pageIds.length) return new Set<string>()
  const rows = await db.tombstones.find({ selector: { scope, pageId: { $in: pageIds } } }).exec()
  return new Set(rows.map((row) => row.pageId))
}

export async function getSharedResourceRole(shareId: string) {
  if (!tallpond) return null
  const resource = await tallpond.resource(shareId).get()
  return resource.currentMember?.role ?? null
}

export async function leaveSharedResource(db: MotionDatabase, shareId: string) {
  if (!tallpond) throw new Error('Tallpond is unavailable.')
  if (!navigator.onLine) throw new Error('Reconnect to leave this shared page.')
  await tallpond.resource(shareId).members.leave()
  const pages = await db.pages.find({ selector: { shareId } }).exec()
  for (const page of pages) await page.remove()
}

let callbackPromise: Promise<boolean> | undefined

export async function finishTallpondCallback() {
  callbackPromise ??= finishTallpondCallbackOnce()
  return callbackPromise
}

async function finishTallpondCallbackOnce() {
  if (!tallpond) return false
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  if (!code) return false

  // Never submit an orphaned / stale callback to the SDK. It would throw an
  // OAuth state mismatch and prevent the user from beginning a clean login.
  const state = url.searchParams.get('state')
  if (!state || sessionStorage.getItem('osg_pkce:state') !== state) {
    window.history.replaceState({}, document.title, window.location.pathname)
    return false
  }
  const callbackSession = await tallpond.auth.handleRedirectCallback(url)
  window.history.replaceState({}, document.title, window.location.pathname)
  return Boolean(callbackSession?.authenticated)
}

export async function startTallpondSession(forceReauthorize = false) {
  if (!tallpond) throw new Error('Connect a Tallpond app before signing in.')
  if (await finishTallpondCallback()) return getTallpondSession(true)
  const session = await getTallpondSession(true) ?? { authenticated: false }
  if (forceReauthorize || !session.authenticated) {
    invalidateTallpondSession()
    await tallpond.auth.signIn()
    return { authenticated: false }
  }
  return session
}

async function writePageMetadata(page: Page) {
  if (!tallpond) throw new Error('Tallpond is unavailable.')
  const table = page.shareId
    ? tallpond.resource(page.shareId).table('shared_pages')
    : tallpond.table('motion_crdt_documents')
  const values = { title: page.title, parentId: page.parentId, clientUpdatedAt: page.updatedAt }
  const updated = await table.update(values).eq('pageId', page.id).lte('clientUpdatedAt', page.updatedAt)
  if (!updated.length && !await table.select('pageId').eq('pageId', page.id).maybeSingle()) await table.insert({
    pageId: page.id, ...values,
    // A new page has no body yet. The document controller materializes this
    // cache after it hydrates the authoritative Yjs update stream.
    markdown: '', yState: '', blocks: []
  })
}

export async function flushTallpondOutbox() {
  if (!tallpond || !navigator.onLine) return { pending: (await listOperations()).length }

  while (true) {
    const operations = await listOperations()
    if (!operations.length) return { pending: 0 }
    const contentGroups = new Map<string, ContentOperation[]>()
    for (const operation of operations) {
      if (operation.kind !== 'content') continue
      const key = `${operation.shareId}\u0000${operation.pageId}`
      const group = contentGroups.get(key) ?? []
      group.push(operation)
      contentGroups.set(key, group)
    }

    for (const group of contentGroups.values()) {
      const first = group[0]
      const table = first.shareId
        ? tallpond.resource(first.shareId).table('markdown_updates')
        : tallpond.table('motion_crdt_updates')
      await table.insert({
        updateId: crypto.randomUUID(), documentId: first.pageId,
        payload: mergeContentOperations(group), clientUpdatedAt: Date.now()
      })
      await removeOperations(group.map((operation) => operation.id))
    }

    for (const operation of operations) {
      if (operation.kind === 'content') continue
      if (operation.kind === 'metadata') {
        await writePageMetadata(operation.page)
        await removeMetadataIfUnchanged(operation)
      } else {
        await deleteRemotePage(operation.page)
        await removeOperations([operation.id])
      }
    }
  }
}

export async function deleteRemotePage(page: Page) {
  if (!tallpond) return
  if (page.shareId) {
    const resource = tallpond.resource(page.shareId)
    const info = await resource.get()
    if (info.currentMember?.role !== 'admin' && info.currentMember?.role !== 'owner') throw new Error('Only the shared document owner can delete pages.')
    const rows = await selectAllRows((cursor) => {
      const query = resource.table('shared_pages').select()
      return cursor ? query.after(cursor) : query
    })
    const ids = subtreeIds(rows, page.id)
    const deletedAt = Date.now()
    const tombstones = ids.map((pageId) => ({ pageId, deleteRootId: page.id, deleteId: crypto.randomUUID(), deletedAt }))
    await resource.table('page_tombstones').upsert(tombstones, { onConflict: ['pageId'] })
  }
  else {
    const pages = await selectAllRows((cursor) => { const query = tallpond.table('motion_crdt_documents').select(); return cursor ? query.after(cursor) : query })
    const ids = subtreeIds(pages, page.id)
    const deletedAt = Date.now()
    const tombstones = ids.map((pageId) => ({ pageId, deleteRootId: page.id, deleteId: crypto.randomUUID(), deletedAt }))
    await tallpond.table('motion_crdt_tombstones').upsert(tombstones, { onConflict: ['pageId'] })
  }
}

function privatePageFromRow(row: Record<string, unknown>): Page {
  const blocks = Array.isArray(row.blocks) ? row.blocks as Array<{ data?: { text?: string } }> : []
  return { id: String(row.pageId), title: String(row.title), parentId: row.parentId ? String(row.parentId) : ROOT_PAGE_ID, shareId: '', markdown: typeof row.markdown === 'string' ? row.markdown : blocks[0]?.data?.text ?? '', updatedAt: Number(row.clientUpdatedAt) }
}

function uniquePages(pages: Page[]) {
  const byId = new Map<string, Page>()
  for (const page of pages) {
    const current = byId.get(page.id)
    if (!current || current.updatedAt <= page.updatedAt) byId.set(page.id, page)
  }
  return [...byId.values()]
}

export async function applyPrivateRows(db: MotionDatabase, rows: Record<string, unknown>[]) {
  const pendingDeletes = await pendingDeletedPageIds()
  const candidates = uniquePages(rows.map(privatePageFromRow))
  const tombstoned = await locallyDeletedPageIds(db, 'private', candidates.map((page) => page.id))
  const pages = candidates.filter((page) => !pendingDeletes.has(page.id) && !tombstoned.has(page.id))
  if (!pages.length) return
  const existing = await db.pages.findByIds(pages.map((page) => page.id)).exec()
  const changed = pages.flatMap((page) => {
    const local = existing.get(page.id)
    if (!local) return [page]
    if (local.updatedAt >= page.updatedAt) return []
    return [{ ...local.toJSON(), title: page.title, parentId: page.parentId, shareId: '', updatedAt: page.updatedAt }]
  })
  if (changed.length) await db.pages.bulkUpsert(changed)
}

type SharedPageRow = { pageId: string; parentId: string; title: string; markdown: string; yState: string; blocks: unknown[]; clientUpdatedAt: number }

function descendants(pages: Page[], rootId: string) {
  const included = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const page of pages) {
      if (!included.has(page.id) && included.has(page.parentId)) { included.add(page.id); changed = true }
    }
  }
  return pages.filter((page) => included.has(page.id))
}

export async function sharePageTree(db: MotionDatabase, root: Page) {
  if (!tallpond) throw new Error('Connect Tallpond before sharing.')
  if (root.shareId) return root.shareId
  const resource = await tallpond.resource.create('shared_document', { name: root.title || 'Untitled page', visibility: 'members' })
  const allPages = (await db.pages.find({ selector: {} }).exec()).map((page) => page.toJSON())
  const tree = descendants(allPages, root.id)
  for (const page of tree) {
    if (page.id === root.id && page.parentId !== ROOT_PAGE_ID) await setLocalDocumentMetadata(page, { parentId: ROOT_PAGE_ID })
    const local = await localDocumentSnapshot(page)
    const row: SharedPageRow = {
      pageId: page.id,
      // A nested page becomes the shared root when its subtree is shared.
      parentId: page.id === root.id ? ROOT_PAGE_ID : page.parentId,
      title: local.title,
      markdown: '',
      yState: '',
      blocks: [],
      clientUpdatedAt: page.updatedAt
    }
    await tallpond.resource(resource.id).table('shared_pages').insert(row)
    await tallpond.resource(resource.id).table('markdown_updates').insert({ updateId: crypto.randomUUID(), documentId: page.id, payload: local.state, clientUpdatedAt: Date.now() })
  }
  for (const page of tree) {
    const local = await db.pages.findOne(page.id).exec()
    if (local) await local.incrementalPatch({ shareId: resource.id, parentId: page.id === root.id ? ROOT_PAGE_ID : page.parentId })
  }
  return resource.id
}

function sharedPageFromRow(row: Record<string, unknown>, shareId: string): Page {
  const blocks = Array.isArray(row.blocks) ? row.blocks as Array<{ data?: { text?: string } }> : []
  return {
    id: String(row.pageId),
    title: String(row.title),
    parentId: row.parentId ? String(row.parentId) : ROOT_PAGE_ID,
    shareId,
    markdown: typeof row.markdown === 'string' ? row.markdown : blocks[0]?.data?.text ?? '',
    updatedAt: Number(row.clientUpdatedAt)
  }
}

export async function applyTombstoneRows(db: MotionDatabase, rows: TombstoneRow[], scope: string) {
  if (!rows.length) return
  await db.tombstones.bulkUpsert(rows.map((row) => ({
    id: `${scope}:${row.pageId}`, scope, pageId: row.pageId,
    deleteRootId: row.deleteRootId, deletedAt: row.deletedAt
  })))
  const docs = await db.pages.find({ selector: scope === 'private' ? { shareId: '' } : { shareId: scope } }).exec()
  const pages = docs.map((doc) => doc.toJSON())
  const ids = new Set(rows.map((row) => row.pageId))
  const cascadeRoots = new Set(rows.filter((row) => row.pageId === row.deleteRootId).map((row) => row.deleteRootId))
  for (const rootId of cascadeRoots) for (const id of subtreeIds(pages, rootId)) ids.add(id)
  const docsById = new Map(docs.map((doc) => [doc.id, doc]))
  const removed = [...ids].map((id) => docsById.get(id)).filter((doc): doc is NonNullable<typeof doc> => Boolean(doc))
  if (removed.length) await db.pages.bulkRemove(removed)
}

export async function applySharedRows(db: MotionDatabase, rows: Record<string, unknown>[], shareId: string) {
  const pendingDeletes = await pendingDeletedPageIds()
  const candidates = uniquePages(rows.map((row) => sharedPageFromRow(row, shareId)))
  // Sharing moves a page out of the private discovery scope. The old private
  // row can remain remotely for historical releases, but it must never race the
  // resource row for the same local page id.
  await db.tombstones.bulkUpsert(candidates.map((page) => ({
    id: `private:${page.id}`, scope: 'private', pageId: page.id,
    deleteRootId: page.id, deletedAt: page.updatedAt
  })))
  const tombstoned = await locallyDeletedPageIds(db, shareId, candidates.map((page) => page.id))
  const pages = candidates.filter((page) => !pendingDeletes.has(page.id) && !tombstoned.has(page.id))
  if (!pages.length) return
  const existing = await db.pages.findByIds(pages.map((page) => page.id)).exec()
  const changed = pages.flatMap((page) => {
    const local = existing.get(page.id)
    if (!local) return [page]
    if (local.updatedAt >= page.updatedAt && local.shareId === shareId) return []
    return [{ ...local.toJSON(), title: page.title, parentId: page.parentId, shareId, updatedAt: page.updatedAt }]
  })
  if (changed.length) await db.pages.bulkUpsert(changed)
}

export async function restoreSharedPages(db: MotionDatabase) {
  if (!tallpond) return [] as string[]
  const resources = await tallpond.resource.list({ type: 'shared_document' })
  void db
  return resources.map((resource) => resource.id)
}

export function subscribeToSharedPages(db: MotionDatabase, shareIds: string[], onError: (error: unknown) => void) {
  if (!tallpond) return () => {}
  let closed = false
  let applyChain = Promise.resolve()
  let flushScheduled = false
  const pageBatches = new Map<string, Map<string, Record<string, unknown>>>()
  const tombstoneBatches = new Map<string, Map<string, TombstoneRow>>()
  const scheduleFlush = () => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      const pages = [...pageBatches.entries()].map(([scope, rows]) => [scope, [...rows.values()]] as const)
      const tombstones = [...tombstoneBatches.entries()].map(([scope, rows]) => [scope, [...rows.values()]] as const)
      pageBatches.clear(); tombstoneBatches.clear()
      applyChain = applyChain.then(async () => {
        if (closed) return
        for (const [scope, rows] of tombstones) await applyTombstoneRows(db, rows, scope)
        for (const [scope, rows] of pages) {
          if (scope === 'private') await applyPrivateRows(db, rows)
          else await applySharedRows(db, rows, scope)
        }
      }).catch(onError)
    })
  }
  const queuePage = (scope: string, row: Record<string, unknown>) => {
    const batch = pageBatches.get(scope) ?? new Map()
    batch.set(String(row.pageId), row); pageBatches.set(scope, batch); scheduleFlush()
  }
  const queueTombstone = (scope: string, row: Record<string, unknown>) => {
    const value = normalizeTombstone(row)
    const batch = tombstoneBatches.get(scope) ?? new Map()
    batch.set(value.pageId, value); tombstoneBatches.set(scope, batch); scheduleFlush()
  }
  const subscriptions = [tallpond.table('motion_crdt_documents').select().live()
    .on('insert', (row) => queuePage('private', row))
    .on('update', (row) => queuePage('private', row))
    .on('error', onError), tallpond.table('motion_crdt_tombstones').select().live()
    .on('insert', (row) => queueTombstone('private', row))
    .on('update', (row) => queueTombstone('private', row))
    .on('error', onError), ...shareIds.flatMap((shareId) => {
      const handle = tallpond.resource(shareId)
      return [handle.table('shared_pages').select().live()
        .on('insert', (row) => queuePage(shareId, row))
        .on('update', (row) => queuePage(shareId, row))
        .on('error', onError),
      handle.table('page_tombstones').select().live()
        .on('insert', (row) => queueTombstone(shareId, row))
        .on('update', (row) => queueTombstone(shareId, row))
        .on('error', onError)
      ]
    })]
  return () => { closed = true; subscriptions.forEach((subscription) => subscription.close()) }
}

export async function isRemotePageTombstoned(page: Page) {
  if (!tallpond) return false
  if (!page.shareId) {
    const rows = await tallpond.table('motion_crdt_tombstones').eq('pageId', page.id).limit(1)
    return rows.length > 0
  }
  const rows = await tallpond.resource(page.shareId).table('page_tombstones').eq('pageId', page.id).limit(1)
  return rows.length > 0
}

export async function inviteToSharedPage(shareId: string, handle: string, role: 'reader' | 'writer') {
  if (!tallpond) throw new Error('Tallpond is unavailable.')
  const profile = await tallpond.users.byHandle(handle.replace(/^@/, ''))
  if (!profile.id) throw new Error('Tallpond user not found.')
  const invitation = await tallpond.resource(shareId).members.invite(profile.id, { role })
  return {
    userId: profile.id,
    role,
    state: invitation.state,
    kind: 'user',
    ownerId: null,
    ownerHandle: profile.handle,
    ownerDisplayName: profile.displayName
  } satisfies MemberInfo
}

export async function getSharedMembers(shareId: string) {
  if (!tallpond) return []
  const members = await tallpond.resource(shareId).members.list()
  if (members.length === 0) return members
  try {
    const profiles = await tallpond.users(members.map((member) => member.userId)).profiles()
    return members.map((member) => {
      const profile = profiles[member.userId]
      return {
        ...member,
        ownerDisplayName: member.ownerDisplayName || profile?.displayName || null,
        ownerHandle: member.ownerHandle || profile?.handle || null
      } satisfies MemberInfo
    })
  } catch {
    return members
  }
}

export async function getSharedInvitations() {
  if (!tallpond) return []
  // SDK 0.0.15 implements this endpoint internally but drops `invitations`
  // when wrapping the public resource function. Call the same authenticated
  // gateway route until the wrapper exports it correctly.
  const response = await tallpond.gateway.request<{ invitations: InvitationInfo[] }>('/v1/resources/invitations?type=shared_document')
  return response.invitations
}

export async function acceptSharedInvitation(resourceId: string) {
  if (!tallpond) throw new Error('Tallpond is unavailable.')
  return tallpond.resource(resourceId).members.accept()
}

export async function rejectSharedInvitation(resourceId: string) {
  if (!tallpond) throw new Error('Tallpond is unavailable.')
  return tallpond.resource(resourceId).members.reject()
}
