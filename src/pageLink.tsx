import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DecoratorNode, $getSelection, $isRangeSelection, $isTextNode, $createRangeSelection, $setSelection, $insertNodes, $createTextNode, COMMAND_PRIORITY_LOW, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import { realmPlugin, addImportVisitor$, addLexicalNode$, addExportVisitor$, addComposerChild$, activeEditor$, useCellValue } from '@mdxeditor/editor'
import { PAGE_LINK_SCHEME } from './links'

// Internal page links are stored as ordinary markdown links with a `motion:`
// scheme — `[Cached Title](motion:<id>)`. The scheme keeps them round-tripping
// through CommonMark with zero custom syntax (unlike directives, which would
// turn any `:word` in prose into a node). The bracket text is only a cache for
// external readers: the app never reads it back, resolving the live title from
// the notes store on every render, so an internal link can never go stale.

// ---------------------------------------------------------------------------
// Services bridge. The editor renders in its own Lexical realm, deep inside
// MDXEditor; rather than thread React context through decorator portals, the
// app publishes a small service object here (matching how sync/local expose
// module singletons). Pills subscribe so a title edit anywhere repaints them.
// ---------------------------------------------------------------------------

export type PageOption = { id: string; title: string }
export type PageLinkServices = {
  // The current title for a note id, or null when it no longer exists.
  resolveTitle: (id: string) => string | null
  navigate: (id: string) => void
  // Candidate pages for the `[[` picker, already filtered and ranked.
  searchPages: (query: string) => PageOption[]
  // Creates a subpage of the page being edited; resolves to its id, or null
  // if creation is not possible (e.g. no write access).
  createSubpage: (title: string) => Promise<string | null>
}

let services: PageLinkServices | null = null
const serviceListeners = new Set<() => void>()

export function setPageLinkServices(next: PageLinkServices | null) {
  services = next
  for (const listener of serviceListeners) listener()
}

function usePageLinkServices() {
  return useSyncExternalStore(
    (listener) => { serviceListeners.add(listener); return () => serviceListeners.delete(listener) },
    () => services
  )
}

// ---------------------------------------------------------------------------
// The Lexical node.
// ---------------------------------------------------------------------------

type SerializedPageLinkNode = SerializedLexicalNode & { pageId: string }

export class PageLinkNode extends DecoratorNode<ReactNode> {
  __id: string

  static getType() { return 'page-link' }
  static clone(node: PageLinkNode) { return new PageLinkNode(node.__id, node.__key) }

  constructor(id: string, key?: NodeKey) {
    super(key)
    this.__id = id
  }

  static importJSON(serialized: SerializedPageLinkNode) { return $createPageLinkNode(serialized.pageId) }
  exportJSON(): SerializedPageLinkNode { return { type: 'page-link', version: 1, pageId: this.__id } }

  getId() { return this.__id }
  isInline() { return true }
  isKeyboardSelectable() { return true }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'page-ref-host'
    return span
  }
  updateDOM() { return false }

  // Plain-text fallback (copy, accessibility trees) shows the live title.
  getTextContent() { return services?.resolveTitle(this.__id) ?? 'page' }

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return <PageRef id={this.__id} nodeKey={this.getKey()} />
  }
}

export function $createPageLinkNode(id: string) { return new PageLinkNode(id) }
export function $isPageLinkNode(node: LexicalNode | null | undefined): node is PageLinkNode {
  return node instanceof PageLinkNode
}

// ---------------------------------------------------------------------------
// The rendered pill.
// ---------------------------------------------------------------------------

