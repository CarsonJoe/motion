import { createClient, type InvitationInfo, type MemberInfo, type MembershipChange, type ResourceInfo, type RoomChange, type RoomInfo, type Row, type TableQuery, type User } from '@tallpond/sdk'
import { mergeBase64Updates } from './codec'
import { adoptScope, ANON_SCOPE, dropScope, openLocalStore, subtreeIds, surveyScope, type LocalStore, type Note, type NoteOp, type ScopeSurvey, type UpdateOp } from './local'

// Tallpond injects gateway config on its hosted origin; local Vite development
// supplies the same two values through .env.local. Developer credentials never
// ship in the bundle — sessions are cookie-backed PKCE logins.
const clientId = import.meta.env.VITE_TALLPOND_CLIENT_ID as string | undefined
const injectedConfig = typeof window === 'undefined' ? null : (window as Window & {
  __TALLPOND__?: { gatewayUrl?: string; clientId?: string }
}).__TALLPOND__
const createTallpondClient = () => {
  try {
    // Hosted config must outrank build-time development variables. Tallpond
    // injects `/_osg` here; a production bundle built on a machine whose
    // .env.local points at Vite's `/tallpond` proxy must not carry that local
    // route onto the hosted origin, where it is an app-shell path and returns
    // 405 for auth refreshes.
    if (injectedConfig?.gatewayUrl && injectedConfig.clientId) return createClient()
    return clientId
      ? createClient({ gatewayUrl: import.meta.env.VITE_TALLPOND_GATEWAY_URL || 'https://api.tallpond.com', clientId })
      : createClient()
  } catch { return null }
}

// A client owns more than configuration: it also owns realtime socket pools,
// reconnect timers, and identity-dependent membership snapshot state. Replace
// it after logout so signing into another account cannot reuse any of those.
export let tallpond = createTallpondClient()

export type TallpondClient = NonNullable<typeof tallpond>

export type SyncPhase = 'checking' | 'local' | 'connecting' | 'offline' | 'syncing' | 'synced' | 'error' | 'auth-required'
export type DeletedElsewhereSurvey = { notes: number; titles: string[]; ids: string[] }
export type SyncState = {
  phase: SyncPhase
  // True once this run has confirmed a valid session. Presentation state like
  // the remembered login is never treated as proof of a live credential.
  connected: boolean
  error: string | null
  user: { id: string; name: string } | null
  // Resource roles and narrower per-room grants, refreshed on every full sync
  // and cached for offline permission checks.
  roles: Record<string, string>
  roomRoles: Record<string, string>
  pending: number
  // Set when signing in found work in the anonymous scope. Purely a question
  // for the user: nothing is moved or dropped until they answer it.
  adoptable: ScopeSurvey | null
  // Previously-synced pages missing from a complete server inventory, but
  // carrying local outbox work. Sync pauses those pages until the user chooses
  // whether to keep the work as new pages or move it to Recently deleted.
  deletedElsewhere: DeletedElsewhereSurvey | null
  // A whole-tree pull is running: startup, reconnect, or an explicit retry.
  // Tracked separately because `phase: 'syncing'` cannot carry this — `settle`
  // also uses it to mean "the outbox still has work", which is true through
  // most of ordinary typing and says nothing about how heavy the work is.
  fullSyncing: boolean
}

// The last identity this device scoped to. It is what lets a cold boot open the
// right database before the network has said anything — without it an offline
// start would show a signed-in user the empty anonymous scope and read as data
// loss. Presentation only, exactly like CONNECTED_KEY below: it names a local
// database, it is never evidence of a live session.
const USER_KEY = 'motion-user'
const storedScope = () => localStorage.getItem(USER_KEY) || ANON_SCOPE
export const initialScope = storedScope

// Roles are cached per identity for offline UI. An unscoped key would hand the
// next user this one's roles, which is the same leak as an unscoped database.
const ROLE_KEY = 'motion-role:'
const rolePrefix = (scope: string) => `${ROLE_KEY}${scope}:`
const storedRoles = (scope: string) => {
  const prefix = rolePrefix(scope)
  const roles: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) roles[key.slice(prefix.length)] = localStorage.getItem(key) ?? ''
  }
  return roles
}
const clearStoredRoles = (scope: string) => {
  const prefix = rolePrefix(scope)
  for (const key of Object.keys(localStorage).filter((candidate) => candidate.startsWith(prefix))) {
    localStorage.removeItem(key)
  }
}
const ROOM_ROLE_KEY = 'motion-room-role:'
const roomRolePrefix = (scope: string) => `${ROOM_ROLE_KEY}${scope}:`
export const roomAccessKey = (shareId: string, roomId: string) => `${shareId}:${roomId}`
const storedRoomRoles = (scope: string) => {
  const prefix = roomRolePrefix(scope)
  const roles: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) roles[key.slice(prefix.length)] = localStorage.getItem(key) ?? ''
  }
  return roles
}
const clearStoredRoomRoles = (scope: string) => {
  const prefix = roomRolePrefix(scope)
  for (const key of Object.keys(localStorage).filter((candidate) => candidate.startsWith(prefix))) localStorage.removeItem(key)
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

// Until startSync has checked connectivity and the remembered session, neither
// “Connect” nor “Offline” is known to be true. Keeping that brief startup state
// explicit prevents either status flashing before the real answer arrives.
let state: SyncState = { phase: 'checking', connected: false, error: null, user: null, roles: storedRoles(storedScope()), roomRoles: storedRoomRoles(storedScope()), pending: 0, fullSyncing: false, adoptable: null, deletedElsewhere: null }
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

// Membership is not durable app data, but changes affect several views at once:
// notification badges, access requests, the share sheet, and the set of resource
// scopes included in sync. Keep the gateway subscription here and expose only a
// small invalidation signal to UI consumers.
export type MembershipEvent = { resourceId: string }
const membershipListeners = new Set<(event: MembershipEvent) => void>()
export const subscribeMembershipChanges = (listener: (event: MembershipEvent) => void) => {
  membershipListeners.add(listener)
  return () => { membershipListeners.delete(listener) }
}
const emitMembershipChange = (resourceId: string) => {
  for (const listener of membershipListeners) listener({ resourceId })
}

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
  roomId: shareId ? String(row.roomId ?? '') : '',
  deletedAt: Number(row.deletedAt ?? 0),
  updatedAt: Number(row.clientUpdatedAt ?? 0)
})

