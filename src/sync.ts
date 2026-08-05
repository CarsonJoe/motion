import { createClient, type InvitationInfo, type MemberInfo, type ResourceInfo, type Row, type TableQuery, type User } from '@tallpond/sdk'
import { mergeBase64Updates } from './codec'
import { subtreeIds, type LocalStore, type Note, type NoteOp, type UpdateOp } from './local'

// Tallpond injects gateway config on its hosted origin; local Vite development
// supplies the same two values through .env.local. Developer credentials never
// ship in the bundle — sessions are cookie-backed PKCE logins.
const clientId = import.meta.env.VITE_TALLPOND_CLIENT_ID as string | undefined
export const tallpond = (() => {
  try {
    return clientId
      ? createClient({ gatewayUrl: import.meta.env.VITE_TALLPOND_GATEWAY_URL || 'https://api.tallpond.com', clientId })
      : createClient()
  } catch { return null }
})()

export type TallpondClient = NonNullable<typeof tallpond>

export type SyncPhase = 'local' | 'connecting' | 'offline' | 'syncing' | 'synced' | 'error' | 'auth-required'
export type SyncState = {
  phase: SyncPhase
  // True once this run has confirmed a valid session. Presentation state like
  // the remembered login is never treated as proof of a live credential.
  connected: boolean
  error: string | null
  user: { id: string; name: string } | null
  // shareId -> role, refreshed on every full sync and cached for offline UI.
  roles: Record<string, string>
  pending: number
}

const ROLE_KEY = 'motion-role:'
const storedRoles = () => {
  const roles: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(ROLE_KEY)) roles[key.slice(ROLE_KEY.length)] = localStorage.getItem(key) ?? ''
  }
  return roles
}

let state: SyncState = { phase: 'local', connected: false, error: null, user: null, roles: storedRoles(), pending: 0 }
const listeners = new Set<() => void>()
const setState = (patch: Partial<SyncState>) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export const subscribeSyncState = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const getSyncState = () => state

export function isAuthError(error: unknown) {
  const candidate = error as { status?: number; code?: string } | null
  return candidate?.status === 401 || ['not_signed_in', 'session_expired', 'invalid_session'].includes(candidate?.code ?? '')
}

const describeError = (error: unknown) => {
  const requestId = (error as { requestId?: string | null } | null)?.requestId
  return `${error instanceof Error ? error.message : 'Sync failed'}${requestId ? ` · Request ${requestId}` : ''}`
}

