import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { Page } from './db'
import { openDocument } from './collaboration'
import { listOperations, removeOperations } from './outbox'

Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
const localValues = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => localValues.get(key) ?? null,
  setItem: (key: string, value: string) => localValues.set(key, value),
  removeItem: (key: string) => localValues.delete(key)
}, configurable: true })

describe('local document durability', () => {
  it('renders local state immediately and survives closing the controller offline', async () => {
    const page: Page = {
      id: crypto.randomUUID(), title: 'Offline', parentId: '', shareId: '',
      markdown: 'original', updatedAt: Date.now()
    }
    const firstValues: string[] = []
    let operationStored!: () => void
    const stored = new Promise<void>((resolve) => { operationStored = resolve })
    const first = await openDocument({
      page, connected: false, writable: true,
      onText: (value) => firstValues.push(value), onPresence: () => {},
      onTransportState: () => {}, onLocalOperation: operationStored,
      onError: (error) => { throw error }
    })
    expect(firstValues[0]).toBe('original')
    first.setText('saved while offline')
    await stored
    first.close()

    const secondValues: string[] = []
    const second = await openDocument({
      page, connected: false, writable: true,
      onText: (value) => secondValues.push(value), onPresence: () => {},
      onTransportState: () => {}, onLocalOperation: () => {},
      onError: (error) => { throw error }
    })
    expect(secondValues[0]).toBe('saved while offline')
    second.close()

    const operations = await listOperations()
    await removeOperations(operations.filter((operation) => operation.pageId === page.id).map((operation) => operation.id))
  })
})
