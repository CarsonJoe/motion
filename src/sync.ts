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
  // A whole-tree pull is running: startup, reconnect, or an explicit retry.
  // Tracked separately because `phase: 'syncing'` cannot carry this — `settle`
  // also uses it to mean "the outbox still has work", which is true through
  // most of ordinary typing and says nothing about how heavy the work is.
  fullSyncing: boolean
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

// "This device has signed in before" — presentation only. It decides whether a
// failure reads as *offline* or as *signed out*, and is never treated as proof
// of a live credential; only `state.connected` is that.
const CONNECTED_KEY = 'motion-connected'
const rememberedLogin = () => Boolean(localStorage.getItem(CONNECTED_KEY))
const rememberLogin = () => localStorage.setItem(CONNECTED_KEY, 'true')

// The gateway's OAuth redirect_uri is the bare origin, so the hash route — which
// is the entire address of a page in this app — does not survive the trip
// through the identity provider. Carrying it in session storage is what keeps a
// shared link that prompts for sign-in from landing the user on the home screen
// instead of the page they were invited to.
const RETURN_KEY = 'motion-return-route'
const stashRoute = () => {
  try { sessionStorage.setItem(RETURN_KEY, window.location.hash) } catch { /* storage unavailable */ }
}
const restoreRoute = () => {
  let stashed = ''
  try {
    stashed = sessionStorage.getItem(RETURN_KEY) ?? ''
    sessionStorage.removeItem(RETURN_KEY)
  } catch { /* storage unavailable */ }
  const hash = stashed || window.location.hash
  window.history.replaceState({}, document.title, `${window.location.pathname}${hash}`)
  // replaceState never fires hashchange, and the router read the URL before the
  // callback resolved, so the restored route has to be announced explicitly.
  if (hash) window.dispatchEvent(new Event('hashchange'))
}

let state: SyncState = { phase: 'local', connected: false, error: null, user: null, roles: storedRoles(), pending: 0, fullSyncing: false }
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

// A failure the user has read should not outlive their attention. The condition
// itself, if it persists, re-reports itself on the next attempt.
export const dismissSyncError = () => setState({ error: null })

// The phase to fall back to when nothing is in flight. An expired session is
// sticky: only an explicit reconnect clears it, so an ordinary keystroke can
// never downgrade the red "Reconnect" prompt to a gray "Saved locally".
const idlePhase = (): SyncPhase =>
  state.phase === 'auth-required' ? 'auth-required'
    : !navigator.onLine ? (state.connected || rememberedLogin() ? 'offline' : 'local')
      : 'local'

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
  // Bounded by progress rather than by an empty queue. A metadata op whose
  // revision keeps moving — a title being typed — can never be dequeued, and
  // looping until it is would cost a gateway round trip per keystroke. A pass
  // that removes nothing hands the work back to the next flush instead.
  // Set when a content update came back permanently rejected. Those ops stay in
  // the outbox, so the user has to be told: otherwise the app reads as fully
  // synced while some of their writing is stuck and going nowhere.
  let rejected = false
  while (true) {
    const ops = await store.listOps()
    if (!ops.length) break
    let progress = false

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
        // A rejected content update is the user's writing, and it exists
        // nowhere else the server can see. This used to fall through to the
        // removeOps below and silently drop it — a 403 from a stale cached role
        // was enough to lose an edit with nothing shown to the user.
        //
        // Keep it queued instead. It is left for a later flush (a role really
        // can come back — an owner re-granting write access), and it does not
        // spin: the op stays, `progress` is not set for it, so a pass that
        // achieves nothing else ends the loop rather than retrying in place.
        rejected = true
        continue
      }
      await store.removeOps(group.map((op) => op.id))
      progress = true
    }

    for (const op of ops) {
      if (op.kind !== 'note') continue
      try {
        if (await pushNoteRow(client, store, op)) progress = true
      } catch (error) {
        if (!isPermanentRejection(error)) throw error
        await store.removeOps([op.id])
        progress = true
      }
    }

    if (!progress) break
  }

  if (rejected) {
    setState({ error: 'Some edits could not be synced — you may no longer have edit access. They are still saved on this device.' })
  }
}

