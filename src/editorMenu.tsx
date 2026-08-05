import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection, $insertNodes, $isElementNode, $isRangeSelection, $isTextNode, $setSelection, COMMAND_PRIORITY_CRITICAL, KEY_ENTER_COMMAND, type LexicalEditor } from 'lexical'
import { $getClipboardDataFromSelection, setLexicalClipboardDataTransfer } from '@lexical/clipboard'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createLinkNode, $isLinkNode } from '@lexical/link'
import { $isListItemNode, $isListNode } from '@lexical/list'
import { $findMatchingParent } from '@lexical/utils'
import { HIGHLIGHT, registerMarkdownShortcuts, type ElementTransformer } from '@lexical/markdown'
import { $createHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { realmPlugin, addComposerChild$, activeEditor$, applyListType$, convertSelectionToNode$, insertTable$, insertThematicBreak$, rootEditor$, useCellValue, usePublisher } from '@mdxeditor/editor'
import { $createPageLinkNode, $isPageLinkNode, usePageLinkServices } from './pageLink'

// A single trigger-driven command menu, shared by `[[` page links and `/` slash
// commands. The important property is that it is *stateful*: a session opens on
// the edit that types a trigger, survives typing, and closes only on Esc, a
// click away, or a completion — after which the trigger text is left as plain
// prose and will not reopen unless the trigger is typed afresh. (The earlier
// version derived the menu purely from the caret position, so Esc couldn't
// truly dismiss it.) New triggers register by adding a Provider below.

type MenuItem = {
  key: string
  label: string
  detail?: string
  keywords?: string
  icon: IconName
  // Runs after the engine has deleted the trigger text and put the caret where
  // it began. May insert nodes or publish a block command.
  run: (editor: LexicalEditor) => void
}

type Provider = {
  id: string
  // Detects the trigger at the end of the text before the caret. `start` is the
  // offset of the trigger's first character within the anchor text node.
  match: (before: string) => { query: string; start: number } | null
  items: (query: string) => MenuItem[]
  emptyLabel: string
}

type Session = { providerId: string; anchorKey: string; anchorStart: number; query: string; left: number; top: number; bottom: number }

const PAGE_TRIGGER = /\[\[([^[\]\n]*)$/
const SLASH_TRIGGER = /(?:^|\s)\/([^/\s]*)$/
const isUrl = (value: string) => /^https?:\/\/\S+$/i.test(value)

const caretRect = () => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  if (!rect.width && !rect.height && !rect.top && !rect.left) return null
  return rect
}

const insertPageLink = (editor: LexicalEditor, id: string) =>
  editor.update(() => { $insertNodes([$createPageLinkNode(id), $createTextNode(' ')]) })

function EditorMenu() {
  const editor = useCellValue(activeEditor$) as LexicalEditor | null
  const services = usePageLinkServices()
  const convertBlock = usePublisher(convertSelectionToNode$)
  const applyList = usePublisher(applyListType$)
  const insertDivider = usePublisher(insertThematicBreak$)
  const insertTable = usePublisher(insertTable$)

  const [session, setSession] = useState<Session | null>(null)
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const dismissedRef = useRef<{ key: string; start: number } | null>(null)

  const providers = useMemo<Provider[]>(() => {
    const slashItems: MenuItem[] = [
      { key: 'text', label: 'Text', detail: 'Paragraph', keywords: 'paragraph body plain', icon: 'text', run: () => convertBlock(() => $createParagraphNode()) },
      { key: 'h1', label: 'Heading 1', keywords: 'title large', icon: 'h1', run: () => convertBlock(() => $createHeadingNode('h1')) },
      { key: 'h2', label: 'Heading 2', keywords: 'subtitle medium', icon: 'h2', run: () => convertBlock(() => $createHeadingNode('h2')) },
      { key: 'h3', label: 'Heading 3', keywords: 'small', icon: 'h3', run: () => convertBlock(() => $createHeadingNode('h3')) },
      { key: 'bullet', label: 'Bulleted list', keywords: 'unordered ul point', icon: 'bullet', run: () => applyList('bullet') },
      { key: 'number', label: 'Numbered list', keywords: 'ordered ol', icon: 'number', run: () => applyList('number') },
      { key: 'check', label: 'To-do list', keywords: 'todo checkbox task', icon: 'check', run: () => applyList('check') },
      { key: 'quote', label: 'Quote', keywords: 'blockquote callout', icon: 'quote', run: () => convertBlock(() => $createQuoteNode()) },
      { key: 'divider', label: 'Divider', keywords: 'hr rule separator line', icon: 'divider', run: () => insertDivider() },
      { key: 'table', label: 'Table', keywords: 'grid rows columns', icon: 'table', run: () => insertTable({ rows: 2, columns: 2 }) },
      { key: 'link-page', label: 'Link to page', keywords: 'mention reference internal', icon: 'page', run: (editor) => editor.update(() => { const s = $getSelection(); if ($isRangeSelection(s)) s.insertText('[[') }) }
    ]

    const page: Provider = {
      id: 'page',
      emptyLabel: 'Type a name to link or create a page',
      match: (before) => { const m = PAGE_TRIGGER.exec(before); return m ? { query: m[1], start: before.length - m[0].length } : null },
      items: (query) => {
        const q = query.trim()
        const items: MenuItem[] = (services?.searchPages(query) ?? []).map((option) => ({
          key: `p:${option.id}`, label: option.title || 'Untitled', detail: 'Page', icon: 'page',
          run: (editor) => insertPageLink(editor, option.id)
        }))
        if (isUrl(q)) items.unshift({
          key: 'url', label: q, detail: 'External link', icon: 'link',
          run: (editor) => editor.update(() => { const link = $createLinkNode(q); link.append($createTextNode(q)); $insertNodes([link, $createTextNode(' ')]) })
        })
        if (q) {
          items.push({ key: 'new-sub', label: `New subpage “${q}”`, detail: 'Nested here', icon: 'plus', run: (editor) => { void services?.createPage(q, true).then((id) => { if (id) insertPageLink(editor, id) }) } })
          items.push({ key: 'new-page', label: `New page “${q}”`, detail: 'Top level', icon: 'plus', run: (editor) => { void services?.createPage(q, false).then((id) => { if (id) insertPageLink(editor, id) }) } })
        }
        return items
      }
    }

    const slash: Provider = {
      id: 'slash',
      emptyLabel: 'No matching blocks',
      match: (before) => { const m = SLASH_TRIGGER.exec(before); return m ? { query: m[1], start: before.length - m[1].length - 1 } : null },
      items: (query) => {
        const q = query.trim().toLowerCase()
        if (!q) return slashItems
        return slashItems.filter((item) => item.label.toLowerCase().includes(q) || (item.keywords ?? '').includes(q))
      }
    }

    return [page, slash]
  }, [services, convertBlock, applyList, insertDivider, insertTable])

  const provider = session ? providers.find((candidate) => candidate.id === session.providerId) ?? null : null
  const items = useMemo(() => (provider && session ? provider.items(session.query) : []), [provider, session?.query])
  useEffect(() => { setHighlight(0) }, [session?.providerId, session?.query])

  // Keep the highlighted option scrolled into view during arrow-key navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  // Latest values for the imperative command handlers, without re-registering.
  const stateRef = useRef({ session, items, highlight, providers })
  stateRef.current = { session, items, highlight, providers }

  const complete = (index: number) => {
    const { session, items, providers } = stateRef.current
    const item = items[index]
    if (!editor || !session || !item) return
    const active = providers.find((candidate) => candidate.id === session.providerId)
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
      const node = selection.anchor.getNode()
      if (!$isTextNode(node)) return
      const caret = selection.anchor.offset
      const match = active?.match(node.getTextContent().slice(0, caret))
      if (!match) return
      // Select the trigger run and delete it via the selection, which handles
      // emptying the whole text node cleanly (spliceText can throw doing that,
      // which rolled the update back and left the `/div` text behind).
      const range = $createRangeSelection()
      range.anchor.set(node.getKey(), match.start, 'text')
      range.focus.set(node.getKey(), caret, 'text')
      $setSelection(range)
      range.removeText()
    })
    item.run(editor)
    dismissedRef.current = null
    setSession(null)
  }
  const dismiss = () => {
    const active = stateRef.current.session
    if (active) dismissedRef.current = { key: active.anchorKey, start: active.anchorStart }
    setSession(null)
  }
  const completeRef = useRef(complete); completeRef.current = complete
  const dismissRef = useRef(dismiss); dismissRef.current = dismiss

  // Open / track / close the session from document edits.
  useEffect(() => {
    if (!editor) return
    return editor.registerUpdateListener(({ editorState, dirtyLeaves }) => {
      const info = editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
        const node = selection.anchor.getNode()
        if (!$isTextNode(node)) return null
        const before = node.getTextContent().slice(0, selection.anchor.offset)
        for (const candidate of providers) {
          const match = candidate.match(before)
          if (match) return { providerId: candidate.id, anchorKey: node.getKey(), anchorStart: match.start, query: match.query }
        }
        return null
      })
      const isEdit = dirtyLeaves.size > 0
      setSession((prev) => {
        if (!info) { dismissedRef.current = null; return null }
        if (prev && prev.providerId === info.providerId && prev.anchorKey === info.anchorKey && prev.anchorStart === info.anchorStart) {
          return prev.query === info.query ? prev : { ...prev, query: info.query }
        }
        const dismissed = dismissedRef.current
        if (dismissed && dismissed.key === info.anchorKey && dismissed.start === info.anchorStart) return prev
        if (!isEdit) return prev
        const rect = caretRect()
        if (!rect) return prev
        dismissedRef.current = null
        return { providerId: info.providerId, anchorKey: info.anchorKey, anchorStart: info.anchorStart, query: info.query, left: rect.left, top: rect.top, bottom: rect.bottom }
      })
    })
  }, [editor, providers])

  // Keyboard while a session is open. A window capture listener is used instead
  // of Lexical commands so navigation is deterministic: it fires before the
  // contenteditable acts, and preventDefault reliably stops caret movement,
  // newlines, and tab indentation.
  useEffect(() => {
    if (!session) return
    const onKey = (event: KeyboardEvent) => {
      const { items, highlight } = stateRef.current
      const take = () => { event.preventDefault(); event.stopPropagation() }
      if (event.key === 'ArrowDown') { take(); setHighlight((value) => items.length ? (value + 1) % items.length : 0) }
      else if (event.key === 'ArrowUp') { take(); setHighlight((value) => items.length ? (value - 1 + items.length) % items.length : 0) }
      else if (event.key === 'Escape') { take(); dismissRef.current() }
      else if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (items.length === 0) { if (event.key === 'Enter') dismissRef.current(); return }
        take(); completeRef.current(highlight)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [session])

  // Ctrl/Cmd+Enter opens the link the caret is on — an internal page or an
  // external URL — regardless of whether a menu is open.
  useEffect(() => {
    if (!editor || !services) return
    return editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      if (!event || !(event.ctrlKey || event.metaKey)) return false
      let action: { page: string } | { url: string } | null = null
      editor.getEditorState().read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return
        const candidates = [...selection.getNodes(), selection.anchor.getNode()]
        const anchor = selection.anchor.getNode()
        if ($isElementNode(anchor)) {
          const before = anchor.getChildAtIndex(selection.anchor.offset - 1)
          const at = anchor.getChildAtIndex(selection.anchor.offset)
          if (before) candidates.push(before)
          if (at) candidates.push(at)
        } else {
          const prev = anchor.getPreviousSibling()
          if (prev) candidates.push(prev)
        }
        for (const node of candidates) {
          if ($isPageLinkNode(node)) { action = { page: node.getId() }; return }
          const link = $findMatchingParent(node, $isLinkNode)
          if (link) { action = { url: (link as ReturnType<typeof $createLinkNode>).getURL() }; return }
        }
      })
      if (!action) return false
      event.preventDefault()
      if ('page' in action) services.navigate(action.page)
      else window.open(action.url, '_blank', 'noopener,noreferrer')
      return true
    }, COMMAND_PRIORITY_CRITICAL)
  }, [editor, services])

  // Cut with a collapsed caret removes the whole block it sits in — the list
  // item inside a list, otherwise the top-level block (paragraph, heading, …) —
  // rather than just emptying it. We serialize the block into the cut event's
  // clipboardData ourselves (so formatting and page-link pills round-trip on
  // paste) and then delete the node outright. A real selection is left to the
  // native cut.
  useEffect(() => {
    if (!editor) return
    const onCut = (event: ClipboardEvent) => {
      if (!event.clipboardData) return
      let handled = false
      editor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
        const anchor = selection.anchor.getNode()
        const block = $findMatchingParent(anchor, $isListItemNode) ?? anchor.getTopLevelElement()
        if (!$isElementNode(block)) return
        const range = $createRangeSelection()
        range.anchor.set(block.getKey(), 0, 'element')
        range.focus.set(block.getKey(), block.getChildrenSize(), 'element')
        setLexicalClipboardDataTransfer(event.clipboardData!, $getClipboardDataFromSelection(range))
        handled = true
        // Where the caret lands once the block is gone.
        const fallback = block.getPreviousSibling() ?? block.getNextSibling()
        const list = block.getParent()
        block.remove()
        if ($isListNode(list) && list.getChildrenSize() === 0) list.remove()
        const root = $getRoot()
        if (root.getChildrenSize() === 0) { const p = $createParagraphNode(); root.append(p); p.select() }
        else if (fallback) fallback.selectEnd()
      }, { discrete: true })
      if (handled) event.preventDefault()
    }
    window.addEventListener('cut', onCut, true)
    return () => window.removeEventListener('cut', onCut, true)
  }, [editor])

  // A click anywhere outside the menu dismisses it, leaving the trigger as prose.
  useEffect(() => {
    if (!session) return
    const onDown = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.editor-menu')) dismissRef.current() }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [session])

  if (!session) return null
  const width = 300
  const left = Math.min(session.left, window.innerWidth - width - 12)
  const openUp = window.innerHeight - session.bottom < 300
  const style: React.CSSProperties = openUp
    ? { left, bottom: window.innerHeight - session.top + 6, width }
    : { left, top: session.bottom + 6, width }
  return createPortal(
    <div ref={listRef} className="editor-menu" style={style} onMouseDown={(event) => event.preventDefault()} role="listbox">
      {items.length === 0
        ? <div className="editor-menu-empty">{provider?.emptyLabel}</div>
        : items.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="option"
            data-index={index}
            aria-selected={index === highlight}
            className={`editor-menu-item${index === highlight ? ' active' : ''}`}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => completeRef.current(index)}
          >
            <span className="editor-menu-icon">{ICONS[item.icon]}</span>
            <span className="editor-menu-label">{item.label}</span>
            {item.detail && <span className="editor-menu-detail">{item.detail}</span>}
          </button>
        ))}
    </div>,
    document.body
  )
}

