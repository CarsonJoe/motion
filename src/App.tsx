import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { InvitationInfo, MemberInfo } from '@tallpond/sdk'
import { BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, CodeToggle, CreateLink, headingsPlugin, InsertCodeBlock, InsertTable, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, type MDXEditorMethods, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo } from '@mdxeditor/editor'
import { openLocalStore, type LocalStore, type Note } from './local'
import { openNoteDoc, type CollaboratorPresence, type DocTransport, type NoteDocController } from './doc'
import { persistentBlankLinesPlugin } from './blankLinesPlugin'
import { acceptInvitation, connectInteractive, deleteNoteTree, fullSync, getSyncState, inviteByHandle, leaveShare, listInvitations, listMembers, rejectInvitation, saveNote, shareNoteTree, startSync, subscribeSyncState, tallpond } from './sync'

const uid = () => crypto.randomUUID()
type SyncTone = 'gray' | 'green' | 'amber' | 'red'
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
    headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), tablePlugin(), codeBlockPlugin(), linkPlugin(), markdownShortcutPlugin(), persistentBlankLinesPlugin({}),
    toolbarPlugin({ toolbarClassName: 'motion-md-toolbar', toolbarContents: () => createPortal(<><span className="core-tools"><UndoRedo /><BlockTypeSelect /><BoldItalicUnderlineToggles /><ListsToggle /><CreateLink /></span><span className="extra-tools"><InsertTable /><InsertCodeBlock /><CodeToggle /></span></>, toolbarHost) })
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

