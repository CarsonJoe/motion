import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InvitationInfo, MemberInfo } from '@tallpond/sdk'
import { BlockTypeSelect, BoldItalicUnderlineToggles, codeBlockPlugin, CodeToggle, CreateLink, headingsPlugin, InsertCodeBlock, InsertTable, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, type MDXEditorMethods, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo } from '@mdxeditor/editor'
import type { Page, MotionDatabase } from './db'
import { initDatabase, ROOT_PAGE_ID } from './db'
import { openDocument, type CollaboratorPresence, type DocumentController } from './collaboration'
import { persistentBlankLinesPlugin } from './blankLinesPlugin'
import { enqueueDelete, enqueueMetadata, outboxSize } from './outbox'
import { acceptSharedInvitation, ensureTallpondSession, finishTallpondCallback, flushTallpondOutbox, getSharedInvitations, getSharedMembers, getSharedResourceRole, getTallpondSession, invalidateTallpondSession, inviteToSharedPage, leaveSharedResource, rejectSharedInvitation, restoreSharedPages, sharePageTree, startTallpondSession, subscribeToSharedPages, tallpond } from './tallpond'

const uid = () => crypto.randomUUID()
type SyncStatus = 'local' | 'connecting' | 'saving' | 'synced' | 'offline' | 'retrying' | 'error' | 'auth-required'
type SyncTone = 'gray' | 'green' | 'amber' | 'red'

function isTallpondAuthError(error: unknown) {
  const candidate = error as { status?: number; code?: string; message?: string } | null
  return candidate?.status === 401 || ['not_signed_in', 'session_expired', 'invalid_session'].includes(candidate?.code ?? '')
}

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
    headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(), tablePlugin(), codeBlockPlugin(), markdownShortcutPlugin(), persistentBlankLinesPlugin({}),
    toolbarPlugin({ toolbarClassName: 'motion-md-toolbar', toolbarContents: () => createPortal(<><span className="core-tools"><UndoRedo /><BlockTypeSelect /><BoldItalicUnderlineToggles /><ListsToggle /><CreateLink /></span><span className="extra-tools"><InsertTable /><InsertCodeBlock /><CodeToggle /></span></>, toolbarHost) })
  ]} /></div>
}

