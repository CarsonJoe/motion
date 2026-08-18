// The boundary between motion's stored Markdown and a plain .md file.
//
// The stored body is already Markdown — the CRDT holds one string and nothing
// else — so nothing here is a conversion. What it is, is the two places where
// motion's private conventions have to come off (or fail to go back on),
// because a file has no app around it to interpret them.

import * as Y from 'yjs'
import { toBase64 } from './codec'
import { PAGE_LINK_SCHEME } from './links'
import type { LocalStore, Note } from './local'
import { pageUrl } from './router'

// The blank-line marker (see blankLinesPlugin): a zero-width space standing in
// for an empty paragraph, which CommonMark cannot otherwise express. Private to
// this app, so it must not leave it — an exported file would carry invisible
// characters into every other editor, and they would be nearly impossible for
// anyone to diagnose or remove by hand.
const BLANK_LINE = '\u200B'

const PAGE_LINK = new RegExp(`\\]\\(${PAGE_LINK_SCHEME}([^)\\s]+)\\)`, 'g')

// The absolute address of a page, which is what `pageUrl` already defines for
// the router and the share sheet. Export resolving through the same function is
// the point: URL shape is decided in exactly one place, so a route change can
// never leave export emitting links that no longer open.
export const absolutePageUrl = (noteId: string, shareId: string | null) =>
  `${window.location.origin}${window.location.pathname}${pageUrl(noteId, shareId || null)}`

// Stored links stay origin-free as `motion:<id>` so a document survives moving
// between deployments — content authored against localhost must not carry
// localhost links into production. A file has no such context, so the export
// boundary is where those become addresses a browser can follow.
export function toExportMarkdown(markdown: string, shareIdFor: (noteId: string) => string | null) {
  return `${markdown
    .replace(PAGE_LINK, (_match, id: string) => {
      const noteId = decodeURIComponent(id)
      return `](${absolutePageUrl(noteId, shareIdFor(noteId))})`
    })
    .replaceAll(BLANK_LINE, '')
    // Stripping the markers leaves the blank lines they were holding open.
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

// Windows-hostile characters plus the separators, so the name is safe to hand
// to a download attribute on any platform.
export const exportFileName = (title: string) =>
  `${(title.trim() || 'Untitled').replace(/[\\/:*?"<>|#]/g, '-').replace(/\s+/g, ' ').slice(0, 80).trim()}.md`

// MDXEditor's Markdown importer treats CommonMark angle-bracket autolinks as
// malformed MDX and silently renders the whole document empty. Feed it the
// equivalent ordinary-link syntax; the stored Markdown is unchanged until the
// user makes a real edit, at which point the editor exports this valid form.
export function toEditorMarkdown(markdown: string) {
  return markdown.replace(/<(https?:\/\/[^<>\s]+)>/gi, (_match, url: string) => {
    const label = url.replace(/([\\\[\]])/g, '\\$1')
    const destination = url.replace(/[()]/g, (character) => character === '(' ? '%28' : '%29')
    return `[${label}](${destination})`
  })
}

// A dropped file is plain CommonMark that knows nothing about this app. There
// are no markers to restore — consecutive empty blocks are not expressible in
// Markdown, so there is genuinely nothing to recover — and any `motion:` links
// in it address a workspace that is not this one. Those are left exactly as
// written: a visibly dead link beats content edited behind the author's back.
export function fromImportMarkdown(text: string, fileName: string) {
  const lines = text.replace(/\r\n?/g, '\n').replaceAll(BLANK_LINE, '').split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  const heading = /^#\s+(.+?)\s*$/.exec(lines[start] ?? '')
  const stem = fileName.replace(/\.(md|markdown|mdx|txt)$/i, '').trim()
  // A leading H1 is the document's title far more often than it is its first
  // line of content, and it is what this app's own export produces.
  if (heading) return { title: heading[1], body: lines.slice(start + 1).join('\n').replace(/^\n+/, '') }
  return { title: stem || 'Untitled Note', body: lines.slice(start).join('\n') }
}

// An imported note is not open, so there is no document controller to write
// through. Seed it the way the controller would — doc state first, then the
// outbox — so a crash between the two writes loses nothing that hydrating the
// note later cannot heal.
export async function seedNoteBody(store: LocalStore, note: Note, body: string) {
  if (!body.trim()) return
  const doc = new Y.Doc()
  doc.getText('content').insert(0, body)
  const state = toBase64(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  await store.putDocState(note.id, state)
  await store.enqueueUpdate(note.id, note.shareId, note.roomId, state)
}
