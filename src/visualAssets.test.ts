import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openLocalStore, type Note } from './local'
import { MAX_VISUAL_ASSET_BYTES, resolveVisualAsset, stageVisualAsset, syncVisualAsset, validateVisualAsset, visualAssetPath, visualAssetSource } from './visualAssets'

const note: Note = { id: 'note-1', title: '', parentId: '', shareId: '', roomId: '', deletedAt: 0, updatedAt: 0 }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true })
})

describe('visual assets', () => {
  it('stages an image locally behind a stable markdown source', async () => {
    const store = await openLocalStore('user-a')
    const file = new File(['pixels'], 'photo.png', { type: 'image/png' })
    const asset = await stageVisualAsset(store, note, file)
    const source = visualAssetSource(asset.path)

    expect(asset.path).toMatch(/^notes\/note-1\/[\w-]+\.png$/)
    expect(visualAssetPath(source)).toBe(asset.path)
    expect(await (await store.getAsset(asset.path))?.blob.text()).toBe('pixels')
  })

  it('rejects unsupported and oversized files', () => {
    expect(() => validateVisualAsset(new File(['x'], 'vector.svg', { type: 'image/svg+xml' }))).toThrow(/JPEG/)
    const oversized = new File([new Uint8Array(MAX_VISUAL_ASSET_BYTES + 1)], 'large.png', { type: 'image/png' })
    expect(() => validateVisualAsset(oversized)).toThrow(/10 MB/)
  })

  it('uploads shared images into the note room', async () => {
    const store = await openLocalStore('user-a')
    const shared = { ...note, shareId: 'workspace-1', roomId: 'private-room' }
    const asset = await stageVisualAsset(store, shared, new File(['pixels'], 'photo.png', { type: 'image/png' }))
    const uploaded: string[] = []
    const files = { upload: async (path: string) => { uploaded.push(path); return {} }, delete: async () => ({ deleted: true }) }
    const client = { resource: (id: string) => ({ room: (roomId: string) => ({ files: (bucket: string) => { expect([id, roomId, bucket]).toEqual(['workspace-1', 'private-room', 'visual_assets']); return files } }), files: () => files }), files: () => files }

    await syncVisualAsset(client as never, store, asset, shared, 'user-a')
    expect(uploaded).toEqual([asset.path])
    expect((await store.getAsset(asset.path))?.placement).toBe('resource:workspace-1:private-room')
  })

  it('downloads a remote room image into the offline cache', async () => {
    const store = await openLocalStore('user-a')
    const shared = { ...note, shareId: 'workspace-1', roomId: 'private-room' }
    const path = 'notes/note-1/asset-1.png'
    const files = {
      list: async () => [{ path, owner: 'user-b', sizeBytes: 6, contentType: 'image/png' }],
      download: async () => new Blob(['pixels'], { type: 'image/png' }),
      url: () => 'https://example.test/image'
    }
    const client = { resource: () => ({ room: () => ({ files: () => files }), files: () => files }), files: () => files }

    expect(await resolveVisualAsset(client as never, store, shared, visualAssetSource(path))).toMatch(/^blob:/)
    const cached = await store.getAsset(path)
    expect(cached?.cacheOnly).toBe(true)
    expect(await cached?.blob.text()).toBe('pixels')
  })

  it('rejects malformed internal image sources', () => {
    expect(visualAssetPath('motion-asset:../../secret.png')).toBeNull()
    expect(visualAssetPath('https://example.com/photo.png')).toBeNull()
  })
})
