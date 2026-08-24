import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { renderedOffsetToSource, sourceOffsetToRendered, translateTextOffset } from './cursorMap'

describe('cursor markdown mapping', () => {
  it('maps across block and formatting syntax', () => {
    const markdown = '# One\n\nA **bold** word'
    const rendered = 'OneA bold word'
    for (let offset = 0; offset <= rendered.length; offset += 1) {
      const source = renderedOffsetToSource(markdown, rendered, offset)
      expect(sourceOffsetToRendered(markdown, rendered, source)).toBe(offset)
    }
  })

  it('keeps a second-block caret attached when the first block changes', () => {
    const before = 'One\n\nSecond'
    const after = 'One longer\n\nSecond'
    const beforeSource = renderedOffsetToSource(before, 'OneSecond', 6)
    expect(beforeSource).toBe(8)
    // A Y relative position at the source location moves by the inserted bytes.
    const transformedSource = beforeSource + ' longer'.length
    expect(sourceOffsetToRendered(after, 'One longerSecond', transformedSource)).toBe(13)
  })

  it('maps table cell text without counting Markdown delimiters', () => {
    const markdown = '| A | B |\n| - | - |\n| C | D |'
    const rendered = 'ABCD'
    for (let offset = 0; offset <= rendered.length; offset += 1) {
      const source = renderedOffsetToSource(markdown, rendered, offset)
      expect(sourceOffsetToRendered(markdown, rendered, source)).toBe(offset)
    }
  })

  it('moves a remote caret backward immediately when text before it is deleted', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const before = 'First block\n\nSecond block'
    text.insert(0, before)
    const source = renderedOffsetToSource(before, 'First blockSecond block', 'First blockSecond'.length)
    const relative = Y.createRelativePositionFromTypeIndex(text, source)

    text.delete(0, 'First '.length)
    const after = text.toString()
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc)
    expect(absolute?.type).toBe(text)
    expect(sourceOffsetToRendered(after, 'blockSecond block', absolute?.index ?? 0)).toBe('blockSecond'.length)
  })

  it('reconciles live decorator text with its cached Markdown label', () => {
    const markdown = '[Old](motion:page) after'
    const rendered = 'A much longer title after'
    const source = renderedOffsetToSource(markdown, rendered, 'A much longer title'.length)
    expect(sourceOffsetToRendered(markdown, rendered, source)).toBe('A much longer title'.length)
  })

  it('translates offsets through insertions and deletions', () => {
    expect(translateTextOffset('abcdef', 'abef', 4)).toBe(2)
    expect(translateTextOffset('abef', 'abcdef', 2)).toBe(4)
  })
})
