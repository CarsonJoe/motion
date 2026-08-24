import { describe, expect, it } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $isTextNode, createEditor, DELETE_CHARACTER_COMMAND, ParagraphNode } from 'lexical'
import { registerPersistentBlankLines } from './blankLinesPlugin'

const settleNormalization = () => new Promise((resolve) => setTimeout(resolve, 0))

function testEditor() {
  const editor = createEditor({
    namespace: 'blank-lines-test',
    nodes: [ParagraphNode],
    onError: (error) => { throw error }
  })
  const cleanup = registerPersistentBlankLines(editor)
  return { editor, cleanup }
}

describe('persistent blank lines', () => {
  it('keeps the caret after the first character typed into a blank page', async () => {
    const { editor, cleanup } = testEditor()
    editor.update(() => {
      const paragraph = $createParagraphNode()
      $getRoot().append(paragraph)
      paragraph.selectStart()
    }, { discrete: true })
    await settleNormalization()

    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) selection.insertText('a')
    }, { discrete: true })
    await settleNormalization()

    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('a')
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if ($isRangeSelection(selection)) expect(selection.anchor.offset).toBe(1)
    })
    cleanup()
  })

  it('repairs a stale mobile selection when the first character enters the marker node', async () => {
    const { editor, cleanup } = testEditor()
    editor.update(() => {
      const paragraph = $createParagraphNode()
      $getRoot().append(paragraph)
      paragraph.selectStart()
    }, { discrete: true })
    await settleNormalization()

    editor.update(() => {
      const marker = $getRoot().getFirstDescendant()
      if ($isTextNode(marker)) {
        marker.setTextContent(`a${marker.getTextContent()}`)
        // This is the stale selection observed from mobile before reconciliation.
        marker.select(0, 0)
      }
    }, { discrete: true })
    await settleNormalization()

    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('a')
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if ($isRangeSelection(selection)) expect(selection.anchor.offset).toBe(1)
    })
    cleanup()
  })

  it('removes a blank block without deleting the previous block’s final character', async () => {
    const { editor, cleanup } = testEditor()
    editor.update(() => {
      const first = $createParagraphNode().append($createTextNode('abc'))
      const blank = $createParagraphNode()
      $getRoot().append(first, blank)
      blank.selectStart()
    }, { discrete: true })
    await settleNormalization()

    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)
    await settleNormalization()

    editor.getEditorState().read(() => {
      expect($getRoot().getChildrenSize()).toBe(1)
      expect($getRoot().getTextContent()).toBe('abc')
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if ($isRangeSelection(selection)) expect(selection.anchor.offset).toBe(3)
    })
    cleanup()
  })
})
