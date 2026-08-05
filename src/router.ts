// Hash routing. The active page lives in the URL as #/p/<noteId>. A shared page
// also carries its resource id (#/p/<noteId>?r=<resourceId>) so that opening a
// copied link can bootstrap access — a stranger or an invited-but-not-yet-joined
// visitor needs the resource id to request or accept membership, and cannot
// derive it from a note they can't yet read. Hash routing keeps refresh, offline
// (PWA), and middle-click-new-tab working on static hosting with no server rules.

export type Route = { noteId: string | null; resourceId: string | null }

const ROUTE = /^\/p\/([^/?#]+)(?:\?(.*))?$/

export function readRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '')
  const match = ROUTE.exec(hash)
  if (!match) return { noteId: null, resourceId: null }
  const params = new URLSearchParams(match[2] ?? '')
  const resourceId = params.get('r')
  return { noteId: decodeURIComponent(match[1]), resourceId: resourceId ? decodeURIComponent(resourceId) : null }
}

// The href for a page link. Given to anchors so the browser handles
// middle/ctrl-click natively (open in a new tab, which deep-links on load).
export function pageUrl(noteId: string, resourceId?: string | null): string {
  const base = `#/p/${encodeURIComponent(noteId)}`
  return resourceId ? `${base}?r=${encodeURIComponent(resourceId)}` : base
}

const hashFor = (noteId: string | null, resourceId?: string | null) => (noteId ? pageUrl(noteId, resourceId) : '#/')

// Reflects the active page into the URL without reloading. No-ops when already
// there so the activeId->URL mirror never fights the URL->activeId listener.
export function writeRoute(noteId: string | null, resourceId?: string | null, replace = false) {
  const next = hashFor(noteId, resourceId)
  const current = window.location.hash
  if (current === next) return
  if (!noteId && (current === '' || current === '#' || current === '#/')) return
  const url = `${window.location.pathname}${window.location.search}${next}`
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener('popstate', listener)
  window.addEventListener('hashchange', listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener('hashchange', listener)
  }
}