function NotificationButton({ count, onClick }: { count: number; onClick: () => void }) {
  return <button className="notification-button" aria-label={count ? `${count} pending invitation${count === 1 ? '' : 's'}` : 'Notifications'} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{count > 0 && <span>{count > 9 ? '9+' : count}</span>}</button>
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
      const resolvePath = (path: number[] | null) => {
        if (!path) return null
        let target: Node = root
        for (const index of path) {
          const child = target.childNodes[index]
          if (!child) return null
          target = child
        }
        return target
      }
      setPositions(presence.filter((item) => item.active).flatMap((item) => {
        const pathTarget = resolvePath(item.focusPath)
        if (pathTarget) {
          const range = document.createRange()
          const maxOffset = pathTarget.nodeType === Node.TEXT_NODE ? (pathTarget.textContent?.length ?? 0) : pathTarget.childNodes.length
          range.setStart(pathTarget, Math.min(item.focusNodeOffset, maxOffset))
          range.collapse(true)
          const rect = range.getBoundingClientRect()
          if (rect.height || rect.width) return [{ ...item, left: rect.left - containerRect.left, top: rect.top - containerRect.top, height: rect.height || 22 }]
          const lineElement = pathTarget.nodeType === Node.ELEMENT_NODE ? pathTarget as HTMLElement : pathTarget.parentElement
          const lineRect = lineElement?.getBoundingClientRect()
          if (lineRect) return [{ ...item, left: lineRect.left - containerRect.left, top: lineRect.top - containerRect.top, height: Number.parseFloat(getComputedStyle(lineElement!).lineHeight) || lineRect.height || 22 }]
        }
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

function PageTree({ pages, parentId, activeId, depth, onOpen, menuId, onToggleMenu, onCreateChild, onDelete, canDeletePage, expandedIds, onToggleExpanded }: { pages: Page[]; parentId: string; activeId: string | null; depth: number; onOpen: (id: string) => void; menuId: string | null; onToggleMenu: (id: string) => void; onCreateChild: (page: Page) => void; onDelete: (page: Page) => void; canDeletePage: (page: Page) => boolean; expandedIds: Set<string>; onToggleExpanded: (id: string) => void }) {
  return <>{pages.filter((page) => page.parentId === parentId).map((page) => <div key={page.id} className="page-tree-item">
    <div className={`page-row ${activeId === page.id ? 'active' : ''}`}>{pages.some((child) => child.parentId === page.id) ? <button className="page-toggle" style={{ marginLeft: 5 + depth * 16 }} aria-label={`${expandedIds.has(page.id) ? 'Collapse' : 'Expand'} ${page.title || 'Untitled'}`} aria-expanded={expandedIds.has(page.id)} onClick={() => onToggleExpanded(page.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={expandedIds.has(page.id) ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg></button> : <span className="page-toggle-spacer" style={{ marginLeft: 5 + depth * 16 }} />}<button className="page-link" onClick={() => onOpen(page.id)}>{page.title || 'Untitled'}</button><button className="page-menu-button" aria-label={`Page options for ${page.title || 'Untitled'}`} onClick={() => onToggleMenu(page.id)}>•••</button></div>
    {menuId === page.id && <div className="page-menu" role="menu"><button onClick={() => onCreateChild(page)}>New subpage</button><button className="danger" onClick={() => onDelete(page)}>{canDeletePage(page) ? 'Delete page' : 'Leave page'}</button></div>}
    {expandedIds.has(page.id) && <PageTree pages={pages} parentId={page.id} activeId={activeId} depth={depth + 1} onOpen={onOpen} menuId={menuId} onToggleMenu={onToggleMenu} onCreateChild={onCreateChild} onDelete={onDelete} canDeletePage={canDeletePage} expandedIds={expandedIds} onToggleExpanded={onToggleExpanded} />}
  </div>)}</>
}

export default function App() {
  const [db, setDb] = useState<MotionDatabase | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [sharedRoles, setSharedRoles] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('motion-sidebar-collapsed') !== 'true')
  const collapseSidebar = () => { setSidebarOpen(false); localStorage.setItem('motion-sidebar-collapsed', 'true') }
  const openSidebar = () => { setSidebarOpen(true); localStorage.removeItem('motion-sidebar-collapsed') }
  const [mobileView, setMobileView] = useState<'list' | 'editor'>(() => window.innerWidth <= 760 ? 'list' : 'editor')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  // The remembered flag is presentation state, not proof that today's app
  // credential is valid. Network subsystems start only after the session gate.
  const [isConnected, setIsConnected] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('local')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [collaboration, setCollaboration] = useState<DocumentController | null>(null)
  const [collaborativeMarkdown, setCollaborativeMarkdown] = useState<{ pageId: string; value: string } | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [sharePreparing, setSharePreparing] = useState(false)
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
  const [pageMenuId, setPageMenuId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [titleDraft, setTitleDraft] = useState<{ pageId: string | null; value: string }>({ pageId: null, value: '' })
  const sharedResourceIds = useMemo(() => [...new Set(pages.map((page) => page.shareId).filter(Boolean))].sort(), [pages])
  const sharedResourceKey = sharedResourceIds.join('|')
  const dbRef = useRef<MotionDatabase | null>(null)
  const connectedRef = useRef(isConnected)
  const retryTimer = useRef<number | null>(null)
  const syncInFlight = useRef(false)
  const sharedPagesUnsubscribe = useRef<() => void>(() => {})
  const sharedController = useRef<DocumentController | null>(null)
  const pendingLocalPatches = useRef(new Map<string, { update: Partial<Page>; queueRemote: boolean }>())
  const runningLocalPatches = useRef(new Set<string>())

  const setConnected = useCallback((connected: boolean) => {
    connectedRef.current = connected
    setIsConnected(connected)
    if (connected) localStorage.setItem('motion-tallpond-connected', 'true')
    else localStorage.removeItem('motion-tallpond-connected')
  }, [])

  const reconcile = useCallback(async (full = true) => {
    const currentDb = dbRef.current
    if (!currentDb || !connectedRef.current || syncInFlight.current) return
    if (!navigator.onLine) { setSyncStatus('offline'); return }
    syncInFlight.current = true
    setSyncStatus('saving')
    setSyncError(null)
    try {
      if (full && !await ensureTallpondSession(true)) throw Object.assign(new Error('Session expired'), { status: 401 })
      if (full) {
        const shareIds = await restoreSharedPages(currentDb)
        sharedPagesUnsubscribe.current()
        sharedPagesUnsubscribe.current = subscribeToSharedPages(currentDb, shareIds, (error) => {
          if (isTallpondAuthError(error)) { invalidateTallpondSession(); setConnected(false); setSyncStatus('auth-required') }
          setSyncError(error instanceof Error ? error.message : 'Realtime page update failed')
        })
        // One explicit migration replaces the previous dirty/seeded heuristics.
        // New edits enter the durable outbox at the point of mutation.
        const migrationKey = 'motion-metadata-outbox-v1'
        if (!localStorage.getItem(migrationKey)) {
          const localPages = await currentDb.pages.find({ selector: {} }).exec()
          for (const page of localPages) if (!page.shareId) await enqueueMetadata(page.toJSON())
          localStorage.setItem(migrationKey, '1')
        }
      }
      const result = await flushTallpondOutbox()
      if (result.pending) throw new Error(`${result.pending} local change${result.pending === 1 ? '' : 's'} still pending`)
      setSyncStatus('synced')
    } catch (error) {
      const authRequired = isTallpondAuthError(error)
      if (authRequired) { invalidateTallpondSession(); setConnected(false) }
      const requestId = (error as { requestId?: string | null } | null)?.requestId
      setSyncError(`${error instanceof Error ? error.message : 'Cloud backup will retry'}${requestId ? ` · Request ${requestId}` : ''}`)
      setSyncStatus(authRequired ? 'auth-required' : navigator.onLine ? 'retrying' : 'offline')
    } finally { syncInFlight.current = false }
  }, [])

  const queueBackup = useCallback((page: Page) => {
    void enqueueMetadata(page).then(() => {
      if (!connectedRef.current) { setSyncStatus('local'); return }
      if (!navigator.onLine) { setSyncStatus('offline'); return }
      setSyncStatus('saving')
      setSyncError(null)
      void reconcile(false)
    }).catch((error) => { setSyncError(error instanceof Error ? error.message : 'Could not save locally'); setSyncStatus('error') })
  }, [reconcile])

  const loadInvitations = useCallback(async () => {
    if (!connectedRef.current || !navigator.onLine) return
    setNotificationsLoading(true)
    try { setInvitations(await getSharedInvitations()) }
    catch (error) { if (isTallpondAuthError(error)) { invalidateTallpondSession(); setConnected(false); setSyncStatus('auth-required') }; setSyncError(error instanceof Error ? error.message : 'Could not load invitations') }
    finally { setNotificationsLoading(false) }
  }, [])

  useEffect(() => { void initDatabase().then(setDb) }, [])
  useEffect(() => { dbRef.current = db }, [db])
  useEffect(() => {
    if (!db) return
    const sub = db.pages.find({ selector: {}, sort: [{ updatedAt: 'desc' }] }).$.subscribe((docs) => setPages(docs.map((doc) => doc.toJSON())))
    return () => sub.unsubscribe()
  }, [db])
  useEffect(() => {
    if (!tallpond || !isConnected || !navigator.onLine || !sharedResourceIds.length) return
    let cancelled = false
    void Promise.all(sharedResourceIds.map(async (shareId) => [shareId, await getSharedResourceRole(shareId)] as const)).then((entries) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const [shareId, role] of entries) if (role) { next[shareId] = role; localStorage.setItem(`motion-tallpond-role:${shareId}`, role) }
      setSharedRoles((current) => ({ ...current, ...next }))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [isConnected, sharedResourceKey])
  useEffect(() => {
    if (!db || !isOnline) { if (db) setSyncStatus(localStorage.getItem('motion-tallpond-connected') === 'true' ? 'offline' : 'local'); return }
    void (async () => {
      await finishTallpondCallback()
      const session = await getTallpondSession(true)
      if (session?.authenticated) { if (session.userId) localStorage.setItem('motion-tallpond-user-id', session.userId); setConnected(true); await reconcile() }
      else { setConnected(false); setSyncStatus('local') }
    })().catch((error) => { const authRequired = isTallpondAuthError(error); if (authRequired) setConnected(false); setSyncStatus(authRequired ? 'auth-required' : 'error'); setSyncError(error instanceof Error ? error.message : 'Could not check cloud sync') })
  }, [db, isOnline, reconcile, setConnected])
  useEffect(() => {
    if (!tallpond || !isConnected) { setDisplayName(null); return }
    void tallpond.auth.getUser().then((user) => setDisplayName(user?.profile.displayName || user?.profile.handle || null)).catch(() => setDisplayName(null))
  }, [isConnected])
  useEffect(() => {
    const online = () => { setIsOnline(true) }
    const offline = () => { setIsOnline(false); setSyncStatus(connectedRef.current ? 'offline' : 'local') }
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); sharedPagesUnsubscribe.current(); if (retryTimer.current) window.clearTimeout(retryTimer.current) }
  }, [reconcile])
  useEffect(() => {
    if (syncStatus !== 'retrying' || !isOnline || !isConnected) return
    retryTimer.current = window.setTimeout(() => { retryTimer.current = null; void reconcile(false) }, 2500)
    return () => { if (retryTimer.current) window.clearTimeout(retryTimer.current); retryTimer.current = null }
  }, [syncStatus, isOnline, isConnected, reconcile])
  useEffect(() => {
    const resize = () => { if (window.innerWidth > 760) setMobileView('editor') }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (!isConnected) { setInvitations([]); return }
    if (!isOnline) return
    void loadInvitations()
    const refresh = () => void loadInvitations()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [isConnected, isOnline, loadInvitations])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShareOpen(false); setPageMenuId(null) } }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  useEffect(() => {
    const outsideMenu = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.page-menu, .page-menu-button')) setPageMenuId(null)
      if (!target.closest('.notification-center, .notification-button')) setNotificationsOpen(false)
    }
    document.addEventListener('pointerdown', outsideMenu)
    return () => document.removeEventListener('pointerdown', outsideMenu)
  }, [])

  const activePage = useMemo(() => pages.find((page) => page.id === activeId) ?? null, [pages, activeId])
  const canEditActivePage = !activePage?.shareId || ['writer', 'admin', 'owner'].includes(sharedRoles[activePage.shareId] ?? localStorage.getItem(`motion-tallpond-role:${activePage.shareId}`) ?? '')
  useEffect(() => {
    if (activePage) setTitleDraft({ pageId: activePage.id, value: activePage.title })
    else setTitleDraft({ pageId: null, value: '' })
  }, [activePage?.id])
  const breadcrumbs = useMemo(() => {
    if (!activePage) return []
    const byId = new Map(pages.map((page) => [page.id, page]))
    const path: Page[] = []
    const visited = new Set<string>()
    let current: Page | undefined = activePage
    while (current && !visited.has(current.id)) {
      path.unshift(current)
      visited.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return path
  }, [activePage, pages])
  useEffect(() => {
    sharedController.current?.close(); sharedController.current = null; setCollaboration(null); setCollaborativeMarkdown(null); setRemotePresence([])
    if (!activePage || !db) return
    let cancelled = false
    void openDocument({
      page: activePage,
      connected: isConnected,
      writable: canEditActivePage,
      onText: (value, source) => {
        if (cancelled) return
        if (source !== 'local') setCollaborativeMarkdown({ pageId: activePage.id, value })
      },
      onPresence: (presence) => { if (!cancelled) setRemotePresence(presence) },
      onTransportState: (state) => {
        if (cancelled) return
        if (state === 'offline') setSyncStatus('offline')
        else if (state === 'saving' || state === 'connecting') setSyncStatus('saving')
        else if (state === 'saved') void outboxSize().then((pending) => { if (!cancelled) setSyncStatus(pending ? 'saving' : 'synced') })
        else if (state === 'local') setSyncStatus('local')
      },
      onLocalOperation: () => { if (!cancelled) void reconcile(false) },
      onError: (error) => {
        if (cancelled) return
        if (isTallpondAuthError(error)) { invalidateTallpondSession(); setConnected(false); setSyncStatus('auth-required') }
        setSyncError(error instanceof Error ? error.message : 'Realtime collaboration failed')
      }
    }).then((controller) => { if (cancelled) controller.close(); else { sharedController.current = controller; setCollaboration(controller) } }).catch((error) => setSyncError(error instanceof Error ? error.message : 'Could not open document'))
    return () => {
      cancelled = true
      sharedController.current?.close(); sharedController.current = null
    }
  }, [activePage?.id, activePage?.shareId, isConnected, canEditActivePage, db, reconcile])
  useEffect(() => {
    const selectionChanged = () => {
      const root = document.querySelector<HTMLElement>('.motion-md-content')
      const selection = window.getSelection()
      if (!root || !selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        sharedController.current?.setSelection(null)
        return
      }
      const offsetAt = (node: Node, offset: number) => {
        const range = document.createRange()
        range.selectNodeContents(root)
        range.setEnd(node, offset)
        return range.toString().length
      }
      const pathAt = (node: Node) => {
        const path: number[] = []
        let current: Node | null = node
        while (current && current !== root) {
          const parent: Node | null = current.parentNode
          if (!parent) return []
          path.unshift(Array.prototype.indexOf.call(parent.childNodes, current) as number)
          current = parent
        }
        return current === root ? path : []
      }
      sharedController.current?.setSelection({ anchor: offsetAt(selection.anchorNode, selection.anchorOffset), focus: offsetAt(selection.focusNode, selection.focusOffset), anchorPath: pathAt(selection.anchorNode), focusPath: pathAt(selection.focusNode), anchorNodeOffset: selection.anchorOffset, focusNodeOffset: selection.focusOffset })
    }
    const blurred = () => sharedController.current?.setSelection(null)
    document.addEventListener('selectionchange', selectionChanged)
    window.addEventListener('blur', blurred)
    return () => { document.removeEventListener('selectionchange', selectionChanged); window.removeEventListener('blur', blurred) }
  }, [activePage?.id])
  useEffect(() => {
    if (!activePage?.shareId || !isConnected) { setMembers([]); setMembersLoading(false); return }
    let cancelled = false
    setMembersLoading(true)
    void getSharedMembers(activePage.shareId).then((value) => { if (!cancelled) setMembers(value) }).catch(() => { if (!cancelled) setMembers([]) }).finally(() => { if (!cancelled) setMembersLoading(false) })
    return () => { cancelled = true }
  }, [activePage?.shareId, isConnected])
  useEffect(() => {
    if (!shareOpen || sharePreparing) return
    const frame = window.requestAnimationFrame(() => inviteInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [shareOpen, sharePreparing])

  const createPage = async (parent: Page | null = null) => {
    if (!db) return
    if (parent?.shareId && !['writer', 'admin', 'owner'].includes(sharedRoles[parent.shareId] ?? localStorage.getItem(`motion-tallpond-role:${parent.shareId}`) ?? '')) {
      setSyncError('You need edit access to add a subpage.')
      return
    }
    const page: Page = { id: uid(), title: 'Untitled Note', parentId: parent?.id ?? ROOT_PAGE_ID, shareId: parent?.shareId ?? '', markdown: '', updatedAt: Date.now() }
    await db.pages.insert(page)
    setActiveId(page.id)
    setMobileView('editor')
    // The durable outbox records this even when Motion has never been connected.
    // Connecting later drains every page, not only the currently open one.
    queueBackup(page)
  }
  const canDeletePage = (page: Page) => !page.shareId || ['admin', 'owner'].includes(sharedRoles[page.shareId] ?? localStorage.getItem(`motion-tallpond-role:${page.shareId}`) ?? '')
  const removeSharedFromWorkspace = async (shareId: string) => {
    if (!db || !shareId) return
    sharedPagesUnsubscribe.current()
    sharedPagesUnsubscribe.current = () => {}
    try {
      setSyncStatus('saving')
      await leaveSharedResource(db, shareId)
      if (activePage?.shareId === shareId) { setActiveId(null); setMobileView('list') }
      setPageMenuId(null)
      await reconcile(true)
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Could not leave this page')
      setSyncStatus(navigator.onLine ? 'error' : 'offline')
      void reconcile(true)
    }
  }
  const deletePage = async (root: Page) => {
    if (!db) return
    if (root.shareId && !canDeletePage(root)) { await removeSharedFromWorkspace(root.shareId); return }
    const removed = new Set([root.id])
    let changed = true
    while (changed) {
      changed = false
      for (const page of pages) if (!removed.has(page.id) && removed.has(page.parentId)) { removed.add(page.id); changed = true }
    }
    const removedPages = pages.filter((page) => removed.has(page.id))
    const deletedAt = Date.now()
    const scope = root.shareId || 'private'
    await db.tombstones.bulkUpsert([...removed].map((pageId) => ({
      id: `${scope}:${pageId}`, scope, pageId, deleteRootId: root.id, deletedAt
    })))
    await enqueueDelete(root, [...removed])
    for (const page of [...removedPages].reverse()) {
      const doc = await db.pages.findOne(page.id).exec()
      await doc?.remove()
    }
    if (removed.has(activeId ?? '')) { setActiveId(root.parentId || null); setMobileView('list') }
    setPageMenuId(null)
    if (isConnected && navigator.onLine) { setSyncStatus('saving'); void reconcile(false) }
  }
  const patch = (update: Partial<Page>, queueRemote = true) => {
    if (!db || !activePage) return
    const pageId = activePage.id
    const pending = pendingLocalPatches.current.get(pageId)
    pendingLocalPatches.current.set(pageId, { update: { ...pending?.update, ...update }, queueRemote: Boolean(pending?.queueRemote || queueRemote) })
    if (runningLocalPatches.current.has(pageId)) return
    runningLocalPatches.current.add(pageId)
    void (async () => {
      try {
        while (pendingLocalPatches.current.has(pageId)) {
          const nextPatch = pendingLocalPatches.current.get(pageId)!
          const nextUpdate = nextPatch.update
          pendingLocalPatches.current.delete(pageId)
          const doc = await db.pages.findOne(pageId).exec()
          if (!doc) return
          const updated = await doc.incrementalPatch({ ...nextUpdate, updatedAt: Date.now() })
          if (nextPatch.queueRemote) queueBackup(updated.toJSON())
        }
      } finally {
        runningLocalPatches.current.delete(pageId)
      }
    })()
  }
  const connect = async () => {
    if (!navigator.onLine) { setSyncStatus('local'); return }
    setSyncStatus('connecting'); setSyncError(null)
    try { const session = await startTallpondSession(syncStatus === 'auth-required'); if (session.authenticated && db) { if (session.userId) localStorage.setItem('motion-tallpond-user-id', session.userId); setConnected(true); await reconcile() } }
    catch (error) { setSyncStatus('error'); setSyncError(error instanceof Error ? error.message : 'Sync failed') }
  }
  const share = async () => {
    if (!db || !activePage || !isConnected) return
    setShareOpen(true)
    setSharePreparing(true)
    try { setSyncStatus('saving'); const shareId = await sharePageTree(db, activePage); setSyncStatus('synced'); await reconcile(); setActiveId(activePage.id); if (!shareId) throw new Error('Share was not created.') }
    catch (error) { setSyncError(error instanceof Error ? error.message : 'Could not share this page'); setSyncStatus('error') }
    finally { setSharePreparing(false) }
  }
  const invite = async () => {
    if (!activePage?.shareId || !inviteHandle.trim() || inviteBusy) return
    const handle = inviteHandle.trim().replace(/^@/, '')
    const pendingId = `pending:${handle}`
    const pendingMember: MemberInfo = { userId: pendingId, role: inviteRole, state: 'inviting', kind: 'user', ownerId: null, ownerHandle: handle, ownerDisplayName: null }
    setInviteHandle('')
    setInviteBusy(true)
    setMembers((current) => [...current.filter((member) => member.userId !== pendingId), pendingMember])
    try {
      const member = await inviteToSharedPage(activePage.shareId, handle, inviteRole)
      setMembers((current) => [...current.filter((candidate) => candidate.userId !== pendingId && candidate.userId !== member.userId), member])
    }
    catch (error) { setMembers((current) => current.filter((member) => member.userId !== pendingId)); setSyncError(error instanceof Error ? error.message : 'Could not invite that person') }
    finally { setInviteBusy(false) }
  }
  const acceptInvitation = async (resourceId: string) => {
    try {
      setNotificationsLoading(true)
      await acceptSharedInvitation(resourceId)
      localStorage.removeItem(`motion-hidden-shared-resource:${resourceId}`)
      await loadInvitations()
      await reconcile()
    } catch (error) { setSyncError(error instanceof Error ? error.message : 'Could not accept invitation') }
    finally { setNotificationsLoading(false) }
  }
  const rejectInvitation = async (resourceId: string) => {
    try { setNotificationsLoading(true); await rejectSharedInvitation(resourceId); await loadInvitations() }
    catch (error) { setSyncError(error instanceof Error ? error.message : 'Could not decline invitation') }
    finally { setNotificationsLoading(false) }
  }
  const syncIndicator = (() => {
    if (syncStatus === 'auth-required') return { label: 'Reconnect', tone: 'red' as SyncTone, action: 'Reconnect' }
    if (syncStatus === 'error' || syncStatus === 'retrying') return { label: 'Sync failed', tone: 'red' as SyncTone, action: isConnected ? 'Retry sync' : 'Connect to Tallpond' }
    if (syncStatus === 'connecting') return { label: 'Connecting…', tone: 'amber' as SyncTone, action: null }
    if (!isOnline || syncStatus === 'offline') return { label: 'Saved locally', tone: 'gray' as SyncTone, action: null }
    if (!isConnected || syncStatus === 'local') return { label: 'Saved locally', tone: 'gray' as SyncTone, action: 'Connect to Tallpond' }
    if (syncStatus === 'saving') return { label: 'Syncing', tone: 'green' as SyncTone, action: null }
    return { label: activePage?.shareId ? 'Live' : 'Saved', tone: 'green' as SyncTone, action: null }
  })()
  const syncAction = tallpond ? syncIndicator.action : 'Sync setup required'
  const openPage = (id: string) => { setPageMenuId(null); setActiveId(id); setMobileView('editor') }
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
    <aside><div className="list-header"><span>Notes</span><div className="list-header-actions">{isConnected && <NotificationButton count={invitations.length} onClick={() => setNotificationsOpen((open) => !open)} />}<button className="new icon-new" aria-label="New page" onClick={() => void createPage()}>＋</button></div></div><div className="desktop-sidebar-actions"><button className="sidebar-close" aria-label="Collapse sidebar" onClick={collapseSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 9l-3 3 3 3" /></svg></button><button className="new desktop-new" onClick={() => void createPage()}>＋ New page</button>{isConnected && <NotificationButton count={invitations.length} onClick={() => setNotificationsOpen((open) => !open)} />}</div>{notificationsOpen && <section className="notification-center" aria-label="Notifications">{notificationsLoading && invitations.length === 0 ? <p className="notification-empty">Checking…</p> : invitations.length === 0 ? <p className="notification-empty">You’re all caught up.</p> : <div className="invitation-list">{invitations.map((invitation) => <div className="invitation-item" key={invitation.resourceId}><span><strong>{invitation.name || 'Shared document'}</strong> · {invitation.role}</span><div className="invitation-actions"><button aria-label={`Decline ${invitation.name}`} disabled={notificationsLoading} onClick={() => void rejectInvitation(invitation.resourceId)}>×</button><button className="accept" aria-label={`Accept ${invitation.name}`} disabled={notificationsLoading} onClick={() => void acceptInvitation(invitation.resourceId)}>Accept</button></div></div>)}</div>}</section>}<div className="section-label">PAGES</div><nav><PageTree pages={pages} parentId={ROOT_PAGE_ID} activeId={activeId} depth={0} onOpen={openPage} menuId={pageMenuId} onToggleMenu={(id) => setPageMenuId((current) => current === id ? null : id)} onCreateChild={(page) => { setPageMenuId(null); setExpandedIds((current) => new Set(current).add(page.id)); void createPage(page) }} onDelete={(page) => { setPageMenuId(null); void (canDeletePage(page) ? deletePage(page) : removeSharedFromWorkspace(page.shareId)) }} canDeletePage={canDeletePage} expandedIds={expandedIds} onToggleExpanded={(id) => { setExpandedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }) }} /></nav><div className="sidebar-footer"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span className="sync-status">{syncIndicator.label}</span>{syncAction && <button className="sync-button" disabled={!tallpond || !isOnline || syncStatus === 'connecting'} onClick={() => void (syncStatus === 'auth-required' || !isConnected ? connect() : reconcile())}>{syncAction}</button>}{syncError && <span className="sync-error">{syncError}</span>}</div></aside>
    <main onMouseDown={focusEditorCanvas}>{activePage ? <><header className="editor-header"><div className="editor-header-row"><div className="header-left">{!sidebarOpen && <button className="sidebar-open header-button" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M10 9l3 3-3 3" /></svg></button>}<button className="back-button" aria-label="Back to page list" onClick={() => { if (window.innerWidth <= 760) setMobileView('list'); else { openSidebar(); setActiveId(null) } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg></button><div className="page-path" aria-label="Page path">{breadcrumbs.length === 1 ? <span className="breadcrumb-current"><button onClick={() => openPage(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span> : <><span className="breadcrumb-root"><button onClick={() => openPage(breadcrumbs[0].id)}>{breadcrumbs[0].title || 'Untitled'}</button></span><i>/</i>{breadcrumbs.length > 2 && <><span className="breadcrumb-ellipsis">…</span><i>/</i></>}<span className="breadcrumb-current"><button onClick={() => openPage(breadcrumbs[breadcrumbs.length - 1].id)}>{breadcrumbs[breadcrumbs.length - 1].title || 'Untitled'}</button></span></>}</div></div><div ref={setToolbarHost} className="editor-toolbar" role="toolbar" aria-label="Formatting tools" /><div className="header-right">{remotePresence.length > 0 && <div className="presence-list" aria-label="Online collaborators">{remotePresence.map((presence) => <span key={presence.presenceId} title={presence.displayName} style={{ background: presence.color }}>{presence.displayName.slice(0, 1).toUpperCase()}</span>)}</div>}<div className="header-status"><span className={`local-dot sync-dot-${syncIndicator.tone}`}/><span>{syncIndicator.label}</span></div><div className="header-actions"><button className="header-button share-button" aria-label={activePage.shareId ? 'Open sharing' : 'Share page'} disabled={!isConnected || !isOnline} onClick={() => void (activePage.shareId ? setShareOpen(!shareOpen) : share())}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12L8 7m4-4 4 4"/><path d="M7 10H5v10h14V10h-2"/></svg></button></div></div></div></header><article ref={articleRef}><input aria-label="Page title" className="title" readOnly={!canEditActivePage} value={titleDraft.pageId === activePage.id ? titleDraft.value : activePage.title} onChange={(event) => { const title = event.target.value; setTitleDraft({ pageId: activePage.id, value: title }); patch({ title }) }} placeholder="Untitled Note" />
      {toolbarHost && collaboration && <MarkdownEditor key={activePage.id} toolbarHost={toolbarHost} readOnly={!canEditActivePage} markdown={collaborativeMarkdown?.pageId === activePage.id ? collaborativeMarkdown.value : activePage.markdown} onChange={(markdown) => sharedController.current?.setText(markdown)} />}
      <RemoteCursors presence={remotePresence} containerRef={articleRef} />
      </article></> : <section className="empty">{!sidebarOpen && <button className="empty-sidebar-open sidebar-open" aria-label="Open sidebar" onClick={openSidebar}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>}{pages.length > 0 ? <><div className="empty-mark">M</div><h1>Welcome back{displayName ? `, ${displayName}` : ''}</h1><p>Pick up where you left off.</p><div className="recent-pages" aria-label="Recent pages">{pages.slice(0, 3).map((page) => <button className="recent-page" key={page.id} onClick={() => openPage(page.id)}><span className="recent-page-icon">📄</span><span>{page.title || 'Untitled'}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>)}</div><button className="new" onClick={() => void createPage()}>＋ New page</button></> : <><div className="empty-mark">M</div><h1>Your ideas, in motion.</h1><p>Create a page to begin. Everything works offline.</p><button className="new" onClick={() => void createPage()}>Create your first page</button></>}</section>}</main>
    {shareOpen && activePage && (activePage.shareId || sharePreparing) && createPortal(<div className="share-modal-backdrop" role="presentation" onPointerDownCapture={() => sharedController.current?.setSelection(null)} onMouseDown={() => setShareOpen(false)}><section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}><header><div><strong id="share-title">Share this page</strong><span>{sharePreparing ? 'Preparing secure sharing…' : 'Subpages inherit access.'}</span></div><button className="modal-close" aria-label="Close sharing" onClick={() => setShareOpen(false)}>×</button></header><p>Links to other pages remain private unless you share them separately.</p><div className="invite-row"><input ref={inviteInputRef} aria-label="Tallpond handle" value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)} placeholder="Tallpond handle" disabled={sharePreparing} /><select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'reader' | 'writer')} disabled={sharePreparing}><option value="writer">Can edit</option><option value="reader">Can view</option></select><button className="new" disabled={sharePreparing || inviteBusy || !inviteHandle.trim()} onClick={() => void invite()}>{inviteBusy ? 'Inviting…' : 'Invite'}</button></div>{membersLoading && members.length === 0 ? <div className="member-list"><span>Loading people…</span></div> : members.length > 0 && <div className="member-list">{members.map((member) => <span key={member.userId}>{member.ownerDisplayName || member.ownerHandle || member.userId.slice(0, 8)} · {member.role}{member.state !== 'active' ? ` · ${member.state}` : ''}</span>)}</div>}</section></div>, document.body)}
  </div>
}
