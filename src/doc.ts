import * as Y from 'yjs'
import type { Row } from '@tallpond/sdk'
import { fromBase64, patchYText, toBase64 } from './codec'
import type { LocalStore, Note } from './local'
import { getSyncState, isAuthError, noteChanged, subscribeSyncState, tallpond, updatesTable } from './sync'

export const LOCAL_ORIGIN = Symbol('motion-local')
export const REMOTE_ORIGIN = Symbol('motion-remote')

// Beyond this many rows, a reader folds the log into one update and deletes
// what it consumed. Yjs updates merge idempotently, so a crash or a concurrent
// compaction can only leave harmless duplicates, never lose state.
const COMPACT_THRESHOLD = 64

export type CollaboratorPresence = {
  presenceId: string
  userId: string
  displayName: string
  color: string
  anchor: number
  focus: number
  active: boolean
  expiresAt: number
}

export type Selection = { anchor: number; focus: number }

export type DocTransport = 'local' | 'connecting' | 'live' | 'offline'

export type NoteDocController = {
  setText: (value: string) => void
  setSelection: (selection: Selection | null) => void
  // Resolves when every local edit so far has reached the doc store and the
  // outbox. Callers that need durability before proceeding await this.
  flushed: () => Promise<void>
  close: () => void
}

const presenceColors = ['#ff6b6b', '#f59f00', '#51cf66', '#22b8cf', '#748ffc', '#b197fc', '#f06595']
const colorFor = (value: string) => presenceColors[[...value].reduce((total, char) => total + char.charCodeAt(0), 0) % presenceColors.length]

