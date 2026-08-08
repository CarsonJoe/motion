/* __MOTION_PRECACHE__ */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // Installation is atomic. A worker that is missing part of the shell is not
    // an offline-capable worker and must not replace the currently active one.
    await Promise.all(PRECACHE.map(async (path) => {
      const response = await fetch(path, { cache: 'reload' })
      if (!response.ok) throw new Error(`Could not cache ${path}: ${response.status}`)
      await cache.put(path, response)
    }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith('motion-shell-') && key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  // Never proxy third-party requests or Tallpond APIs. When offline, a failed
  // auth/session request should not turn into a failed navigation response.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/_osg/')) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    if (event.request.mode === 'navigate') {
      // Cache-first, refreshed in the background. Network-first would be more
      // obviously "correct", but it puts a round trip in front of every single
      // launch — including an installed PWA opening on a slow or flaky
      // connection, where the whole app sits blank waiting on an HTML file it
      // already has. Serving the cached shell makes launch independent of the
      // network, which is the point of installing it.
      //
      // The staleness this trades for is bounded and small: the document is a
      // near-empty shell whose only real content is the hashed asset links, the
      // refetch below updates it for the next launch, and a genuinely new build
      // ships a new worker whose install fetches everything with cache:reload
      // anyway. Worst case is one launch on the previous build.
      const revalidate = fetch(event.request)
        .then(async (response) => {
          if (response.ok) await cache.put('/index.html', response.clone())
          return response
        })
        .catch(() => null)
      const cached = (await cache.match('/index.html')) || (await cache.match('/'))
      if (cached) {
        // Keep the worker alive for the refetch, which is now nobody's response.
        event.waitUntil(revalidate)
        return cached
      }
      return (await revalidate) || new Response('Offline', { status: 503 })
    }

    const cached = await cache.match(event.request)
    if (cached) return cached
    try {
      const response = await fetch(event.request)
      if (response.ok) await cache.put(event.request, response.clone())
      return response
    } catch {
      // Returning a response, rather than throwing, prevents Safari's
      // FetchEvent.respondWith "Load failed" page-level error.
      return new Response('', { status: 504, statusText: 'Offline' })
    }
  })())
})