// Resource reads without a room intentionally span every room the caller can
// read. Writes must name the note's exact room, while an empty room id preserves
// the existing default-room behavior.
export const resourceTable = (client: TallpondClient, shareId: string, roomId: string, table: string) =>
  roomId ? client.resource(shareId).room(roomId).table(table) : client.resource(shareId).table(table)

const notesTable = (client: TallpondClient, shareId: string, roomId = '') =>
  shareId ? resourceTable(client, shareId, roomId, 'member_notes') : client.table('notes')

export const updatesTable = (client: TallpondClient, shareId: string, roomId = '') =>
  shareId ? resourceTable(client, shareId, roomId, 'member_note_updates') : client.table('note_updates')

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

export async function drainOutbox(client: TallpondClient, store: LocalStore, blockedNoteIds: ReadonlySet<string> = new Set()) {
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
      if (op.kind !== 'update' || blockedNoteIds.has(op.noteId)) continue
      const key = `${op.shareId}:${op.roomId}:${op.noteId}`
      updates.set(key, [...updates.get(key) ?? [], op])
    }
    for (const group of updates.values()) {
      const { noteId, shareId, roomId } = group[0]
      try {
        await updatesTable(client, shareId, roomId).insert({
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
      if (op.kind !== 'note' || blockedNoteIds.has(op.noteId)) continue
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
  const table = () => notesTable(client, note.shareId, note.roomId)
  const values = { title: note.title, parentId: note.parentId, deletedAt: note.deletedAt, clientUpdatedAt: note.updatedAt }
  const updated = await table().update(values).eq('noteId', note.id).lte('clientUpdatedAt', note.updatedAt)
  if (!updated.length && !await table().select('noteId').eq('noteId', note.id).maybeSingle()) {
    await table().insert({ noteId: note.id, ...values })
  }
  await store.markRemoteKnown(note.id)
  return store.removeNoteOpIfRev(op)
}

// ---------------------------------------------------------------------------
// The engine singleton. App code calls startSync once, then interacts through
// noteChanged / connectInteractive / the share and membership helpers.
// ---------------------------------------------------------------------------

let local: LocalStore | null = null
// How App is told the store underneath it has been replaced by a scope swap.
let onScopeChange: ((store: LocalStore) => void) | null = null
const currentScope = () => local?.scope ?? storedScope()
const roleKey = (shareId: string) => `${rolePrefix(currentScope())}${shareId}`
const roomRoleKey = (shareId: string, roomId: string) => `${roomRolePrefix(currentScope())}${roomAccessKey(shareId, roomId)}`
let liveSubscriptions: Array<{ close: () => void }> = []
const closeLiveSubscriptions = () => {
  for (const subscription of liveSubscriptions) subscription.close()
  liveSubscriptions = []
}
let applyChain = Promise.resolve()
let flushing = false
let flushQueued = false
let retryTimer: number | null = null
let retryAttempt = 0
let fullSyncPromise: Promise<void> | null = null
let sessionRefreshPromise: Promise<void> | null = null
let flushTimer: number | null = null
// resources.live() covers every resource type in the app, including retained
// legacy types Motion no longer syncs. Remember confirmed non-Motion resources
// so their initial snapshot rows cannot repeatedly trigger whole-tree syncs.
const ignoredMembershipResources = new Set<string>()
// In-memory on purpose. If the app closes before the question is answered the
// outbox remains untouched, and the next complete sync discovers it again.
const deletedElsewhereIds = new Set<string>()

// Edits arrive per keystroke; pushes do not have to. Content updates already
// merge per note inside the drain and metadata ops coalesce onto one stable
// outbox key, so coalescing the flush itself costs nothing but a fraction of a
// second of latency and removes the round trip per character.
// Local durability still happens on every edit; this delay only batches the
// network publish. Keeping it comfortably below Tallpond's ~11s realtime
// hibernation window avoids turning an active writing session into a sequence
// of expensive cold coordinator wakes.
const FLUSH_DELAY_MS = 2500
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
    if (await confirmSignedOut()) {
      closeLiveSubscriptions()
      setState({ phase: 'auth-required', connected: false, error: describeError(error) })
    }
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
      await drainOutbox(tallpond, local, deletedElsewhereIds)
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
  closeLiveSubscriptions()
  const onError = (error: unknown) => { if (isAuthError(error)) reportFailure(error) }
  const notes = ['', ...shareIds].map((shareId) => notesTable(client, shareId).select().live()
    .on('insert', applyRemoteRow(shareId))
    .on('update', applyRemoteRow(shareId))
    .on('error', onError))

  // This private-scope feed covers this user's invitations and membership in
  // every resource. An acceptance in another tab must pull the newly available
  // pages; a role change or removal must refresh permissions/local scopes.
  const refreshOwnMembership = (change: MembershipChange | { id: string }) => {
    const resourceId = 'resourceId' in change
      ? change.resourceId
      : change.id.slice(0, change.id.lastIndexOf(':'))
    if (!resourceId) return
    emitMembershipChange(resourceId)

    if (!('state' in change)) {
      // A deletion only matters to Motion if this was one of its known shares.
      if (state.roles[resourceId]) void fullSync().finally(() => emitMembershipChange(resourceId))
      return
    }
    if (change.state !== 'active' || state.roles[resourceId] === change.role) return
    if (shareIds.includes(resourceId)) {
      void fullSync().finally(() => emitMembershipChange(resourceId))
      return
    }
    if (ignoredMembershipResources.has(resourceId)) return

    // The app-wide membership feed also snapshots legacy resource types. An
    // unknown active membership might be a newly accepted shared_notes invite,
    // but blindly treating every unknown row as one creates an infinite loop:
    // fullSync rebuilds the subscription, whose next legacy snapshot triggers
    // fullSync again. Resolve the type once before widening Motion's scopes.
    void client.resource(resourceId).get().then((info) => {
      if (info.type !== 'shared_notes') { ignoredMembershipResources.add(resourceId); return }
      return fullSync().finally(() => emitMembershipChange(resourceId))
    }).catch(() => {})
  }
  const ownMembership = client.resources.live()
    .on('insert', refreshOwnMembership)
    .on('update', refreshOwnMembership)
    .on('delete', refreshOwnMembership)
    .on('error', onError)

  // Room grants are the per-note half of access. Snapshot rows already present
  // in state are ignored so rebuilding subscriptions after a full sync cannot
  // trigger another full sync forever.
  const refreshOwnRoom = (change: RoomChange | { id: string }) => {
    const resourceId = 'resourceId' in change ? change.resourceId : undefined
    if (!resourceId || !shareIds.includes(resourceId)) return
    const roomId = 'roomId' in change ? change.roomId : change.id.slice(0, change.id.lastIndexOf(':'))
    if (!roomId) return
    const key = roomAccessKey(resourceId, roomId)
    if ('role' in change && state.roomRoles[key] === change.role) return
    if (!('role' in change) && !state.roomRoles[key]) return
    void fullSync().finally(() => emitMembershipChange(resourceId))
  }
  const ownRooms = client.rooms.live()
    .on('insert', refreshOwnRoom)
    .on('update', refreshOwnRoom)
    .on('delete', refreshOwnRoom)
    .on('error', onError)

  // Admins additionally receive changes for every member of their resources:
  // new access requests, invite acceptance/rejection, removals, and role edits.
  const managedMemberships = shareIds
    .filter((shareId) => ['owner', 'admin'].includes(state.roles[shareId]))
    .map((shareId) => client.resource(shareId).members.live()
      .on('insert', () => emitMembershipChange(shareId))
      .on('update', () => emitMembershipChange(shareId))
      .on('delete', () => emitMembershipChange(shareId))
      .on('error', onError))

  liveSubscriptions = [...notes, ownMembership, ownRooms, ...managedMemberships]
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

export async function reconcileAuthoritativeAbsence(store: LocalStore, seenByScope: Map<string, Set<string>>) {
  const ops = await store.listOps()
  const pending = new Set(ops.map((op) => op.noteId))
  const conflicts: Note[] = []

  for (const note of store.getSnapshot()) {
    const seen = seenByScope.get(note.shareId)
    // A scope not fetched completely says nothing about absence. Explicit
    // false marks a page created locally by this version; undefined is legacy
    // data, where a queued op is conservatively offered to the user rather than
    // allowed to resurrect an id that may have been purged.
    if (!seen || note.remoteKnown === false || seen.has(note.id)) continue

    if (note.deletedAt) {
      // This device already saw the deletion. The server has now finished the
      // purge, so its old outgoing tombstone is obsolete; retain the local
      // trash copy only for the remainder of its own recovery window.
      await store.removeOpsForNote(note.id)
      if (purgeDueAt(note) <= Date.now()) await store.removeNote(note.id)
      else await store.markRemoteKnown(note.id, false)
    } else if (pending.has(note.id)) conflicts.push(note)
    else await store.removeNote(note.id)
  }

  deletedElsewhereIds.clear()
  for (const note of conflicts) deletedElsewhereIds.add(note.id)
  setState({
    deletedElsewhere: conflicts.length
      ? { notes: conflicts.length, titles: conflicts.slice(0, 8).map((note) => note.title.trim() || 'Untitled'), ids: conflicts.map((note) => note.id) }
      : null
  })
}

export async function fullSync() {
  fullSyncPromise ??= (async () => {
    try {
      const client = tallpond
      if (!client || !local || !state.connected) return
      if (!navigator.onLine) { setState({ phase: 'offline' }); return }
      setState({ phase: 'syncing', error: null, fullSyncing: true })

      // Captured before the resource list is fetched: a share created
      // concurrently by this device is absent here and so is never pruned.
      const sharesBefore = new Set(local.getSnapshot().map((note) => note.shareId).filter(Boolean))
      const seenByScope = new Map<string, Set<string>>()

      // Neither inventory depends on the other. Starting both together removes
      // a full gateway round trip from every startup, including an account with
      // no changes at all.
      const [privateRows, resources] = await Promise.all([
        selectAll((cursor) => {
          const query = client.table('notes').select()
          return cursor ? query.after(cursor) : query
        }),
        client.resource.list({ type: 'shared_notes' })
      ])

      seenByScope.set('', new Set(privateRows.map((row) => String(row.noteId))))
      for (const row of privateRows) await local.applyRemoteNote(rowToNote(row, ''))

      // Shared resources are independent scopes too. Fetch them concurrently;
      // applying their rows remains ordered below so IndexedDB writes stay
      // simple and deterministic.
      const sharedInventories = await Promise.all(resources.map(async (resource) => {
        const handle = client.resource(resource.id)
        const [rows, rooms] = await Promise.all([
          selectAll((cursor) => {
            const query = handle.table('member_notes').select()
            return cursor ? query.after(cursor) : query
          }),
          handle.rooms.list()
        ])
        return { resource, rows, rooms }
      }))
      const roles = { ...state.roles }
      const roomRoles: Record<string, string> = {}
      for (const { resource, rows, rooms } of sharedInventories) {
        if (resource.currentMember?.role) {
          roles[resource.id] = resource.currentMember.role
          localStorage.setItem(roleKey(resource.id), resource.currentMember.role)
        }
        for (const room of rooms) {
          if (room.isDefault || !room.currentGrant?.role) continue
          const key = roomAccessKey(resource.id, room.id)
          roomRoles[key] = room.currentGrant.role
        }
        seenByScope.set(resource.id, new Set(rows.map((row) => String(row.noteId))))
        for (const row of rows) await local.applyRemoteNote(rowToNote(row, resource.id))
      }

      await reconcileAuthoritativeAbsence(local, seenByScope)

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
        localStorage.removeItem(roleKey(shareId))
        delete roles[shareId]
        await local.removeShare(shareId)
      }
      clearStoredRoomRoles(currentScope())
      for (const [key, role] of Object.entries(roomRoles)) localStorage.setItem(`${roomRolePrefix(currentScope())}${key}`, role)
      setState({ roles, roomRoles })
      subscribeLive(client, resources.map((resource) => resource.id))
      await drainOutbox(client, local, deletedElsewhereIds)
      // After the drain, so a delete queued on this device reaches the server
      // before the purge decides whether that page's window has passed.
      await purgeExpired(client, local)
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

  // Signing into another account in a sibling tab replaces this origin's
  // cookies without notifying the old tab. Stop its transports as soon as the
  // session endpoint names a different principal: otherwise an old scope can
  // keep retrying sockets — or, worse, send its outbox under the new account.
  const sessionUserId = session.userId
  if (sessionUserId && sessionUserId !== currentScope()) {
    closeLiveSubscriptions()
    setState({ connected: false, user: null })
  } else if (sessionUserId && state.connected && state.user?.id === sessionUserId) {
    // The common focus check: the session endpoint confirms the same principal.
    // The profile and scoped store are already established, so do not turn one
    // cheap identity check into another user request and a whole-tree sync.
    rememberLogin()
    return true
  }

  // The identity is now on the critical path rather than a background nicety:
  // every local database is scoped by it, so a session we cannot name is a
  // session we cannot safely sync. Failing here is strictly better than
  // proceeding — syncing under an unknown identity is what writes one user's
  // notes into another's scope.
  const user: User | null = await tallpond.auth.getUser()
  if (!user) return false
  // The cookie changed again between the two identity requests. Do not sync
  // either account; the retry will take a fresh, internally consistent reading.
  if (sessionUserId && sessionUserId !== user.id) throw new Error('Your Tallpond session changed while Motion was reconnecting.')
  rememberLogin()
  await applyScope(user.id)
  setState({ connected: true, user: { id: user.id, name: user.profile.displayName || user.profile.handle || 'You' } })
  return true
}

// Repoints every local read and write at this identity's database. Called after
// the session is confirmed and before the first sync touches anything: a
// `fullSync` run against the previous scope would pull the account's notes into
// it and push its notes up as this user, which is the leak this exists to close.
async function applyScope(userId: string) {
  localStorage.setItem(USER_KEY, userId)
  if (!local || local.scope === userId) return
  const previous = local
  const scoped = await openLocalStore(userId)
  await purgeExpiredLocalCopies(scoped)
  local = scoped
  deletedElsewhereIds.clear()
  previous.close()
  onScopeChange?.(scoped)
  setState({ roles: storedRoles(userId), roomRoles: storedRoomRoles(userId), deletedElsewhere: null })
  await refreshPending()

  // Whatever the previous scope held is now untouched by the running app, so
  // asking about it is safe and answering it is never urgent.
  if (previous.scope !== ANON_SCOPE) return
  // A scope holding nothing but tombstones is not worth a dialog — there is no
  // page for the user to recognise — but it is still worth adopting silently so
  // those deletes reach the server.
  const survey = await surveyScope(ANON_SCOPE)
  if (survey.notes) setState({ adoptable: survey })
  else if (survey.deleted || survey.pending) await adoptAnonymousWork()
}

// The one re-entry point for automatic recovery: a session that was never
// confirmed is re-established before the sync it was blocking.
let resumePromise: Promise<void> | null = null
async function resume() {
  resumePromise ??= (async () => {
    if (!tallpond || !local) return
    if (!navigator.onLine) { setState({ phase: idlePhase() }); return }
    try {
      // Re-check even while connected. Cookies are shared by same-origin tabs,
      // so another tab can replace this session without any event in this one.
      if (!await establishSession()) {
        closeLiveSubscriptions()
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
    await fullSync()
  })().finally(() => { resumePromise = null })
  return resumePromise
}

// Returning to a tab is the only browser signal available when a sibling tab
// has replaced httpOnly session cookies. Revalidate the identity, but only pull
// the whole tree if the tab was disconnected or the account actually changed.
// A healthy focus must remain one session request, not a sync/resubscribe cycle.
export function refreshConnection() {
  if (resumePromise) return resumePromise
  sessionRefreshPromise ??= (async () => {
    if (!tallpond || !local || !navigator.onLine) return
    const wasConnected = state.connected
    const previousScope = currentScope()
    try {
      if (!await establishSession()) {
        closeLiveSubscriptions()
        const expired = rememberedLogin()
        setState({
          phase: expired ? 'auth-required' : 'local', connected: false,
          error: expired ? 'Your Tallpond session expired.' : null
        })
        return
      }
    } catch (error) { reportFailure(error); return }
    if (!wasConnected || currentScope() !== previousScope) await fullSync()
  })().finally(() => { sessionRefreshPromise = null })
  return sessionRefreshPromise
}

export async function startSync(store: LocalStore, scopeChanged: (store: LocalStore) => void) {
  if (local) return
  local = store
  onScopeChange = scopeChanged
  await purgeExpiredLocalCopies(store)
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

// ---------------------------------------------------------------------------
// Anonymous work, and leaving.
// ---------------------------------------------------------------------------

// Move the anonymous scope's pages into this account and push them. The prompt
// that leads here is the only place the choice is offered, and the alternative
// keeps the data rather than deleting it, so neither answer loses work.
export async function adoptAnonymousWork() {
  if (!local || local.scope === ANON_SCOPE) return
  try {
    await adoptScope(ANON_SCOPE, local, mergeBase64Updates)
    setState({ adoptable: null })
    await refreshPending()
    scheduleFlush()
  } catch (error) {
    setState({ error: `Could not merge the work saved on this device: ${describeError(error)}` })
  }
}

// "Not now" leaves the anonymous scope exactly where it is: the question comes
// back on the next sign-in, which is a mild annoyance and strictly better than
// a one-click discard of the only copy of something.
export const declineAnonymousWork = () => setState({ adoptable: null })

// The explicit discard, reachable only after the user has been told what it
// contains. Separate from `decline` on purpose — one of these is destructive.
export async function discardAnonymousWork() {
  await dropScope(ANON_SCOPE)
  setState({ adoptable: null })
}

// A complete pull found that these previously-synced ids no longer exist, but
// this device has work queued for them. Keeping copies the latest local state
// into fresh private pages: an explicit recovery, not a resurrection of ids the
// server permanently purged.
// Defers the question without releasing its outbox rows. A later complete sync
// discovers the same ids and asks again.
export const declineDeletedElsewhere = () => setState({ deletedElsewhere: null })

export async function keepDeletedElsewhere() {
  if (!local || !deletedElsewhereIds.size) return
  const ids = new Set(deletedElsewhereIds)
  const originals = local.getSnapshot().filter((note) => ids.has(note.id))
  const newIds = new Map(originals.map((note) => [note.id, crypto.randomUUID()]))
  const now = Date.now()

  for (const note of originals) {
    const id = newIds.get(note.id)!
    const parentId = newIds.get(note.parentId) ?? ''
    const recovered: Note = {
      ...note, id, parentId, shareId: '', roomId: '', deletedAt: 0,
      updatedAt: now, remoteKnown: false
    }
    await local.putNote(recovered)
    const body = await local.getDocState(note.id)
    if (body) {
      await local.putDocState(id, body)
      await local.enqueueUpdate(id, '', '', body)
    }
    await local.enqueueNote(id)
  }
  for (const note of originals) await local.removeNote(note.id)

  deletedElsewhereIds.clear()
  setState({ deletedElsewhere: null })
  noteChanged()
}

// Trash reuses the existing recovery path. Its old outgoing edits are removed
// first so the local tombstone can never recreate the permanently-purged row.
export async function trashDeletedElsewhere() {
  if (!local || !deletedElsewhereIds.size) return
  const now = Date.now()
  for (const id of deletedElsewhereIds) {
    const note = local.getNote(id)
    if (!note) continue
    await local.removeOpsForNote(id)
    await local.putNote({ ...note, deletedAt: now, updatedAt: now, remoteKnown: false })
  }
  deletedElsewhereIds.clear()
  setState({ deletedElsewhere: null })
  noteChanged()
}

// Signing out is refused while the outbox still holds work. It would be
// possible to drain first, but the honest failure — "this device still has
// changes that have not reached the server" — is one the user can act on,
// where a sign-out that quietly dropped them is not recoverable.
export async function signOut() {
  if (!tallpond) return
  if (state.pending > 0) {
    throw new Error(`${state.pending === 1 ? 'One change has' : `${state.pending} changes have`} not synced yet. Wait for syncing to finish, then sign out.`)
  }
  const scope = currentScope()

  // Stop every engine-owned transport before invalidating the cookie. If they
  // remain alive during logout, a reconnect can mint/refresh against the old
  // session while logout is rotating or clearing it. That race can leave the
  // next login with a socket ticket from the account that just signed out.
  closeLiveSubscriptions()
  if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null }
  if (flushTimer !== null) { window.clearTimeout(flushTimer); flushTimer = null }
  setState({ connected: false, user: null })

  const signedOutClient = tallpond
  try { await signedOutClient.auth.signOut() } catch { /* the local half still has to happen */ }
  // The SDK caches socket and membership identity state per client. A fresh
  // client makes logout a hard session boundary even when the next login uses
  // the same browser tab.
  tallpond = createTallpondClient()

  clearStoredRoles(scope)
  clearStoredRoomRoles(scope)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(CONNECTED_KEY)

  // The signed-in scope's database is left on disk untouched. Signing back in
  // re-opens it with everything still there, which is what makes signing out
  // reversible instead of a local wipe. It is not readable by the next user:
  // its name is the previous user's id and nothing but their sign-in reaches it.
  const previous = local
  const anonymous = await openLocalStore(ANON_SCOPE)
  await purgeExpiredLocalCopies(anonymous)
  local = anonymous
  previous?.close()
  onScopeChange?.(anonymous)

  deletedElsewhereIds.clear()
  setState({ phase: 'local', connected: false, error: null, user: null, roles: {}, roomRoles: {}, pending: 0, fullSyncing: false, adoptable: null, deletedElsewhere: null })
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
  // Explicit false distinguishes a new offline page from legacy rows whose
  // provenance predates authoritative-absence reconciliation.
  const merged = current
    ? { ...note, shareId: current.shareId, roomId: current.roomId, deletedAt: current.deletedAt }
    : { ...note, remoteKnown: note.remoteKnown ?? false }
  await store.putNote(merged)
  await store.enqueueNote(merged.id)
  noteChanged()
}

// A soft delete, and nothing more. The body is deliberately left on disk: this
// used to call `deleteDocState` here and in `applyRemoteNote`, which made the
// delete irreversible in fact even though `deletedAt` is reversible in
// principle — restoring a page returned its title and an empty document. The
// bodies are what a trash or archive would have to give back, so they stay
// until something genuinely destroys the page.
//
// The whole subtree is stamped with one identical `deletedAt`, which is also
// the natural key for the deletion as a single undoable operation. Already-
// deleted notes are excluded from the subtree walk, so a child deleted earlier
// keeps its own timestamp and stays a separate deletion rather than being
// folded into this one.
export async function deleteNoteTree(store: LocalStore, rootId: string) {
  const notes = store.getSnapshot()
  const ids = subtreeIds(notes.filter((note) => !note.deletedAt), rootId)
  const deletedAt = Date.now()
  for (const note of notes) {
    if (!ids.has(note.id)) continue
    await store.putNote({ ...note, deletedAt, updatedAt: deletedAt })
    await store.enqueueNote(note.id)
  }
  noteChanged()
}

// How long a deleted page stays recoverable. Long on purpose: a purge is the
// only irreversible act in the app, and the window is also what makes the purge
// safe to run at all. A device that was offline through the purge still has the
// page alive and would re-push it, so the window has to comfortably outlast any
// plausible absence — see `purgeExpired`.
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const purgeDueAt = (note: Note) => note.deletedAt + TRASH_RETENTION_MS

// Copies retained only on this device after an authoritative server purge can
// finish expiring without a connection. Ordinary synced tombstones stay until
// connected purge confirms the corresponding server deletion.
export async function purgeExpiredLocalCopies(store: LocalStore, now = Date.now()) {
  for (const note of store.getSnapshot()) {
    if (note.remoteKnown === false && note.deletedAt && purgeDueAt(note) <= now) {
      await store.removeNote(note.id)
    }
  }
}

// The notes to show in Recently deleted: the top of each deletion, not every
// page it took with it. A note is a root of its deletion if its parent was not
// removed by the same operation — `deleteNoteTree` stamps one timestamp across
// the whole subtree, so that comparison is all it takes to reassemble which
// pages went together.
export function trashRoots(notes: Note[]) {
  const byId = new Map(notes.map((note) => [note.id, note]))
  return notes
    .filter((note) => note.deletedAt && byId.get(note.parentId)?.deletedAt !== note.deletedAt)
    .sort((a, b) => b.deletedAt - a.deletedAt)
}

// Everything removed by the same deletion as `rootId`.
function deletionGroup(notes: Note[], root: Note) {
  const ids = new Set([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const note of notes) {
      if (ids.has(note.id) || note.deletedAt !== root.deletedAt) continue
      if (ids.has(note.parentId)) { ids.add(note.id); changed = true }
    }
  }
  return ids
}

// Undoes one deletion, restoring the pages that went together.
//
// The reparenting is not a nicety. The tree renders by walking `parentId` from
// the root, so a page whose parent is still deleted is not shown anywhere —
// not under its parent, not at the top level, nowhere — and there is no way to
// drag it back. Anything whose parent did not come back with it is re-homed to
// the root instead, which is visible and fixable; leaving it attached to a
// deleted parent would be neither.
export async function restoreNoteTree(store: LocalStore, rootId: string) {
  const notes = store.getSnapshot()
  const root = notes.find((note) => note.id === rootId)
  if (!root?.deletedAt) return
  const ids = deletionGroup(notes, root)
  const alive = (id: string) => Boolean(id) && !ids.has(id) && notes.some((note) => note.id === id && !note.deletedAt)
  const updatedAt = Date.now()
  for (const note of notes) {
    if (!ids.has(note.id)) continue
    const parentId = ids.has(note.parentId) || alive(note.parentId) ? note.parentId : ''
    await store.putNote({ ...note, parentId, deletedAt: 0, updatedAt })
    await store.enqueueNote(note.id)
  }
  noteChanged()
}

// Drops pages whose retention window has passed, locally and on the server.
//
// Only ever called from a connected full sync, and only removes a note locally
// once the server has confirmed the delete. Purging locally while the row still
// existed remotely would just pull it back on the next sync, and purging while
// offline would do exactly that. A failure — most likely a reader or writer
// hitting the `admin` requirement on a shared page — leaves the note in place
// for whichever device does have the rights.
async function purgeExpired(client: TallpondClient, store: LocalStore) {
  const cutoff = Date.now() - TRASH_RETENTION_MS
  for (const note of store.getSnapshot()) {
    if (!note.deletedAt || note.deletedAt > cutoff) continue
    try {
      // Bodies first: a note row removed while its updates survived would leave
      // rows keyed to a note nothing can ever reach again.
      await updatesTable(client, note.shareId, note.roomId).delete().eq('noteId', note.id)
      await notesTable(client, note.shareId, note.roomId).delete().eq('noteId', note.id)
    } catch { continue }
    await store.removeNote(note.id)
  }
}

// Moves one access-homogeneous subtree between rooms. Body rows move first, so
// destination readers never observe metadata for a page whose content is still
// inaccessible. Local placement changes only after both remote tables confirm;
// a crash before then is repaired by the next authoritative pull.
async function rowIdsForNotes(table: () => TableQuery, noteIds: string[]) {
  const ids: string[] = []
  for (let index = 0; index < noteIds.length; index += 100) {
    const chunk = noteIds.slice(index, index + 100)
    const rows = await selectAll((cursor) => {
      const query = table().select('id').in('noteId', chunk)
      return cursor ? query.after(cursor) : query
    })
    ids.push(...rows.map((row) => String(row.id)))
  }
  return ids
}

export async function moveNoteTreeToRoom(client: TallpondClient, store: LocalStore, root: Note, destinationRoomId: string) {
  if (!root.shareId) throw new Error('Share this page before changing its access scope.')
  if (root.roomId === destinationRoomId) return

  // A nested room is an access boundary and is not inherited by a move of its
  // ancestor. Only the contiguous subtree in the root's current scope moves.
  const eligible = store.getSnapshot().filter((note) =>
    !note.deletedAt && note.shareId === root.shareId && note.roomId === root.roomId)
  const ids = subtreeIds(eligible, root.id)
  const tree = eligible.filter((note) => ids.has(note.id))
  if (!tree.some((note) => note.id === root.id)) throw new Error('This page belongs to a different access scope.')

  await drainOutbox(client, store)
  const noteIds = tree.map((note) => note.id)
  const sourceNotes = () => resourceTable(client, root.shareId, root.roomId, 'member_notes')
  const sourceUpdates = () => resourceTable(client, root.shareId, root.roomId, 'member_note_updates')
  const [metadataRowIds, updateRowIds] = await Promise.all([
    rowIdsForNotes(sourceNotes, noteIds),
    rowIdsForNotes(sourceUpdates, noteIds)
  ])
  if (metadataRowIds.length !== noteIds.length) throw new Error('Not every page was ready to move. Sync and try again.')

  // Tallpond names the default room with the resource id at the move boundary;
  // locally it remains the empty string for backwards-compatible routing.
  const destination = destinationRoomId || root.shareId
  if (updateRowIds.length) await sourceUpdates().moveRoom(updateRowIds, destination)
  await sourceNotes().moveRoom(metadataRowIds, destination)
  await store.moveNotesToRoom(ids, destinationRoomId)
}

export async function createNoteRoom(store: LocalStore, root: Note): Promise<RoomInfo> {
  if (!tallpond) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) throw new Error('Reconnect to change access for this page.')
  if (!root.shareId) throw new Error('Share this page before changing its access scope.')
  const userId = state.user?.id
  if (!userId) throw new Error('Reconnect before changing access for this page.')

  const resource = tallpond.resource(root.shareId)
  const room = await resource.rooms.create({ name: root.title || 'Untitled Note' })
  try {
    // Room grants narrow resource roles and cannot confer ownership. Admin is
    // sufficient to manage this page and move it again later.
    await resource.room(room.id).grants.set(userId, 'admin')
    await moveNoteTreeToRoom(tallpond, store, root, room.id)
    const key = roomAccessKey(root.shareId, room.id)
    localStorage.setItem(roomRoleKey(root.shareId, room.id), 'admin')
    setState({ roomRoles: { ...state.roomRoles, [key]: 'admin' } })
    subscribeLiveForCurrentShares(store)
    return room
  } catch (error) {
    // This succeeds only while the room is empty. If a partial remote move made
    // it nonempty, retaining it is safer than concealing those rows.
    await resource.room(room.id).delete().catch(() => {})
    throw error
  }
}

// A share promotion has to survive at every await boundary. The old path wrote
// the remote metadata first and only then remembered the resource locally. If a
// body upload failed between those steps, retrying created another resource and
// collided with the orphaned row's globally-unique noteId.
const shareMigrationKey = (noteId: string) => `motion-share-migration:${currentScope()}:${noteId}`

async function interruptedShare(client: TallpondClient, rootId: string) {
  const resources = await client.resource.list({ type: 'shared_notes' })
  const remembered = localStorage.getItem(shareMigrationKey(rootId))
  const candidates = [...resources].sort((a, b) => Number(b.id === remembered) - Number(a.id === remembered))
  for (const resource of candidates) {
    if (!['owner', 'admin'].includes(resource.currentMember?.role ?? '')) continue
    try {
      const row = await client.resource(resource.id).table('member_notes').select('noteId').eq('noteId', rootId).maybeSingle()
      if (row) return resource
    } catch { /* another candidate may be the interrupted promotion */ }
  }
  return null
}

export async function migrateNoteTreeToShare(client: TallpondClient, store: LocalStore, root: Note, shareId: string) {
  // A nested page already belonging to another share is a scope boundary, not
  // part of this promotion. This mirrors moveBlockedBy's cross-scope invariant.
  const eligible = store.getSnapshot().filter((note) =>
    !note.deletedAt && (!note.shareId || note.shareId === shareId))
  const ids = subtreeIds(eligible, root.id)
  const tree = eligible.filter((note) => ids.has(note.id))
  if (!tree.some((note) => note.id === root.id)) throw new Error('This page belongs to a different shared space.')

  // Persist the complete destination before making another remote write. The
  // outbox is rebuilt from full local state, so old private-scope operations
  // cannot race the promotion and a restart can safely resume it.
  for (const note of tree) {
    const parentId = note.id === root.id ? '' : note.parentId
    await store.removeOpsForNote(note.id)
    await store.putNote({ ...note, parentId, shareId, roomId: '', remoteKnown: false })
    await store.enqueueNote(note.id)
    const body = await store.getDocState(note.id)
    if (body) await store.enqueueUpdate(note.id, shareId, '', body)
  }

  await drainOutbox(client, store)

  // Retire private rows only after their shared replacements are confirmed.
  // Repeating this update is harmless, which makes the whole promotion
  // resumable rather than a one-shot sequence of inserts.
  const deletedAt = Date.now()
  for (const note of tree) {
    // Promotion changes scope, not the note revision. Keeping the same conflict
    // timestamp lets a fresh device deterministically replace this private
    // tombstone with the shared row when it pulls both inventories.
    await client.table('notes').update({ deletedAt, clientUpdatedAt: note.updatedAt }).eq('noteId', note.id)
  }
}

// Sharing is an online operation: create (or recover) the resource, durably
// re-home the subtree, drain its full state, and only then retire private rows.
export async function shareNoteTree(store: LocalStore, root: Note) {
  const client = tallpond
  if (!client) throw new Error('Sync is not configured for this deployment.')
  if (!navigator.onLine) throw new Error('Reconnect to share this page.')

  const migrationKey = shareMigrationKey(root.id)
  if (root.shareId && localStorage.getItem(migrationKey) !== root.shareId) return root.shareId

  let resource = root.shareId
    ? await client.resource(root.shareId).get()
    : await interruptedShare(client, root.id)
  if (!resource) {
    resource = await client.resource.create('shared_notes', { name: root.title || 'Untitled Note', visibility: 'members' })
  }

  localStorage.setItem(migrationKey, resource.id)
  const role = resource.currentMember?.role || 'owner'
  localStorage.setItem(roleKey(resource.id), role)
  setState({ roles: { ...state.roles, [resource.id]: role } })

  await migrateNoteTreeToShare(client, store, root, resource.id)
  localStorage.removeItem(migrationKey)
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
  localStorage.removeItem(roleKey(shareId))
  const roles = { ...state.roles }
  delete roles[shareId]
  const roomRoles = Object.fromEntries(Object.entries(state.roomRoles).filter(([key]) => !key.startsWith(`${shareId}:`)))
  clearStoredRoomRoles(currentScope())
  for (const [key, role] of Object.entries(roomRoles)) localStorage.setItem(`${roomRolePrefix(currentScope())}${key}`, role)
  setState({ roles, roomRoles })
  await store.removeShare(shareId)
  subscribeLiveForCurrentShares(store)
}

// ---------------------------------------------------------------------------
// Membership and invitations.
// ---------------------------------------------------------------------------

export async function listInvitations(): Promise<InvitationInfo[]> {
  if (!tallpond) return []
  return tallpond.resource.invitations({ type: 'shared_notes' })
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
