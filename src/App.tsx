import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { InvitationInfo, MemberInfo } from '@tallpond/sdk'
import { moveBlockedBy, openLocalStore, subtreeIds, type LocalStore, type Note, type ScopeSurvey } from './local'
import { openNoteDoc, readNoteText, type CollaboratorPresence, type DocTransport, type NoteDocController } from './doc'
import { setPageLinkServices, type PageOption } from './pageLinkServices'
import { backlinkSources, getLinksVersion, indexNote, rebuildLinkIndex, subscribeLinks } from './links'
import { pageUrl, readRoute, subscribeRoute, writeRoute, type Route } from './router'
import { exportFileName, fromImportMarkdown, seedNoteBody, toExportMarkdown } from './markdown'
import { useMobileKeyboard, toggleDebug } from './mobileKeyboard'
import { acceptInvitation, adoptAnonymousWork, approveRequest, connectInteractive, declineAnonymousWork, deleteNoteTree, denyRequest, discardAnonymousWork, dismissSyncError, fullSync, getResourceInfo, getSyncState, initialScope, inviteByHandle, joinResource, leaveShare, listAccessRequests, listInvitations, listMembers, noteChanged, rejectInvitation, purgeDueAt, requestAccess, restoreNoteTree, saveNote, shareNoteTree, signOut, startSync, subscribeSyncState, tallpond, trashRoots, type AccessRequest } from './sync'

// Lazily loaded, and prefetched as soon as the local store opens (see below) —
// so in practice the chunk is warm before a page is ever opened, and the
// fallback below is only ever seen on a genuinely cold, slow first load.
//
// The catch handles the one failure a split bundle can have that a single
// bundle cannot. Asset filenames carry a content hash, so a deploy renames this
// chunk; a tab that was already open when the new service worker activated is
// now controlled by it, and the URL this import resolves to belongs to the
// build that worker just evicted. The request misses the cache, misses on the
// server too, and the import rejects — leaving the page body permanently blank,
// because a rejected lazy import never retries itself.
//
// Only a fresh document can know the new filenames, so recovery is a reload.
// Two guards keep that from becoming a loop: it happens at most once per tab
// (the flag is cleared once an import succeeds, so a second deploy in a long
// session can still recover), and never while offline, where a failure means
// the precache is incomplete rather than stale and reloading would fix nothing.
const CHUNK_RELOAD_FLAG = 'motion-chunk-reload'
async function importMarkdownEditor() {
  try {
    const loaded = await import('./markdownEditor')
    sessionStorage.removeItem(CHUNK_RELOAD_FLAG)
    return loaded
  } catch (error) {
    if (!navigator.onLine || sessionStorage.getItem(CHUNK_RELOAD_FLAG)) throw error
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1')
    location.reload()
    // The page is going away; resolving would only render against a dead document.
    return new Promise<never>(() => {})
  }
}
const MarkdownEditor = lazy(importMarkdownEditor)


// Run after the browser has finished the work that is actually on screen.
// Returns a canceller so an effect can drop the callback on unmount.
function whenIdle(work: () => void) {
  const idle = window.requestIdleCallback
  if (idle) {
    const handle = idle(() => work(), { timeout: 2000 })
    return () => window.cancelIdleCallback(handle)
  }
  const handle = window.setTimeout(work, 200)
  return () => window.clearTimeout(handle)
}

const uid = () => crypto.randomUUID()

// Connectivity as a subscribed store. Reading navigator.onLine during render
// only samples it at that moment, so controls gated on it would stay stale
// until some unrelated state change happened to repaint them.
const subscribeOnline = (listener: () => void) => {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => { window.removeEventListener('online', listener); window.removeEventListener('offline', listener) }
}
const getOnline = () => navigator.onLine

// A sync that finishes inside BUSY_DELAY_MS is one the user never needed to
// know about — the resting state of a healthy app is silence, and a word that
// flashes up and vanishes is noise, not information. The delay is long enough
// that only genuinely slow work ever reaches the screen; BUSY_MIN_MS then keeps
// it there long enough to actually be read.
const BUSY_DELAY_MS = 700
const BUSY_MIN_MS = 1200

// True only after `active` has held for `delayMs`, and then for at least
// `minVisibleMs` afterwards. A flap that never outlasts the delay never shows
// at all, which is the point: ordinary typing must leave the screen quiet.
function useDelayedFlag(active: boolean, delayMs: number, minVisibleMs: number) {
  const [visible, setVisible] = useState(false)
  const shownAt = useRef(0)
  useEffect(() => {
    if (active === visible) return
    const wait = active ? delayMs : Math.max(0, minVisibleMs - (Date.now() - shownAt.current))
    const timer = window.setTimeout(() => {
      if (active) shownAt.current = Date.now()
      setVisible(active)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [active, visible, delayMs, minVisibleMs])
  return visible
}

type SyncTone = 'gray' | 'red'
// The interstitial shown when a link points at a page this device can't open
// yet: it might need sign-in, an invite to accept, an open resource to join,
// or a request to the owner.
type LandingStatus = 'checking' | 'sign-in' | 'invited' | 'join' | 'request' | 'requested' | 'unknown'
type Landing = { note: string; resource: string | null; status: LandingStatus; name: string | null }
const EMPTY_NOTES: Note[] = []

function NotificationButton({ count, onClick }: { count: number; onClick: () => void }) {
  return <button className="notification-button" aria-label={count ? `${count} pending invitation${count === 1 ? '' : 's'}` : 'Notifications'} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{count > 0 && <span>{count > 9 ? '9+' : count}</span>}</button>
}

// One quiet word, no mark and no motion. Anything animated is a claim on the
// user's attention, and a sync they did not start and cannot hurry has no
// business making one — a word they can read once and ignore is the whole job.
// `announce` is reserved for whichever copy is actually on screen, so a desktop
// layout showing both doesn't say it twice.
function SyncBusyLabel({ announce = false }: { announce?: boolean }) {
  return <span className="sync-status" {...(announce ? { role: 'status', 'aria-live': 'polite' as const } : {})}>Syncing</span>
}

// Remote carets are placed by walking the rendered markdown to each
// collaborator's absolute text offset. Offsets come from Yjs relative
// positions, so they stay attached to the right characters across edits.
// The question asked once, when signing in finds pages in the anonymous scope
// that are not in the account yet.
//
// The page list is behind a button rather than on the face of the dialog. The
// decision does not turn on the individual titles — it is "is this mine, yes or
// no" — so listing them by default spends the reader's attention on scanning a
// list to reach an answer they already had, and on a phone it pushes the
// buttons off the first screen. The list is one tap away for the case where
// someone genuinely does not recognise the count.
function AdoptDialog({ survey, busy, onMerge, onDecline, onDiscard }: {
  survey: ScopeSurvey
  busy: boolean
  onMerge: () => void
  onDecline: () => void
  onDiscard: () => void
}) {
  const [view, setView] = useState<'summary' | 'pages' | 'discard'>('summary')
  const pageCount = survey.notes === 1 ? '1 page' : `${survey.notes} pages`

  if (view === 'pages') {
    return <section className="share-modal adopt-modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
      <header><div><strong id="adopt-title">Pages on this device</strong><span>{`${pageCount} not in your account yet`}</span></div><button className="modal-close" aria-label="Back" onClick={() => setView('summary')}>←</button></header>
      <ul className="adopt-list">{survey.titles.map((title, index) => <li key={index}>{title}</li>)}{survey.notes > survey.titles.length && <li className="adopt-more">{`and ${survey.notes - survey.titles.length} more`}</li>}</ul>
      <div className="adopt-actions"><span className="adopt-spacer" /><button className="new" disabled={busy} onClick={onMerge}>{busy ? 'Merging…' : 'Merge into my account'}</button></div>
    </section>
  }

  if (view === 'discard') {
    return <section className="share-modal adopt-modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
      <header><div><strong id="adopt-title">Delete these pages?</strong><span>{`${pageCount} will be removed from this device`}</span></div></header>
      <p className="adopt-body">They are not on the server, so this cannot be undone.</p>
      <div className="adopt-actions"><span className="adopt-spacer" /><button disabled={busy} onClick={() => setView('summary')}>Cancel</button><button className="adopt-discard" disabled={busy} onClick={onDiscard}>{busy ? 'Deleting…' : 'Delete them'}</button></div>
    </section>
  }

  return <section className="share-modal adopt-modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
    <header><div><strong id="adopt-title">Bring your local pages with you?</strong><span>{`${pageCount} on this device ${survey.notes === 1 ? 'is' : 'are'} not in your account yet.`}</span></div></header>
    <p className="adopt-body">Merging copies them into your account and syncs them. “Not now” leaves them here untouched — you’ll be asked again next time you sign in.</p>
    {survey.deleted > 0 && <p className="adopt-note">{`${survey.deleted === 1 ? '1 deleted page comes' : `${survey.deleted} deleted pages come`} too, so ${survey.deleted === 1 ? 'it stays' : 'they stay'} deleted everywhere.`}</p>}
    <button className="adopt-see-pages" onClick={() => setView('pages')}>{`See ${survey.notes === 1 ? 'the page' : 'the pages'}`}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></button>
    <div className="adopt-actions"><button className="adopt-discard-link" disabled={busy} onClick={() => setView('discard')}>Delete them</button><span className="adopt-spacer" /><button disabled={busy} onClick={onDecline}>Not now</button><button className="new" disabled={busy} onClick={onMerge}>{busy ? 'Merging…' : 'Merge'}</button></div>
  </section>
}

// How long a deleted page has left, in the terms someone deciding whether to
// recover it actually cares about. Rounds up, so a page with any part of a day
// remaining never reads as "0 days left".
function describeRetention(note: Note) {
  const remaining = purgeDueAt(note) - Date.now()
  if (remaining <= 0) return 'Deleting soon'
  const days = Math.ceil(remaining / 86400000)
  if (days > 1) return `${days} days left`
  const hours = Math.ceil(remaining / 3600000)
  return hours > 1 ? `${hours} hours left` : 'Less than an hour left'
}

function RemoteCursors({ presence, containerRef }: { presence: CollaboratorPresence[]; containerRef: { current: HTMLElement | null } }) {
  const [positions, setPositions] = useState<Array<CollaboratorPresence & { left: number; top: number; height: number }>>([])
  useEffect(() => {
    let frame = 0
    const place = () => {
      frame = 0
      const root = document.querySelector<HTMLElement>('.motion-md-content')
      const container = containerRef.current
      if (!root || !container) { setPositions([]); return }
      const containerRect = container.getBoundingClientRect()
      const textNodes: Text[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) textNodes.push(node as Text)
      setPositions(presence.filter((item) => item.active).flatMap((item) => {
        let remaining = Math.max(0, item.focus)
        let target = textNodes[0]
        let offset = 0
        for (const textNode of textNodes) {
          target = textNode
          if (remaining <= textNode.length) { offset = remaining; break }
          remaining -= textNode.length
          offset = textNode.length
        }
        if (!target) return []
        const range = document.createRange()
        range.setStart(target, Math.min(offset, target.length))
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        if (!rect.height && !rect.width) return []
        return [{ ...item, left: rect.left - containerRect.left, top: rect.top - containerRect.top, height: rect.height || 22 }]
      }))
    }
    const schedulePlace = () => {
      if (!frame) frame = window.requestAnimationFrame(place)
    }
    schedulePlace()
    const root = document.querySelector<HTMLElement>('.motion-md-content')
    const observer = root ? new MutationObserver(schedulePlace) : null
    if (root && observer) observer.observe(root, { subtree: true, childList: true, characterData: true })
    const resizeObserver = root ? new ResizeObserver(schedulePlace) : null
    if (root && resizeObserver) resizeObserver.observe(root)
    window.addEventListener('resize', schedulePlace)
    window.visualViewport?.addEventListener('resize', schedulePlace)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', schedulePlace)
      window.visualViewport?.removeEventListener('resize', schedulePlace)
    }
  }, [presence, containerRef])
  return <>{positions.map((item) => <div className="remote-cursor" key={item.presenceId} style={{ left: item.left, top: item.top, height: item.height, background: item.color }}><span style={{ background: item.color }}>{item.displayName}</span></div>)}</>
}

// `scope` namespaces the per-node expand/menu state so a page that appears in
// both FAVORITES and PAGES tracks each copy independently.
// `recency` carries each note's subtree recency (see subtreeRecency below) so
// every level of the tree can sort by branch activity rather than by the row's
// own timestamp.
// `hiddenRootIds` drops top-level rows that FAVORITES already shows, so a
// favorited root page isn't listed twice. Nested rows are never hidden: a
// favorited child still belongs under its parent in PAGES.
type NoteTreeShared = { scope: string; notes: Note[]; recency: Map<string, number>; activeId: string | null; onOpen: (id: string) => void; menuKey: string | null; onToggleMenu: (key: string, anchor: HTMLElement) => void; expandedIds: Set<string>; onToggleExpanded: (key: string, expanded: boolean) => void; hiddenRootIds?: Set<string>; previewParentId: string | null; dimmedIds: Set<string> | null; dragEnabled: boolean; onDragStart: (note: Note, event: React.PointerEvent, fromScope: string) => void; clickSuppressed: () => boolean; renamingKey: string | null; onRenameSubmit: (note: Note, title: string) => void; onRenameCancel: () => void }

// Marks where the page will come to rest: children sort by recency and the move
// bumps the dragged note's timestamp, so it lands at the top of its new parent.
// The line is absolutely positioned on purpose — inserting a real row would
// reflow the list under the pointer, moving the drop target out from under it
// and flickering between the two states.
// Lines up with where the row's title will start, not where its indent box
// begins: 5px of row padding, 16px per level, the 22px expand-toggle column
// every row reserves whether or not it has children, and .page-link's own 9px
// of padding. Dropping that last 9 put the line more than half an indent step
// short of the text it was pointing at.
function DropLine({ depth }: { depth: number }) {
  return <span className="drop-line" style={{ left: 5 + depth * 16 + 22 + 9 }} />
}

// Most recent activity anywhere in the branch rooted at a note, newest first.
const byRecency = (recency: Map<string, number>) => (a: Note, b: Note) => (recency.get(b.id) ?? b.updatedAt) - (recency.get(a.id) ?? a.updatedAt)

// Only what the tree needs to paint. The cursor-following ghost is a plain DOM
// node instead, so pointer movement never re-renders App — and App owns the
// editor, which is far too heavy to re-render at pointer rate.
type DragState = { noteId: string; targetId: string | null; valid: boolean; fromScope: string }
// The two section headings move a page between the lists rather than around the
// tree: drop on FAVORITES to favorite it, drop back on PAGES to unfavorite. The
// sentinel keeps FAVORITES distinguishable from a real parent id ('' is the top
// level, which PAGES and the blank space below the tree still mean).
const FAVORITES_DROP = 'motion:favorites'

// Pointer-driven because the sidebar is the whole home screen on mobile, where
// HTML5 drag-and-drop does not exist. A mouse drag starts on movement; a touch
// drag starts on a hold, since an immediate start would eat every scroll.
// Hovering a collapsed row deliberately does NOT open it: the rows under the
// pointer would shift mid-drag, and picking up a page with children opened the
// page being dragged, which is never what you meant.
// Nothing follows the pointer: the dimmed subtree and the drop line say what is
// moving and where it will land, and a floating copy of the row only obscures
// the list it is being dropped into.
function useNoteDrag(options: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  canDrop: (noteId: string, targetId: string, fromScope: string) => boolean
  onDrop: (noteId: string, targetId: string, fromScope: string) => void
}) {
  const latest = useRef(options)
  latest.current = options
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // A drag ends on the same pointerup that would otherwise read as a tap on the
  // row, which would navigate away from the page you just moved.
  const suppressClick = useRef(false)
  const apply = (next: DragState | null) => {
    const current = dragRef.current
    dragRef.current = next
    if (!next || !current || current.noteId !== next.noteId || current.targetId !== next.targetId || current.valid !== next.valid) setDrag(next)
  }

  const startDrag = (note: Note, event: React.PointerEvent, fromScope: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const hold = event.pointerType !== 'mouse'
    const origin = { x: event.clientX, y: event.clientY }
    let last = origin
    let active = false
    let holdTimer = 0
    let frame = 0

    const blockScroll = (event: Event) => event.preventDefault()
    const cleanup = () => {
      window.clearTimeout(holdTimer)
      window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('touchmove', blockScroll)
      window.removeEventListener('contextmenu', blockScroll)
    }
    const update = (x: number, y: number) => {
      const zone = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-drop-id]') as HTMLElement | null
      const targetId = zone?.getAttribute('data-drop-id') ?? null
      apply({ noteId: note.id, targetId, fromScope, valid: targetId !== null && latest.current.canDrop(note.id, targetId, fromScope) })
    }
    const tick = () => {
      const box = latest.current.scrollRef.current
      if (box) {
        const rect = box.getBoundingClientRect()
        if (last.y < rect.top + 44) box.scrollTop -= 10
        else if (last.y > rect.bottom - 44) box.scrollTop += 10
      }
      frame = window.requestAnimationFrame(tick)
    }
    const begin = () => {
      if (active) return
      active = true
      window.addEventListener('touchmove', blockScroll, { passive: false })
      window.addEventListener('contextmenu', blockScroll)
      frame = window.requestAnimationFrame(tick)
      update(last.x, last.y)
    }
    const onMove = (event: PointerEvent) => {
      last = { x: event.clientX, y: event.clientY }
      if (active) { update(event.clientX, event.clientY); return }
      const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y)
      // Before a hold matures, movement means the finger is scrolling the list.
      if (hold) { if (travelled > 10) cleanup() }
      else if (travelled > 5) begin()
    }
    const onUp = () => {
      const current = dragRef.current
      cleanup()
      if (active) {
        suppressClick.current = true
        window.setTimeout(() => { suppressClick.current = false }, 0)
        if (current?.valid && current.targetId !== null) latest.current.onDrop(current.noteId, current.targetId, current.fromScope)
      }
      apply(null)
    }
    const onCancel = () => { cleanup(); apply(null) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }

    if (hold) holdTimer = window.setTimeout(begin, 400)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  return { drag, startDrag, clickSuppressed: () => suppressClick.current }
}

