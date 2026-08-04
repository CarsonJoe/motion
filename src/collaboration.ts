import * as Y from 'yjs'
import type { Row, TableQuery } from '@tallpond/sdk'
import type { Page } from './db'
import { enqueueContent } from './outbox'
import { fromBase64, LOCAL_ORIGIN, openLocalDocument, patchYText, REMOTE_ORIGIN, seedDocument, toBase64 } from './documentState'
import { tallpond } from './tallpond'

export type CollaboratorPresence = {
  presenceId: string
  userId: string
  displayName: string
  color: string
  anchor: number
  focus: number
  anchorPath: number[] | null
  focusPath: number[] | null
  anchorNodeOffset: number
  focusNodeOffset: number
  active: boolean
  expiresAt: number
}

type Selection = {
  anchor: number
  focus: number
  anchorPath: number[]
  focusPath: number[]
  anchorNodeOffset: number
  focusNodeOffset: number
}

export type DocumentController = {
  setText: (value: string) => void
  setSelection: (selection: Selection | null) => void
  close: () => void
}

type LiveSubscription = {
  on: (event: string, callback: (value: any) => void) => LiveSubscription
  close: () => void
}

const presenceColors = ['#ff6b6b', '#f59f00', '#51cf66', '#22b8cf', '#748ffc', '#b197fc', '#f06595']
const colorFor = (value: string) => presenceColors[[...value].reduce((total, char) => total + char.charCodeAt(0), 0) % presenceColors.length]

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