async function selectAll(build: (cursor?: string) => TableQuery) {
  const rows: Row[] = []
  let cursor: string | undefined
  do {
    const page = await build(cursor).limit(200).page()
    rows.push(...page.rows)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

const rowToNote = (row: Row, shareId: string): Note => ({
  id: String(row.noteId),
  title: String(row.title ?? ''),
  parentId: String(row.parentId ?? ''),
  shareId,
  deletedAt: Number(row.deletedAt ?? 0),
  updatedAt: Number(row.clientUpdatedAt ?? 0)
})

const notesTable = (client: TallpondClient, shareId: string) =>
  shareId ? client.resource(shareId).table('member_notes') : client.table('notes')

export const updatesTable = (client: TallpondClient, shareId: string) =>
  shareId ? client.resource(shareId).table('member_note_updates') : client.table('note_updates')

// ---------------------------------------------------------------------------
// Outbox drain. Serialized: one flush at a time, re-running while new work
// arrives. Content updates for the same note merge into a single insert;
// metadata pushes are guarded so an older row can never overwrite a newer one.
// ---------------------------------------------------------------------------

// An op the gateway permanently refuses (rights revoked, resource deleted)
// must not wedge the queue behind it — it is dropped, not retried.
const isPermanentRejection = (error: unknown) => {
  const status = (error as { status?: number } | null)?.status
  return status === 403 || status === 404
}

export async function drainOutbox(client: TallpondClient, store: LocalStore) {
  while (true) {
    const ops = await store.listOps()
    if (!ops.length) return

    const updates = new Map<string, UpdateOp[]>()
    for (const op of ops) {
      if (op.kind !== 'update') continue
      const key = `${op.shareId}:${op.noteId}`
      updates.set(key, [...updates.get(key) ?? [], op])
    }
    for (const group of updates.values()) {
      const { noteId, shareId } = group[0]
      try {
        await updatesTable(client, shareId).insert({
          updateId: crypto.randomUUID(),
          noteId,
          payload: mergeBase64Updates(group.map((op) => op.payload))
        })
      } catch (error) {
        if (!isPermanentRejection(error)) throw error
      }
      await store.removeOps(group.map((op) => op.id))
    }

    for (const op of ops) {
      if (op.kind !== 'note') continue
      try {
        await pushNoteRow(client, store, op)
      } catch (error) {
        if (!isPermanentRejection(error)) throw error
        await store.removeOps([op.id])
      }
    }
  }
}

async function pushNoteRow(client: TallpondClient, store: LocalStore, op: NoteOp) {
  const note = store.getNote(op.noteId)
  if (!note) { await store.removeOps([op.id]); return }
  const table = () => notesTable(client, note.shareId)
  const values = { title: note.title, parentId: note.parentId, deletedAt: note.deletedAt, clientUpdatedAt: note.updatedAt }
  const updated = await table().update(values).eq('noteId', note.id).lte('clientUpdatedAt', note.updatedAt)
  if (!updated.length && !await table().select('noteId').eq('noteId', note.id).maybeSingle()) {
    await table().insert({ noteId: note.id, ...values })
  }
  await store.removeNoteOpIfRev(op)
}

// ---------------------------------------------------------------------------
// The engine singleton. App code calls startSync once, then interacts through
// noteChanged / connectInteractive / the share and membership helpers.
// ---------------------------------------------------------------------------

let local: LocalStore | null = null
let liveSubscriptions: Array<{ close: () => void }> = []
let applyChain = Promise.resolve()
let flushing = false
let flushQueued = false
let retryTimer: number | null = null
let retryAttempt = 0
let fullSyncPromise: Promise<void> | null = null

const refreshPending = async () => {
  if (local) setState({ pending: await local.countOps() })
}

const settle = async () => {
  await refreshPending()
  setState({ phase: state.pending ? 'syncing' : 'synced', error: null })
  retryAttempt = 0
}

function reportFailure(error: unknown) {
  if (isAuthError(error)) {
    setState({ phase: 'auth-required', connected: false, error: describeError(error) })
    return
  }
  if (!navigator.onLine) { setState({ phase: 'offline' }); return }
  setState({ phase: 'error', error: describeError(error) })
  if (retryTimer === null) {
    const delay = Math.min(2500 * 2 ** retryAttempt, 60000)
    retryAttempt += 1
    retryTimer = window.setTimeout(() => { retryTimer = null; void fullSync() }, delay)
  }
}

async function flush() {
  if (!tallpond || !local || !state.connected || !navigator.onLine) return
  if (flushing) { flushQueued = true; return }
  flushing = true
  try {
    do {
      flushQueued = false
      await drainOutbox(tallpond, local)
    } while (flushQueued)
    await settle()
  } catch (error) {
    reportFailure(error)
  } finally {
    flushing = false
  }
}

const applyRemoteRow = (shareId: string) => (row: Row) => {
  applyChain = applyChain.then(async () => {
    if (local) await local.applyRemoteNote(rowToNote(row, shareId))
  }).catch(() => {})
}

function subscribeLive(client: TallpondClient, shareIds: string[]) {
  for (const subscription of liveSubscriptions) subscription.close()
  const onError = (error: unknown) => { if (isAuthError(error)) reportFailure(error) }
  liveSubscriptions = ['', ...shareIds].map((shareId) => notesTable(client, shareId).select().live()
    .on('insert', applyRemoteRow(shareId))
    .on('update', applyRemoteRow(shareId))
    .on('error', onError))
}

export async function fullSync() {
  fullSyncPromise ??= (async () => {
    try {
      if (!tallpond || !local || !state.connected) return
      if (!navigator.onLine) { setState({ phase: 'offline' }); return }
      setState({ phase: 'syncing', error: null })

      // Captured before the resource list is fetched: a share created
      // concurrently by this device is absent here and so is never pruned.
      const sharesBefore = new Set(local.getSnapshot().map((note) => note.shareId).filter(Boolean))

      for (const row of await selectAll((cursor) => {
        const query = tallpond.table('notes').select()
        return cursor ? query.after(cursor) : query
      })) await local.applyRemoteNote(rowToNote(row, ''))

      const resources = await tallpond.resource.list({ type: 'shared_notes' })
      const roles = { ...state.roles }
      for (const resource of resources) {
        if (resource.currentMember?.role) {
          roles[resource.id] = resource.currentMember.role
          localStorage.setItem(`${ROLE_KEY}${resource.id}`, resource.currentMember.role)
        }
        for (const row of await selectAll((cursor) => {
          const query = tallpond.resource(resource.id).table('member_notes').select()
          return cursor ? query.after(cursor) : query
        })) await local.applyRemoteNote(rowToNote(row, resource.id))
      }

      // A share that has dropped out of the list is one this user is no longer
      // a member of — it was deleted, or access was revoked, on another
      // device. Without this the notes linger locally forever, editable
      // against a cached role and invisible to everyone else.
      for (const shareId of sharesBefore) {
        if (resources.some((resource) => resource.id === shareId)) continue
        localStorage.removeItem(`${ROLE_KEY}${shareId}`)
        delete roles[shareId]
        await local.removeShare(shareId)
      }
      setState({ roles })
      subscribeLive(tallpond, resources.map((resource) => resource.id))
      await drainOutbox(tallpond, local)
      await settle()
    } catch (error) {
      reportFailure(error)
    }
  })().finally(() => { fullSyncPromise = null })
  return fullSyncPromise
}

async function establishSession() {
  if (!tallpond) return false
  const url = new URL(window.location.href)
  if (url.searchParams.get('code') && url.searchParams.get('state')) {
    try { await tallpond.auth.handleRedirectCallback(url) }
    catch { /* stale or foreign callback params — fall through to getSession */ }
    window.history.replaceState({}, document.title, window.location.pathname)
  }
  const session = await tallpond.auth.getSession()
  if (!session.authenticated) return false
  setState({ connected: true })
  void tallpond.auth.getUser().then((user: User | null) => {
    if (user) setState({ user: { id: user.id, name: user.profile.displayName || user.profile.handle || 'You' } })
  }).catch(() => {})
  return true
}

export async function startSync(store: LocalStore) {
  local = store
  await refreshPending()
  window.addEventListener('online', () => { if (state.connected) void fullSync(); else setState({ phase: 'local' }) })
  window.addEventListener('offline', () => setState({ phase: state.connected ? 'offline' : 'local' }))
  if (!tallpond || !navigator.onLine) {
    setState({ phase: !navigator.onLine && localStorage.getItem('motion-connected') ? 'offline' : 'local' })
    return
  }
  try {
    if (await establishSession()) {
      localStorage.setItem('motion-connected', 'true')
      await fullSync()
    } else {
      localStorage.removeItem('motion-connected')
      setState({ phase: 'local', connected: false })
    }
  } catch (error) {
    reportFailure(error)
  }
}

// The explicit "Connect" action: finish a pending session if one exists,
// otherwise leave for the identity provider.
export async function connectInteractive() {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) { setState({ phase: 'local' }); return }
  setState({ phase: 'connecting', error: null })
  if (await establishSession()) {
    localStorage.setItem('motion-connected', 'true')
    await fullSync()
    return
  }
  await tallpond.auth.signIn()
}

// Local mutation entry point: App persists the note + op, then calls this to
// reflect the pending work and kick a flush.
export function noteChanged() {
  void refreshPending()
  if (!state.connected) { setState({ phase: 'local' }); return }
  if (!navigator.onLine) { setState({ phase: 'offline' }); return }
  setState({ phase: 'syncing' })
  void flush()
}

// ---------------------------------------------------------------------------
// Notes API used by the App.
// ---------------------------------------------------------------------------

export async function saveNote(store: LocalStore, note: Note) {
  const current = store.getNote(note.id)
  // Callers pass a snapshot taken at render time, which may predate a
  // concurrent re-home or delete. Scope and liveness belong to the store —
  // only sharing and deleting may change them, and both write directly.
  const merged = current ? { ...note, shareId: current.shareId, deletedAt: current.deletedAt } : note
  await store.putNote(merged)
  await store.enqueueNote(merged.id)
  noteChanged()
}

export async function deleteNoteTree(store: LocalStore, rootId: string) {
  const notes = store.getSnapshot()
  const ids = subtreeIds(notes.filter((note) => !note.deletedAt), rootId)
  const deletedAt = Date.now()
  for (const note of notes) {
    if (!ids.has(note.id)) continue
    await store.putNote({ ...note, deletedAt, updatedAt: deletedAt })
    await store.deleteDocState(note.id)
    await store.enqueueNote(note.id)
  }
  noteChanged()
}

// Sharing is an online operation: it creates the resource, copies the subtree
// into it (metadata rows plus one full-state update each), soft-deletes the
// private remote rows, and re-homes the local notes. Edits racing the copy are
// healed by the document controller, which pushes any local-only state it
// finds after hydrating a scope.
export async function shareNoteTree(store: LocalStore, root: Note) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) throw new Error('Reconnect to share this page.')
  if (root.shareId) return root.shareId
  const resource = await tallpond.resource.create('shared_notes', { name: root.title || 'Untitled Note', visibility: 'members' })
  const notes = store.getSnapshot().filter((note) => !note.deletedAt && !note.shareId)
  const ids = subtreeIds(notes, root.id)
  const tree = notes.filter((note) => ids.has(note.id))
  const deletedAt = Date.now()
  for (const note of tree) {
    const parentId = note.id === root.id ? '' : note.parentId
    await tallpond.resource(resource.id).table('member_notes').insert({
      noteId: note.id, title: note.title, parentId, deletedAt: 0, clientUpdatedAt: note.updatedAt
    })
    const body = await store.getDocState(note.id)
    if (body) await tallpond.resource(resource.id).table('member_note_updates').insert({
      updateId: crypto.randomUUID(), noteId: note.id, payload: body
    })
    // Re-home locally *before* retiring the private row. The private live
    // subscription reports that soft delete, and only a note already carrying
    // the new scope is protected from it by the cross-scope guard.
    await store.putNote({ ...note, parentId, shareId: resource.id })
    await tallpond.table('notes').update({ deletedAt, clientUpdatedAt: deletedAt }).eq('noteId', note.id)
  }
  const roles = { ...state.roles, [resource.id]: 'owner' }
  localStorage.setItem(`${ROLE_KEY}${resource.id}`, 'owner')
  setState({ roles })
  subscribeLiveForCurrentShares(store)
  return resource.id
}

