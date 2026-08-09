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

// How long a reopen will wait for the previous controller's writes. Long enough
// that a healthy write (single-digit milliseconds) always wins the race, short
// enough that a wedged one costs a stale read rather than an unusable page.
const PERSIST_WAIT_MS = 2000

// Resolves when `work` settles or the deadline passes, whichever comes first,
// and never rejects. The timer is always cleared, so a fast write does not leave
// one pending for the full deadline.
function settleWithin(work: Promise<void> | undefined, ms: number) {
  if (!work) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.catch(() => {}).then(() => { clearTimeout(timer); resolve() })
  })
}

// Outstanding local writes per note, keyed by note id and shared across every
// controller ever opened for it. Persistence is fire-and-forget from the UI's
// point of view — nothing awaits close() — so this map is the only thing that
// can tell a reopening controller that the previous one still owes the database
// an edit. Entries remove themselves once settled.
const pendingWrites = new Map<string, Promise<void>>()

// Reads a note's text without opening a controller, so the sidebar can export a
// page the user isn't currently looking at. Waits on the same pending writes as
// openNoteDoc: a download taken right after an edit must not miss its tail.
export async function readNoteText(store: LocalStore, noteId: string): Promise<string> {
  await settleWithin(pendingWrites.get(noteId), PERSIST_WAIT_MS)
  const saved = await store.getDocState(noteId)
  if (!saved) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromBase64(saved), REMOTE_ORIGIN)
  const text = doc.getText('content').toString()
  doc.destroy()
  return text
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

  // Writes still in flight from a PREVIOUS controller for this same note have
  // to land before we read, or reopening loses whatever they were carrying.
  // Closing does not await them — App's effect cleanup is synchronous and
  // cannot — so navigating away and straight back (the mobile sidebar, most
  // obviously) used to race its own persistence and hydrate from the state
  // before the edit. What came back was a blank page, and the next keystroke
  // then persisted THAT over the good state, making the loss permanent.
  // Bounded, and swallowed, deliberately. A previous controller's write may
  // reject (its `onError` is free to throw) or — an IndexedDB transaction
  // blocked by another tab is the realistic way — never settle at all. Neither
  // may be allowed to stop the page OPENING: waiting forever here would leave a
  // permanently blank document, which is a worse failure than the stale read
  // this wait exists to prevent. Settled-or-timed-out is enough.
  await settleWithin(pendingWrites.get(note.id), PERSIST_WAIT_MS)

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
  //
  // The chain is continued from `pendingWrites`, not started fresh, so it is
  // serialized per NOTE rather than per controller. Two controllers for one
  // note exist whenever the user reopens a page (and briefly whenever the doc
  // effect re-runs on a connection change); giving each its own chain let their
  // writes interleave and let a reopen read behind the one before it.
  let persistChain = pendingWrites.get(note.id) ?? Promise.resolve()
  const track = (next: Promise<void>) => {
    persistChain = next
    pendingWrites.set(note.id, next)
    // Self-cleaning, so the map holds only genuinely outstanding work and a
    // long-lived session does not accumulate an entry per note ever opened.
    // `.catch` before `.finally` so a rejected chain cleans up without also
    // surfacing as an unhandled rejection; the real error already went to
    // `onError` at the point it happened.
    void next.catch(() => {}).finally(() => { if (pendingWrites.get(note.id) === next) pendingWrites.delete(note.id) })
    return next
  }
  const persistState = () => {
    // Encoded HERE, synchronously at event time — never inside the `then`,
    // where the doc may already have been destroyed by a close.
    const encoded = toBase64(Y.encodeStateAsUpdate(doc))
    return track(persistChain.then(() => store.putDocState(note.id, encoded)).catch(options.onError))
  }

  const documentChanged = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL_ORIGIN) { void persistState(); return }
    const payload = toBase64(update)
    track(persistState().then(async () => {
      await store.enqueueUpdate(note.id, note.shareId, payload)
      noteChanged()
    }).catch(options.onError))
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
