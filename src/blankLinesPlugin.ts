import { createRootEditorSubscription$, realmPlugin } from '@mdxeditor/editor'
import { $isHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { $createTextNode, $getSelection, $isElementNode, $isRangeSelection, $nodesOfType, COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, ParagraphNode, type LexicalEditor } from 'lexical'

// CommonMark discards surplus blank lines. A zero-width space is valid
// Markdown text and keeps an intentionally empty paragraph round-trippable.
const BLANK_LINE = '\u200B'

// Every empty paragraph carries the marker, including the one the caret is in.
// That uniformity is the whole point: the serialized document has to be a
// function of the content alone. When the marker was withheld from the active
// paragraph, the exported Markdown depended on where the caret happened to be,
// so merely clicking into an empty block deleted it for every collaborator, and
// clicking out re-created it — a document rewrite per caret move, and a standing
// disagreement between two clients whose carets sit in different blocks.
//
// The cost of the uniform marker is that a visually empty block is not actually
// empty, so Backspace would eat the marker instead of the block. The command
// handler below restores that gesture.
const blankParagraph = (node: unknown): node is ParagraphNode =>
  node instanceof ParagraphNode && node.getTextContent() === BLANK_LINE

export function registerPersistentBlankLines(editor: LexicalEditor) {
  let queued = false
  // Remember markers created by this editor. Some mobile browser input paths
  // insert the first character into that node but leave Lexical's selection at
  // offset zero. When we strip the marker, explicitly put that stale selection
  // after the inserted text instead of letting reconciliation show it in front.
  const markerKeys = new Set<string>()
  const normalize = () => {
    if (queued) return
    const needed = editor.getEditorState().read(() => $nodesOfType(ParagraphNode).some((paragraph) => {
      const value = paragraph.getTextContent()
      return value === '' || (value !== BLANK_LINE && value.includes(BLANK_LINE))
    }))
    if (!needed) return
    queued = true
    queueMicrotask(() => {
      editor.update(() => {
        const selection = $getSelection()
        const anchorNode = $isRangeSelection(selection) ? selection.anchor.getNode() : null
        for (const paragraph of $nodesOfType(ParagraphNode)) {
          const value = paragraph.getTextContent()
          if (value === '') {
            const active = anchorNode === paragraph || Boolean(anchorNode?.getParents().includes(paragraph))
            const marker = $createTextNode(BLANK_LINE)
            paragraph.append(marker)
            markerKeys.add(marker.getKey())
            // Park the caret ahead of the marker, so the first character typed
            // lands before it and the strip below carries it away.
            if (active) marker.selectStart()
          } else if (value !== BLANK_LINE && value.includes(BLANK_LINE)) {
            for (const child of paragraph.getAllTextNodes()) {
              const text = child.getTextContent()
              if (!text.includes(BLANK_LINE)) continue
              const ownMarker = markerKeys.delete(child.getKey())
              const markerOffset = text.slice(0, text.indexOf(BLANK_LINE)).replaceAll(BLANK_LINE, '').length
              const staleStart = ownMarker && markerOffset > 0 && $isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.key === child.getKey() && selection.anchor.offset === 0
              const pointOffset = (offset: number) => offset - (text.slice(0, offset).split(BLANK_LINE).length - 1)
              const anchorOffset = $isRangeSelection(selection) && selection.anchor.key === child.getKey() ? pointOffset(selection.anchor.offset) : null
              const focusOffset = $isRangeSelection(selection) && selection.focus.key === child.getKey() ? pointOffset(selection.focus.offset) : null
              child.setTextContent(text.replaceAll(BLANK_LINE, ''))
              if ($isRangeSelection(selection)) {
                if (anchorOffset !== null) selection.anchor.set(child.getKey(), staleStart ? markerOffset : anchorOffset, 'text')
                if (focusOffset !== null) selection.focus.set(child.getKey(), staleStart ? markerOffset : focusOffset, 'text')
              }
            }
          }
        }
      }, { onUpdate: () => { queued = false } })
    })
  }

  // Intercept the actual deletion command rather than KEY_BACKSPACE. On iOS
  // Lexical deliberately lets keydown fall through and deletes during
  // beforeinput; handling keydown ourselves made that second pass delete the
  // final character of the preceding block after we had removed this one.
  const removeBackspace = editor.registerCommand(DELETE_CHARACTER_COMMAND, (isBackward) => {
    if (!isBackward) return false
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
    const node = selection.anchor.getNode()
    const paragraph = blankParagraph(node) ? node : node.getParents().find(blankParagraph)
    if (!paragraph) return false
    const previous = paragraph.getPreviousSibling()
    // Nothing to merge back into: swallow the key rather than let the marker
    // be deleted and immediately re-added.
    if (!previous) return true
    // A divider is an atomic decorator rather than an editable block. On
    // mobile there are no arrow keys with which to select it, so Backspace from
    // its trailing paragraph must remove the divider and keep that paragraph
    // (and its caret) available for typing.
    if ($isHorizontalRuleNode(previous)) {
      previous.remove()
      paragraph.selectStart()
      return true
    }
    for (const child of paragraph.getAllTextNodes()) markerKeys.delete(child.getKey())
    if ($isElementNode(previous)) previous.selectEnd()
    else previous.selectNext()
    paragraph.remove()
    return true
  }, COMMAND_PRIORITY_HIGH)

  const removeUpdate = editor.registerUpdateListener(normalize)
  return () => { removeUpdate(); removeBackspace() }
}

export const persistentBlankLinesPlugin = realmPlugin({
  init: (realm) => {
    realm.pub(createRootEditorSubscription$, registerPersistentBlankLines)
  }
})
