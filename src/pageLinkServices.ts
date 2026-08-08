// The page-link service registry, deliberately kept in its own module with no
// editor imports.
//
// The pills and the `[[` picker live inside MDXEditor, but the app that answers
// their questions does not. If this registry sat in pageLink.tsx (which pulls
// Lexical and MDXEditor), App's single `setPageLinkServices` call would drag
// the whole editor into the entry bundle and undo the lazy split. Splitting the
// registry out is what lets App publish services before — and without — the
// editor chunk ever loading.

import { useSyncExternalStore } from 'react'

export type PageOption = {
  id: string
  title: string
  // What kind of document this is. Only pages exist today, but the picker keys
  // the row's icon off this, so a new document type is a new icon rather than a
  // text label bolted onto every row.
  kind: 'page'
  // The shortest location hint that tells this result apart from the other
  // shown results sharing its title. Absent — the common case, since most
  // titles are unique — so ordinary rows stay quiet.
  context?: string
}
// A link target resolves to a live title, a known tombstone, or nothing this
// viewer can see. "private" (absent from the store) is deliberately distinct
// from "deleted" (present with a tombstone): a shared page can link to a page
// the author kept private, and calling that "deleted" would invite cleanup.
export type PageRefState = { kind: 'ok'; title: string } | { kind: 'deleted' } | { kind: 'private' }
export type PageLinkServices = {
  resolveTitle: (id: string) => PageRefState
  navigate: (id: string) => void
  // The shareable href for a page, so link pills are real anchors that honor
  // middle/ctrl-click (open in a new tab).
  pageHref: (id: string) => string
  // Candidate pages for the `[[` picker, already filtered and ranked.
  searchPages: (query: string) => PageOption[]
  // Creates a page and resolves to its id, or null when not possible (e.g. no
  // write access). `parent` true nests it under the page being edited.
  createPage: (title: string, parent: boolean) => Promise<string | null>
}

let services: PageLinkServices | null = null
const serviceListeners = new Set<() => void>()

export function setPageLinkServices(next: PageLinkServices | null) {
  services = next
  for (const listener of serviceListeners) listener()
}

export function getPageLinkServices() { return services }

export function usePageLinkServices() {
  return useSyncExternalStore(
    (listener) => { serviceListeners.add(listener); return () => serviceListeners.delete(listener) },
    () => services
  )
}