function NoteTree({ notes, parentId, activeId, depth, onOpen, menuId, onToggleMenu, onCreateChild, onDelete, canDeleteNote, expandedIds, onToggleExpanded }: { notes: Note[]; parentId: string; activeId: string | null; depth: number; onOpen: (id: string) => void; menuId: string | null; onToggleMenu: (id: string) => void; onCreateChild: (note: Note) => void; onDelete: (note: Note) => void; canDeleteNote: (note: Note) => boolean; expandedIds: Set<string>; onToggleExpanded: (id: string) => void }) {
  return <>{notes.filter((note) => note.parentId === parentId).map((note) => <div key={note.id} className="page-tree-item">
    <div className={`page-row ${activeId === note.id ? 'active' : ''}`}>{notes.some((child) => child.parentId === note.id) ? <button className="page-toggle" style={{ marginLeft: 5 + depth * 16 }} aria-label={`${expandedIds.has(note.id) ? 'Collapse' : 'Expand'} ${note.title || 'Untitled'}`} aria-expanded={expandedIds.has(note.id)} onClick={() => onToggleExpanded(note.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={expandedIds.has(note.id) ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg></button> : <span className="page-toggle-spacer" style={{ marginLeft: 5 + depth * 16 }} />}<button className="page-link" onClick={() => onOpen(note.id)}>{note.title || 'Untitled'}</button><button className="page-menu-button" aria-label={`Page options for ${note.title || 'Untitled'}`} onClick={() => onToggleMenu(note.id)}>•••</button></div>
    {menuId === note.id && <div className="page-menu" role="menu"><button onClick={() => onCreateChild(note)}>New subpage</button><button className="danger" onClick={() => onDelete(note)}>{canDeleteNote(note) ? 'Delete page' : 'Leave page'}</button></div>}
    {expandedIds.has(note.id) && <NoteTree notes={notes} parentId={note.id} activeId={activeId} depth={depth + 1} onOpen={onOpen} menuId={menuId} onToggleMenu={onToggleMenu} onCreateChild={onCreateChild} onDelete={onDelete} canDeleteNote={canDeleteNote} expandedIds={expandedIds} onToggleExpanded={onToggleExpanded} />}
  </div>)}</>
}

export default function App() {
  const [store, setStore] = useState<LocalStore | null>(null)
  const articleRef = useRef<HTMLElement>(null)
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
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  const [remotePresence, setRemotePresence] = useState<CollaboratorPresence[]>([])
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const [noteMenuId, setNoteMenuId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [titleDraft, setTitleDraft] = useState<{ noteId: string | null; value: string }>({ noteId: null, value: '' })
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
    try { setInvitations(await listInvitations()) }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Could not load invitations') }
    finally { setNotificationsLoading(false) }
  }, [])

  useEffect(() => {
    if (!sync.connected) { setInvitations([]); return }
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

  useEffect(() => {
    if (activeNote) setTitleDraft({ noteId: activeNote.id, value: activeNote.title })
    else setTitleDraft({ noteId: null, value: '' })
  }, [activeNote?.id])

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

  useEffect(() => {
    if (!activeNote?.shareId || !sync.connected) { setMembers([]); setMembersLoading(false); return }
    let cancelled = false
    setMembersLoading(true)
    void listMembers(activeNote.shareId).then((value) => { if (!cancelled) setMembers(value) }).catch(() => { if (!cancelled) setMembers([]) }).finally(() => { if (!cancelled) setMembersLoading(false) })
    return () => { cancelled = true }
  }, [activeNote?.shareId, sync.connected])

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
  const openNote = (id: string) => { setNoteMenuId(null); setActiveId(id); setMobileView('editor') }
  const focusEditorCanvas = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, a, [contenteditable="true"]')) return
    const editor = document.querySelector<HTMLElement>('.motion-md-content')
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return <div className={`app-shell mobile-${mobileView} ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <aside><div className="list-header"><span>Notes</span><div className="list-header-actions">{sync.connected && <NotificationButton count={invitations.length} onClick={() => setNotificationsOpen((open) => !open)} />}<button className="new icon-new" aria-label="New page" onClick={() => void createNote()}>＋</button></div></div><div className="desktop-sidebar-actions"><button className="sidebar-close" aria-label="Collapse sidebar" onClick={collapseSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 9l-3 3 3 3" /></svg></button><button className="new desktop-new" onClick={() => void createNote()}>＋ New page</button>{sync.connected && <NotificationButton count={invitations.length} onClick={() => setNotificationsOpen((open) => !open)} />}</div>{notificationsOpen && <section className="notification-center" aria-label="Notifications">{notificationsLoading && invitations.length === 0 ? <p className="notification-empty">Checking…</p> : invitations.length === 0 ? <p className="notification-empty">You’re all caught up.</p> : <div className="invitation-list">{invitations.map((invitation) => <div className="invitation-item" key={invitation.resourceId}><span><strong>{invitation.name || 'Shared page'}</strong> · {invitation.role}</span><div className="invitation-actions"><button aria-label={`Decline ${invitation.name}`} disabled={notificationsLoading} onClick={() => void rejectShareInvitation(invitation.resourceId)}>×</button><button className="accept" aria-label={`Accept ${invitation.name}`} disabled={notificationsLoading} onClick={() => void acceptShareInvitation(invitation.resourceId)}>Accept</button></div></div>)}</div>}</section>}<div className="section-label">PAGES</div><nav><NoteTree notes={notes} parentId="" activeId={activeId} depth={0} onOpen={openNote} menuId={noteMenuId} onToggleMenu={(id) => setNoteMenuId((current) => current === id ? null : id)} onCreateChild={(note) => { setNoteMenuId(null); setExpandedIds((current) => new Set(current).add(note.id)); void createNote(note) }} onDelete={(note) => void removeNote(note)} canDeleteNote={canDeleteNote} expandedIds={expandedIds} onToggleExpanded={(id) => { setExpandedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }) }} /></nav><div className="sidebar-footer"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span className="sync-status">{syncIndicator.label}</span>{syncAction && <button className="sync-button" disabled={!tallpond || !navigator.onLine || sync.phase === 'connecting'} onClick={() => void (sync.phase === 'auth-required' || !sync.connected ? connect() : fullSync())}>{syncAction}</button>}{syncError && <span className="sync-error">{syncError}</span>}</div></aside>
    <main onMouseDown={focusEditorCanvas}>{activeNote ? <><header className="editor-header"><div className="editor-header-row"><div className="header-left">{!sidebarOpen && <button className="sidebar-open header-button" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></svg></button>}<button className="back-button" aria-label="Back to page list" onClick={() => { if (window.innerWidth <= 760) setMobileView('list'); else { openSidebar(); setActiveId(null) } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></button><div className="page-path" aria-label="Page path">{breadcrumbs.length === 1 ? <span className="breadcrumb-current"><button onClick={() => openNote(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span> : <><span className="breadcrumb-root"><button onClick={() => openNote(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span><i>/</i>{breadcrumbs.length > 2 && <><span className="breadcrumb-ellipsis">…</span><i>/</i></>}<span className="breadcrumb-current"><button onClick={() => openNote(breadcrumbs[breadcrumbs.length - 1].id)}>{breadcrumbs[breadcrumbs.length - 1].title || 'Untitled'}</button></span></>}</div></div><div ref={setToolbarHost} className="editor-toolbar" role="toolbar" aria-label="Formatting tools" /><div className="header-right">{remotePresence.length > 0 && <div className="presence-list" aria-label="Online collaborators">{remotePresence.map((presence) => <span key={presence.presenceId} title={presence.displayName} style={{ background: presence.color }}>{presence.displayName.slice(0, 1).toUpperCase()}</span>)}</div>}<div className="header-status"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span>{syncIndicator.label}</span></div><div className="header-actions"><button className="header-button share-button" aria-label={activeNote.shareId ? 'Open sharing' : 'Share page'} disabled={!sync.connected || !navigator.onLine} onClick={() => setShareOpen(!shareOpen)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12L8 7m4-4 4 4"/><path d="M7 10H5v10h14V10h-2"/></svg></button></div></div></div></header><article ref={articleRef}><input aria-label="Page title" className="title" readOnly={!canEditActiveNote} value={titleDraft.noteId === activeNote.id ? titleDraft.value : activeNote.title} onChange={(event) => patchTitle(event.target.value)} placeholder="Untitled Note" />
      {toolbarHost && collaborativeMarkdown?.noteId === activeNote.id && <MarkdownEditor key={activeNote.id} toolbarHost={toolbarHost} readOnly={!canEditActiveNote} markdown={collaborativeMarkdown.value} onChange={(markdown) => { controllerRef.current?.setText(markdown); touchActiveNote() }} />}
      <RemoteCursors presence={remotePresence} containerRef={articleRef} />
      </article></> : <section className="empty">{!sidebarOpen && <button className="empty-sidebar-open sidebar-open" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>}{notes.length > 0 ? <><div className="empty-mark">M</div><h1>Welcome back{sync.user ? `, ${sync.user.name}` : ''}</h1><p>Pick up where you left off.</p><div className="recent-pages" aria-label="Recent pages">{notes.slice(0, 3).map((note) => <button className="recent-page" key={note.id} onClick={() => openNote(note.id)}><span className="recent-page-icon">📄</span><span>{note.title || 'Untitled'}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>)}</div><button className="new" onClick={() => void createNote()}>＋ New page</button></> : <><div className="empty-mark">M</div><h1>Your ideas, in motion.</h1><p>Create a page to begin. Everything works offline.</p><button className="new" onClick={() => void createNote()}>Create your first page</button></>}</section>}</main>
    {shareOpen && activeNote && createPortal(<div className="share-modal-backdrop" role="presentation" onPointerDownCapture={() => controllerRef.current?.setSelection(null)} onMouseDown={() => setShareOpen(false)}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}><header><div><strong id="share-title">Share this page</strong><span>Subpages inherit access.</span></div><button className="modal-close" aria-label="Close sharing" onClick={() => setShareOpen(false)}>×</button></header><p>Links to other pages remain private unless you share them separately.</p><div className="invite-row"><input ref={inviteInputRef} aria-label="Tallpond handle" value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)} placeholder="Tallpond handle" onKeyDown={(e) => { if (e.key === 'Enter') void invite() }} /><select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'reader' | 'writer')}><option value="writer">Can edit</option><option value="reader">Can view</option></select><button className="new" disabled={inviteBusy || !inviteHandle.trim()} onClick={() => void invite()}>{inviteBusy ? 'Inviting…' : 'Invite'}</button></div>{membersLoading && members.length === 0 ? <div className="member-list"><span>Loading people…</span></div> : members.length > 0 && <div className="member-list">{members.map((member) => <span key={member.userId}>{member.ownerDisplayName || member.ownerHandle || member.userId.slice(0, 8)} · {member.role}{member.state !== 'active' ? ` · ${member.state}` : ''}</span>)}</div>}</section></div>, document.body)}
  </div>
}