export const editorMenuPlugin = realmPlugin({
  init(realm) { realm.pubIn({ [addComposerChild$]: EditorMenu }) }
})

// A corrected `---` / `***` / `___` shortcut. MDXEditor's built-in one inserts
// the rule *before* the line and leaves the dashes behind when the line is last
// in the document; this always replaces the line and drops a fresh paragraph
// after. Register `markdownShortcutPlugin` before `thematicBreakPlugin` so the
// built-in horizontal-rule transformer is excluded and this is the only one.
const HORIZONTAL_RULE: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: () => null,
  regExp: /^(-{3,}|\*{3,}|_{3,})\s?$/,
  replace: (parentNode) => {
    const line = $createHorizontalRuleNode()
    parentNode.replace(line)
    const paragraph = $createParagraphNode()
    line.insertAfter(paragraph)
    paragraph.select()
  },
  type: 'element'
}

function ThematicBreakRule() {
  const editor = useCellValue(rootEditor$) as LexicalEditor | null
  // HIGHLIGHT (`==text==`) rides along here: MDXEditor imports/exports the mark
  // syntax but deliberately leaves its live typing shortcut unregistered, so we
  // add it ourselves next to the corrected horizontal-rule shortcut.
  useEffect(() => { if (editor) return registerMarkdownShortcuts(editor, [HORIZONTAL_RULE, HIGHLIGHT]) }, [editor])
  return null
}