function subscribeLiveForCurrentShares(store: LocalStore) {
  if (!tallpond || !state.connected) return
  const shareIds = [...new Set(store.getSnapshot().map((note) => note.shareId).filter(Boolean))]
  subscribeLive(tallpond, shareIds)
}

export async function leaveShare(store: LocalStore, shareId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) throw new Error('Reconnect to leave this shared page.')
  await tallpond.resource(shareId).members.leave()
  localStorage.removeItem(`${ROLE_KEY}${shareId}`)
  const roles = { ...state.roles }
  delete roles[shareId]
  setState({ roles })
  await store.removeShare(shareId)
  subscribeLiveForCurrentShares(store)
}

// ---------------------------------------------------------------------------
// Membership and invitations.
// ---------------------------------------------------------------------------

export async function listInvitations(): Promise<InvitationInfo[]> {
  if (!tallpond) return []
  // SDK 0.0.15 defines `invitations` on the internal resource API but does not
  // copy it onto the public callable wrapper (only create/list/browse/static
  // are assigned), so the helper is undefined at runtime. Use it when a later
  // SDK restores it, and call the same authenticated route otherwise.
  const api = tallpond.resource as Partial<{ invitations: (opts: { type: string }) => Promise<InvitationInfo[]> }>
  if (typeof api.invitations === 'function') return api.invitations({ type: 'shared_notes' })
  const response = await tallpond.gateway.request<{ invitations: InvitationInfo[] }>('/v1/resources/invitations?type=shared_notes')
  return response.invitations ?? []
}

