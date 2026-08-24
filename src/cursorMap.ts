import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTable } from 'micromark-extension-gfm-table'

type Point = { offset?: number }
type MdNode = { type?: string; value?: string; children?: MdNode[]; position?: { start?: Point; end?: Point } }
type Segment = { plainStart: number; plainEnd: number; sourceStart: number; sourceEnd: number; boundaries: number[] }
type CursorMap = { plainText: string; segments: Segment[]; sourceLength: number }

const maps = new Map<string, CursorMap>()
const MAX_CACHED_MAPS = 20

function boundaryMap(source: string, value: string, sourceStart: number, sourceEnd: number) {
  const raw = source.slice(sourceStart, sourceEnd)
  const matches: number[] = []
  let cursor = 0
  for (let index = 0; index < value.length; index += 1) {
    const found = raw.indexOf(value[index], cursor)
    matches.push(found < 0 ? cursor : found)
    cursor = found < 0 ? cursor : found + 1
  }
  const boundaries = [sourceStart]
  for (let index = 1; index < value.length; index += 1) boundaries.push(sourceStart + matches[index])
  boundaries.push(sourceEnd)
  return boundaries
}

function createCursorMap(source: string): CursorMap {
  const segments: Segment[] = []
  let plainText = ''
  try {
    const root = fromMarkdown(source, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }) as MdNode
    const visit = (node: MdNode) => {
      const isLeaf = node.type === 'text' || node.type === 'inlineCode' || node.type === 'code'
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (isLeaf && typeof node.value === 'string' && typeof start === 'number' && typeof end === 'number') {
        const plainStart = plainText.length
        plainText += node.value
        segments.push({ plainStart, plainEnd: plainText.length, sourceStart: start, sourceEnd: end, boundaries: boundaryMap(source, node.value, start, end) })
        return
      }
      node.children?.forEach(visit)
    }
    visit(root)
  } catch {
    plainText = source
    segments.push({ plainStart: 0, plainEnd: source.length, sourceStart: 0, sourceEnd: source.length, boundaries: Array.from({ length: source.length + 1 }, (_, index) => index) })
  }
  return { plainText, segments, sourceLength: source.length }
}

function mapFor(source: string) {
  const cached = maps.get(source)
  if (cached) return cached
  const value = createCursorMap(source)
  maps.set(source, value)
  if (maps.size > MAX_CACHED_MAPS) maps.delete(maps.keys().next().value!)
  return value
}

// Reconcile the parser's logical text with the actual editor DOM. They normally
// match; this also handles decorators such as page links whose live title can
// differ from the cached label stored in Markdown.
export function translateTextOffset(from: string, to: string, offset: number) {
  const point = Math.min(Math.max(offset, 0), from.length)
  if (from === to) return Math.min(point, to.length)
  let start = 0
  while (start < from.length && start < to.length && from[start] === to[start]) start += 1
  let fromEnd = from.length
  let toEnd = to.length
  while (fromEnd > start && toEnd > start && from[fromEnd - 1] === to[toEnd - 1]) { fromEnd -= 1; toEnd -= 1 }
  if (point < start) return point
  if (point >= fromEnd) return Math.min(to.length, toEnd + point - fromEnd)
  const fromSpan = fromEnd - start
  const toSpan = toEnd - start
  return start + Math.round((point - start) / fromSpan * toSpan)
}

export function renderedOffsetToSource(markdown: string, renderedText: string, offset: number) {
  const map = mapFor(markdown)
  const plainOffset = translateTextOffset(renderedText, map.plainText, offset)
  if (plainOffset <= 0 || map.segments.length === 0) return 0
  for (const segment of map.segments) {
    if (plainOffset < segment.plainStart) return segment.sourceStart
    if (plainOffset <= segment.plainEnd) return segment.boundaries[plainOffset - segment.plainStart] ?? segment.sourceEnd
  }
  return map.sourceLength
}

export function sourceOffsetToRendered(markdown: string, renderedText: string, offset: number) {
  const map = mapFor(markdown)
  const sourceOffset = Math.min(Math.max(offset, 0), map.sourceLength)
  let plainOffset = 0
  for (const segment of map.segments) {
    if (sourceOffset < segment.sourceStart) break
    if (sourceOffset <= segment.sourceEnd) {
      let boundary = 0
      while (boundary + 1 < segment.boundaries.length && segment.boundaries[boundary + 1] <= sourceOffset) boundary += 1
      plainOffset = segment.plainStart + boundary
      return translateTextOffset(map.plainText, renderedText, plainOffset)
    }
    plainOffset = segment.plainEnd
  }
  if (sourceOffset >= map.sourceLength) plainOffset = map.plainText.length
  return translateTextOffset(map.plainText, renderedText, plainOffset)
}
