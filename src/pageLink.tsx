import { useSyncExternalStore, type ReactNode } from 'react'
import { DecoratorNode, $getSelection, $isRangeSelection, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import { realmPlugin, addImportVisitor$, addLexicalNode$, addExportVisitor$, activeEditor$, ButtonWithTooltip, iconComponentFor$, useCellValue } from '@mdxeditor/editor'
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

export type PageOption = {
  id: string
  title: string
  // What kind of document this is. Only pages exist today, but the picker keys
  // the row's icon off this, so a new document type is a new icon rather than a
  // text label bolted onto every row.
  kind: 'page'
  // The shortest location hint that tells this result apart from the other
  // shown results sharing its title. Absent — the common case, since most
  // titles are unique — so ordinary rows stay quiet.
  context?: string
}
// A link target resolves to a live title, a known tombstone, or nothing this
// viewer can see. "private" (absent from the store) is deliberately distinct
// from "deleted" (present with a tombstone): a shared page can link to a page
// the author kept private, and calling that "deleted" would invite cleanup.
export type PageRefState = { kind: 'ok'; title: string } | { kind: 'deleted' } | { kind: 'private' }
export type PageLinkServices = {
  resolveTitle: (id: string) => PageRefState
  navigate: (id: string) => void
  // The shareable href for a page, so link pills are real anchors that honor
  // middle/ctrl-click (open in a new tab).
  pageHref: (id: string) => string
  // Candidate pages for the `[[` picker, already filtered and ranked.
  searchPages: (query: string) => PageOption[]
  // Creates a page and resolves to its id, or null when not possible (e.g. no
  // write access). `parent` true nests it under the page being edited.
  createPage: (title: string, parent: boolean) => Promise<string | null>
}

let services: PageLinkServices | null = null
const serviceListeners = new Set<() => void>()

export function setPageLinkServices(next: PageLinkServices | null) {
  services = next
  for (const listener of serviceListeners) listener()
}

export function getPageLinkServices() { return services }

export function usePageLinkServices() {
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
  getTextContent() { const state = services?.resolveTitle(this.__id); return state?.kind === 'ok' ? state.title : 'page' }

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

const DOC_ICON = <svg viewBox="0 0 24 24" aria-hidden="true" className="page-ref-icon"><path d="M14 3v5h5M14 3H6v18h12V8z" /></svg>
const LOCK_ICON = <svg viewBox="0 0 24 24" aria-hidden="true" className="page-ref-icon"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>

function PageRef({ id }: { id: string; nodeKey: NodeKey }) {
  const svc = usePageLinkServices()
  const state = svc?.resolveTitle(id) ?? { kind: 'private' as const }

  // Non-navigable states render as plain spans — there is nothing to open.
  if (state.kind !== 'ok') {
    const label = state.kind === 'deleted' ? 'Deleted page' : 'Private page'
    const hint = state.kind === 'deleted' ? 'This page no longer exists' : 'You don’t have access to this page'
    return (
      <span className={`page-ref ${state.kind === 'deleted' ? 'page-ref-missing' : 'page-ref-private'}`} contentEditable={false} title={hint}>
        {state.kind === 'private' ? LOCK_ICON : DOC_ICON}{label}
      </span>
    )
  }

  // A real anchor so middle/ctrl/shift-click open a new tab; plain left-click is
  // intercepted for instant in-app navigation.
  const open = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    svc?.navigate(id)
  }
  return (
    <a
      className="page-ref"
      href={svc?.pageHref(id) ?? '#'}
      contentEditable={false}
      title={state.title || undefined}
      onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
      onClick={open}
    >
      {DOC_ICON}{state.title || 'Untitled'}
    </a>
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
    const state = services?.resolveTitle(id)
    const title = state?.kind === 'ok' ? state.title : 'Untitled'
    actions.appendToParent(mdastParent, {
      type: 'link',
      url: `${PAGE_LINK_SCHEME}${id}`,
      children: [{ type: 'text', value: title }]
    })
  }
}

// ---------------------------------------------------------------------------
// The single link toolbar button. It opens the `[[` menu, which covers both
// internal pages and external URLs, and is built from the same primitives as
// the other toolbar tools so it matches them exactly.
// ---------------------------------------------------------------------------

export function InsertPageLink() {
  const editor = useCellValue(activeEditor$) as LexicalEditor | null
  const iconComponentFor = useCellValue(iconComponentFor$)
  return (
    <ButtonWithTooltip
      title="Add link"
      aria-label="Add link"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        editor?.focus()
        editor?.update(() => {
          const selection = $getSelection()
          if ($isRangeSelection(selection)) selection.insertText('[[')
        })
      }}
    >
      {iconComponentFor('link')}
    </ButtonWithTooltip>
  )
}

export const pageLinkPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addImportVisitor$]: MdastPageLinkVisitor,
      [addLexicalNode$]: PageLinkNode,
      [addExportVisitor$]: LexicalPageLinkVisitor
    })
  }
})