function PageRef({ id }: { id: string; nodeKey: NodeKey }) {
  const svc = usePageLinkServices()
  const title = svc?.resolveTitle(id) ?? null
  const missing = title === null
  const open = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (!missing) svc?.navigate(id)
  }
  return (
    <span
      className={`page-ref${missing ? ' page-ref-missing' : ''}`}
      contentEditable={false}
      role="link"
      tabIndex={0}
      title={missing ? 'This page no longer exists' : title ?? undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={open}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') open(event as unknown as React.MouseEvent) }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="page-ref-icon"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg>
      {missing ? 'Deleted page' : (title || 'Untitled')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Markdown <-> Lexical visitors.
// ---------------------------------------------------------------------------

const MdastPageLinkVisitor = {
  // Beat the default link visitor (priority 0) for our scheme only.
  priority: 10,
  testNode: (node: unknown) => {
    const link = node as { type?: string; url?: string }
    return link.type === 'link' && typeof link.url === 'string' && link.url.startsWith(PAGE_LINK_SCHEME)
  },
  // Append the leaf directly and ignore the mdast link's text children, so the
  // cached title never enters the document model.
  visitNode: ({ mdastNode, lexicalParent }: { mdastNode: { url: string }; lexicalParent: LexicalNode }) => {
    const id = mdastNode.url.slice(PAGE_LINK_SCHEME.length)
    ;(lexicalParent as unknown as { append: (n: LexicalNode) => void }).append($createPageLinkNode(id))
  }
}

const LexicalPageLinkVisitor = {
  testLexicalNode: $isPageLinkNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }: {
    lexicalNode: PageLinkNode
    mdastParent: unknown
    actions: { appendToParent: (parent: unknown, node: unknown) => unknown }
  }) => {
    const id = lexicalNode.getId()
    const title = services?.resolveTitle(id) ?? 'Untitled'
    actions.appendToParent(mdastParent, {
      type: 'link',
      url: `${PAGE_LINK_SCHEME}${id}`,
      children: [{ type: 'text', value: title }]
    })
  }
}

// ---------------------------------------------------------------------------
// The `[[` autocomplete. Rendered as a composer child so it lives inside the
// realm and can read the active editor.
// ---------------------------------------------------------------------------

const TRIGGER = /\[\[([^[\]]*)$/

type PickerState = { query: string; left: number; top: number; bottom: number } | null

function PageLinkAutocomplete() {
  const editor = useCellValue(activeEditor$) as LexicalEditor | null
  const svc = usePageLinkServices()
  const [picker, setPicker] = useState<PickerState>(null)
  const [highlight, setHighlight] = useState(0)
  const pickerRef = useRef(picker)
  pickerRef.current = picker

  const options = useMemo<PageOption[]>(() => picker && svc ? svc.searchPages(picker.query) : [], [picker, svc])
  const query = picker?.query ?? ''
  const rows = query.trim().length > 0 ? options.length + 1 : options.length
  const createIndex = query.trim().length > 0 ? options.length : -1
  useEffect(() => { setHighlight(0) }, [query])

  // Replace the live `[[query` with a page link. When id is null the query is
  // used to spin up a new subpage first.
  const choose = useCallback((id: string | null) => {
    if (!editor) return
    const insert = (pageId: string) => editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
      const anchor = selection.anchor
      const node = anchor.getNode()
      if (!$isTextNode(node)) return
      const match = TRIGGER.exec(node.getTextContent().slice(0, anchor.offset))
      if (!match) return
      const start = anchor.offset - match[0].length
      const range = $createRangeSelection()
      range.anchor.set(node.getKey(), start, 'text')
      range.focus.set(node.getKey(), anchor.offset, 'text')
      $setSelection(range)
      $insertNodes([$createPageLinkNode(pageId), $createTextNode(' ')])
    })
    setPicker(null)
    if (id) { insert(id); return }
    const title = pickerRef.current?.query.trim()
    if (!title || !svc) return
    void svc.createSubpage(title).then((newId) => { if (newId) { insert(newId); editor.focus() } })
  }, [editor, svc])

  // Watch the caret for an open `[[` run and position the popover at it.
  useEffect(() => {
    if (!editor) return
    return editor.registerUpdateListener(({ editorState }) => {
      const next = editorState.read<PickerState>(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
        const node = selection.anchor.getNode()
        if (!$isTextNode(node)) return null
        const match = TRIGGER.exec(node.getTextContent().slice(0, selection.anchor.offset))
        if (!match) return null
        const domSelection = window.getSelection()
        if (!domSelection || domSelection.rangeCount === 0) return null
        const rect = domSelection.getRangeAt(0).getBoundingClientRect()
        return { query: match[1], left: rect.left, top: rect.top, bottom: rect.bottom }
      })
      setPicker((current) => {
        if (!next) return null
        if (current && current.query === next.query && current.left === next.left && current.bottom === next.bottom) return current
        return next
      })
    })
  }, [editor])

  // Keyboard driving while the popover is open.
  useEffect(() => {
    if (!editor || !picker) return
    const stop = (handler: () => void) => (event: KeyboardEvent | null) => {
      if (!pickerRef.current) return false
      event?.preventDefault()
      handler()
      return true
    }
    const move = (delta: number) => stop(() => setHighlight((value) => rows === 0 ? 0 : (value + delta + rows) % rows))
    const removeDown = editor.registerCommand(KEY_ARROW_DOWN_COMMAND, move(1), COMMAND_PRIORITY_LOW)
    const removeUp = editor.registerCommand(KEY_ARROW_UP_COMMAND, move(-1), COMMAND_PRIORITY_LOW)
    const removeEnter = editor.registerCommand(KEY_ENTER_COMMAND, stop(() => {
      if (createIndex >= 0 && highlight === createIndex) choose(null)
      else if (options[highlight]) choose(options[highlight].id)
    }), COMMAND_PRIORITY_LOW)
    const removeEscape = editor.registerCommand(KEY_ESCAPE_COMMAND, stop(() => setPicker(null)), COMMAND_PRIORITY_LOW)
    return () => { removeDown(); removeUp(); removeEnter(); removeEscape() }
  }, [editor, picker, rows, highlight, createIndex, options, choose])

  if (!picker) return null
  const width = 280
  const left = Math.min(picker.left, window.innerWidth - width - 12)
  const belowSpace = window.innerHeight - picker.bottom
  const openUp = belowSpace < 240
  return createPortal(
    <div
      className="page-ref-picker"
      style={openUp ? { left, bottom: window.innerHeight - picker.top + 6, width } : { left, top: picker.bottom + 6, width }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {options.length === 0 && createIndex < 0 && <div className="page-ref-empty">Type to find a page…</div>}
      {options.map((option, index) => (
        <button
          key={option.id}
          className={`page-ref-option${highlight === index ? ' active' : ''}`}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => choose(option.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg>
          <span>{option.title || 'Untitled'}</span>
        </button>
      ))}
      {createIndex >= 0 && (
        <button
          className={`page-ref-option page-ref-create${highlight === createIndex ? ' active' : ''}`}
          onMouseEnter={() => setHighlight(createIndex)}
          onClick={() => choose(null)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>New subpage “{query.trim()}”</span>
        </button>
      )}
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Plugin registration.
// ---------------------------------------------------------------------------

// A toolbar affordance for people who don't know the `[[` shortcut: it just
// types the trigger and lets the same popover take over.
export function InsertPageLink() {
  const editor = useCellValue(activeEditor$) as LexicalEditor | null
  return (
    <button
      type="button"
      className="page-ref-insert"
      title="Link to page"
      aria-label="Link to page"
      onClick={() => {
        editor?.focus()
        editor?.update(() => {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) selection.insertText('[[')
        })
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg>
    </button>
  )
}

export const pageLinkPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addImportVisitor$]: MdastPageLinkVisitor,
      [addLexicalNode$]: PageLinkNode,
      [addExportVisitor$]: LexicalPageLinkVisitor,
      [addComposerChild$]: PageLinkAutocomplete
    })
  }
})