export const thematicBreakRulePlugin = realmPlugin({
  init(realm) { realm.pubIn({ [addComposerChild$]: ThematicBreakRule }) }
})

// ---------------------------------------------------------------------------
// Icons (inline so the menu stays self-contained).
// ---------------------------------------------------------------------------

type IconName = 'page' | 'link' | 'plus' | 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote' | 'divider' | 'table'
const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
const ICONS: Record<IconName, ReactNode> = {
  page: svg(<path d="M14 3v5h5M14 3H6v18h12V8z" />),
  link: svg(<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  text: svg(<path d="M6 5h12M12 5v14M9 19h6" />),
  h1: svg(<><path d="M4 6v12M12 6v12M4 12h8" /><path d="M17 9l2-1v10" /></>),
  h2: svg(<><path d="M4 6v12M12 6v12M4 12h8" /><path d="M16 9a2 2 0 1 1 3 2l-3 4h4" /></>),
  h3: svg(<><path d="M4 6v12M12 6v12M4 12h8" /><path d="M16 8h4l-3 4a2 2 0 1 1-1 4" /></>),
  bullet: svg(<><path d="M9 7h11M9 12h11M9 17h11" /><circle cx="4.5" cy="7" r="1.2" /><circle cx="4.5" cy="12" r="1.2" /><circle cx="4.5" cy="17" r="1.2" /></>),
  number: svg(<><path d="M10 7h10M10 12h10M10 17h10" /><path d="M4 6l1-.5V9M4 15h2l-2 2h2" /></>),
  check: svg(<><path d="M10 7h10M10 12h10M10 17h10" /><path d="M3 7l1.4 1.4L7 6M3 16l1.4 1.4L7 15" /></>),
  quote: svg(<path d="M7 7H4v6h3zM7 7c0 4-1 6-3 7M17 7h-3v6h3zM17 7c0 4-1 6-3 7" />),
  divider: svg(<path d="M4 12h16" />),
  table: svg(<path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />)
}
