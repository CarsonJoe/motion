import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { InvitationInfo, MemberInfo } from '@tallpond/sdk'
import { BlockTypeSelect, BoldItalicUnderlineToggles, headingsPlugin, HighlightToggle, InsertTable, linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, type MDXEditorMethods, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo } from '@mdxeditor/editor'
import { openLocalStore, type LocalStore, type Note } from './local'
import { openNoteDoc, type CollaboratorPresence, type DocTransport, type NoteDocController } from './doc'
import { persistentBlankLinesPlugin } from './blankLinesPlugin'
import { InsertPageLink, pageLinkPlugin, setPageLinkServices } from './pageLink'
import { editorMenuPlugin, thematicBreakRulePlugin } from './editorMenu'
import { backlinkSources, getLinksVersion, indexNote, rebuildLinkIndex, subscribeLinks } from './links'
import { pageUrl, readRoute, subscribeRoute, writeRoute, type Route } from './router'
import { acceptInvitation, approveRequest, connectInteractive, deleteNoteTree, denyRequest, fullSync, getResourceInfo, getSyncState, inviteByHandle, joinResource, leaveShare, listAccessRequests, listInvitations, listMembers, rejectInvitation, requestAccess, saveNote, shareNoteTree, startSync, subscribeSyncState, tallpond, type AccessRequest } from './sync'

const uid = () => crypto.randomUUID()
type SyncTone = 'gray' | 'green' | 'amber' | 'red'
// The interstitial shown when a link points at a page this device can't open
// yet: it might need sign-in, an invite to accept, an open resource to join,
// or a request to the owner.
type LandingStatus = 'checking' | 'sign-in' | 'invited' | 'join' | 'request' | 'requested' | 'unknown'
type Landing = { note: string; resource: string | null; status: LandingStatus; name: string | null }
const EMPTY_NOTES: Note[] = []

function MarkdownEditor({ markdown, onChange, toolbarHost, readOnly = false }: { markdown: string; onChange: (value: string) => void; toolbarHost: HTMLElement; readOnly?: boolean }) {
  const editor = useRef<MDXEditorMethods>(null)
  const container = useRef<HTMLDivElement>(null)
  const current = useRef(markdown)
  useEffect(() => {
    if (markdown === current.current) return
    current.current = markdown
    const root = container.current?.querySelector<HTMLElement>('.motion-md-content')
    const selection = window.getSelection()
    const selected = root && selection?.anchorNode && selection.focusNode && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
    const pathAt = (node: Node) => {
      const path: number[] = []
      let current: Node | null = node
      while (current && current !== root) {
        const parent: Node | null = current.parentNode
        if (!parent) return null
        path.unshift(Array.prototype.indexOf.call(parent.childNodes, current) as number)
        current = parent
      }
      return current === root ? path : null
    }
    const offsetAt = (node: Node, offset: number) => {
      const range = document.createRange(); range.selectNodeContents(root!); range.setEnd(node, offset); return range.toString().length
    }
    const saved = selected ? {
      anchor: offsetAt(selection!.anchorNode!, selection!.anchorOffset),
      focus: offsetAt(selection!.focusNode!, selection!.focusOffset),
      anchorPath: pathAt(selection!.anchorNode!),
      focusPath: pathAt(selection!.focusNode!),
      anchorNodeOffset: selection!.anchorOffset,
      focusNodeOffset: selection!.focusOffset
    } : null
    editor.current?.setMarkdown(markdown)
    if (saved) window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const nextRoot = container.current?.querySelector<HTMLElement>('.motion-md-content')
      if (!nextRoot) return
      // A remote edit must never pull the caret back into the document. If
      // anything else has taken focus since the change — the share sheet's
      // invite field, the title — leave the selection where the user put it.
      const focused = document.activeElement
      if (focused && focused !== document.body && !nextRoot.contains(focused)) return
      const point = (targetOffset: number) => {
        const walker = document.createTreeWalker(nextRoot, NodeFilter.SHOW_TEXT)
        let remaining = targetOffset; let node: Node | null
        while ((node = walker.nextNode())) { const size = node.textContent?.length ?? 0; if (remaining <= size) return { node, offset: remaining }; remaining -= size }
        return { node: nextRoot, offset: nextRoot.childNodes.length }
      }
      const resolvePath = (path: number[] | null, nodeOffset: number, fallback: number) => {
        let node: Node = nextRoot
        if (path) {
          for (const index of path) {
            const child = node.childNodes[index]
            if (!child) return point(fallback)
            node = child
          }
          const maxOffset = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
          return { node, offset: Math.min(nodeOffset, maxOffset) }
        }
        return point(fallback)
      }
      const anchor = resolvePath(saved.anchorPath, saved.anchorNodeOffset, saved.anchor)
      const focus = resolvePath(saved.focusPath, saved.focusNodeOffset, saved.focus)
      const nextSelection = window.getSelection()
      nextSelection?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    }))
  }, [markdown])
  return <div ref={container}><MDXEditor ref={editor} markdown={markdown} readOnly={readOnly} contentEditableClassName="motion-md-content" onChange={(value, initial) => { current.current = value; if (!initial) onChange(value) }} plugins={[
    headingsPlugin(), listsPlugin(), quotePlugin(), linkPlugin(), linkDialogPlugin(), markdownShortcutPlugin(), thematicBreakPlugin(), tablePlugin(), pageLinkPlugin(), editorMenuPlugin(), thematicBreakRulePlugin(), persistentBlankLinesPlugin({}),
    toolbarPlugin({ toolbarClassName: 'motion-md-toolbar', toolbarContents: () => createPortal(<><span className="core-tools"><UndoRedo /><BlockTypeSelect /><BoldItalicUnderlineToggles /><HighlightToggle /><ListsToggle /><InsertPageLink /></span><span className="extra-tools"><InsertTable /></span></>, toolbarHost) })
  ]} /></div>
}

