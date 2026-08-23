// The Markdown editing surface, split out of App so the entry bundle does not
// carry MDXEditor, Lexical and their stylesheet.
//
// Everything the app can do BEFORE you open a page — paint the shell, read
// IndexedDB, list and search pages, resolve a deep link, start syncing — needs
// none of this code, and it is by far the largest thing in the build. Loading
// it as a separate chunk (App lazy-imports it, and prefetches it the moment the
// local store is up) is what lets a cold PWA launch paint local data without
// first parsing the editor.

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePublisher } from '@mdxeditor/gurx'
import { BoldItalicUnderlineToggles, ButtonWithTooltip, headingsPlugin, HighlightToggle, iconComponentFor$, imagePlugin, insertImage$, InsertTable, linkDialogPlugin, linkPlugin, listsPlugin, ListsToggle, markdownShortcutPlugin, MDXEditor, type MDXEditorMethods, quotePlugin, readOnly$, tablePlugin, thematicBreakPlugin, toolbarPlugin, UndoRedo, useCellValue } from '@mdxeditor/editor'
import { BlockTypeMenu } from './blockTypeMenu'
import { persistentBlankLinesPlugin } from './blankLinesPlugin'
import { InsertPageLink, pageLinkPlugin } from './pageLink'
import { editorMenuPlugin, thematicBreakRulePlugin } from './editorMenu'
import { lexicalBridgePlugin } from './lexicalBridge'
import { toEditorMarkdown } from './markdown'
import './editorVendor.css'

// The stored document IS this Markdown string, so serialization has to be a
// pinned, stable function of the content — never a library default that a
// dependency bump can move under us. Any drift here is not cosmetic: the editor
// re-exports the whole document, so a changed marker rewrites every line of
// every page, which the CRDT has to merge as a genuine edit.
//
// `-` bullets and `_` rules are chosen to match what people type and paste, so
// the stored text stays the Markdown a user would have written by hand. The two
// markers stay distinct on purpose: `---` under a paragraph is a Setext heading,
// not a rule.
const MARKDOWN_OPTIONS = {
  bullet: '-', bulletOrdered: '.', listItemIndent: 'one',
  emphasis: '_', strong: '*', rule: '_',
  fence: '`', fences: true, quote: '"',
  incrementListMarker: true, resourceLink: false, setext: false
} as const

// The image button is intentionally just a file-picker trigger. URL, alt, and
// title fields belong in Markdown for people who need them; the common action
// should be one click, one system picker, and an immediate local-first insert.
function InsertImagePicker() {
  const input = useRef<HTMLInputElement>(null)
  const insertImage = usePublisher(insertImage$)
  const iconComponentFor = useCellValue(iconComponentFor$)
  const readOnly = useCellValue(readOnly$)
  return <>
    <ButtonWithTooltip
      title="Insert image"
      aria-label="Insert image"
      disabled={readOnly}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => input.current?.click()}
    >
      {iconComponentFor('add_photo')}
    </ButtonWithTooltip>
    <input
      ref={input}
      hidden
      tabIndex={-1}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      onClick={(event) => { event.currentTarget.value = '' }}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file) insertImage({ file })
      }}
    />
  </>
}

const NoImageUi = () => null

export default function MarkdownEditor({ markdown, onChange, toolbarHost, readOnly = false, onUploadImage, resolveImage }: { markdown: string; onChange: (value: string) => void; toolbarHost: HTMLElement; readOnly?: boolean; onUploadImage?: (file: File) => Promise<string>; resolveImage?: (source: string) => Promise<string> }) {
  const editor = useRef<MDXEditorMethods>(null)
  const container = useRef<HTMLDivElement>(null)
  const editorMarkdown = toEditorMarkdown(markdown)
  const current = useRef(editorMarkdown)
  // Loading markdown INTO the editor must never come back out as an edit. The
  // editor re-serializes whatever it is given and its output is not always the
  // input byte for byte — bullet markers, escaping, and the blank-line markers
  // this app inserts all get rewritten. Pushing that back into the CRDT makes
  // each client restate text the other authored, and two clients doing it at
  // once is resolved by Yjs the only way it can be: both insertions survive, so
  // the body appears twice. A rewrite that spans a block boundary corrupts the
  // structure instead — a leading list item comes back as escaped paragraph
  // text. Nothing is lost by dropping these: the doc already holds the text the
  // editor was handed, and the next real keystroke exports the whole document.
  //
  // MDXEditor mutes onChange for its own import, but persistentBlankLinesPlugin
  // normalizes in a microtask right after it, once that mute has been lifted —
  // so the hold has to outlive the task rather than the import call.
  const applying = useRef(true)
  const release = useRef<number | undefined>(undefined)
  const holdApplying = () => {
    applying.current = true
    window.clearTimeout(release.current)
    release.current = window.setTimeout(() => { applying.current = false }, 0)
  }
  useEffect(() => {
    holdApplying()
    return () => window.clearTimeout(release.current)
  }, [])
  useEffect(() => {
    if (editorMarkdown === current.current) return
    current.current = editorMarkdown
    holdApplying()
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
    editor.current?.setMarkdown(editorMarkdown)
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
  }, [editorMarkdown])
  return <div ref={container}><MDXEditor ref={editor} markdown={editorMarkdown} readOnly={readOnly} contentEditableClassName="motion-md-content" toMarkdownOptions={MARKDOWN_OPTIONS} onChange={(value) => { current.current = value; if (!applying.current) onChange(value) }} plugins={[
    headingsPlugin(), listsPlugin(), quotePlugin(), linkPlugin(), linkDialogPlugin(), imagePlugin({ imageUploadHandler: onUploadImage ?? null, imagePreviewHandler: resolveImage ?? null, allowSetImageDimensions: false, disableImageSettingsButton: true, ImageDialog: NoImageUi, EditImageToolbar: NoImageUi }), markdownShortcutPlugin(), thematicBreakPlugin(), tablePlugin(), pageLinkPlugin(), editorMenuPlugin(), thematicBreakRulePlugin(), lexicalBridgePlugin(), persistentBlankLinesPlugin({}),
    toolbarPlugin({ toolbarClassName: 'motion-md-toolbar', toolbarContents: () => createPortal(<><span className="core-tools"><UndoRedo /><BlockTypeMenu /><BoldItalicUnderlineToggles /><HighlightToggle /><ListsToggle /><InsertPageLink /><InsertImagePicker /></span><span className="extra-tools"><InsertTable /></span></>, toolbarHost) })
  ]} /></div>
}