async function fetchAllUpdates(shareId: string, noteId: string) {
  const rows: Row[] = []
  let cursor: string | undefined
  do {
    let query = updatesTable(tallpond!, shareId).select().eq('noteId', noteId).limit(200)
    if (cursor) query = query.after(cursor)
    const page = await query.page()
    rows.push(...page.rows)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

export async function openNoteDoc(options: {
  note: Note
  store: LocalStore
  connected: boolean
  writable: boolean
  onText: (text: string, source: 'local' | 'remote' | 'initial') => void
  onPresence: (presence: CollaboratorPresence[]) => void
  onTransport: (transport: DocTransport) => void
  onError: (error: unknown) => void
}): Promise<NoteDocController> {
  const { note, store } = options
  const doc = new Y.Doc()
  const text = doc.getText('content')
  let closed = false

  const saved = await store.getDocState(note.id)
  if (saved) Y.applyUpdate(doc, fromBase64(saved), REMOTE_ORIGIN)

  const emitText = (source: 'local' | 'remote' | 'initial') => options.onText(text.toString(), source)
  const textChanged = (event: Y.YTextEvent) => {
    if (event.transaction.origin === LOCAL_ORIGIN) emitText('local')
    else if (event.transaction.origin === REMOTE_ORIGIN) emitText('remote')
  }
  text.observe(textChanged)

  // Persist-then-queue, serialized per document: the doc store always holds at
  // least what the outbox is about to send, so a crash between the two writes
  // loses nothing locally — hydration heals the server copy instead. State is
  // encoded synchronously at event time so a close can never drop the tail.
  let persistChain = Promise.resolve()
  const persistState = () => {
    const state = toBase64(Y.encodeStateAsUpdate(doc))
    persistChain = persistChain.then(() => store.putDocState(note.id, state)).catch(options.onError)
    return persistChain
  }

  const documentChanged = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL_ORIGIN) { void persistState(); return }
    const payload = toBase64(update)
    persistChain = persistState().then(async () => {
      await store.enqueueUpdate(note.id, note.shareId, payload)
      noteChanged()
    }).catch(options.onError)
  }
  doc.on('update', documentChanged)

  // Local state paints first in every network condition; the network can only
  // improve it.
  emitText('initial')

  let liveSubscription: { close: () => void } | null = null
  let presenceSubscription: { close: () => void } | null = null
  let presenceCleanup = () => {}

  const online = options.connected && navigator.onLine && Boolean(tallpond)
  if (online) {
    options.onTransport('connecting')
    // Subscribe before fetching and buffer inserts until the backfill lands,
    // so no update can fall between the two.
    let bootstrap: Row[] | null = []
    const applyRows = (rows: Row[]) => {
      const updates = rows.flatMap((row) => {
        try { return row.payload ? [fromBase64(String(row.payload))] : [] } catch { return [] }
      })
      if (updates.length) Y.applyUpdate(doc, Y.mergeUpdates(updates), REMOTE_ORIGIN)
    }
    liveSubscription = updatesTable(tallpond!, note.shareId).select().eq('noteId', note.id).live()
      .on('insert', (row) => { if (bootstrap) bootstrap.push(row); else applyRows([row]) })
      .on('status', (status) => {
        if (closed) return
        if (status === 'live') options.onTransport('live')
        else if (status === 'offline') options.onTransport('offline')
        else options.onTransport('connecting')
      })
      .on('error', options.onError)

    void (async () => {
      const rows = await fetchAllUpdates(note.shareId, note.id)
      if (closed) return
      const payloads = rows.flatMap((row) => {
        try { return row.payload ? [fromBase64(String(row.payload))] : [] } catch { return [] }
      })
      const merged = payloads.length ? Y.mergeUpdates(payloads) : null
      if (merged) Y.applyUpdate(doc, merged, REMOTE_ORIGIN)
      const buffered = bootstrap ?? []
      bootstrap = null
      applyRows(buffered)

      // Self-heal: anything this device knows that the fetched log does not —
      // edits made before sharing, or updates lost to a failed flush — is
      // pushed as one diff against the log's state vector.
      if (options.writable) {
        const diff = merged
          ? Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(merged))
          : Y.encodeStateAsUpdate(doc)
        if (diff.length > 2) {
          await store.enqueueUpdate(note.id, note.shareId, toBase64(diff))
          noteChanged()
        }
      }

      if (options.writable && rows.length > COMPACT_THRESHOLD && merged) {
        await updatesTable(tallpond!, note.shareId).insert({
          updateId: crypto.randomUUID(), noteId: note.id, payload: toBase64(merged)
        })
        const ids = rows.map((row) => String(row.updateId))
        for (let index = 0; index < ids.length; index += 100) {
          await updatesTable(tallpond!, note.shareId).delete().in('updateId', ids.slice(index, index + 100))
        }
      }
    })().catch((error) => { if (!isAuthError(error)) options.onError(error) })
  } else {
    options.onTransport(options.connected ? 'offline' : 'local')
  }

  // Presence: ephemeral rows with a 30s lease, upserted on a heartbeat and on
  // selection changes, never queued while offline.
  if (note.shareId && online) {
    // One row per editing session, keyed on the session alone so the row stays
    // addressable for upsert and delete no matter what we learn about the user
    // later. The identity written INTO the row is read fresh on every publish:
    // `establishSession` flips `connected` before the profile fetch it kicks
    // off resolves, and the document opens on that flip, so this device
    // routinely does not know who it is yet. Capturing the name here is what
    // published "Collaborator" — and a random per-session `userId`, which also
    // cost the user their stable presence colour — for the life of the page.
    const sessionId = crypto.randomUUID()
    const presenceId = sessionId
    const identity = () => {
      const user = getSyncState().user
      return { userId: user?.id ?? sessionId, displayName: user?.name ?? 'Collaborator' }
    }
    let selection: Selection | null = null
    let inFlight = false
    let queued = false
    const rows = new Map<string, CollaboratorPresence>()

    const relative = (index: number) =>
      toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(Math.max(index, 0), text.length))))
    const absolute = (value: unknown) => {
      if (typeof value !== 'string' || !value) return 0
      const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(value)), doc)
      return position?.type === text ? position.index : 0
    }

    const emitPresence = () => {
      const now = Date.now()
      for (const [id, value] of rows) if (value.expiresAt <= now) rows.delete(id)
      options.onPresence([...rows.values()].filter((value) => value.presenceId !== presenceId))
    }
    const receivePresence = (row: Row) => {
      const data = typeof row.data === 'object' && row.data ? row.data as Record<string, unknown> : {}
      rows.set(String(row.presenceId), {
        presenceId: String(row.presenceId), userId: String(data.userId ?? ''),
        displayName: String(row.displayName ?? 'Collaborator'),
        color: String(data.color ?? colorFor(String(data.userId ?? row.presenceId))),
        anchor: absolute(data.anchorRel), focus: absolute(data.focusRel),
        active: Boolean(data.active), expiresAt: Number(row.expiresAt ?? 0)
      })
      emitPresence()
    }
    const publishPresence = async () => {
      if (closed || !options.writable || !navigator.onLine) return
      if (inFlight) { queued = true; return }
      inFlight = true
      const { userId, displayName } = identity()
      try {
        await tallpond!.resource(note.shareId).table('member_presence').upsert({
          presenceId, noteId: note.id, displayName,
          data: {
            userId, color: colorFor(userId),
            anchorRel: relative(selection?.anchor ?? 0),
            focusRel: relative(selection?.focus ?? 0),
            active: Boolean(selection)
          },
          expiresAt: Date.now() + 30000
        }, { onConflict: ['presenceId'] })
      } catch (error) { if (!isAuthError(error)) options.onError(error) }
      finally {
        inFlight = false
        if (queued) { queued = false; void publishPresence() }
      }
    }

    presenceSubscription = tallpond!.resource(note.shareId).table('member_presence').select().eq('noteId', note.id).live()
      .on('insert', receivePresence).on('update', receivePresence).on('error', () => {})
    void publishPresence()
    // The profile normally lands a round trip after the document opens. Republish
    // the moment it does, so collaborators see a name within the second rather
    // than at the next heartbeat. Sync state changes on every pending-count tick,
    // so only an actual change of identity is worth a write.
    let publishedUserId = identity().userId
    const unsubscribeIdentity = subscribeSyncState(() => {
      const { userId } = identity()
      if (userId === publishedUserId) return
      publishedUserId = userId
      void publishPresence()
    })
    const heartbeat = window.setInterval(() => void publishPresence(), 10000)
    const expiry = window.setInterval(emitPresence, 5000)
    presenceCleanup = () => {
      unsubscribeIdentity()
      window.clearInterval(heartbeat)
      window.clearInterval(expiry)
      if (options.writable && navigator.onLine) {
        void Promise.resolve(tallpond!.resource(note.shareId).table('member_presence').delete().eq('presenceId', presenceId)).catch(() => {})
      }
    }

    return {
      setText: (value) => doc.transact(() => patchYText(text, value), LOCAL_ORIGIN),
      setSelection: (value) => { selection = value; void publishPresence() },
      flushed: () => persistChain,
      close: () => {
        closed = true
        liveSubscription?.close(); presenceSubscription?.close(); presenceCleanup()
        text.unobserve(textChanged); doc.off('update', documentChanged)
        doc.destroy()
      }
    }
  }

  return {
    setText: (value) => doc.transact(() => patchYText(text, value), LOCAL_ORIGIN),
    setSelection: () => {},
    flushed: () => persistChain,
    close: () => {
      closed = true
      liveSubscription?.close()
      text.unobserve(textChanged); doc.off('update', documentChanged)
      doc.destroy()
    }
  }
}
