type ScrollSurface = EventTarget & { scrollTop: number }
type FrameScheduler = {
  request: (callback: FrameRequestCallback) => number
  cancel: (id: number) => void
}

const browserFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id)
}

// Replacing an editor document can briefly collapse its scroll container before
// the new DOM has layout. Browsers clamp scrollTop during that gap and do not
// restore it when the content returns. Hold the old offset through the two
// frames MDXEditor uses to finish importing, unless the user starts a new
// interaction and therefore owns the viewport again.
export function preserveScrollDuringImport(surface: ScrollSurface | null, apply: () => void, frames: FrameScheduler = browserFrames) {
  if (!surface) { apply(); return () => {} }
  const savedTop = surface.scrollTop
  let frame = 0
  let passes = 0
  let stopped = false
  const interactionEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
  const stop = () => {
    if (stopped) return
    stopped = true
    if (frame) frames.cancel(frame)
    frame = 0
    for (const type of interactionEvents) surface.removeEventListener(type, stop)
  }
  const restore = () => {
    if (stopped) return
    surface.scrollTop = savedTop
    if (passes++ < 2) frame = frames.request(restore)
    else stop()
  }
  for (const type of interactionEvents) surface.addEventListener(type, stop, { passive: true })
  try {
    apply()
    restore()
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