export async function openDocument(options: {
  page: Page
  connected: boolean
  writable: boolean
  onText: (text: string, source: 'local' | 'remote' | 'initial') => void
  onPresence: (presence: CollaboratorPresence[]) => void
  onTransportState: (state: 'local' | 'connecting' | 'saving' | 'saved' | 'offline') => void
  onLocalOperation: () => void
  onError: (error: unknown) => void
}): Promise<DocumentController> {
  const { page } = options
  const { doc, persistence, text, meta } = await openLocalDocument(page.id)
  let closed = false
  let liveBootstrapRows: Record<string, unknown>[] | null = []
  let updateSubscription: LiveSubscription | null = null
  let presenceSubscription: LiveSubscription | null = null

  seedDocument(doc, text, meta, page)

  const updatesTable = () => page.shareId
    ? tallpond!.resource(page.shareId).table('markdown_updates')
    : tallpond!.table('motion_crdt_updates')
  const snapshotTable = () => page.shareId
    ? tallpond!.resource(page.shareId).table('shared_pages')
    : tallpond!.table('motion_crdt_documents')

  const emitText = (source: 'local' | 'remote' | 'initial') => options.onText(text.toString(), source)

  const textChanged = (event: Y.YTextEvent) => {
    if (event.transaction.origin === REMOTE_ORIGIN) { emitText('remote'); return }
    if (event.transaction.origin === LOCAL_ORIGIN) emitText('local')
  }
  text.observe(textChanged)

  // y-indexeddb persists every update locally. The outbox persists the same
  // local update for transport before a network request is attempted.
  const documentChanged = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL_ORIGIN) return
    options.onTransportState(options.connected && navigator.onLine ? 'saving' : options.connected ? 'offline' : 'local')
    void enqueueContent(page.id, page.shareId, update)
      .then(options.onLocalOperation)
      .catch(options.onError)
  }
  doc.on('update', documentChanged)

  // Local state is the first paint in every network state. Remote hydration may
  // improve it, but can never hold the editor hostage.
  emitText('initial')

  const applyRemoteUpdate = (row: Record<string, unknown>) => {
    if (closed || !row.payload) return
    try { Y.applyUpdate(doc, fromBase64(String(row.payload)), REMOTE_ORIGIN) }
    catch (error) { options.onError(error) }
  }

  const applyRemoteRows = (rows: Array<Record<string, unknown>>) => {
    const updates = rows.flatMap((row) => {
      try { return row.payload ? [fromBase64(String(row.payload))] : [] }
      catch (error) { options.onError(error); return [] }
    })
    if (updates.length) Y.applyUpdate(doc, Y.mergeUpdates(updates), REMOTE_ORIGIN)
  }

  const writeSnapshotCache = async () => {
    if (closed || !options.writable || !navigator.onLine) return
    const cache = { markdown: text.toString(), yState: toBase64(Y.encodeStateAsUpdate(doc)), blocks: [] }
    await snapshotTable().update(cache).eq('pageId', page.id)
  }

  if (options.connected && navigator.onLine && tallpond) {
    options.onTransportState('connecting')
    const snapshotPromise = snapshotTable().select().eq('pageId', page.id).maybeSingle()
    updateSubscription = updatesTable().select().eq('documentId', page.id).live()
          .on('insert', (row) => { if (liveBootstrapRows) liveBootstrapRows.push(row); else applyRemoteUpdate(row) })
          .on('status', (status: string) => {
            if (closed) return
            if (status === 'live') {
              const bootstrap = liveBootstrapRows ?? []
              liveBootstrapRows = null
              applyRemoteRows(bootstrap)
              options.onTransportState('saved')
            } else if (status === 'offline') options.onTransportState('offline')
            else options.onTransportState('connecting')
          })
          .on('error', options.onError) as LiveSubscription
        void snapshotPromise.then((snapshot) => {
          if (closed) return
          if (snapshot?.yState) applyRemoteRows([{ payload: snapshot.yState }])
          else if (text.length) void writeSnapshotCache().catch(options.onError)
        }).catch(options.onError)
        void selectAllRows((cursor) => {
          const query = updatesTable().select().eq('documentId', page.id)
          return cursor ? query.after(cursor) : query
        }).then(async (rows) => {
          if (closed) return
          applyRemoteRows(rows)
          await writeSnapshotCache()
        }).catch(options.onError)
  } else {
    options.onTransportState(options.connected ? 'offline' : 'local')
  }

  // Explicit one-time migration from the former dirty/snapshot system. Once
  // queued, this state lives durably in IndexedDB until the remote insert wins.
  const migrationKey = `motion-outbox-v1:${page.shareId || 'private'}:${page.id}`
  if (options.writable && !localStorage.getItem(migrationKey) && localStorage.getItem(`motion-document-dirty:${page.id}`)) {
    await enqueueContent(page.id, page.shareId, Y.encodeStateAsUpdate(doc))
    localStorage.setItem(migrationKey, '1')
    localStorage.removeItem(`motion-document-dirty:${page.id}`)
    localStorage.removeItem(`motion-document-cloud-seeded:${page.shareId || 'private'}:${page.id}`)
    options.onLocalOperation()
  }

  let selection: Selection | null = null
  let presenceCleanup = () => {}

  if (page.shareId && options.connected && navigator.onLine && tallpond) {
    let currentUserId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    let displayName = 'Collaborator'
    let presenceId = `${currentUserId}:${sessionId}:${page.id}`
    let color = colorFor(currentUserId)
    let identityReady = false
    let presenceInFlight = false
    let presenceQueued = false
    const presenceRows = new Map<string, CollaboratorPresence>()

    const relative = (index: number) => toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, Math.min(Math.max(index, 0), text.length))))
    const absolute = (value: unknown) => {
      if (typeof value !== 'string' || !value) return 0
      const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(value)), doc)
      return position?.type === text ? position.index : 0
    }
    const parsePresence = (row: Record<string, unknown>) => {
      const value = typeof row.selection === 'object' && row.selection ? row.selection as Record<string, unknown> : {}
      return {
        presenceId: String(row.presenceId ?? ''), userId: String(value.userId ?? ''),
        displayName: String(row.displayName ?? 'Collaborator'), color: String(value.color ?? colorFor(String(value.userId ?? row.presenceId))),
        anchor: absolute(value.anchorRelative), focus: absolute(value.focusRelative),
        anchorPath: null, focusPath: null, anchorNodeOffset: 0, focusNodeOffset: 0,
        active: Boolean(value.active), expiresAt: Number(row.expiresAt ?? 0)
      } satisfies CollaboratorPresence
    }
    const emitPresence = () => {
      const now = Date.now()
      for (const [id, value] of presenceRows) if (value.expiresAt <= now) presenceRows.delete(id)
      options.onPresence([...presenceRows.values()].filter((value) => value.presenceId !== presenceId))
    }
    const receivePresence = (row: Record<string, unknown>) => {
      const value = parsePresence(row)
      presenceRows.set(value.presenceId, value)
      emitPresence()
    }
    const publishPresence = async () => {
      if (closed || !options.writable || !identityReady || !navigator.onLine) return
      if (presenceInFlight) { presenceQueued = true; return }
      presenceInFlight = true
      try {
        await tallpond!.resource(page.shareId).table('presence').upsert({
          presenceId, documentId: page.id, displayName,
          selection: {
            userId: currentUserId, color,
            anchorRelative: relative(selection?.anchor ?? 0),
            focusRelative: relative(selection?.focus ?? 0),
            active: Boolean(selection)
          },
          expiresAt: Date.now() + 30000
        }, { onConflict: ['presenceId'] })
      } catch (error) { options.onError(error) }
      finally {
        presenceInFlight = false
        if (presenceQueued) { presenceQueued = false; void publishPresence() }
      }
    }

    presenceSubscription = tallpond.resource(page.shareId).table('presence').select().eq('documentId', page.id).live()
      .on('insert', receivePresence).on('update', receivePresence).on('error', options.onError) as LiveSubscription

    void tallpond.auth.getUser().then((user) => {
      if (user) {
        currentUserId = user.id
        displayName = user.profile.displayName || user.profile.handle || 'Collaborator'
        presenceId = `${currentUserId}:${sessionId}:${page.id}`
        color = colorFor(currentUserId)
      }
    }).catch(options.onError).finally(() => { identityReady = true; void publishPresence() })

    const heartbeat = window.setInterval(() => void publishPresence(), 10000)
    const expiry = window.setInterval(emitPresence, 5000)
    presenceCleanup = () => {
      window.clearInterval(heartbeat)
      window.clearInterval(expiry)
      if (options.writable && identityReady && navigator.onLine) void Promise.resolve(tallpond!.resource(page.shareId).table('presence').eq('presenceId', presenceId).delete()).catch(() => {})
    }

    return {
      setText: (value) => doc.transact(() => patchYText(text, value), LOCAL_ORIGIN),
      setSelection: (value) => { selection = value; void publishPresence() },
      close: () => {
        closed = true
        updateSubscription?.close(); presenceSubscription?.close(); presenceCleanup()
        text.unobserve(textChanged); doc.off('update', documentChanged)
        persistence.destroy(); doc.destroy()
      }
    }
  }

  return {
    setText: (value) => doc.transact(() => patchYText(text, value), LOCAL_ORIGIN),
    setSelection: () => {},
    close: () => {
      closed = true
      updateSubscription?.close()
      text.unobserve(textChanged); doc.off('update', documentChanged)
      persistence.destroy(); doc.destroy()
    }
  }
}
