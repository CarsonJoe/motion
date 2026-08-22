import type { LocalAsset, LocalStore, Note } from './local'
import type { TallpondClient } from './sync'

export const VISUAL_ASSET_BUCKET = 'visual_assets'
export const VISUAL_ASSET_PREFIX = 'motion-asset:'
export const MAX_VISUAL_ASSET_BYTES = 10 * 1024 * 1024
export const VISUAL_ASSET_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const objectUrls = new Map<string, string>()
const resolving = new Map<string, Promise<string>>()
const unavailableImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" fill="#1b1b1b"/><text x="320" y="120" fill="#777" font-family="system-ui,sans-serif" font-size="16" text-anchor="middle" dominant-baseline="middle">Image available when online</text></svg>')}`

const extensionFor = (type: string) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'
}[type] ?? 'bin')

export function visualAssetSource(path: string) {
  return `${VISUAL_ASSET_PREFIX}${path}`
}

export function visualAssetPath(source: string) {
  if (!source.startsWith(VISUAL_ASSET_PREFIX)) return null
  const path = source.slice(VISUAL_ASSET_PREFIX.length)
  return /^notes\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif)$/.test(path) ? path : null
}

export function validateVisualAsset(file: File) {
  if (!VISUAL_ASSET_TYPES.has(file.type)) throw new Error('Choose a JPEG, PNG, WebP, or GIF image.')
  if (file.size > MAX_VISUAL_ASSET_BYTES) throw new Error('Images must be 10 MB or smaller.')
}

export async function stageVisualAsset(store: LocalStore, note: Note, file: File) {
  validateVisualAsset(file)
  const path = `notes/${note.id}/${crypto.randomUUID()}.${extensionFor(file.type)}`
  const asset: LocalAsset = { path, noteId: note.id, blob: file, contentType: file.type, sizeBytes: file.size }
  await store.putAsset(asset)
  return asset
}

const placementFor = (note: Note) => note.shareId
  ? `resource:${note.shareId}:${note.roomId || 'default'}`
  : 'private'

const handleForNote = (client: TallpondClient | null, note: Note) => {
  if (!client) return null
  if (!note.shareId) return client.files(VISUAL_ASSET_BUCKET)
  const resource = client.resource(note.shareId)
  return note.roomId ? resource.room(note.roomId).files(VISUAL_ASSET_BUCKET) : resource.files(VISUAL_ASSET_BUCKET)
}

const handleForPlacement = (client: TallpondClient | null, placement: string) => {
  if (!client) return null
  if (placement === 'private') return client.files(VISUAL_ASSET_BUCKET)
  const match = /^resource:([^:]+):(.+)$/.exec(placement)
  if (!match) return null
  const resource = client.resource(match[1])
  return match[2] === 'default' ? resource.files(VISUAL_ASSET_BUCKET) : resource.room(match[2]).files(VISUAL_ASSET_BUCKET)
}

export async function syncVisualAsset(client: TallpondClient | null, store: LocalStore, asset: LocalAsset, note: Note, userId: string) {
  if (!client || !navigator.onLine || note.deletedAt) return
  const desired = placementFor(note)
  if (asset.placement === desired && asset.ownerId === userId) return
  const destination = handleForNote(client, note)
  if (!destination) return

  // Paths are unique across rooms for one uploader. Moving between rooms in a
  // resource therefore has to release the old placement before uploading the
  // same stable path into the new one. The local blob remains the durable retry
  // source throughout, so a network failure cannot lose the image.
  const previous = asset.placement ? handleForPlacement(client, asset.placement) : null
  const sameResource = asset.placement?.startsWith(`resource:${note.shareId}:`) && desired.startsWith(`resource:${note.shareId}:`)
  if (previous && sameResource) await previous.delete(asset.path).catch(() => {})

  await destination.upload(asset.path, asset.blob, {
    contentType: asset.contentType,
    cacheControl: 'private, max-age=31536000, immutable',
    upsert: true
  })
  await store.putAsset({ ...asset, placement: desired, ownerId: userId })

  // Cross-scope copies can overlap safely. Remove the old copy only after the
  // destination exists; failure here costs redundant storage, never content.
  if (previous && !sameResource && asset.placement !== desired) await previous.delete(asset.path).catch(() => {})
}

export async function syncVisualAssets(client: TallpondClient | null, store: LocalStore, notes: readonly Note[], userId: string) {
  const byId = new Map(notes.map((note) => [note.id, note]))
  for (const asset of await store.allAssets()) {
    const note = byId.get(asset.noteId)
    if (note && !asset.cacheOnly) await syncVisualAsset(client, store, asset, note, userId)
  }
}

export async function resolveVisualAsset(client: TallpondClient | null, store: LocalStore, note: Note, source: string) {
  const path = visualAssetPath(source)
  if (!path) return source
  const key = `${store.scope}:${path}`
  const cached = objectUrls.get(key)
  if (cached) return cached
  const pending = resolving.get(key)
  if (pending) return pending

  const resolution = (async () => {
    const local = await store.getAsset(path)
    if (local?.blob) {
      const url = URL.createObjectURL(local.blob)
      objectUrls.set(key, url)
      return url
    }
    if (!client || !navigator.onLine) return unavailableImage
    const handle = handleForNote(client, note)
    if (!handle) return unavailableImage
    const metadata = note.shareId
      ? (await handle.list(path)).find((file) => file.path === path)
      : await handle.metadata(path).catch(() => null)
    if (!metadata) return unavailableImage
    try {
      const blob = await handle.download(path, note.shareId ? { owner: metadata.owner } : undefined)
      await store.putAsset({ path, noteId: note.id, blob, contentType: metadata.contentType || blob.type || 'application/octet-stream', sizeBytes: metadata.sizeBytes, placement: placementFor(note), ownerId: metadata.owner, cacheOnly: true })
      const url = URL.createObjectURL(blob)
      objectUrls.set(key, url)
      return url
    } catch {
      return handle.url(path, note.shareId ? { owner: metadata.owner } : undefined)
    }
  })().finally(() => resolving.delete(key))
  resolving.set(key, resolution)
  return resolution
}