function NotificationButton({ count, onClick }: { count: number; onClick: () => void }) {
  return <button className="notification-button" aria-label={count ? `${count} pending invitation${count === 1 ? '' : 's'}` : 'Notifications'} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{count > 0 && <span>{count > 9 ? '9+' : count}</span>}</button>
}

// Remote carets are placed by walking the rendered markdown to each
// collaborator's absolute text offset. Offsets come from Yjs relative
// positions, so they stay attached to the right characters across edits.
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
type NoteTreeShared = { scope: string; notes: Note[]; activeId: string | null; onOpen: (id: string) => void; menuKey: string | null; onToggleMenu: (key: string, anchor: HTMLElement) => void; expandedIds: Set<string>; onToggleExpanded: (key: string) => void }

function NoteTreeNode({ note, depth, ...shared }: NoteTreeShared & { note: Note; depth: number }) {
  const { scope, notes, activeId, onOpen, menuKey, onToggleMenu, expandedIds, onToggleExpanded } = shared
  const key = `${scope}:${note.id}`
  const hasChildren = notes.some((child) => child.parentId === note.id)
  const expanded = expandedIds.has(key)
  return <div className="page-tree-item">
    <div className={`page-row ${activeId === note.id ? 'active' : ''}`}>{hasChildren ? <button className="page-toggle" style={{ marginLeft: 5 + depth * 16 }} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${note.title || 'Untitled'}`} aria-expanded={expanded} onClick={() => onToggleExpanded(key)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg></button> : <span className="page-toggle-spacer" style={{ marginLeft: 5 + depth * 16 }} />}<button className="page-link" onClick={() => onOpen(note.id)}><span className="page-link-label">{note.title || 'Untitled'}</span></button><button className={`page-menu-button ${menuKey === key ? 'menu-open' : ''}`} aria-label={`Page options for ${note.title || 'Untitled'}`} aria-haspopup="menu" aria-expanded={menuKey === key} onClick={(event) => onToggleMenu(key, event.currentTarget)}>•••</button></div>
    {hasChildren && expanded && <NoteTree {...shared} parentId={note.id} depth={depth + 1} />}
  </div>
}

function NoteTree({ parentId, depth, ...shared }: NoteTreeShared & { parentId: string; depth: number }) {
  return <>{shared.notes.filter((note) => note.parentId === parentId).map((note) => <NoteTreeNode key={note.id} {...shared} note={note} depth={depth} />)}</>
}

function PageMenu({ anchor, note, canDelete, isFavorite, onToggleFavorite, onCreateChild, onDelete, onClose }: { anchor: HTMLElement; note: Note; canDelete: boolean; isFavorite: boolean; onToggleFavorite: (id: string) => void; onCreateChild: (note: Note) => void; onDelete: (note: Note) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = ref.current?.offsetWidth ?? 160
      const height = ref.current?.offsetHeight ?? 84
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
      <button role="menuitem" onClick={() => onCreateChild(note)}>New subpage</button>
      <button role="menuitem" className="danger" onClick={() => onDelete(note)}>{canDelete ? 'Delete page' : 'Leave page'}</button>
    </div>,
    document.body,
  )
}

export default function App() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('motion-sidebar-collapsed') !== 'true')
  const collapseSidebar = () => { setSidebarOpen(false); localStorage.setItem('motion-sidebar-collapsed', 'true') }
  const openSidebar = () => { setSidebarOpen(true); localStorage.removeItem('motion-sidebar-collapsed') }
  const [mobileView, setMobileView] = useState<'list' | 'editor'>(() => window.innerWidth <= 760 ? 'list' : 'editor')
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
  const [remotePresence, setRemotePresence] = useState<CollaboratorPresence[]>([])
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  // Menu/expand state is keyed by `${scope}:${noteId}` so a page shown in both
  // the FAVORITES and PAGES sections is controlled independently in each.
  const [noteMenuId, setNoteMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const onToggleMenu = useCallback((key: string, anchor: HTMLElement) => { setMenuAnchor(anchor); setNoteMenuId((current) => current === key ? null : key) }, [])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const onToggleExpanded = useCallback((key: string) => { setExpandedIds((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }) }, [])
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
  const [landing, setLanding] = useState<Landing | null>(null)
  const [landingBusy, setLandingBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const mirrorReadyRef = useRef(false)
  const controllerRef = useRef<NoteDocController | null>(null)
  const contentTouchRef = useRef(new Map<string, number>())

  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)
  const subscribeNotes = useCallback((listener: () => void) => store ? store.subscribe(listener) : () => {}, [store])
  const getNotes = useCallback(() => store ? store.getSnapshot() : EMPTY_NOTES, [store])
  const allNotes = useSyncExternalStore(subscribeNotes, getNotes)
  const notes = useMemo(() => allNotes.filter((note) => !note.deletedAt), [allNotes])

  useEffect(() => {
    let cancelled = false
    void openLocalStore().then((opened) => {
      if (cancelled) { opened.close(); return }
      setStore(opened)
      void startSync(opened)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const resize = () => { if (window.innerWidth > 760) setMobileView('editor') }
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
      if (!target.closest('.notification-center, .notification-button')) setNotificationsOpen(false)
    }
    document.addEventListener('pointerdown', outsideMenu)
    return () => document.removeEventListener('pointerdown', outsideMenu)
  }, [])

  const activeNote = useMemo(() => notes.find((note) => note.id === activeId) ?? null, [notes, activeId])
  const roleFor = (shareId: string) => sync.roles[shareId] ?? ''
  const canEditActiveNote = !activeNote?.shareId || ['writer', 'admin', 'owner'].includes(roleFor(activeNote.shareId))
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
      navigate: (id) => { setNoteMenuId(null); setActiveId(id); setMobileView('editor') },
      pageHref: (id) => pageUrl(id, known.get(id)?.shareId || null),
      searchPages: (query) => {
        const q = query.trim().toLowerCase()
        return notes
          .filter((note) => note.id !== activeId && (q === '' || (note.title || '').toLowerCase().includes(q)))
          .slice(0, 8)
          .map((note) => ({ id: note.id, title: note.title }))
      },
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
  useEffect(() => { if (store) void rebuildLinkIndex(store) }, [store])
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
  useEffect(() => subscribeRoute(() => setPendingRoute(readRoute())), [])

  // URL -> active page. Resolves once the store is up, and again as pages arrive
  // so a deep link opens the moment its page syncs. Consumed on success so an
  // unrelated edit can't re-apply a stale target.
  useEffect(() => {
    if (!store) return
    mirrorReadyRef.current = true
    const target = pendingRoute.noteId
    if (!target) return
    if (allNotes.some((note) => note.id === target && !note.deletedAt)) {
      setActiveId(target)
      setMobileView('editor')
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
    if (existing && !existing.deletedAt) { setLanding(null); return }
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
    setMobileView('editor')
  }

  const removeNote = async (note: Note) => {
    if (!store) return
    setNoteMenuId(null)
    try {
      if (note.shareId && !canDeleteNote(note)) {
        await leaveShare(store, note.shareId)
        if (activeNote?.shareId === note.shareId) { setActiveId(null); setMobileView('list') }
        return
      }
      const wasActive = activeId && (activeId === note.id || breadcrumbs.some((crumb) => crumb.id === note.id))
      await deleteNoteTree(store, note.id)
      if (wasActive) { setActiveId(note.parentId || null); setMobileView('list') }
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
  const syncIndicator = (() => {
    if (sync.phase === 'auth-required') return { label: 'Reconnect', tone: 'red' as SyncTone, action: 'Reconnect' }
    if (sync.phase === 'error') return { label: 'Sync failed', tone: 'red' as SyncTone, action: sync.connected ? 'Retry sync' : 'Connect to Tallpond' }
    if (sync.phase === 'connecting') return { label: 'Connecting…', tone: 'amber' as SyncTone, action: null }
    if (sync.phase === 'offline') return { label: 'Saved locally', tone: 'gray' as SyncTone, action: null }
    if (sync.phase === 'local') return { label: 'Saved locally', tone: 'gray' as SyncTone, action: sync.connected ? null : 'Connect to Tallpond' }
    if (sync.phase === 'syncing' || docTransport === 'connecting') return { label: 'Syncing', tone: 'green' as SyncTone, action: null }
    return { label: activeNote?.shareId && docTransport === 'live' ? 'Live' : 'Saved', tone: 'green' as SyncTone, action: null }
  })()
  const syncAction = tallpond ? syncIndicator.action : 'Sync setup required'
  // Explicit navigation clears any pending deep-link/landing so it doesn't keep
  // covering the page the user just chose.
  const clearPendingNavigation = () => { setLanding(null); setPendingRoute((current) => current.noteId ? { noteId: null, resourceId: null } : current) }
  const openNote = (id: string) => { setNoteMenuId(null); clearPendingNavigation(); setActiveId(id); setMobileView('editor') }
  const copyPageLink = async () => {
    if (!activeNote) return
    const url = `${window.location.origin}${window.location.pathname}${pageUrl(activeNote.id, activeNote.shareId || null)}`
    try { await navigator.clipboard.writeText(url); setCopiedLink(true); window.setTimeout(() => setCopiedLink(false), 1500) }
    catch { setActionError('Could not copy the link') }
  }
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
  return <div className={`app-shell mobile-${mobileView} ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <aside><div className="list-header"><span>Notes</span><div className="list-header-actions">{sync.connected && <NotificationButton count={invitations.length + requests.length} onClick={() => setNotificationsOpen((open) => !open)} />}<button className="new icon-new" aria-label="New page" onClick={() => void createNote()}>＋</button></div></div><div className="desktop-sidebar-actions"><button className="sidebar-close" aria-label="Collapse sidebar" onClick={collapseSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 9l-3 3 3 3" /></svg></button><button className="new desktop-new" onClick={() => void createNote()}>＋ New page</button>{sync.connected && <NotificationButton count={invitations.length + requests.length} onClick={() => setNotificationsOpen((open) => !open)} />}</div>{notificationsOpen && <section className="notification-center" aria-label="Notifications">{notificationsLoading && invitations.length === 0 && requests.length === 0 ? <p className="notification-empty">Checking…</p> : invitations.length === 0 && requests.length === 0 ? <p className="notification-empty">You’re all caught up.</p> : <div className="invitation-list">{invitations.map((invitation) => <div className="invitation-item" key={invitation.resourceId}><span><strong>{invitation.name || 'Shared page'}</strong> · {invitation.role}</span><div className="invitation-actions"><button aria-label={`Decline ${invitation.name}`} disabled={notificationsLoading} onClick={() => void rejectShareInvitation(invitation.resourceId)}>×</button><button className="accept" aria-label={`Accept ${invitation.name}`} disabled={notificationsLoading} onClick={() => void acceptShareInvitation(invitation.resourceId)}>Accept</button></div></div>)}{requests.map((request) => <div className="invitation-item" key={`${request.resourceId}:${request.userId}`}><span><strong>{requesterName(request)}</strong> wants to join {requestPageName(request.resourceId)}</span><div className="invitation-actions"><button aria-label="Decline request" disabled={notificationsLoading} onClick={() => void denyAccessRequest(request.resourceId, request.userId)}>×</button><button className="accept" aria-label="Approve request" disabled={notificationsLoading} onClick={() => void approveAccessRequest(request.resourceId, request.userId)}>Approve</button></div></div>)}</div>}</section>}{(() => { const byId = new Map(notes.map((note) => [note.id, note])); const hasFavoritedAncestor = (note: Note) => { let parent = byId.get(note.parentId); while (parent) { if (favorites.has(parent.id)) return true; parent = byId.get(parent.parentId) } return false }; const favoriteRoots = notes.filter((note) => favorites.has(note.id) && !hasFavoritedAncestor(note)); const treeProps = { notes, activeId, onOpen: openNote, menuKey: noteMenuId, onToggleMenu, expandedIds, onToggleExpanded }; return favoriteRoots.length > 0 && <><div className="section-label">FAVORITES</div><nav className="favorites-nav">{favoriteRoots.map((note) => <NoteTreeNode key={note.id} scope="fav" {...treeProps} note={note} depth={0} />)}</nav></> })()}<div className="section-label">PAGES</div><nav><NoteTree scope="pages" notes={notes} parentId="" activeId={activeId} depth={0} onOpen={openNote} menuKey={noteMenuId} onToggleMenu={onToggleMenu} expandedIds={expandedIds} onToggleExpanded={onToggleExpanded} /></nav><div className="sidebar-footer"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span className="sync-status">{syncIndicator.label}</span>{syncAction && <button className="sync-button" disabled={!tallpond || !navigator.onLine || sync.phase === 'connecting'} onClick={() => void (sync.phase === 'auth-required' || !sync.connected ? connect() : fullSync())}>{syncAction}</button>}{syncError && <span className="sync-error">{syncError}</span>}</div></aside>
    <main onMouseDown={focusEditorCanvas}>{activeNote && !landing ? <><header className="editor-header"><div className="editor-header-row"><div className="header-left">{!sidebarOpen && <button className="sidebar-open header-button" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></svg></button>}<button className="back-button" aria-label="Back to page list" onClick={() => { if (window.innerWidth <= 760) setMobileView('list'); else { openSidebar(); setActiveId(null) } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></button><div className="page-path" aria-label="Page path">{breadcrumbs.length === 1 ? <span className="breadcrumb-current"><button onClick={() => openNote(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span> : <><span className="breadcrumb-root"><button onClick={() => openNote(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span><i>/</i>{breadcrumbs.length > 2 && <><span className="breadcrumb-ellipsis">…</span><i>/</i></>}<span className="breadcrumb-current"><button onClick={() => openNote(breadcrumbs[breadcrumbs.length - 1].id)}>{breadcrumbs[breadcrumbs.length - 1].title || 'Untitled'}</button></span></>}</div></div><div ref={setToolbarHost} className="editor-toolbar" role="toolbar" aria-label="Formatting tools" /><div className="header-right">{remotePresence.length > 0 && <div className="presence-list" aria-label="Online collaborators">{remotePresence.map((presence) => <span key={presence.presenceId} title={presence.displayName} style={{ background: presence.color }}>{presence.displayName.slice(0, 1).toUpperCase()}</span>)}</div>}<div className="header-status"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span>{syncIndicator.label}</span></div><div className="header-actions"><button className="header-button share-button" aria-label={activeNote.shareId ? 'Open sharing' : 'Share page'} disabled={!sync.connected || !navigator.onLine} onClick={() => setShareOpen(!shareOpen)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12L8 7m4-4 4 4"/><path d="M7 10H5v10h14V10h-2"/></svg></button></div></div></div></header><article ref={articleRef}><textarea ref={titleInputRef} aria-label="Page title" className="title" rows={1} readOnly={!canEditActiveNote} value={titleDraft.noteId === activeNote.id ? titleDraft.value : activeNote.title} onChange={(event) => patchTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); focusEditorBody() } }} placeholder="Untitled Note" />
      {toolbarHost && collaborativeMarkdown?.noteId === activeNote.id && <MarkdownEditor key={activeNote.id} toolbarHost={toolbarHost} readOnly={!canEditActiveNote} markdown={collaborativeMarkdown.value} onChange={(markdown) => { controllerRef.current?.setText(markdown); indexNote(activeNote.id, markdown); touchActiveNote() }} />}
      <RemoteCursors presence={remotePresence} containerRef={articleRef} />
      {backlinks.length > 0 && <section className="backlinks" aria-label="Backlinks"><h2>Backlinks</h2>{backlinks.map((note) => <button key={note.id} className="backlink" onClick={() => openNote(note.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg><span>{note.title || 'Untitled'}</span></button>)}</section>}
      </article></> : landing ? <section className="empty access-landing">{!sidebarOpen && <button className="empty-sidebar-open sidebar-open" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>}<div className="empty-mark">M</div>{(() => {
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
    })()}<button className="landing-dismiss" onClick={dismissLanding}>Back to your pages</button></section> : <section className="empty">{!sidebarOpen && <button className="empty-sidebar-open sidebar-open" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>}{notes.length > 0 ? <><div className="empty-mark">M</div><h1>Welcome back{sync.user ? `, ${sync.user.name}` : ''}</h1><p>Pick up where you left off.</p><div className="recent-pages" aria-label="Recent pages">{notes.slice(0, 3).map((note) => <button className="recent-page" key={note.id} onClick={() => openNote(note.id)}><span className="recent-page-icon">📄</span><span>{note.title || 'Untitled'}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>)}</div><button className="new" onClick={() => void createNote()}>＋ New page</button></> : <><div className="empty-mark">M</div><h1>Your ideas, in motion.</h1><p>Create a page to begin. Everything works offline.</p><button className="new" onClick={() => void createNote()}>Create your first page</button></>}</section>}</main>
    {noteMenuId && menuAnchor && (() => { const scope = noteMenuId.slice(0, noteMenuId.indexOf(':')); const menuNote = notes.find((note) => note.id === noteMenuId.slice(noteMenuId.indexOf(':') + 1)); return menuNote ? <PageMenu anchor={menuAnchor} note={menuNote} canDelete={canDeleteNote(menuNote)} isFavorite={favorites.has(menuNote.id)} onToggleFavorite={(id) => { setNoteMenuId(null); toggleFavorite(id) }} onCreateChild={(note) => { setNoteMenuId(null); setExpandedIds((current) => new Set(current).add(`${scope}:${note.id}`)); void createNote(note) }} onDelete={(note) => { setNoteMenuId(null); void removeNote(note) }} onClose={() => setNoteMenuId(null)} /> : null })()}
    {flash && <div className="flash-toast" role="status">{flash}</div>}
    {shareOpen && activeNote && createPortal(<div className="share-modal-backdrop" role="presentation" onPointerDownCapture={() => controllerRef.current?.setSelection(null)} onMouseDown={() => setShareOpen(false)}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}><header><div><strong id="share-title">Share this page</strong><span>Subpages inherit access.</span></div><button className="modal-close" aria-label="Close sharing" onClick={() => setShareOpen(false)}>×</button></header><div className="share-link-row"><span className="share-link-label">Anyone you add can open this page from its link</span><button className="copy-link" onClick={() => void copyPageLink()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l6-6M11 6l1-1a4 4 0 0 1 6 6l-1 1M13 18l-1 1a4 4 0 0 1-6-6l1-1" /></svg>{copiedLink ? 'Copied' : 'Copy link'}</button></div><div className="invite-row"><input ref={inviteInputRef} aria-label="Tallpond handle" value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)} placeholder="Tallpond handle" onKeyDown={(e) => { if (e.key === 'Enter') void invite() }} /><select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'reader' | 'writer')}><option value="writer">Can edit</option><option value="reader">Can view</option></select><button className="new" disabled={inviteBusy || !inviteHandle.trim()} onClick={() => void invite()}>{inviteBusy ? 'Inviting…' : 'Invite'}</button></div>{membersLoading && members.length === 0 ? <div className="member-list"><span>Loading people…</span></div> : members.length > 0 && <div className="member-list">{members.map((member) => <span key={member.userId}>{member.ownerDisplayName || member.ownerHandle || member.userId.slice(0, 8)} · {member.role}{member.state !== 'active' ? ` · ${member.state}` : ''}</span>)}</div>}</section></div>, document.body)}
  </div>
}
