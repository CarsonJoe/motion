import { describe, expect, it } from 'vitest'
import { preserveScrollDuringImport } from './scrollPreservation'

function testFrames() {
  let nextId = 1
  const pending = new Map<number, FrameRequestCallback>()
  return {
    scheduler: {
      request: (callback: FrameRequestCallback) => { const id = nextId++; pending.set(id, callback); return id },
      cancel: (id: number) => { pending.delete(id) }
    },
    runNext: () => {
      const entry = pending.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!entry) return false
      pending.delete(entry[0])
      entry[1](0)
      return true
    },
    size: () => pending.size
  }
}

describe('preserveScrollDuringImport', () => {
  it('restores an offset through synchronous and delayed DOM collapse', () => {
    const surface = Object.assign(new EventTarget(), { scrollTop: 420 })
    const frames = testFrames()

    preserveScrollDuringImport(surface, () => { surface.scrollTop = 0 }, frames.scheduler)
    expect(surface.scrollTop).toBe(420)

    surface.scrollTop = 0
    expect(frames.runNext()).toBe(true)
    expect(surface.scrollTop).toBe(420)

    surface.scrollTop = 0
    expect(frames.runNext()).toBe(true)
    expect(surface.scrollTop).toBe(420)
    expect(frames.size()).toBe(0)
  })

  it('stops restoring when the user starts another interaction', () => {
    const surface = Object.assign(new EventTarget(), { scrollTop: 300 })
    const frames = testFrames()

    preserveScrollDuringImport(surface, () => { surface.scrollTop = 0 }, frames.scheduler)
    surface.dispatchEvent(new Event('wheel'))
    surface.scrollTop = 175

    expect(frames.runNext()).toBe(false)
    expect(surface.scrollTop).toBe(175)
  })
})
