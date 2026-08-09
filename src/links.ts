import * as Y from 'yjs'
import { fromBase64 } from './codec'
import type { LocalStore } from './local'

// The URL scheme that marks a markdown link as pointing at another page rather
// than an external site: `[Cached Title](motion:<id>)`. Kept here (not in the
// editor plugin) so the index stays free of any DOM/editor imports.
export const PAGE_LINK_SCHEME = 'motion:'

// A derived, in-memory index of internal links, so a page can show which other
// pages point at it (backlinks) without re-parsing every body on demand. It is
// seeded from local doc state and kept fresh as bodies change. Titles are not
// stored here — the app resolves those live from the notes cache.

const LINK_PATTERN = new RegExp(`\\]\\(${PAGE_LINK_SCHEME}([^)\\s]+)\\)`, 'g')

export function extractLinks(markdown: string): string[] {
  const ids = new Set<string>()
  LINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINK_PATTERN.exec(markdown))) ids.add(decodeURIComponent(match[1]))
  return [...ids]
}

// sourceId -> the note ids it links to.
const outgoing = new Map<string, Set<string>>()
let version = 0
const listeners = new Set<() => void>()
const emit = () => { version += 1; for (const listener of listeners) listener() }

const sameSet = (a: Set<string>, b: string[]) => a.size === b.length && b.every((id) => a.has(id))

// Records the internal links found in one note's body. No-ops when nothing
// changed so unrelated edits don't churn the index or repaint backlink panels.
export function indexNote(noteId: string, markdown: string) {
  const targets = extractLinks(markdown)
  const current = outgoing.get(noteId)
  if (targets.length === 0) {
    if (current) { outgoing.delete(noteId); emit() }
    return
  }
  if (current && sameSet(current, targets)) return
  outgoing.set(noteId, new Set(targets))
  emit()
}

export function forgetNote(noteId: string) {
  if (outgoing.delete(noteId)) emit()
}

// The note ids that link to the given page, excluding self-links.
export function backlinkSources(targetId: string): string[] {
  const sources: string[] = []
  for (const [sourceId, targets] of outgoing) {
    if (sourceId !== targetId && targets.has(targetId)) sources.push(sourceId)
  }
  return sources
}

export const subscribeLinks = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const getLinksVersion = () => version

// One pass over every locally-stored body to seed the index at startup.
export async function rebuildLinkIndex(store: LocalStore) {
  const states = await store.allDocStates()
  for (const { noteId, state } of states) {
    try {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, fromBase64(state))
      indexNote(noteId, doc.getText('content').toString())
      doc.destroy()
    } catch { /* a corrupt body just stays unindexed */ }
  }
}
