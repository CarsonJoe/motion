import { createRootEditorSubscription$, realmPlugin } from '@mdxeditor/editor'
import { $createTextNode, $getSelection, $isElementNode, $isRangeSelection, $nodesOfType, COMMAND_PRIORITY_LOW, KEY_BACKSPACE_COMMAND, ParagraphNode } from 'lexical'

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

export const persistentBlankLinesPlugin = realmPlugin({
  init: (realm) => {
    realm.pub(createRootEditorSubscription$, (editor) => {
      let queued = false
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
                paragraph.append($createTextNode(BLANK_LINE))
                // Park the caret ahead of the marker, so the first character
                // typed lands before it and the strip below carries it away.
                if (active) paragraph.selectStart()
              } else if (value !== BLANK_LINE && value.includes(BLANK_LINE)) {
                for (const child of paragraph.getAllTextNodes()) child.setTextContent(child.getTextContent().replaceAll(BLANK_LINE, ''))
              }
            }
          }, { onUpdate: () => { queued = false } })
        })
      }

      // Backspace in a blank block removes the block, not the marker inside it.
      // Without this the marker absorbs the keystroke, normalize puts it back,
      // and the block cannot be deleted at all.
      const removeBackspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, () => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
        const node = selection.anchor.getNode()
        const paragraph = blankParagraph(node) ? node : node.getParents().find(blankParagraph)
        if (!paragraph) return false
        const previous = paragraph.getPreviousSibling()
        // Nothing to merge back into: swallow the key rather than let the
        // marker be deleted and immediately re-added.
        if (!previous) return true
        if ($isElementNode(previous)) previous.selectEnd()
        else previous.selectNext()
        paragraph.remove()
        return true
      }, COMMAND_PRIORITY_LOW)

      const removeUpdate = editor.registerUpdateListener(normalize)
      return () => { removeUpdate(); removeBackspace() }
    })
  }
})