// Resolves true when the op left the outbox — the drain's signal that another
// pass is worth making.
async function pushNoteRow(client: TallpondClient, store: LocalStore, op: NoteOp) {
  const note = store.getNote(op.noteId)
  if (!note) { await store.removeOps([op.id]); return true }
  const table = () => notesTable(client, note.shareId)
  const values = { title: note.title, parentId: note.parentId, deletedAt: note.deletedAt, clientUpdatedAt: note.updatedAt }
  const updated = await table().update(values).eq('noteId', note.id).lte('clientUpdatedAt', note.updatedAt)
  if (!updated.length && !await table().select('noteId').eq('noteId', note.id).maybeSingle()) {
    await table().insert({ noteId: note.id, ...values })
  }
  return store.removeNoteOpIfRev(op)
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
let flushTimer: number | null = null

// Edits arrive per keystroke; pushes do not have to. Content updates already
// merge per note inside the drain and metadata ops coalesce onto one stable
// outbox key, so coalescing the flush itself costs nothing but a fraction of a
// second of latency and removes the round trip per character.
const FLUSH_DELAY_MS = 600
const scheduleFlush = () => {
  if (flushTimer !== null) return
  flushTimer = window.setTimeout(() => { flushTimer = null; void flush() }, FLUSH_DELAY_MS)
}

const refreshPending = async () => {
  if (local) setState({ pending: await local.countOps() })
}

const settle = async () => {
  await refreshPending()
  setState({ phase: state.pending ? 'syncing' : 'synced', error: null })
  retryAttempt = 0
  // Success makes a queued retry pointless. Disarming it also matters for the
  // duplicate-suppression below: an armed timer left over from an outage that
  // is already over would swallow the first report of the next one.
  if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null }
}

// Rounds of automatic retry that pass without telling the user anything. One
// dropped request is not news: the outbox still holds the work, the retry below
// is already scheduled, and on a flaky connection nearly all of these are fixed
// within seconds. Alarming immediately taught the user to distrust an indicator
// that was, in the end, wrong.
const QUIET_RETRIES = 1

// A 401 that reaches us has already survived the SDK's own refresh-and-retry, so
// it usually is a real expiry — but not always. A refresh that lost a race, or
// one that failed against a gateway having a bad minute, arrives looking exactly
// the same, and latching on it costs the user a full trip through the identity
// provider for a session that was never actually dead. So ask the one question
// that separates them before latching. Single-flighted: a burst of 401s from a
// sync in flight is one verdict, not one probe each.
let authCheck: Promise<void> | null = null
function verifyThenLatch(error: unknown) {
  authCheck ??= (async () => {
    if (await confirmSignedOut()) setState({ phase: 'auth-required', connected: false, error: describeError(error) })
    // Still signed in: the 401 was noise. Treat it as any other transient
    // failure — quiet retry, and the outbox still holds the work.
    else scheduleRetry(error)
  })().catch(() => {}).finally(() => { authCheck = null })
}

function reportFailure(error: unknown) {
  if (isAuthError(error)) {
    // A latch already in place is the answer; re-probing on every subsequent
    // request would just hammer the gateway with the user already prompted.
    if (state.phase !== 'auth-required') verifyThenLatch(error)
    return
  }
  scheduleRetry(error)
}