export async function acceptInvitation(resourceId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.accept()
  await fullSync()
}

// Opening a shared link: what is this viewer's standing with the resource?
// Returns null when the resource can't be read (a stranger to a private one),
// in which case the caller can still offer to request access blindly.
export async function getResourceInfo(resourceId: string): Promise<ResourceInfo | null> {
  if (!tallpond) return null
  try { return await tallpond.resource(resourceId).get() } catch { return null }
}

// Ask an owner to let you in. Pending until they approve; nothing syncs yet.
export async function requestAccess(resourceId: string, role: 'reader' | 'writer' = 'writer') {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.request({ role })
}

// Join an open (discoverable) resource outright, then pull its pages.
export async function joinResource(resourceId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.join()
  await fullSync()
}

export async function rejectInvitation(resourceId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.reject()
}

// Resolving the handle first means a typo costs nothing: an unshared note is
// still unshared, with no empty resource left behind.
export async function inviteByHandle(shareId: string, handle: string, role: 'reader' | 'writer'): Promise<MemberInfo> {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  const profile = await tallpond.users.byHandle(handle.replace(/^@/, ''))
  if (!profile.id) throw new Error('Tallpond user not found.')
  const invitation = await tallpond.resource(shareId).members.invite(profile.id, { role })
  return {
    userId: profile.id, role, state: invitation.state, kind: 'user',
    ownerId: null, ownerHandle: profile.handle, ownerDisplayName: profile.displayName
  }
}

export async function listMembers(shareId: string): Promise<MemberInfo[]> {
  if (!tallpond) return []
  const members = await tallpond.resource(shareId).members.list()
  if (!members.length) return members
  try {
    const profiles = await tallpond.users(members.map((member) => member.userId)).profiles()
    return members.map((member) => ({
      ...member,
      ownerDisplayName: member.ownerDisplayName || profiles[member.userId]?.displayName || null,
      ownerHandle: member.ownerHandle || profiles[member.userId]?.handle || null
    }))
  } catch { return members }
}
