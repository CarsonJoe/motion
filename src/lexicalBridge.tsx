import { useEffect } from 'react'
import { $getNearestNodeFromDOMNode, $getRoot, $isElementNode, $isTextNode, type LexicalEditor } from 'lexical'
import { addComposerChild$, realmPlugin, rootEditor$, useCellValue } from '@mdxeditor/editor'
import { registerEditorAdapter } from './editorAdapter'

// Exposes the raw Lexical editor to the framework-agnostic mobile-keyboard
// engine, and implements caret placement + focus THROUGH Lexical's API rather
// than by poking the DOM selection. That's the whole point: when we set the
// caret via the DOM and focus the element ourselves, Lexical reconciles its own
// model a beat later and overwrites us (the caret jumps back to its last
// selection, and its scroll-into-view re-pans). Going through Lexical means the
// selection we set IS Lexical's selection — nothing to reconcile against.
//
// This is the first concrete "editor adapter" for the engine: the engine calls
// these editor-agnostic operations; only this file knows about Lexical.

let editor: LexicalEditor | null = null

// Rendered inside the editor realm via addComposerChild$ (see lexicalBridgePlugin).
export function LexicalBridge() {
  const current = useCellValue(rootEditor$) as LexicalEditor | null
  useEffect(() => {
    editor = current
    return () => { if (editor === current) editor = null }
  }, [current])
  return null
}

function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y)
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (!pos) return null
  const r = document.createRange()
  r.setStart(pos.offsetNode, pos.offset)
  r.collapse(true)
  return r
}

export const lexicalAdapter = {
  hasEditor: () => editor !== null,

  // Resolve a screen point to a DOM range on the CURRENT layout. Do this BEFORE
  // any scroll (e.g. placeCaretAtStart) — the range references nodes, so placing
  // it later survives a shift, whereas re-resolving coordinates after a scroll
  // lands on the wrong line.
  rangeFromPoint(x: number, y: number): Range | null {
    return caretRangeFromPoint(x, y)
  },

  // Place the caret at a previously-resolved DOM range, through Lexical.
  // `discrete: true` flushes synchronously so the DOM selection is updated
  // before we measure/scroll.
  placeCaretAtRange(range: Range): boolean {
    if (!editor) return false
    let ok = false
    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(range.startContainer)
      if (!node) return
      if (range.startContainer.nodeType === Node.TEXT_NODE && $isTextNode(node)) node.select(range.startOffset, range.startOffset)
      else if ($isElementNode(node)) node.selectEnd()
      else node.selectNext?.()
      ok = true
    }, { discrete: true })
    return ok
  },

  placeCaretAtEnd(): boolean {
    if (!editor) return false
    editor.update(() => { $getRoot().selectEnd() }, { discrete: true })
    return true
  },

  // Used to park the caret at the top BEFORE focusing, so iOS's focus check
  // sees a visible caret and doesn't pan; the real caret is placed right after.
  placeCaretAtStart(): boolean {
    if (!editor) return false
    editor.update(() => { $getRoot().selectStart() }, { discrete: true })
    return true
  },

  // Lexical's focus() uses preventScroll internally and keeps ITS current
  // selection (the one we just set) — so a reopen's blur+focus no longer
  // resurrects the previous caret.
  focus(): void { editor?.focus() },
  blur(): void { editor?.blur() },
  isFocused(): boolean {
    const el = editor?.getRootElement()
    return !!el && el.contains(document.activeElement)
  },
}

// Registered on import rather than on mount: this module only evaluates when
// the editor chunk loads, and until then the engine sees the inert proxy.
registerEditorAdapter(lexicalAdapter)

export const lexicalBridgePlugin = realmPlugin({
  init(realm) { realm.pubIn({ [addComposerChild$]: LexicalBridge }) }
})