function scheduleRetry(error: unknown) {
  if (!navigator.onLine) { setState({ phase: 'offline' }); return }
  // A retry already queued means this is the same outage reported a second time
  // by another request that was in flight when it hit — one blip, not a new
  // round, and it must not escalate on its own.
  if (retryTimer !== null) return
  // Below the threshold the phase stays 'syncing', which is honest: it really is
  // still trying, and the UI shows a spinner rather than a red alarm.
  setState(retryAttempt >= QUIET_RETRIES
    ? { phase: 'error', error: describeError(error) }
    : { phase: 'syncing', error: null })
  const delay = Math.min(2500 * 2 ** retryAttempt, 60000)
  retryAttempt += 1
  retryTimer = window.setTimeout(() => { retryTimer = null; void resume() }, delay)
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

// Does the server agree this user has lost access to a resource? Only a
// definitive answer counts, because the caller deletes data on `true`:
//
//   • the resource loads and reports no membership → ended
//   • 403/404 — revoked, or the resource itself is gone → ended
//   • anything else, including every network failure → NOT ended
//
// `getResourceInfo` cannot be reused here: it collapses every error to null,
// which would make an offline blip look exactly like revocation.
async function membershipEnded(resourceId: string) {
  if (!tallpond) return false
  try {
    const info = await tallpond.resource(resourceId).get()
    return !info?.currentMember
  } catch (error) {
    return isPermanentRejection(error)
  }
}

export async function fullSync() {
  fullSyncPromise ??= (async () => {
    try {
      if (!tallpond || !local || !state.connected) return
      if (!navigator.onLine) { setState({ phase: 'offline' }); return }
      setState({ phase: 'syncing', error: null, fullSyncing: true })

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

      // A share that has dropped out of the list may be one this user is no
      // longer a member of — deleted, or access revoked, on another device.
      // Without pruning, its notes linger locally forever, editable against a
      // cached role and invisible to everyone else.
      //
      // But absence from that list is NOT proof, and this is the only path in
      // the app that destroys local data irrecoverably: `removeShare` hard
      // deletes the notes, their bodies, AND any unsent outbox rows. Unlike the
      // two cursor loops above, `resource.list()` takes no cursor and returns a
      // bare array (`browse()` is a different, discovery endpoint — not a
      // paginated form of this one), so a truncated or transiently empty
      // response is indistinguishable from genuine revocation. Trusting it cost
      // whole pages.
      //
      // So absence only nominates a candidate; the server has to confirm each
      // one individually before anything is deleted. Anything inconclusive — a
      // network failure, an unexpected status — keeps the notes. Lingering
      // notes are a visible annoyance the next sync can still fix; deleted ones
      // are gone.
      for (const shareId of sharesBefore) {
        if (resources.some((resource) => resource.id === shareId)) continue
        if (!(await membershipEnded(shareId))) continue
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
  })().finally(() => { fullSyncPromise = null; setState({ fullSyncing: false }) })
  return fullSyncPromise
}

// `getSession()` cannot distinguish an unreachable gateway from a real sign-out
// — it swallows the fetch error and reports "not authenticated" either way. So
// before discarding a remembered login (which costs the user a full trip through
// the identity provider) confirm with a call that *can* tell them apart:
// getUser() resolves null only on a 401 and throws everything else.
async function confirmSignedOut() {
  try { return (await tallpond!.auth.getUser()) === null }
  catch (error) { return isAuthError(error) }
}

async function establishSession() {
  if (!tallpond) return false
  const url = new URL(window.location.href)
  if (url.searchParams.get('code') && url.searchParams.get('state')) {
    let failure: unknown = null
    try { await tallpond.auth.handleRedirectCallback(url) }
    catch (error) { failure = error }
    restoreRoute()
    // A callback that was attempted and failed is reported, not swallowed:
    // falling through silently leaves the user pressing Connect over and over
    // against an error only the gateway ever saw.
    if (failure) throw failure
  }
  const session = await tallpond.auth.getSession()
  if (!session.authenticated) {
    if (rememberedLogin() && !await confirmSignedOut()) {
      throw new Error('Could not reach Tallpond to check your session.')
    }
    return false
  }
  rememberLogin()
  setState({ connected: true })
  void tallpond.auth.getUser().then((user: User | null) => {
    if (user) setState({ user: { id: user.id, name: user.profile.displayName || user.profile.handle || 'You' } })
  }).catch(() => {})
  return true
}

// The one re-entry point for automatic recovery: a session that was never
// confirmed is re-established before the sync it was blocking.
async function resume() {
  if (!tallpond || !local) return
  if (!navigator.onLine) { setState({ phase: idlePhase() }); return }
  if (!state.connected) {
    try {
      if (!await establishSession()) {
        // A remembered login that will not establish has expired. That is a
        // "Reconnect", not a "you were never signed in", and it stays on screen
        // until an explicit reconnect clears it.
        const expired = rememberedLogin()
        setState({
          phase: expired ? 'auth-required' : 'local',
          connected: false,
          error: expired ? 'Your Tallpond session expired.' : null
        })
        return
      }
    } catch (error) { reportFailure(error); return }
  }
  await fullSync()
}

export async function startSync(store: LocalStore) {
  if (local) return
  local = store
  await refreshPending()
  window.addEventListener('online', () => {
    if (state.connected || rememberedLogin()) void resume()
    else setState({ phase: 'local' })
  })
  window.addEventListener('offline', () => setState({ phase: idlePhase() }))
  if (!tallpond || !navigator.onLine) { setState({ phase: idlePhase() }); return }
  await resume()
}

// The explicit "Connect" action: finish a pending session if one exists,
// otherwise leave for the identity provider.
export async function connectInteractive() {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) { setState({ phase: idlePhase() }); return }
  // Clearing the phase here is what releases the sticky auth-required latch.
  setState({ phase: 'connecting', error: null })
  try {
    if (await establishSession()) { await fullSync(); return }
  } catch (error) { reportFailure(error); throw error }
  stashRoute()
  await tallpond.auth.signIn()
}

// Local mutation entry point: App persists the note + op, then calls this to
// reflect the pending work and kick a flush.
export function noteChanged() {
  void refreshPending()
  if (!state.connected || !navigator.onLine) { setState({ phase: idlePhase() }); return }
  setState({ phase: 'syncing' })
  scheduleFlush()
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

// Pending access requests across the resources this user administers, so the
// owner can be notified and let people in. A requester's membership sits in the
// 'requested' state until an admin accepts it.
export type AccessRequest = { resourceId: string; userId: string; role: string; handle: string | null; displayName: string | null }

export async function listAccessRequests(): Promise<AccessRequest[]> {
  if (!tallpond) return []
  const adminShares = Object.entries(state.roles).filter(([, role]) => role === 'owner' || role === 'admin').map(([id]) => id)
  const requests: AccessRequest[] = []
  for (const resourceId of adminShares) {
    try {
      for (const member of await listMembers(resourceId)) {
        if (member.state === 'requested') requests.push({ resourceId, userId: member.userId, role: member.role, handle: member.ownerHandle, displayName: member.ownerDisplayName })
      }
    } catch { /* a resource we lost access to just contributes nothing */ }
  }
  return requests
}

export async function approveRequest(resourceId: string, userId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.accept(userId)
}

export async function denyRequest(resourceId: string, userId: string) {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  await tallpond.resource(resourceId).members.reject(userId)
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