// Renaming edits a draft, not the note: a half-typed title must not stream into
// the header and the page list on every keystroke. Escape drops the draft,
// Enter and blur commit it.
function RenameInput({ title, onSubmit, onCancel }: { title: string; onSubmit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(title)
  const committed = useRef(false)
  const commit = () => { if (committed.current) return; committed.current = true; onSubmit(value.trim()) }
  return <input
    className="page-rename-input"
    aria-label="Page name"
    autoFocus
    value={value}
    onChange={(event) => setValue(event.target.value)}
    onFocus={(event) => event.currentTarget.select()}
    onPointerDown={(event) => event.stopPropagation()}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit() }
      else if (event.key === 'Escape') { event.preventDefault(); committed.current = true; onCancel() }
    }}
  />
}

function NoteTreeNode({ note, depth, ...shared }: NoteTreeShared & { note: Note; depth: number }) {
  const { scope, notes, activeId, onOpen, menuKey, onToggleMenu, expandedIds, onToggleExpanded, previewParentId, dimmedIds, dragEnabled, onDragStart, clickSuppressed, renamingKey, onRenameSubmit, onRenameCancel } = shared
  const key = `${scope}:${note.id}`
  const hasChildren = notes.some((child) => child.parentId === note.id)
  const expanded = expandedIds.has(key)
  // The whole subtree greys out: the children travel with the row being moved.
  const dragging = dimmedIds?.has(note.id)
  return <div className="page-tree-item">
    <div data-drop-id={dragEnabled ? note.id : undefined} className={`page-row ${activeId === note.id ? 'active' : ''} ${dragging ? 'dragging' : ''}`}>{hasChildren ? <button className="page-toggle" style={{ marginLeft: 5 + depth * 16 }} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${note.title || 'Untitled'}`} aria-expanded={expanded} onClick={() => onToggleExpanded(key, expanded)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg></button> : <span className="page-toggle-spacer" style={{ marginLeft: 5 + depth * 16 }} />}{renamingKey === key
      ? <RenameInput title={note.title} onSubmit={(title) => onRenameSubmit(note, title)} onCancel={onRenameCancel} />
      : <button className="page-link" onPointerDown={dragEnabled ? (event) => onDragStart(note, event, scope) : undefined} onClick={() => { if (!clickSuppressed()) onOpen(note.id) }}><span className="page-link-label">{note.title || 'Untitled'}</span></button>}<button className={`page-menu-button ${menuKey === key ? 'menu-open' : ''}`} aria-label={`Page options for ${note.title || 'Untitled'}`} aria-haspopup="menu" aria-expanded={menuKey === key} onClick={(event) => onToggleMenu(key, event.currentTarget)}>•••</button>{previewParentId === note.id && <DropLine depth={depth + 1} />}</div>
    {hasChildren && expanded && <NoteTree {...shared} parentId={note.id} depth={depth + 1} />}
  </div>
}

function NoteTree({ parentId, depth, ...shared }: NoteTreeShared & { parentId: string; depth: number }) {
  const hidden = parentId === '' ? shared.hiddenRootIds : undefined
  // Nested lines hang off the parent row; the top level has no row to hang off,
  // so it draws its own against the nav.
  const rootPreview = parentId === '' && shared.previewParentId === ''
  return <>{rootPreview && <DropLine depth={depth} />}{shared.notes.filter((note) => note.parentId === parentId && !hidden?.has(note.id)).sort(byRecency(shared.recency)).map((note) => <NoteTreeNode key={note.id} {...shared} note={note} depth={depth} />)}</>
}

function PageMenu({ anchor, note, canDelete, isFavorite, onToggleFavorite, onCreateChild, onRename, onDownload, onDelete, onClose }: { anchor: HTMLElement; note: Note; canDelete: boolean; isFavorite: boolean; onToggleFavorite: (id: string) => void; onCreateChild: (note: Note) => void; onRename: (note: Note) => void; onDownload: (note: Note) => void; onDelete: (note: Note) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = ref.current?.offsetWidth ?? 160
      const height = ref.current?.offsetHeight ?? 160
      const gap = 6
      let left = Math.min(rect.right - width, window.innerWidth - width - 8)
      if (left < 8) left = 8
      let top = rect.bottom + gap
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - gap)
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onClose, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onClose, true) }
  }, [anchor, onClose])
  return createPortal(
    <div ref={ref} className="page-menu" role="menu" style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      <button role="menuitem" onClick={() => onToggleFavorite(note.id)}><svg viewBox="0 0 24 24" aria-hidden="true" fill={isFavorite ? 'currentColor' : 'none'}><path d="m12 3 2.7 5.5 6 .9-4.35 4.24 1.03 6-5.38-2.83L6.62 19.6l1.03-6L3.3 9.4l6-.9z" /></svg>{isFavorite ? 'Remove from favorites' : 'Add to favorites'}</button>
      <button role="menuitem" onClick={() => onRename(note)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M14 6l4 4" /></svg>Rename</button>
      <button role="menuitem" onClick={() => onCreateChild(note)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M12 6v12M6 12h12" /></svg>New subpage</button>
      <button role="menuitem" onClick={() => onDownload(note)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></svg>Download</button>
      <button role="menuitem" className="danger" onClick={() => onDelete(note)}>{canDelete
        ? <><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>Delete page</>
        : <><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M14 5H6v14h8" /><path d="M12 12h8m0 0-3-3m3 3-3 3" /></svg>Leave page</>}</button>
    </div>,
    document.body,
  )
}

// Page-level actions for the open page. Shares the anchored-dropdown chrome
// with the sidebar's per-row menu (`.page-menu`), so there is one popup style
// in the app rather than two that drift apart.
function HeaderMenu({ anchor, canShare, onShare, onCopyMarkdown, onDownload, onClose }: {
  anchor: HTMLElement
  canShare: boolean
  onShare: () => void
  onCopyMarkdown: () => void
  onDownload: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = ref.current?.offsetWidth ?? 190
      const height = ref.current?.offsetHeight ?? 120
      const gap = 6
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
      const top = rect.bottom + gap + height > window.innerHeight - 8
        ? Math.max(8, rect.top - height - gap)
        : rect.bottom + gap
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onClose, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onClose, true) }
  }, [anchor, onClose])
  return createPortal(
    <div ref={ref} className="page-menu header-menu" role="menu" style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      <button role="menuitem" disabled={!canShare} onClick={onShare}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M12 3v12m0-12L8 7m4-4 4 4" /><path d="M7 10H5v10h14V10h-2" /></svg>Share</button>
      <button role="menuitem" onClick={onCopyMarkdown}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4V4h11v1" /></svg>Copy as Markdown</button>
      <button role="menuitem" onClick={onDownload}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M12 4v11m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></svg>Download</button>
    </div>,
    document.body,
  )
}

// Account-level actions, hung off the sidebar's identity button. Recently
// deleted lives here rather than in the tree: it is a place you visit to undo
// something, not a peer of the pages you navigate every day. Shares `.page-menu`
// chrome with the other two dropdowns.
function IdentityMenu({ anchor, name, connected, signOutBlocked, trashCount, onTrash, onConnect, onSignOut, onClose }: {
  anchor: HTMLElement
  name: string
  connected: boolean
  signOutBlocked: boolean
  trashCount: number
  onTrash: () => void
  onConnect: () => void
  onSignOut: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = ref.current?.offsetWidth ?? 220
      const height = ref.current?.offsetHeight ?? 120
      const gap = 6
      // Left-aligned to the button it hangs from, unlike the page menus, which
      // hang off a right-hand icon and align to their right edge.
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      const top = rect.bottom + gap + height > window.innerHeight - 8
        ? Math.max(8, rect.top - height - gap)
        : rect.bottom + gap
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onClose, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onClose, true) }
  }, [anchor, onClose])
  return createPortal(<>
    <div className="menu-scrim" onMouseDown={onClose} />
    <div ref={ref} className="page-menu identity-menu" role="menu" style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}>
      <div className="identity-menu-head">{name}</div>
      <button role="menuitem" onClick={onTrash}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>Recently deleted{trashCount > 0 && <span className="identity-menu-count">{trashCount}</span>}</button>
      {connected
        ? <button role="menuitem" disabled={signOutBlocked} title={signOutBlocked ? 'Waiting for your changes to finish syncing' : undefined} onClick={onSignOut}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M16 17l5-5-5-5M21 12H9M12 21H5V3h7" /></svg>Sign out</button>
        : <button role="menuitem" onClick={onConnect}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M9 12H4M8 8l-4 4 4 4M15 3h4v18h-4" /></svg>Connect to Tallpond</button>}
    </div>
  </>, document.body)
}

// --- `[[` picker ranking ----------------------------------------------------
// Results are ordered by how well the title matches, then by how close the page
// sits to the one being edited (a sibling called "Spec" is nearly always the one
// meant), then by recency. Titles are allowed to collide, so each result also
// carries the shortest ancestor suffix that tells it apart from the *other shown
// results* with the same title — and nothing at all when its title is already
// unique among them, which is the common case.

const PAGE_RESULT_LIMIT = 10
const editedOn = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
// Titles carry whatever whitespace was typed into them. Two pages called "Todo"
// and "Todo " read as identical and must be treated as identical — otherwise
// they look like a collision the picker failed to resolve. Matching, grouping
// and the row label all go through this.
const cleanTitle = (title: string) => title.replace(/\s+/g, ' ').trim()

function rankPages(notes: Note[], activeId: string, query: string): PageOption[] {
  const byId = new Map(notes.map((note) => [note.id, note]))
  // The chain from the page being edited up to the root. A candidate's parent's
  // position in it is its distance from "here"; 0 is a child of the open page,
  // 1 a sibling, and so on. Anything off the chain sorts after all of it.
  const chain: string[] = []
  for (let id = activeId; id && !chain.includes(id);) { chain.push(id); id = byId.get(id)?.parentId ?? '' }
  chain.push('')
  const distanceOf = new Map(chain.map((id, index) => [id, index]))

  const q = cleanTitle(query).toLowerCase()
  const scored: { note: Note; rank: number; distance: number }[] = []
  for (const note of notes) {
    if (note.id === activeId) continue
    const title = cleanTitle(note.title || '').toLowerCase()
    let rank = 4
    if (q) {
      if (title === q) rank = 0
      else if (title.startsWith(q)) rank = 1
      else if (title.split(/\W+/).some((word) => word.startsWith(q))) rank = 2
      else if (title.includes(q)) rank = 3
      else continue
    }
    scored.push({ note, rank, distance: distanceOf.get(note.parentId) ?? chain.length })
  }
  scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance || b.note.updatedAt - a.note.updatedAt)
  const top = scored.slice(0, PAGE_RESULT_LIMIT).map((entry) => entry.note)

  // Ancestor titles, nearest first, and the display path built from the nearest
  // `depth` of them. A top-level page has no ancestors, so it says where it is.
  const ancestorsOf = (note: Note) => {
    const names: string[] = []
    for (let id = note.parentId; id && names.length < 12;) {
      const parent = byId.get(id)
      if (!parent) break
      names.push(cleanTitle(parent.title) || 'Untitled')
      id = parent.parentId
    }
    return names
  }
  const pathOf = (names: string[], depth: number) => names.length === 0 ? 'Top level' : names.slice(0, depth).reverse().join(' / ')

  const groups = new Map<string, Note[]>()
  for (const note of top) {
    const key = cleanTitle(note.title || '').toLowerCase()
    const group = groups.get(key) ?? []
    group.push(note)
    groups.set(key, group)
  }
  const context = new Map<string, string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const chains = group.map(ancestorsOf)
    const deepest = Math.max(1, ...chains.map((names) => names.length))
    group.forEach((note, index) => {
      let path = ''
      let resolved = false
      for (let depth = 1; depth <= deepest; depth++) {
        path = pathOf(chains[index], depth)
        if (chains.every((other, at) => at === index || pathOf(other, depth) !== path)) { resolved = true; break }
      }
      // Same title in the same place: location can never separate them, so fall
      // back to the one thing that does.
      context.set(note.id, resolved ? path : `${path} · ${editedOn(note.updatedAt)}`)
    })
  }

  return top.map((note) => ({ id: note.id, title: cleanTitle(note.title), kind: 'page', context: context.get(note.id) }))
}

// --- sidebar search ----------------------------------------------------------
// Titles only. There is no body index in the app (`links.ts` indexes outgoing
// links, not text), and building one over every CRDT doc to answer a keystroke
// would cost more than it returns — a page you can name is the case worth being
// instant. Ranking mirrors the `[[` picker: exact, prefix, word-prefix,
// substring. Every result carries its full path, because in a tree the same
// title in two places is the ambiguity search has to resolve.
const SEARCH_RESULT_LIMIT = 40
function searchPages(notes: Note[], query: string) {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const pathOf = (note: Note) => {
    const names: string[] = []
    const seen = new Set<string>([note.id])
    for (let id = note.parentId; id && !seen.has(id) && names.length < 12;) {
      const parent = byId.get(id)
      if (!parent) break
      names.unshift(cleanTitle(parent.title) || 'Untitled')
      seen.add(id)
      id = parent.parentId
    }
    return names.join(' / ')
  }
  const q = cleanTitle(query).toLowerCase()
  const scored: { note: Note; rank: number }[] = []
  for (const note of notes) {
    const title = cleanTitle(note.title || '').toLowerCase()
    let rank = 4
    if (q) {
      if (title === q) rank = 0
      else if (title.startsWith(q)) rank = 1
      else if (title.split(/\W+/).some((word) => word.startsWith(q))) rank = 2
      else if (title.includes(q)) rank = 3
      else continue
    }
    scored.push({ note, rank })
  }
  scored.sort((a, b) => a.rank - b.rank || b.note.updatedAt - a.note.updatedAt)
  return scored.slice(0, SEARCH_RESULT_LIMIT).map(({ note }) => ({ note, path: pathOf(note) }))
}

export default function App() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('motion-sidebar-collapsed') !== 'true')
  const collapseSidebar = () => { setSidebarOpen(false); localStorage.setItem('motion-sidebar-collapsed', 'true') }
  const openSidebar = () => { setSidebarOpen(true); localStorage.removeItem('motion-sidebar-collapsed') }
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 760)
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [docTransport, setDocTransport] = useState<DocTransport>('local')
  const [collaborativeMarkdown, setCollaborativeMarkdown] = useState<{ noteId: string; value: string } | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [inviteHandle, setInviteHandle] = useState('')
  const inviteInputRef = useRef<HTMLInputElement>(null)
  const [inviteRole, setInviteRole] = useState<'reader' | 'writer'>('writer')
  const [members, setMembers] = useState<MemberInfo[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [invitations, setInvitations] = useState<InvitationInfo[]>([])
  const [requests, setRequests] = useState<AccessRequest[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  // The three sidebar surfaces that open over the tree. Only one at a time —
  // each opener closes the others, since they all cover the same column.
  const [identityOpen, setIdentityOpen] = useState(false)
  const [identityAnchor, setIdentityAnchor] = useState<HTMLElement | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [trashViewOpen, setTrashViewOpen] = useState(false)
  const [remotePresence, setRemotePresence] = useState<CollaboratorPresence[]>([])
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  // Menu/expand state is keyed by `${scope}:${noteId}` so a page shown in both
  // the FAVORITES and PAGES sections is controlled independently in each.
  const [noteMenuId, setNoteMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const onToggleMenu = useCallback((key: string, anchor: HTMLElement) => { setMenuAnchor(anchor); setNoteMenuId((current) => current === key ? null : key) }, [])
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const onRenameCancel = useCallback(() => setRenamingKey(null), [])
  // Two layers. `expandedIds` is what the user opened by hand and it survives
  // navigation. On top of that the tree auto-reveals the path to the open page,
  // which is derived state — walk away from the page and the branch closes
  // itself again. `collapsedIds` is the escape hatch: collapsing an
  // auto-revealed branch has to win over the derivation, or the chevron would
  // do nothing. It is scoped to one page open (cleared below on navigation) so
  // the next page still reveals itself.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const onToggleExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedIds((current) => { const next = new Set(current); if (expanded) next.delete(key); else next.add(key); return next })
    setCollapsedIds((current) => { const next = new Set(current); if (expanded) next.add(key); else next.delete(key); return next })
  }, [])
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('motion-favorites') || '[]') as string[]) } catch { return new Set() }
  })
  const toggleFavorite = useCallback((id: string) => {
    setFavorites((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id); else next.add(id)
      localStorage.setItem('motion-favorites', JSON.stringify([...next]))
      return next
    })
  }, [])
  const [titleDraft, setTitleDraft] = useState<{ noteId: string | null; value: string }>({ noteId: null, value: '' })
  const [pendingRoute, setPendingRoute] = useState<Route>(() => readRoute())
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<HTMLElement | null>(null)
  const [scrollY, setScrollY] = useState(0)
  // Desktop only: the formatting toolbar is noise when nobody is typing, so the
  // header shows it while the caret is in the page body, and otherwise falls
  // back to the breadcrumb path — but only when the sidebar is closed, since an
  // open sidebar already says where you are. Only the body counts — the title is a plain
  // textarea that none of these tools apply to, and the header's own controls
  // (sidebar, page menu, breadcrumb links) are navigation, not writing. The
  // toolbar is in scope because its buttons take focus out of the
  // contenteditable, and dropping it mid-click would pull the button out from
  // under the pointer.
  const [editing, setEditing] = useState(false)
  // `parentId` is the page the files would land under — null while the cursor
  // is anywhere that cannot answer that question, which is what makes the drop
  // refuse rather than guess.
  const [fileDrag, setFileDrag] = useState<{ parentId: string | null } | null>(null)
  const [landing, setLanding] = useState<Landing | null>(null)
  const [landingBusy, setLandingBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const mirrorReadyRef = useRef(false)
  const controllerRef = useRef<NoteDocController | null>(null)
  const contentTouchRef = useRef(new Map<string, number>())

  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)
  const online = useSyncExternalStore(subscribeOnline, getOnline)
  const subscribeNotes = useCallback((listener: () => void) => store ? store.subscribe(listener) : () => {}, [store])
  const getNotes = useCallback(() => store ? store.getSnapshot() : EMPTY_NOTES, [store])
  const allNotes = useSyncExternalStore(subscribeNotes, getNotes)
  const notes = useMemo(() => allNotes.filter((note) => !note.deletedAt), [allNotes])

  // Startup order matters here. Opening the store and painting what is already
  // on this device is the only thing on the critical path; everything else —
  // reaching the network, pulling down the editor chunk — is started after, and
  // never awaited before the first render of real content.
  useEffect(() => {
    let cancelled = false
    // The scope opened here is the last identity this device used, so a signed-in
    // user — including one starting offline — paints their own pages immediately
    // and never sees the empty anonymous scope flash past. Sync confirms the
    // session afterwards and swaps the store only if the identity turns out to
    // have changed.
    void openLocalStore(initialScope()).then((opened) => {
      if (cancelled) { opened.close(); return }
      setStore(opened)
      // Warm the editor chunk while the user is still reading the page list, so
      // opening a page does not pay for the download. Idle so it cannot compete
      // with the first paint of the shell.
      whenIdle(() => { void importMarkdownEditor() })
      // Every consumer of the store keys off this state, so a swap tears down
      // and rebuilds the doc controller and the link index the same way a route
      // change does. Nothing else has to know a swap happened.
      void startSync(opened, (scoped) => { if (!cancelled) setStore(scoped) })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const resize = () => setIsMobile(window.innerWidth <= 760)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const loadInvitations = useCallback(async () => {
    if (!getSyncState().connected || !navigator.onLine) return
    setNotificationsLoading(true)
    try {
      const [invites, incoming] = await Promise.all([listInvitations(), listAccessRequests()])
      setInvitations(invites)
      setRequests(incoming)
    }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not load notifications') }
    finally { setNotificationsLoading(false) }
  }, [])

  // Membership has no realtime channel, so notifications are fetched on connect
  // and on window focus — event-driven, no background timer.
  useEffect(() => {
    if (!sync.connected) { setInvitations([]); setRequests([]); return }
    void loadInvitations()
    const refresh = () => void loadInvitations()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [sync.connected, loadInvitations])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShareOpen(false); setNoteMenuId(null) } }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => {
    const outsideMenu = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.page-menu, .page-menu-button')) setNoteMenuId(null)
      if (!target.closest('.page-menu, .page-options-button')) setHeaderMenuOpen(false)
      if (!target.closest('.notification-center, .notification-button')) setNotificationsOpen(false)
    }
    document.addEventListener('pointerdown', outsideMenu)
    return () => document.removeEventListener('pointerdown', outsideMenu)
  }, [])
  useEffect(() => {
    // focusout lands while activeElement is still <body>, so the read is
    // deferred a tick — otherwise every click that moves focus from the editor
    // to a toolbar button would blink the toolbar out and back in.
    let pending = 0
    const track = () => {
      clearTimeout(pending)
      pending = window.setTimeout(() => {
        const active = document.activeElement
        setEditing(Boolean(active && active !== document.body && active.closest('.mdxeditor, .editor-toolbar')))
      }, 0)
    }
    track()
    document.addEventListener('focusin', track)
    document.addEventListener('focusout', track)
    return () => { clearTimeout(pending); document.removeEventListener('focusin', track); document.removeEventListener('focusout', track) }
  }, [])
  // A new page means a new document; nothing is focused in it yet.
  useEffect(() => { setEditing(false) }, [activeId])

  // Resolved against every note, not just the live ones: a page in Recently
  // deleted can be opened and read, it just cannot be edited until it is
  // recovered. Everywhere that must not show deleted pages — the tree, search,
  // backlinks — filters on `notes` instead.
  const activeNote = useMemo(() => allNotes.find((note) => note.id === activeId) ?? null, [allNotes, activeId])
  const activeTrashed = Boolean(activeNote?.deletedAt)
  // Everything below the body has to wait for the body. The doc opens
  // asynchronously (and is cleared on every note switch), so for a frame or two
  // the article is just a title — anything after it paints hard under the header
  // and is then shoved down once the editor mounts and claims its min-height.
  // Mirrors the editor's own gate in the article below; keep the two in step.
  const bodyMounted = Boolean(toolbarHost && activeNote && collaborativeMarkdown?.noteId === activeNote.id)
  // Sort key for the sidebar: the newest updatedAt anywhere in a note's subtree,
  // not just its own. Editing a nested subpage is activity on the whole branch
  // holding it, so its ancestors have to rise with it — otherwise a root whose
  // child changed a minute ago sits below one untouched for months, and the
  // top level (the part you actually navigate by) never reflects real use.
  // Each note pushes its timestamp up the whole parent chain, taking a max at
  // every step. Stopping early at an ancestor that already holds something newer
  // would also be correct, but only because getSnapshot happens to hand us notes
  // sorted by updatedAt — an invariant in another file that nothing here would
  // notice losing. A full walk costs a pass per depth level on a note tree and
  // owes nothing to input order. `seen` guards a corrupt parent chain, the same
  // way the breadcrumb walk does.
  const subtreeRecency = useMemo(() => {
    const byId = new Map(notes.map((note) => [note.id, note]))
    const recency = new Map(notes.map((note) => [note.id, note.updatedAt]))
    for (const note of notes) {
      const seen = new Set<string>([note.id])
      let parent = note.parentId ? byId.get(note.parentId) : undefined
      while (parent && !seen.has(parent.id)) {
        if ((recency.get(parent.id) ?? 0) < note.updatedAt) recency.set(parent.id, note.updatedAt)
        seen.add(parent.id)
        parent = parent.parentId ? byId.get(parent.parentId) : undefined
      }
    }
    return recency
  }, [notes])
  // Which pane the mobile breakpoint shows. Derived, never stored: the route is
  // the only navigation state, so a refresh, a deep link and a back gesture all
  // land wherever the URL says. The landing interstitial counts as content
  // because it renders into <main>.
  const mobileView: 'list' | 'editor' = activeId || landing ? 'editor' : 'list'
  // The page list is `display: none` while the editor is up on mobile, and an
  // element with no layout forgets its scroll offset. Record it as the user
  // scrolls (reading it back on the way out is too late — it is already 0) and
  // put it back when the list returns, so leaving a page and coming back lands
  // where they were rather than at the top.
  const pagesNavRef = useRef<HTMLDivElement>(null)
  const listScroll = useRef(0)
  useLayoutEffect(() => {
    if (!isMobile || mobileView !== 'list') return
    if (pagesNavRef.current) pagesNavRef.current.scrollTop = listScroll.current
  }, [isMobile, mobileView])
  // <main> is one scroller reused by every page, so switching pages would land
  // you at the last page's offset. Remember an offset per page and put it back
  // on arrival. The editor fills its content in over a few frames, so the page
  // is often too short to honour the offset on the first try — retry until it
  // takes, and give up the moment the user scrolls for themselves.
  // A page taller than the viewport gets cut off mid-line at both edges. Fades
  // hanging off the top and bottom of the scroller dissolve those cuts, and each
  // one only shows while there is content past that edge to dissolve.
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false })
  const updateScrollFade = useCallback(() => {
    if (!mainEl) return
    const top = mainEl.scrollTop > 4
    const bottom = mainEl.scrollTop + mainEl.clientHeight < mainEl.scrollHeight - 4
    setScrollFade((current) => current.top === top && current.bottom === bottom ? current : { top, bottom })
  }, [mainEl])
  // Typing, loading and resizing all change whether there is overflow without
  // ever firing a scroll event, so watch the scroller and its content too.
  useEffect(() => {
    if (!mainEl) return
    updateScrollFade()
    const observer = new ResizeObserver(updateScrollFade)
    observer.observe(mainEl)
    for (const child of Array.from(mainEl.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [mainEl, updateScrollFade, activeId, landing])
  const editorScroll = useRef(new Map<string, number>())
  const rememberEditorScroll = (event: React.UIEvent<HTMLElement>) => {
    if (activeId) editorScroll.current.set(activeId, event.currentTarget.scrollTop)
    setScrollY(event.currentTarget.scrollTop)
    updateScrollFade()
  }
  useLayoutEffect(() => {
    if (!mainEl) return
    const target = (activeId && editorScroll.current.get(activeId)) || 0
    let frames = 0
    let raf = 0
    const stop = () => { cancelAnimationFrame(raf); raf = 0; frames = Infinity }
    const apply = () => {
      mainEl.scrollTop = target
      if (mainEl.scrollTop < target && frames++ < 30) raf = requestAnimationFrame(apply)
    }
    apply()
    for (const type of ['wheel', 'touchstart', 'keydown'] as const) mainEl.addEventListener(type, stop, { passive: true })
    return () => {
      stop()
      for (const type of ['wheel', 'touchstart', 'keydown'] as const) mainEl.removeEventListener(type, stop)
    }
  }, [activeId, mainEl])
  // The ancestors of the open page, in both sections, so the sidebar always
  // shows where you are. Derived, not stored: navigating away closes the branch
  // again unless the user had opened it by hand.
  const revealedIds = useMemo(() => {
    const keys = new Set<string>()
    if (!activeId) return keys
    const byId = new Map(notes.map((note) => [note.id, note]))
    let parent = byId.get(byId.get(activeId)?.parentId ?? '')
    const seen = new Set<string>()
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id)
      keys.add(`pages:${parent.id}`); keys.add(`fav:${parent.id}`)
      parent = byId.get(parent.parentId)
    }
    return keys
  }, [notes, activeId])
  // A hand-collapse only outranks the reveal for the page it was aimed at.
  useEffect(() => { setCollapsedIds((current) => current.size ? new Set() : current) }, [activeId])
  const effectiveExpandedIds = useMemo(() => {
    const next = new Set(expandedIds)
    for (const key of revealedIds) if (!collapsedIds.has(key)) next.add(key)
    return next
  }, [expandedIds, revealedIds, collapsedIds])
  // Revealing the row is pointless if it is below the fold.
  useEffect(() => {
    if (!activeId) return
    pagesNavRef.current?.querySelector('.page-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [activeId, effectiveExpandedIds])
  const roleFor =(shareId: string) => sync.roles[shareId] ?? ''
  const canWriteNote = (note: Note) => !note.shareId || ['writer', 'admin', 'owner'].includes(roleFor(note.shareId))
  // A page in the trash is read-only for everyone. Editing it would push
  // content updates for a page the purge is counting down on, and would leave
  // the writing somewhere the user cannot see it.
  const canEditActiveNote = Boolean(activeNote) && !activeTrashed && canWriteNote(activeNote!)
  const canDeleteNote = (note: Note) => !note.shareId || ['admin', 'owner'].includes(roleFor(note.shareId))

  // Publish the services the editor's page links need: resolving live titles,
  // navigating, searching pages, and spawning a subpage from the `[[` picker.
  // Re-runs whenever notes change so a rename instantly repaints every pill.
  useEffect(() => {
    if (!store) { setPageLinkServices(null); return }
    const byId = new Map(notes.map((note) => [note.id, note]))
    // Resolve titles against allNotes (which keeps soft-delete tombstones) so a
    // link to a synced-but-deleted page reads "deleted", while a link to a page
    // this viewer never had access to — absent entirely — reads "private".
    const known = new Map(allNotes.map((note) => [note.id, note]))
    setPageLinkServices({
      resolveTitle: (id) => {
        const note = known.get(id)
        if (!note) return { kind: 'private' }
        if (note.deletedAt) return { kind: 'deleted' }
        return { kind: 'ok', title: note.title || '' }
      },
      navigate: (id) => { setNoteMenuId(null); setActiveId(id) },
      pageHref: (id) => pageUrl(id, known.get(id)?.shareId || null),
      searchPages: (query) => rankPages(notes, activeId ?? '', query),
      // `parent` nests the new page under the one being edited; otherwise it is
      // created at the top level. A subpage inherits the parent's share scope.
      createPage: async (title, parent) => {
        const host = parent && activeId ? byId.get(activeId) ?? null : null
        if (parent && !host) return null
        if (host?.shareId && !['writer', 'admin', 'owner'].includes(roleFor(host.shareId))) return null
        const note: Note = { id: uid(), title: title || 'Untitled Note', parentId: host?.id ?? '', shareId: host?.shareId ?? '', deletedAt: 0, updatedAt: Date.now() }
        await saveNote(store, note)
        if (host) setExpandedIds((current) => new Set(current).add(`pages:${host.id}`))
        return note.id
      }
    })
    return () => setPageLinkServices(null)
  }, [store, notes, allNotes, activeId, sync.roles])

  // Seed the backlink index from every body already on this device, then keep
  // the open note's outgoing links current as its text changes (below).
  // Backlinks are a secondary panel, and seeding them decodes every body this
  // device holds — Yjs work that scales with the number of pages and would
  // otherwise land in the same frames as the first paint. Deferred to idle: the
  // index fills in a beat later and nothing before then reads it.
  useEffect(() => {
    if (!store) return
    return whenIdle(() => { void rebuildLinkIndex(store) })
  }, [store])
  useEffect(() => { if (collaborativeMarkdown) indexNote(collaborativeMarkdown.noteId, collaborativeMarkdown.value) }, [collaborativeMarkdown])

  const linksVersion = useSyncExternalStore(subscribeLinks, getLinksVersion)
  const backlinks = useMemo(() => {
    if (!activeNote) return []
    const byId = new Map(notes.map((note) => [note.id, note]))
    return backlinkSources(activeNote.id).map((id) => byId.get(id)).filter((note): note is Note => Boolean(note))
  }, [activeNote, notes, linksVersion])

  // --- Hash routing ---------------------------------------------------------
  // Only real URL navigation (back/forward, an opened link) emits these events;
  // our own pushState mirror below does not, so the two never fight.
  useEffect(() => subscribeRoute(() => {
    const route = readRoute()
    setPendingRoute(route)
    // Landing on the root is a deselection, not a page to resolve, so the
    // resolver below (which only ever opens pages) would leave the old note on
    // screen under a `#/` URL. On mobile this is the whole back gesture: `#/`
    // is the list. Safe to do here because only real navigation — back/forward,
    // an opened link — emits these events; our own pushState mirror does not.
    if (!route.noteId) setActiveId(null)
  }), [])

  // URL -> active page. Resolves once the store is up, and again as pages arrive
  // so a deep link opens the moment its page syncs. Consumed on success so an
  // unrelated edit can't re-apply a stale target.
  useEffect(() => {
    if (!store) return
    mirrorReadyRef.current = true
    const target = pendingRoute.noteId
    if (!target) return
    // Deleted pages resolve too. A link to something in Recently deleted opens
    // it read-only, which is a far better answer than the "you don't have
    // access" interstitial it used to fall through to.
    if (allNotes.some((note) => note.id === target)) {
      setActiveId(target)
      setPendingRoute({ noteId: null, resourceId: null })
    }
  }, [store, pendingRoute, allNotes])

  // Active page -> URL. Suppressed until the initial deep link has had a chance
  // to resolve, so it never clobbers an incoming link on load. Same-page writes
  // (normalizing the resource id) replace rather than push a history entry.
  useEffect(() => {
    if (!mirrorReadyRef.current) return
    writeRoute(activeId, activeNote?.shareId ?? null, readRoute().noteId === activeId)
  }, [activeId, activeNote?.shareId])

  // When a link points at a page we can't open, work out why and offer the way
  // in. Keyed on the target + connection (not the note list) so it doesn't
  // re-query on every edit; the resolver above clears pendingRoute once the page
  // arrives, which re-runs this and dismisses the landing.
  useEffect(() => {
    const target = pendingRoute.noteId
    if (!store || !target) { setLanding(null); return }
    const existing = store.getNote(target)
    if (existing) { setLanding(null); return }
    const rid = pendingRoute.resourceId
    if (!rid) { setLanding({ note: target, resource: null, status: 'unknown', name: null }); return }
    if (!sync.connected) { setLanding({ note: target, resource: rid, status: 'sign-in', name: null }); return }
    let cancelled = false
    setLanding({ note: target, resource: rid, status: 'checking', name: null })
    void (async () => {
      // A pending invite is the authoritative "accept" signal — an invited user
      // often can't read the resource yet, so check invitations before get().
      const invite = (await listInvitations().catch(() => [])).find((item) => item.resourceId === rid)
      if (cancelled) return
      if (invite) { setLanding({ note: target, resource: rid, status: 'invited', name: invite.name || null }); return }
      const info = await getResourceInfo(rid)
      if (cancelled) return
      if (info?.currentMember?.state === 'active') { void fullSync(); return }
      if (info?.currentMember) { setLanding({ note: target, resource: rid, status: 'invited', name: info.name || null }); return }
      setLanding({ note: target, resource: rid, status: info?.discoverable ? 'join' : 'request', name: info?.name || null })
    })()
    return () => { cancelled = true }
  }, [store, pendingRoute, sync.connected])

  const runLanding = async (action: () => Promise<void>, done?: () => void) => {
    setLandingBusy(true)
    try { await action(); done?.() }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not complete that') }
    finally { setLandingBusy(false) }
  }
  const dismissLanding = () => { setLanding(null); setPendingRoute({ noteId: null, resourceId: null }); setActiveId(null) }

  // The one place a short poll earns its keep: while the user waits on the
  // "request sent" screen there is no other signal that an owner approved them.
  // Bounded to ~2 minutes — after that they can reopen the link, and a normal
  // sync (startup, reconnect) will have pulled the page anyway.
  useEffect(() => {
    if (landing?.status !== 'requested' || !sync.connected || !store) return
    const target = landing.note
    let attempts = 0
    const interval = window.setInterval(async () => {
      attempts += 1
      if (attempts > 20) { window.clearInterval(interval); return }
      await fullSync().catch(() => {})
      const note = store.getNote(target)
      if (note && !note.deletedAt) setFlash('Your request was approved — opening the page.')
    }, 6000)
    return () => window.clearInterval(interval)
  }, [landing?.status, landing?.note, sync.connected, store])

  // Auto-dismiss the flash toast.
  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 4000)
    return () => window.clearTimeout(timer)
  }, [flash])

  // A one-off action failure describes a moment, not a state — left alone it
  // would sit in the footer for the rest of the session. The engine's own error
  // is not on a timer: it clears itself when the next sync succeeds.
  useEffect(() => {
    if (!actionError) return
    const timer = window.setTimeout(() => setActionError(null), 8000)
    return () => window.clearTimeout(timer)
  }, [actionError])

  // Adopt remote renames of the open note. While this device is typing in the
  // field its own draft wins; the metadata row is last-write-wins regardless.
  useEffect(() => {
    if (!activeNote) { setTitleDraft({ noteId: null, value: '' }); return }
    setTitleDraft((current) => {
      if (current.noteId !== activeNote.id) return { noteId: activeNote.id, value: activeNote.title }
      if (document.activeElement === titleInputRef.current) return current
      return { noteId: activeNote.id, value: activeNote.title }
    })
  }, [activeNote?.id, activeNote?.title])

  const breadcrumbs = useMemo(() => {
    if (!activeNote) return []
    const byId = new Map(notes.map((note) => [note.id, note]))
    const path: Note[] = []
    const visited = new Set<string>()
    let current: Note | undefined = activeNote
    while (current && !visited.has(current.id)) {
      path.unshift(current)
      visited.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return path
  }, [activeNote, notes])

  useEffect(() => {
    controllerRef.current?.close(); controllerRef.current = null
    setCollaborativeMarkdown(null); setRemotePresence([]); setDocTransport('local')
    if (!activeNote || !store) return
    let cancelled = false
    void openNoteDoc({
      note: activeNote,
      store,
      connected: sync.connected,
      writable: canEditActiveNote,
      onText: (value, source) => {
        if (cancelled) return
        if (source !== 'local') setCollaborativeMarkdown({ noteId: activeNote.id, value })
      },
      onPresence: (presence) => { if (!cancelled) setRemotePresence(presence) },
      onTransport: (transport) => { if (!cancelled) setDocTransport(transport) },
      onError: (error) => { if (!cancelled) setActionError(error instanceof Error ? error.message : 'Realtime collaboration failed') }
    }).then((controller) => {
      if (cancelled) controller.close()
      else controllerRef.current = controller
    }).catch((error) => setActionError(error instanceof Error ? error.message : 'Could not open document'))
    return () => {
      cancelled = true
      controllerRef.current?.close(); controllerRef.current = null
    }
  }, [activeNote?.id, activeNote?.shareId, sync.connected, canEditActiveNote, store])

  useEffect(() => {
    const selectionChanged = () => {
      const root = document.querySelector<HTMLElement>('.motion-md-content')
      const selection = window.getSelection()
      if (!root || !selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        controllerRef.current?.setSelection(null)
        return
      }
      const offsetAt = (node: Node, offset: number) => {
        const range = document.createRange()
        range.selectNodeContents(root)
        range.setEnd(node, offset)
        return range.toString().length
      }
      controllerRef.current?.setSelection({ anchor: offsetAt(selection.anchorNode, selection.anchorOffset), focus: offsetAt(selection.focusNode, selection.focusOffset) })
    }
    const blurred = () => controllerRef.current?.setSelection(null)
    document.addEventListener('selectionchange', selectionChanged)
    window.addEventListener('blur', blurred)
    return () => { document.removeEventListener('selectionchange', selectionChanged); window.removeEventListener('blur', blurred) }
  }, [activeNote?.id])

  // On small screens, float the formatting toolbar above the software keyboard
  // and keep the caret in a safe zone (ported from the Notes Lab experiment).
  // No-op on desktop; re-binds when the open note remounts the editor.
  useMobileKeyboard({ toolbar: toolbarHost, main: mainEl, enabled: isMobile, noteId: activeNote?.id ?? null })

  const loadMembers = useCallback(async (shareId: string) => {
    setMembersLoading(true)
    try { setMembers(await listMembers(shareId)) }
    catch { setMembers([]) }
    finally { setMembersLoading(false) }
  }, [])

  useEffect(() => {
    if (!activeNote?.shareId || !sync.connected) { setMembers([]); setMembersLoading(false); return }
    void loadMembers(activeNote.shareId)
  }, [activeNote?.shareId, sync.connected, loadMembers])

  useEffect(() => {
    if (!shareOpen) return
    const frame = window.requestAnimationFrame(() => inviteInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [shareOpen])

  const createNote = async (parent: Note | null = null) => {
    if (!store) return
    if (parent?.shareId && !['writer', 'admin', 'owner'].includes(roleFor(parent.shareId))) {
      setActionError('You need edit access to add a subpage.')
      return
    }
    const note: Note = { id: uid(), title: 'Untitled Note', parentId: parent?.id ?? '', shareId: parent?.shareId ?? '', deletedAt: 0, updatedAt: Date.now() }
    await saveNote(store, note)
    setLanding(null)
    setPendingRoute((current) => current.noteId ? { noteId: null, resourceId: null } : current)
    setActiveId(note.id)
  }

  // Reparenting is a one-field write: the tree is derived from parentId, so the
  // dragged note's children follow without being touched. moveBlockedBy holds
  // the invariants (no cycles, no cross-share moves — a share covers a whole
  // subtree, so leaving one is a join/leave rather than a move).
  const moveNote = async (noteId: string, parentId: string) => {
    if (!store) return
    const blocked = moveBlockedBy(notes, noteId, parentId)
    if (blocked !== 'none') {
      if (blocked === 'cycle') setActionError('A page can’t be moved inside itself.')
      if (blocked === 'scope') setActionError('Pages can only move within the same shared space.')
      return
    }
    const note = store.getNote(noteId)
    if (!note) return
    if (note.shareId && !['writer', 'admin', 'owner'].includes(roleFor(note.shareId))) {
      setActionError('You need edit access to move this page.')
      return
    }
    try { await saveNote(store, { ...note, parentId, updatedAt: Date.now() }) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not move this page') }
  }
  const { drag, startDrag, clickSuppressed } = useNoteDrag({
    scrollRef: pagesNavRef,
    // A heading is a membership change, not a move: the page keeps its place in
    // the tree either way. Dropping on PAGES only unfavorites when the row came
    // out of the favorites list — a row dragged from PAGES to its own heading
    // still means "move to the top level", as does the blank space below it.
    canDrop: (noteId, targetId, fromScope) => {
      if (targetId === FAVORITES_DROP) return !favorites.has(noteId)
      if (targetId === '' && fromScope === 'fav') return favorites.has(noteId)
      return moveBlockedBy(notes, noteId, targetId) === 'none'
    },
    onDrop: (noteId, targetId, fromScope) => {
      if (targetId === FAVORITES_DROP || (targetId === '' && fromScope === 'fav')) { toggleFavorite(noteId); return }
      void moveNote(noteId, targetId)
    }
  })
  const dimmedIds = drag ? subtreeIds(notes, drag.noteId) : null
  // A file drag paints through the same preview the reorder drag uses, so the
  // two gestures read identically: the same insertion line, in the same place.
  const previewParentId = fileDrag ? fileDrag.parentId : drag?.valid ? drag.targetId : null
  // A favorite/unfavorite drop changes no parent, so the tree must not draw an
  // insertion line for it — the line would promise a move that is not coming.
  // The heading's own highlight carries that drop instead.
  const favoriteDrop = Boolean(drag?.valid && (drag.targetId === FAVORITES_DROP || (drag.targetId === '' && drag.fromScope === 'fav')))
  const treePreviewParentId = favoriteDrop ? null : previewParentId

  // Deleting takes the whole subtree with it and there's no undo, so the menu
  // only stages the note here — removeNote runs once the dialog is confirmed.
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null)
  useEffect(() => {
    if (!pendingDelete) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPendingDelete(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingDelete])
  const removeNote = async (note: Note) => {
    if (!store) return
    setNoteMenuId(null)
    setPendingDelete(null)
    try {
      if (note.shareId && !canDeleteNote(note)) {
        await leaveShare(store, note.shareId)
        if (activeNote?.shareId === note.shareId) setActiveId(null)
        return
      }
      const wasActive = activeId && (activeId === note.id || breadcrumbs.some((crumb) => crumb.id === note.id))
      await deleteNoteTree(store, note.id)
      if (wasActive) setActiveId(note.parentId || null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete this page')
    }
  }

  const resizeTitle = useCallback(() => {
    const el = titleInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  useLayoutEffect(resizeTitle, [resizeTitle, activeId, titleDraft])

  const focusEditorBody = () => {
    const editor = document.querySelector<HTMLElement>('.motion-md-content')
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const patchTitle = (title: string) => {
    if (!store || !activeNote) return
    setTitleDraft({ noteId: activeNote.id, value: title })
    void saveNote(store, { ...activeNote, title, updatedAt: Date.now() }).catch((error) => setActionError(error instanceof Error ? error.message : 'Could not save locally'))
  }

  // The sidebar can rename any page, open or not, so it writes the note row
  // directly instead of going through the open page's title draft. A rename of
  // the open page reaches the header through the usual adopt-remote-title
  // effect, which leaves the field alone only while it has focus.
  const renameNote = (note: Note, title: string) => {
    setRenamingKey(null)
    if (!store || title === note.title) return
    void saveNote(store, { ...note, title, updatedAt: Date.now() }).catch((error) => setActionError(error instanceof Error ? error.message : 'Could not rename this page'))
  }

  // Content edits flow through the CRDT; the metadata row only needs an
  // occasional recency bump so device lists sort by real activity.
  const touchActiveNote = () => {
    if (!store || !activeNote) return
    const last = contentTouchRef.current.get(activeNote.id) ?? 0
    if (Date.now() - last < 5000) return
    contentTouchRef.current.set(activeNote.id, Date.now())
    void saveNote(store, { ...activeNote, updatedAt: Date.now() }).catch(() => {})
  }

  const connect = async () => {
    try { setActionError(null); await connectInteractive() }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Sync failed') }
  }

  // Discarding is behind a second view inside the dialog because it is the one
  // action here that destroys the only copy of something.
  const [adoptBusy, setAdoptBusy] = useState(false)
  const runAdoptAction = (work: () => Promise<void>) => async () => {
    setAdoptBusy(true)
    try { await work() }
    finally { setAdoptBusy(false) }
  }

  // Recently deleted, and getting back out of it.
  const trashed = useMemo(() => trashRoots(allNotes), [allNotes])
  // Raised when someone tries to type into a page that is in the trash. The
  // page is genuinely read-only, so the keystroke is going nowhere — saying why,
  // once, beats letting them wonder why the keyboard stopped working.
  const [recoverPrompt, setRecoverPrompt] = useState<Note | null>(null)
  const [recoverBusy, setRecoverBusy] = useState(false)
  const recover = async (note: Note) => {
    if (!store) return
    setRecoverBusy(true)
    try {
      await restoreNoteTree(store, note.id)
      setRecoverPrompt(null)
      setActiveId(note.id)
    }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not recover this page') }
    finally { setRecoverBusy(false) }
  }

  // --- sidebar surfaces ------------------------------------------------------
  const searchResults = useMemo(() => searchOpen ? searchPages(notes, searchQuery) : [], [searchOpen, searchQuery, notes])
  const openSearch = useCallback(() => { setIdentityOpen(false); setNotificationsOpen(false); setSearchQuery(''); setSearchOpen(true) }, [])
  const accountName = sync.connected && sync.user ? sync.user.name : 'Local'
  const accountInitial = (accountName.trim()[0] || '?').toUpperCase()
  // ⌘K/Ctrl-K opens search from anywhere, including mid-sentence in the editor,
  // so it has to win over the browser default. Escape closes whichever surface
  // is open — deepest first, so it never skips one.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
        return
      }
      if (event.key !== 'Escape') return
      if (searchOpen) setSearchOpen(false)
      else if (trashViewOpen) setTrashViewOpen(false)
      else if (identityOpen) setIdentityOpen(false)
      else if (notificationsOpen) setNotificationsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSearch, searchOpen, trashViewOpen, identityOpen, notificationsOpen])
  // Modifier combinations and navigation keys are how someone reads a page —
  // scrolling, selecting, copying. Only a key that would have produced text is
  // treated as an attempt to edit.
  const editingKeyPressed = (event: ReactKeyboardEvent) =>
    !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab'].includes(event.key))

  const leave = async () => {
    try { setActionError(null); await signOut() }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not sign out') }
  }

  // Opening the share sheet is a pure UI action. Nothing is created until an
  // invite is actually sent, so closing the sheet leaves no empty resource
  // behind and never re-homes a note the user only looked at.
  const invite = async () => {
    if (!store || !activeNote || !inviteHandle.trim() || inviteBusy) return
    const handle = inviteHandle.trim().replace(/^@/, '')
    const pendingId = `pending:${handle}`
    const pendingMember: MemberInfo = { userId: pendingId, role: inviteRole, state: 'inviting', kind: 'user', ownerId: null, ownerHandle: handle, ownerDisplayName: null }
    setInviteHandle('')
    setInviteBusy(true)
    setMembers((current) => [...current.filter((member) => member.userId !== pendingId), pendingMember])
    try {
      // First invite promotes the page to a shared resource.
      const shareId = activeNote.shareId || await shareNoteTree(store, activeNote)
      const member = await inviteByHandle(shareId, handle, inviteRole)
      setMembers((current) => [...current.filter((candidate) => candidate.userId !== pendingId && candidate.userId !== member.userId), member])
    }
    catch (error) { setMembers((current) => current.filter((member) => member.userId !== pendingId)); setActionError(error instanceof Error ? error.message : 'Could not invite that person') }
    finally { setInviteBusy(false) }
  }

  const acceptShareInvitation = async (resourceId: string) => {
    try {
      setNotificationsLoading(true)
      await acceptInvitation(resourceId)
      await loadInvitations()
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not accept invitation') }
    finally { setNotificationsLoading(false) }
  }
  const rejectShareInvitation = async (resourceId: string) => {
    try { setNotificationsLoading(true); await rejectInvitation(resourceId); await loadInvitations() }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not decline invitation') }
    finally { setNotificationsLoading(false) }
  }
  // Membership lives on the server, not in a table we can subscribe to, so after
  // any change refresh both views that show it — notifications and the open
  // share sheet — to keep them from drifting apart.
  const refreshMembership = async (resourceId: string) => {
    await loadInvitations()
    if (activeNote?.shareId === resourceId) await loadMembers(resourceId)
  }
  const approveAccessRequest = async (resourceId: string, userId: string) => {
    try { setNotificationsLoading(true); await approveRequest(resourceId, userId); await refreshMembership(resourceId) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not approve request') }
    finally { setNotificationsLoading(false) }
  }
  const denyAccessRequest = async (resourceId: string, userId: string) => {
    try { setNotificationsLoading(true); await denyRequest(resourceId, userId); await refreshMembership(resourceId) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not decline request') }
    finally { setNotificationsLoading(false) }
  }
  const requesterName = (request: AccessRequest) => request.displayName || (request.handle ? `@${request.handle}` : 'Someone')
  const requestPageName = (resourceId: string) => notes.find((note) => note.shareId === resourceId && !note.parentId)?.title || 'a page'

  const syncError = sync.error ?? actionError
  const clearSyncError = () => { setActionError(null); dismissSyncError() }
  // The resting state of a healthy, signed-in app is silence. Everything that
  // reaches the screen is therefore either work in flight (a spinner) or a
  // condition wanting the user's attention (a notice) — never a running
  // commentary on a sync that is behaving. `sidebarOnly` marks the standing
  // conditions that are worth an affordance in the footer but must not put a
  // permanent badge on every page header.
  const syncNotice = (() => {
    if (!tallpond) return { tone: 'gray' as SyncTone, label: 'Sync setup required', action: null, sidebarOnly: true }
    if (sync.phase === 'auth-required') return { tone: 'red' as SyncTone, label: 'Reconnect', action: 'Reconnect', sidebarOnly: false }
    if (sync.phase === 'error') return { tone: 'red' as SyncTone, label: 'Sync failed', action: sync.connected ? 'Retry sync' : 'Connect to Tallpond', sidebarOnly: false }
    // No spinner here: nothing is progressing, so a moving one would lie.
    if (sync.phase === 'offline') return { tone: 'gray' as SyncTone, label: 'Offline', action: null, sidebarOnly: false }
    if (sync.phase === 'local') return { tone: 'gray' as SyncTone, label: 'Saved locally', action: sync.connected ? null : 'Connect to Tallpond', sidebarOnly: true }
    return null
  })()
  // Heavy work only: establishing a session, or a whole-tree pull at startup /
  // reconnect. Explicitly NOT `phase === 'syncing'` or `pending > 0` — `settle`
  // sets both whenever the outbox is non-empty, which is most of the time while
  // someone is typing, so keying off them marked every keystroke as activity.
  // Draining the outbox is the background work this app exists to hide.
  const heavySync = sync.phase === 'connecting' || sync.fullSyncing
  // A notice outranks work in flight — an expired session, a dead network or an
  // unconfigured deployment all mean the queue is going nowhere.
  const syncBusy = useDelayedFlag(!syncNotice && (heavySync || docTransport === 'connecting'), BUSY_DELAY_MS, BUSY_MIN_MS)
  // The header is the one surface the user is actually reading, so it stays out
  // of the way: conditions that need them (offline, an error) and the one sync
  // slow enough to explain a wait, but no commentary on the per-page backfill
  // behind every page open. The footer still carries that.
  const headerBusy = useDelayedFlag(!syncNotice && heavySync, BUSY_DELAY_MS, BUSY_MIN_MS)
  const runSyncAction = () => void (sync.phase === 'auth-required' || !sync.connected ? connect() : fullSync())
  // Explicit navigation clears any pending deep-link/landing so it doesn't keep
  // covering the page the user just chose.
  const clearPendingNavigation = () => { setLanding(null); setPendingRoute((current) => current.noteId ? { noteId: null, resourceId: null } : current) }
  const openNote = (id: string) => { setNoteMenuId(null); clearPendingNavigation(); setActiveId(id) }
  // Five taps on the sidebar title toggle the keyboard debug overlay. The
  // reload is what applies it: the flag is read once, when the effect installs.
  const debugTaps = useRef({ count: 0, at: 0 })
  const countDebugTap = () => {
    const now = Date.now()
    const taps = debugTaps.current
    taps.count = now - taps.at < 3000 ? taps.count + 1 : 1
    taps.at = now
    if (taps.count < 5) return
    taps.count = 0
    toggleDebug()
    location.reload()
  }

  // The single header control that means "show me the sidebar". On desktop the
  // sidebar is a panel beside the content, so this is a toggle and the URL is
  // untouched — collapsing a panel must never become a history entry. On mobile
  // the sidebar is a full-screen view that lives at `#/`, so this is a real
  // navigation; that is what puts the list in the history stack and lets the
  // system back gesture return to it.
  const showSidebar = () => {
    if (!isMobile) { openSidebar(); return }
    setNoteMenuId(null); clearPendingNavigation(); setActiveId(null)
  }
  const copyPageLink = async () => {
    if (!activeNote) return
    const url = `${window.location.origin}${window.location.pathname}${pageUrl(activeNote.id, activeNote.shareId || null)}`
    try { await navigator.clipboard.writeText(url); setCopiedLink(true); window.setTimeout(() => setCopiedLink(false), 1500) }
    catch { setActionError('Could not copy the link') }
  }
  // Export reads the open document straight out of the editor's current value,
  // which is the same string the CRDT holds — no separate serialization path
  // that could drift from what is stored.
  const currentMarkdown = () => toExportMarkdown(
    collaborativeMarkdown?.noteId === activeNote?.id ? collaborativeMarkdown?.value ?? '' : '',
    (noteId) => notes.find((note) => note.id === noteId)?.shareId || null
  )

  const copyMarkdown = async () => {
    if (!activeNote) return
    setHeaderMenuOpen(false)
    const text = `# ${activeNote.title || 'Untitled Note'}\n\n${currentMarkdown()}`
    try { await navigator.clipboard.writeText(text); setCopiedMarkdown(true); window.setTimeout(() => setCopiedMarkdown(false), 1500) }
    catch { setActionError('Could not copy the page') }
  }

  const saveMarkdownFile = (title: string, body: string) => {
    const text = `# ${title || 'Untitled Note'}\n\n${body}`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = exportFileName(title)
    anchor.click()
    // The object URL is only needed for the duration of the click; releasing it
    // on the next frame keeps a long session from accumulating them.
    window.requestAnimationFrame(() => URL.revokeObjectURL(url))
  }

  const downloadMarkdown = () => {
    if (!activeNote) return
    setHeaderMenuOpen(false)
    saveMarkdownFile(activeNote.title, currentMarkdown())
  }

  // Downloads one page — never its subtree — from the sidebar. The open page's
  // editor value is ahead of what's persisted, so it is preferred; any other
  // page is read out of the local doc store.
  const downloadNote = async (note: Note) => {
    setNoteMenuId(null)
    if (!store) return
    try {
      const raw = collaborativeMarkdown?.noteId === note.id ? collaborativeMarkdown.value : await readNoteText(store, note.id)
      saveMarkdownFile(note.title, toExportMarkdown(raw, (noteId) => notes.find((item) => item.id === noteId)?.shareId || null))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not download this page')
    }
  }

  // An imported page needs a parent, and the sidebar is the only thing that can
  // say which — so import takes one rather than guessing. Each file becomes a
  // whole page: dropping four files must not silently concatenate them.
  const importMarkdownFiles = async (files: File[], parentId: string) => {
    if (!store || !files.length) return
    const parent = parentId ? notes.find((note) => note.id === parentId) ?? null : null
    if (parentId && !parent) return
    if (parent?.shareId && !['writer', 'admin', 'owner'].includes(roleFor(parent.shareId))) {
      setActionError('You need edit access to import into that page.')
      return
    }
    let opened: string | null = null
    try {
      for (const file of files) {
        const { title, body } = fromImportMarkdown(await file.text(), file.name)
        const note: Note = { id: uid(), title, parentId, shareId: parent?.shareId ?? '', deletedAt: 0, updatedAt: Date.now() }
        await saveNote(store, note)
        await seedNoteBody(store, note, body)
        opened ??= note.id
      }
      noteChanged()
      if (parentId) setExpandedIds((current) => new Set(current).add(`pages:${parentId}`))
      if (opened) { setLanding(null); setActiveId(opened) }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not import that file')
    }
  }

  // A dragged file is arbitrated by the sidebar, the same way a dragged page is:
  // the drop target comes from `[data-drop-id]` under the cursor, so both
  // gestures agree on what "here" means. The listeners are on the window
  // because a drag that leaves the viewport delivers its leave event to no
  // element inside it — which is what stranded the overlay on screen when you
  // dragged away without dropping. `relatedTarget === null` is that exit.
  const fileDragLatest = useRef({ sidebarOpen, openSidebar, importMarkdownFiles, setActionError, parentId: null as string | null })
  fileDragLatest.current = { ...fileDragLatest.current, sidebarOpen, openSidebar, importMarkdownFiles, setActionError }
  useEffect(() => {
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer) && [...event.dataTransfer!.types].includes('Files')
    const clear = () => { fileDragLatest.current.parentId = null; setFileDrag(null) }
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      // Required on every dragover, not just the first: without it the browser
      // treats the surface as rejecting the drag and never fires `drop`.
      event.preventDefault()
      if (!fileDragLatest.current.sidebarOpen) fileDragLatest.current.openSidebar()
      const zone = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest('[data-drop-id]')
      const zoneId = zone?.getAttribute('data-drop-id') ?? null
      // FAVORITES is a membership target, not a parent — there is nothing for an
      // imported file to land in, so the heading rejects the drag outright.
      const parentId = zoneId === FAVORITES_DROP ? null : zoneId
      if (event.dataTransfer) event.dataTransfer.dropEffect = parentId === null ? 'none' : 'copy'
      fileDragLatest.current.parentId = parentId
      setFileDrag((current) => current?.parentId === parentId ? current : { parentId })
    }
    const leave = (event: DragEvent) => { if (!event.relatedTarget) clear() }
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      const { parentId, importMarkdownFiles: run, setActionError: fail } = fileDragLatest.current
      clear()
      // Released over the canvas, the header, or empty space: nothing said where
      // this should go, so nothing is imported.
      if (parentId === null) return
      const files = [...event.dataTransfer?.files ?? []].filter((file) => /\.(md|markdown|mdx|txt)$/i.test(file.name))
      if (files.length) void run(files, parentId)
      else fail('Only Markdown files can be imported.')
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', clear)
    }
  }, [])

  const focusEditorCanvas = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return
    const editor = document.querySelector<HTMLElement>('.motion-md-content')
    if (!editor) return
    const selection = window.getSelection()
    if (!selection) return
    // Prevent the default mousedown so the browser doesn't blur/re-focus and
    // wipe the caret we place below.
    event.preventDefault()
    // Place the caret at the character nearest the click, not always at the end.
    // caretRangeFromPoint uses the element under the point, so a click in the
    // gutter (left/right/below the text) lands outside the editor — clamp the
    // point into the editor's box and retry so we snap to the closest line.
    const rect = editor.getBoundingClientRect()
    const clampedX = Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1)
    const clampedY = Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1)
    const caretFromPoint = (x: number, y: number) => {
      const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y)
      const position = doc.caretPositionFromPoint?.(x, y)
      if (!position) return null
      const range = document.createRange()
      range.setStart(position.offsetNode, position.offset)
      range.collapse(true)
      return range
    }
    editor.focus()
    let range = caretFromPoint(event.clientX, event.clientY)
    if (!range || !editor.contains(range.startContainer)) range = caretFromPoint(clampedX, clampedY)
    if (!range || !editor.contains(range.startContainer)) {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return <div className={`app-shell mobile-${mobileView} ${sidebarOpen ? '' : 'sidebar-collapsed'} ${drag ? 'dragging-page' : ''}`}>
    <aside><div className="sidebar-top"><button className="identity" aria-haspopup="menu" aria-expanded={identityOpen} onClick={(event) => { countDebugTap(); setIdentityAnchor(event.currentTarget); setNotificationsOpen(false); setIdentityOpen((open) => !open) }}><span className="identity-avatar" aria-hidden="true">{accountInitial}</span><span className="identity-name">{accountName}</span><svg className="identity-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button><div className="sidebar-top-actions">{sync.connected && <NotificationButton count={invitations.length + requests.length} onClick={() => { setIdentityOpen(false); setNotificationsOpen((open) => !open) }} />}<button className="sidebar-close" aria-label="Collapse sidebar" onClick={collapseSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 9l-3 3 3 3" /></svg></button></div></div><button className="sidebar-search" onClick={openSearch}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></svg><span>Search</span><kbd aria-hidden="true">⌘K</kbd></button>{identityOpen && identityAnchor && <IdentityMenu anchor={identityAnchor} name={accountName} connected={sync.connected} signOutBlocked={sync.pending > 0} trashCount={trashed.length} onTrash={() => { setIdentityOpen(false); setTrashViewOpen(true) }} onConnect={() => { setIdentityOpen(false); void connect() }} onSignOut={() => { setIdentityOpen(false); void leave() }} onClose={() => setIdentityOpen(false)} />}{notificationsOpen && <section className="notification-center" aria-label="Notifications">{notificationsLoading && invitations.length === 0 && requests.length === 0 ? <p className="notification-empty">Checking…</p> : invitations.length === 0 && requests.length === 0 ? <p className="notification-empty">You’re all caught up.</p> : <div className="invitation-list">{invitations.map((invitation) => <div className="invitation-item" key={invitation.resourceId}><span><strong>{invitation.name || 'Shared page'}</strong> · {invitation.role}</span><div className="invitation-actions"><button aria-label={`Decline ${invitation.name}`} disabled={notificationsLoading} onClick={() => void rejectShareInvitation(invitation.resourceId)}>×</button><button className="accept" aria-label={`Accept ${invitation.name}`} disabled={notificationsLoading} onClick={() => void acceptShareInvitation(invitation.resourceId)}>Accept</button></div></div>)}{requests.map((request) => <div className="invitation-item" key={`${request.resourceId}:${request.userId}`}><span><strong>{requesterName(request)}</strong> wants to join {requestPageName(request.resourceId)}</span><div className="invitation-actions"><button aria-label="Decline request" disabled={notificationsLoading} onClick={() => void denyAccessRequest(request.resourceId, request.userId)}>×</button><button className="accept" aria-label="Approve request" disabled={notificationsLoading} onClick={() => void approveAccessRequest(request.resourceId, request.userId)}>Approve</button></div></div>)}</div>}</section>}{(() => { const byId = new Map(notes.map((note) => [note.id, note])); const hasFavoritedAncestor = (note: Note) => { let parent = byId.get(note.parentId); while (parent) { if (favorites.has(parent.id)) return true; parent = byId.get(parent.parentId) } return false }; const favoriteRoots = notes.filter((note) => favorites.has(note.id) && !hasFavoritedAncestor(note)).sort(byRecency(subtreeRecency)); const treeProps = { notes, recency: subtreeRecency, activeId, onOpen: openNote, menuKey: noteMenuId, onToggleMenu, expandedIds: effectiveExpandedIds, onToggleExpanded, previewParentId: treePreviewParentId, dimmedIds, dragEnabled: true, onDragStart: startDrag, clickSuppressed, renamingKey, onRenameSubmit: renameNote, onRenameCancel }; const hiddenRootIds = new Set(favoriteRoots.filter((note) => note.parentId === '').map((note) => note.id)); return <div className="sidebar-scroll" ref={pagesNavRef} onScroll={(event) => { listScroll.current = event.currentTarget.scrollTop }}>{favoriteRoots.length > 0 && <><div className={`section-label ${previewParentId === FAVORITES_DROP ? 'drop-target' : ''}`} data-drop-id={FAVORITES_DROP}>FAVORITES</div><nav className="favorites-nav">{favoriteRoots.map((note) => <NoteTreeNode key={note.id} scope="fav" {...treeProps} note={note} depth={0} />)}</nav></>}<div className={`section-label ${previewParentId === '' ? 'drop-target' : ''}`} data-drop-id="">PAGES</div><nav className="pages-nav" data-drop-id=""><NoteTree scope="pages" {...treeProps} parentId="" depth={0} hiddenRootIds={hiddenRootIds} /></nav></div> })()}<button className="new-page-fab" aria-label="New page" title="New page" onClick={() => void createNote()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>{trashViewOpen && <div className="trash-view" role="dialog" aria-label="Recently deleted"><div className="trash-view-head"><strong>Recently deleted</strong><button className="trash-view-close" aria-label="Close" onClick={() => setTrashViewOpen(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>{trashed.length === 0 ? <p className="trash-view-empty">Nothing here. Deleted pages stay for 30 days before they are removed for good.</p> : <div className="trash-list">{trashed.map((note) => <div key={note.id} className={`trash-item ${note.id === activeId ? 'active' : ''}`}><button className="trash-open" onClick={() => { setTrashViewOpen(false); openNote(note.id) }}><span className="trash-title">{note.title || 'Untitled'}</span><span className="trash-when">{describeRetention(note)}</span></button>{canWriteNote(note) && <button className="trash-restore" disabled={recoverBusy} onClick={() => void recover(note)}>Restore</button>}</div>)}</div>}</div>}{(syncBusy || syncNotice || syncError) && <div className="sidebar-footer">{syncBusy ? <SyncBusyLabel announce /> : syncNotice && <>{syncNotice.tone === 'red' && <span className="local-dot sync-dot-red"/>}{syncNotice.label !== syncNotice.action && <span className="sync-status" role="status" aria-live="polite">{syncNotice.label}</span>}{syncNotice.action && <button className="sync-button" disabled={!online} onClick={runSyncAction}>{syncNotice.action}</button>}</>}{syncError && <span className="sync-error" role="alert">{syncError}<button className="sync-error-dismiss" aria-label="Dismiss error" onClick={clearSyncError}>×</button></span>}</div>}</aside>
    {searchOpen && <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search pages" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false) }}>
      <div className="search-panel">
        <div className="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></svg>
          <input autoFocus type="search" enterKeyHint="go" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="Search pages" aria-label="Search pages" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && searchResults[0]) { setSearchOpen(false); openNote(searchResults[0].note.id) } }} />
          {searchQuery && <button className="search-clear" aria-label="Clear search" onClick={() => setSearchQuery('')}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg></button>}
          <button className="search-cancel" onClick={() => setSearchOpen(false)}>Cancel</button>
        </div>
        <div className="search-results">
          {searchResults.length === 0
            ? <p className="search-empty">{searchQuery ? 'No pages match that name.' : 'Nothing here yet.'}</p>
            : <>{!searchQuery && <div className="search-section">Recent</div>}{searchResults.map(({ note, path }) => <button key={note.id} className="search-result" onClick={() => { setSearchOpen(false); openNote(note.id) }}>
              <svg className="search-result-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg>
              <span className="search-result-text"><span className="search-result-title">{note.title || 'Untitled'}</span><span className="search-result-path">{path || 'Top level'}</span></span>
            </button>)}</>}
        </div>
      </div>
    </div>}
    <main ref={setMainEl} onScroll={rememberEditorScroll} onMouseDown={focusEditorCanvas}><div className={`scroll-fade scroll-fade-top ${scrollFade.top ? 'visible' : ''}`} aria-hidden="true" />{activeNote && !landing ? <><header className={`editor-header ${!isMobile && !editing ? 'transparent' : ''}`}><div className="editor-header-row"><div className="header-left">{(isMobile || !sidebarOpen) && <button className="show-sidebar-button" aria-label={isMobile ? 'Back to your pages' : 'Open sidebar'} onClick={showSidebar}><svg viewBox="0 0 24 24" aria-hidden="true">{isMobile ? <><line x1="3" y1="6" x2="18" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><line x1="3" y1="18" x2="12" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></> : <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></>}</svg></button>}{isMobile && activeNote && <span className={`header-title ${scrollY > 100 ? 'visible' : ''}`}>{activeNote.title || 'Untitled'}</span>}</div><div ref={setToolbarHost} className={`editor-toolbar ${!isMobile && !editing ? 'hidden' : ''}`} role="toolbar" aria-label="Formatting tools" /><div className="header-right">{remotePresence.length > 0 && <div className="presence-list" aria-label="Online collaborators">{remotePresence.map((presence) => <span key={presence.presenceId} title={presence.displayName} style={{ background: presence.color }}>{presence.displayName.slice(0, 1).toUpperCase()}</span>)}</div>}{(headerBusy || (syncNotice && !syncNotice.sidebarOnly)) && <div className="header-status">{headerBusy ? <SyncBusyLabel announce={isMobile} /> : syncNotice && <>{syncNotice.tone === 'red' && <span className="local-dot sync-dot-red"/>}{syncNotice.label !== syncNotice.action && <span>{syncNotice.label}</span>}{syncNotice.action && <button className="sync-button" disabled={!online} onClick={runSyncAction}>{syncNotice.action}</button>}</>}</div>}<div className="header-actions">{copiedMarkdown && <span className="copied-flash" role="status">Copied</span>}<button className="header-button page-options-button" aria-label="Page options" aria-haspopup="menu" aria-expanded={headerMenuOpen} onClick={(event) => { setHeaderMenuAnchor(event.currentTarget); setHeaderMenuOpen((open) => !open) }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg></button></div></div></div></header><article ref={articleRef} onKeyDownCapture={(event) => { if (activeTrashed && editingKeyPressed(event)) { event.preventDefault(); setRecoverPrompt(activeNote) } }}>{activeTrashed && <div className="trash-banner" role="status"><div className="trash-banner-text"><strong>This page is in Recently deleted</strong><span>{describeRetention(activeNote)} before it is permanently deleted.</span></div>{canWriteNote(activeNote) && <button className="new" disabled={recoverBusy} onClick={() => void recover(activeNote)}>{recoverBusy ? 'Recovering…' : 'Recover'}</button>}</div>}{!isMobile && (() => { const pathHidden = sidebarOpen || breadcrumbs.length < 2; return <div className={`page-path article-path ${pathHidden ? 'hidden' : ''}`} aria-label="Page path" aria-hidden={pathHidden}>{breadcrumbs.map((crumb, index) => <Fragment key={crumb.id}>{index > 0 && <i>/</i>}<span className={index === breadcrumbs.length - 1 ? 'breadcrumb-current' : 'breadcrumb-ancestor'}><button onClick={() => openNote(crumb.id)}>{crumb.title || 'Untitled'}</button></span></Fragment>)}</div> })()}<textarea ref={titleInputRef} aria-label="Page title" className="title" rows={1} readOnly={!canEditActiveNote} value={titleDraft.noteId === activeNote.id ? titleDraft.value : activeNote.title} onChange={(event) => patchTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); focusEditorBody() } }} placeholder="Untitled Note" />
      {toolbarHost && collaborativeMarkdown?.noteId === activeNote.id && <Suspense fallback={null}><MarkdownEditor key={activeNote.id} toolbarHost={toolbarHost} readOnly={!canEditActiveNote} markdown={collaborativeMarkdown.value} onChange={(markdown) => { controllerRef.current?.setText(markdown); indexNote(activeNote.id, markdown); touchActiveNote() }} /></Suspense>}
      <RemoteCursors presence={remotePresence} containerRef={articleRef} />
      {bodyMounted && backlinks.length > 0 && <section className="backlinks" aria-label="Backlinks"><h2>Backlinks</h2>{backlinks.map((note) => <button key={note.id} className="backlink" onClick={() => openNote(note.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg><span>{note.title || 'Untitled'}</span></button>)}</section>}
      </article></> : landing ? <section className="empty access-landing">{!isMobile && !sidebarOpen && <button className="empty-sidebar-open show-sidebar-button" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></svg></button>}<div className="empty-mark">M</div>{(() => {
      const name = landing.name
      switch (landing.status) {
        case 'checking': return <><h1>Opening…</h1><p>Checking your access.</p></>
        case 'sign-in': return <><h1>Sign in to open this page</h1><p>Connect your Tallpond account to continue.</p><button className="new" onClick={() => void connect()}>Connect to Tallpond</button></>
        case 'invited': return <><h1>{name || 'You’re invited'}</h1><p>You’ve been invited to this page. Accept to open it.</p><button className="new" disabled={landingBusy} onClick={() => void runLanding(() => acceptInvitation(landing.resource!))}>{landingBusy ? 'Accepting…' : 'Accept invitation'}</button></>
        case 'join': return <><h1>{name || 'Open page'}</h1><p>This page is open to join.</p><button className="new" disabled={landingBusy} onClick={() => void runLanding(() => joinResource(landing.resource!))}>{landingBusy ? 'Joining…' : 'Join page'}</button></>
        case 'request': return <><h1>{name || 'Private page'}</h1><p>You don’t have access yet. Ask the owner to let you in.</p><button className="new" disabled={landingBusy} onClick={() => void runLanding(() => requestAccess(landing.resource!), () => setLanding((current) => current ? { ...current, status: 'requested' } : current))}>{landingBusy ? 'Requesting…' : 'Request access'}</button></>
        case 'requested': return <><h1>Request sent</h1><p>You’ll be able to open {name || 'this page'} once the owner approves.</p></>
        default: return <><h1>You don’t have access</h1><p>Ask the owner to share this page with you.</p></>
      }
    })()}<button className="landing-dismiss" onClick={dismissLanding}>Back to your pages</button></section> : <section className="empty">{!isMobile && !sidebarOpen && <button className="empty-sidebar-open show-sidebar-button" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></svg></button>}{notes.length > 0 ? <><div className="empty-mark">M</div><p>Select a page to start writing.</p><button className="new" onClick={() => void createNote()}>＋ New page</button></> : <><div className="empty-mark">M</div><h1>Your ideas, in motion.</h1><p>Create a page to begin. Everything works offline.</p><button className="new" onClick={() => void createNote()}>Create your first page</button></>}</section>}<div className={`scroll-fade scroll-fade-bottom ${scrollFade.bottom ? 'visible' : ''}`} aria-hidden="true" /></main>
    {headerMenuOpen && headerMenuAnchor && activeNote && <HeaderMenu
      anchor={headerMenuAnchor}
      canShare={sync.connected && online}
      onShare={() => { setHeaderMenuOpen(false); setShareOpen(true) }}
      onCopyMarkdown={() => void copyMarkdown()}
      onDownload={downloadMarkdown}
      onClose={() => setHeaderMenuOpen(false)}
    />}
    {noteMenuId && menuAnchor && (() => { const scope = noteMenuId.slice(0, noteMenuId.indexOf(':')); const menuNote = notes.find((note) => note.id === noteMenuId.slice(noteMenuId.indexOf(':') + 1)); return menuNote ? <PageMenu anchor={menuAnchor} note={menuNote} canDelete={canDeleteNote(menuNote)} isFavorite={favorites.has(menuNote.id)} onToggleFavorite={(id) => { setNoteMenuId(null); toggleFavorite(id) }} onCreateChild={(note) => { setNoteMenuId(null); setExpandedIds((current) => new Set(current).add(`${scope}:${note.id}`)); void createNote(note) }} onRename={(note) => { setNoteMenuId(null); setRenamingKey(`${scope}:${note.id}`) }} onDownload={(note) => void downloadNote(note)} onDelete={(note) => { setNoteMenuId(null); setPendingDelete(note) }} onClose={() => setNoteMenuId(null)} /> : null })()}
    {pendingDelete && (() => { const target = pendingDelete; const leaving = !!target.shareId && !canDeleteNote(target); const childCount = subtreeIds(notes, target.id).size - 1; const title = target.title || 'Untitled'; return createPortal(<div className="confirm-modal-backdrop" role="presentation" onMouseDown={() => setPendingDelete(null)}><section className="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title" onMouseDown={(event) => event.stopPropagation()}><strong id="confirm-delete-title">{leaving ? `Leave “${title}”?` : `Delete “${title}”?`}</strong><p>{leaving ? 'You’ll lose access until someone shares it with you again.' : childCount > 0 ? `This also deletes ${childCount} subpage${childCount === 1 ? '' : 's'}. This can’t be undone.` : 'This can’t be undone.'}</p><div className="confirm-actions"><button className="confirm-cancel" onClick={() => setPendingDelete(null)}>Cancel</button><button className="confirm-delete" onClick={() => void removeNote(target)}>{leaving ? 'Leave' : 'Delete'}</button></div></section></div>, document.body) })()}
    {flash && <div className="flash-toast" role="status">{flash}</div>}
    {recoverPrompt && createPortal(<div className="confirm-modal-backdrop" role="presentation" onMouseDown={() => setRecoverPrompt(null)}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="recover-title" onMouseDown={(event) => event.stopPropagation()}><strong id="recover-title">Recover this page to edit it?</strong><p>{`“${recoverPrompt.title || 'Untitled'}” is in Recently deleted, so it can be read but not changed. Recovering puts it back where it was.`}</p><div className="confirm-actions"><button className="confirm-cancel" disabled={recoverBusy} onClick={() => setRecoverPrompt(null)}>Keep reading</button><button className="new" disabled={recoverBusy || !canWriteNote(recoverPrompt)} onClick={() => void recover(recoverPrompt)}>{recoverBusy ? 'Recovering…' : 'Recover'}</button></div></section></div>, document.body)}
    {sync.adoptable && createPortal(<div className="share-modal-backdrop adopt-backdrop" role="presentation"><AdoptDialog survey={sync.adoptable} busy={adoptBusy} onMerge={() => void runAdoptAction(adoptAnonymousWork)()} onDecline={declineAnonymousWork} onDiscard={() => void runAdoptAction(discardAnonymousWork)()} /></div>, document.body)}
    {shareOpen && activeNote && createPortal(<div className="share-modal-backdrop" role="presentation" onPointerDownCapture={() => controllerRef.current?.setSelection(null)} onMouseDown={() => setShareOpen(false)}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}><header><div><strong id="share-title">Share this page</strong><span>Subpages inherit access.</span></div><button className="modal-close" aria-label="Close sharing" onClick={() => setShareOpen(false)}>×</button></header><div className="share-link-row"><span className="share-link-label">Anyone you add can open this page from its link</span><button className="copy-link" onClick={() => void copyPageLink()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l6-6M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></svg>{copiedLink ? 'Copied' : 'Copy link'}</button></div><div className="invite-row"><input ref={inviteInputRef} aria-label="Tallpond handle" value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)} placeholder="Tallpond handle" onKeyDown={(e) => { if (e.key === 'Enter') void invite() }} /><select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'reader' | 'writer')}><option value="writer">Can edit</option><option value="reader">Can view</option></select><button className="new" disabled={inviteBusy || !inviteHandle.trim()} onClick={() => void invite()}>{inviteBusy ? 'Inviting…' : 'Invite'}</button></div>{membersLoading && members.length === 0 ? <div className="member-list"><span>Loading people…</span></div> : members.length > 0 && <div className="member-list">{members.map((member) => <span key={member.userId}>{member.ownerDisplayName || member.ownerHandle || member.userId.slice(0, 8)} · {member.role}{member.state !== 'active' ? ` · ${member.state}` : ''}</span>)}</div>}</section></div>, document.body)}
  </div>
}
