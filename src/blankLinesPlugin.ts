import { createRootEditorSubscription$, realmPlugin } from '@mdxeditor/editor'
import { $createTextNode, $getSelection, $isRangeSelection, $nodesOfType, BLUR_COMMAND, COMMAND_PRIORITY_LOW, ParagraphNode } from 'lexical'

// CommonMark discards surplus blank lines. A zero-width space is valid
// Markdown text and keeps an intentionally empty paragraph round-trippable.
const BLANK_LINE = '\u200B'

export const persistentBlankLinesPlugin = realmPlugin({
  init: (realm) => {
    realm.pub(createRootEditorSubscription$, (editor) => {
      let queued = false
      const normalize = (includeActive: boolean) => {
        if (queued) return
        const needed = editor.getEditorState().read(() => {
          const selection = $getSelection()
          const anchorNode = $isRangeSelection(selection) ? selection.anchor.getNode() : null
          return $nodesOfType(ParagraphNode).some((paragraph) => {
            const active = anchorNode === paragraph || Boolean(anchorNode?.getParents().includes(paragraph))
            const value = paragraph.getTextContent()
            return (value === '' && (includeActive || !active)) || (active && value === BLANK_LINE) || (value.includes(BLANK_LINE) && value !== BLANK_LINE)
          })
        })
        if (!needed) return
        queued = true
        queueMicrotask(() => {
          editor.update(() => {
            const selection = $getSelection()
            const anchorNode = $isRangeSelection(selection) ? selection.anchor.getNode() : null
            for (const paragraph of $nodesOfType(ParagraphNode)) {
              const active = anchorNode === paragraph || Boolean(anchorNode?.getParents().includes(paragraph))
              const value = paragraph.getTextContent()
              if (active && value === BLANK_LINE && !includeActive) {
                paragraph.clear()
                paragraph.selectStart()
              } else if (value === '' && (includeActive || !active)) paragraph.append($createTextNode(BLANK_LINE))
              else if (value.includes(BLANK_LINE) && value !== BLANK_LINE) {
                for (const child of paragraph.getAllTextNodes()) child.setTextContent(child.getTextContent().replaceAll(BLANK_LINE, ''))
              }
            }
          }, { onUpdate: () => { queued = false } })
        })
      }
      const removeUpdate = editor.registerUpdateListener(() => normalize(false))
      const removeBlur = editor.registerCommand(BLUR_COMMAND, () => { normalize(true); return false }, COMMAND_PRIORITY_LOW)
      return () => { removeUpdate(); removeBlur() }
    })
  }
})
