import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

const network = vi.hoisted(() => {
  let requests: Array<{
    signal: AbortSignal
    resolve: (value: { rows: Array<Record<string, unknown>>; nextCursor: null }) => void
    reject: (error: unknown) => void
  }> = []
  let liveCalls = 0
  const subscription = { on: () => subscription, close: vi.fn() }
  const query = () => {
    const value = {
      select: () => value,
      eq: () => value,
      limit: () => value,
      after: () => value,
      toRequest: () => ({ scope: { kind: 'private' }, table: 'note_updates', op: 'select' }),
      live: () => { liveCalls += 1; return subscription },
      insert: () => Promise.resolve(),
      delete: () => value,
      in: () => Promise.resolve(),
    }
    return value
  }
  const client = {
    gateway: {
      request: (_path: string, init: RequestInit) => new Promise((resolve, reject) => {
        const signal = init.signal as AbortSignal
        requests.push({ signal, resolve, reject })
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
  }
  return {
    client,
    query,
    get requests() { return requests },
    get liveCalls() { return liveCalls },
    reset() { requests = []; liveCalls = 0; subscription.close.mockClear() },
  }
})

vi.mock('./sync', () => ({
  tallpond: network.client,
  updatesTable: () => network.query(),
  resourceTable: () => network.query(),
  getSyncState: () => ({ user: null }),
  subscribeSyncState: () => () => {},
  noteChanged: () => {},
  isAuthError: () => false,
}))

Object.defineProperty(globalThis, 'localStorage', {
  value: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
})
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })

const { openLocalStore } = await import('./local')
const { openNoteDoc } = await import('./doc')

const open = async () => {
  const store = await openLocalStore()
  const controller = await openNoteDoc({
    note: { id: crypto.randomUUID(), title: '', parentId: '', shareId: '', roomId: '', deletedAt: 0, updatedAt: 0 },
    store,
    connected: true,
    writable: true,
    onText: () => {},
    onPresence: () => {},
    onTransport: () => {},
    onError: () => {},
  })
  return { store, controller }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  network.reset()
})

describe('active document network priority', () => {
  it('aborts an unfinished backfill when its page closes', async () => {
    const { store, controller } = await open()
    expect(network.requests).toHaveLength(1)
    expect(network.liveCalls).toBe(0)

    controller.close()

    expect(network.requests[0].signal.aborted).toBe(true)
    await vi.waitFor(() => expect(network.liveCalls).toBe(0))
    store.close()
  })

  it('starts realtime only after the active page backfill completes', async () => {
    const { store, controller } = await open()
    expect(network.liveCalls).toBe(0)

    network.requests[0].resolve({ rows: [], nextCursor: null })
    await vi.waitFor(() => expect(network.liveCalls).toBe(1))

    controller.close()
    store.close()
  })
})
