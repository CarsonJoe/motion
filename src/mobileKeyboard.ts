import { useEffect } from 'react'
import { editorAdapter } from './editorAdapter'

// Ported from the "Notes Lab" PWA experiment. It solves the two things mobile
// browsers get wrong for a full-screen editor and that no amount of CSS fixes:
//
//  1. A formatting toolbar that must ride just above the software keyboard.
//     The keyboard's real geometry is only knowable through
//     window.visualViewport, and its resize event fires *after* the keyboard's
//     own animation — so the toolbar is a position:fixed overlay moved via a JS
//     `transform` synced to visualViewport, never a CSS-positioned element.
//  2. Keeping the caret in a comfortable band ("safe zone") between the top of
//     the scroller and the toolbar, correcting scroll with a JS animation that
//     lands *before* the keyboard finishes opening (iOS otherwise pans the
//     whole page to compensate mid-animation).
//
// This drives the app's existing MDXEditor contentEditable (.motion-md-content)
// and <main> scroller — it ports the interaction, not the editor. Every handler
// is a no-op unless `enabled` (small screens only), so desktop is untouched.

const CONTENT_SELECTOR = '.motion-md-content'

// The on-screen debug overlay, toggled by five taps on the sidebar title. An
// installed PWA always launches at its fixed start_url, so `?debug` can't be
// reached from the home screen and the flag has to be persisted.
const DEBUG_KEY = 'motion-debug'
export const debugEnabled = () => localStorage.getItem(DEBUG_KEY) === '1'
export function toggleDebug() {
  const next = !debugEnabled()
  if (next) localStorage.setItem(DEBUG_KEY, '1')
  else localStorage.removeItem(DEBUG_KEY)
  return next
}

type Options = {
  // The toolbar overlay node (App's `toolbarHost` — the MDXEditor toolbar host).
  toolbar: HTMLElement | null
  // The sole scroll container (App's <main>).
  main: HTMLElement | null
  // True only on small screens. Toggling this off tears everything down.
  enabled: boolean
  // Changes whenever the open note changes; MDXEditor remounts per note, so the
  // content element is re-resolved when this flips.
  noteId: string | null
}

export function useMobileKeyboard({ toolbar, main, enabled, noteId }: Options) {
  useEffect(() => {
    if (!enabled || !toolbar || !main) return

    const vv = window.visualViewport

    // The layout-viewport height — the stable reference for keyboard height.
    // NOT window.innerHeight: in a standalone iOS PWA that shrinks when the
    // keyboard opens, so `innerHeight - vv.height` collapses to a bogus small
    // value (~1-in-10 the toolbar/safe-zone are placed for a too-short keyboard
    // and the app gets pulled up). documentElement.clientHeight does not shrink
    // under our position:fixed body, so the subtraction stays correct.
    const layoutH = () => document.documentElement.clientHeight

    // The pan pin. Without it, opening the editor's `[[` / `/` menu while the
    // keyboard is up made the next touch-scroll pan the whole application
    // container instead of scrolling <main>.
    //
    // The cause is the menu being *added to the DOM* while the keyboard is up:
    // it is position:fixed, so mounting it hands WebKit a new
    // viewport-constrained object and it rebuilds the scrolling tree mid
    // gesture. A fixed layer that already exists when that happens absorbs it.
    //
    // Established by bisection on device, each property varied alone:
    //   · must be position:fixed      (position:absolute reproduces the pan)
    //   · must create a layer         (visibility:hidden reproduces it,
    //                                  opacity:0 does not — so this is about
    //                                  compositing, not visibility)
    //   · must intersect the viewport (moved off-screen, it reproduces)
    //   · must PRE-EXIST the menu     (an identical pin mounted at the same
    //                                  moment as the menu reproduces it)
    //   · size and DOM position are irrelevant — hence 1px, anywhere.
    //
    // The alternative fix is to stop adding a fixed layer at all: mount the
    // menu permanently and toggle opacity. That is a much larger change to
    // editorMenu for the same outcome, so this stays.
    const panPin = document.createElement('div')
    panPin.setAttribute('aria-hidden', 'true')
    panPin.style.cssText = 'position:fixed;top:0;left:0;right:0;height:1px;z-index:0;pointer-events:none;background:transparent'
    document.body.appendChild(panPin)

    // Temporary on-screen instrumentation. Open the app with ?debug to see a
    // live log of the focus/scroll pipeline. Remove once the land-before-
    // keyboard behavior is nailed down.
    // `?debug` is unreachable once the app is installed — a PWA always launches
    // at its fixed start_url — so the flag is also readable from storage, set by
    // the seven-tap gesture on the sidebar title (see App).
    const DEBUG = /[?&]debug/.test(location.search) || debugEnabled()
    let debugEl: HTMLElement | null = null
    const debug = (line: string) => {
      if (!DEBUG) return
      if (!debugEl) {
        debugEl = document.createElement('div')
        debugEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;max-height:40vh;overflow:hidden;background:rgba(0,0,0,.82);color:#5f5;font:10px/1.25 monospace;padding:4px;white-space:pre-wrap;pointer-events:none'
        document.body.appendChild(debugEl)
      }
      const t = (performance.now() / 1000).toFixed(2)
      debugEl.textContent = `${t} ${line}\n${(debugEl.textContent || '').slice(0, 3600)}`
    }

    // Best guess before we've measured the keyboard on this device; refined the
    // moment we get a real reading and remembered across visits.
    let lastKeyboardHeight = Number(localStorage.getItem('kb-height')) || 300

    // iOS changes the keyboard height between focuses by showing/hiding the
    // predictive-text strip (~one row), so the last measured height is often a
    // little SHORT for the next focus — and under-scrolling lands the caret
    // behind the keyboard (a miss) while over-scrolling is harmless (the caret
    // sits slightly higher; the real-geometry poll settles it). So before real
    // geometry arrives we intentionally assume the taller keyboard by padding
    // the estimate. Only applies to the estimate, never the measured value.
    const KEYBOARD_ESTIMATE_SAFETY = 12

    // The content element is resolved lazily on focus: MDXEditor mounts it a
    // frame or two after this effect runs, and remounts it per note.
    const getContent = () => main.querySelector<HTMLElement>(CONTENT_SELECTOR)
    // The scrollable article wrapper — the resting space goes here (below the
    // backlinks), not on the editor text, so it reads as trailing space rather
    // than a gap between the note and its backlinks.
    const getArticle = () => main.querySelector<HTMLElement>('article')

    // Reserve scroll room below the content so the caret can sit above the
    // keyboard even on the last line. Only padding — `main` is never resized
    // (every historical bug in the experiment traced back to resizing it).
    const RESTING_BOTTOM_ROOM = 80
    // Room below the last line. While the keyboard is OPEN this is a full
    // keyboard+ so the caret can always scroll into the safe zone (needed for
    // long notes, where the tall min-height adds no extra space). At REST it's
    // just a small trailing margin — no scroll is needed with the keyboard down,
    // so a big reserve would only be dead space under the backlinks.
    function reserveScrollRoom(open = true) {
      const article = getArticle()
      if (!article) return
      article.style.paddingBottom = (open ? lastKeyboardHeight + toolbar!.offsetHeight + 200 : RESTING_BOTTOM_ROOM) + 'px'
      void article.offsetHeight // force reflow so scrollHeight reflects it now
    }

    // Expand the editor to a full page WHILE the keyboard is open, so iOS has a
    // real scroll surface and scrolls `main` instead of pulling the document (the
    // short-note pan). Compact at rest so backlinks stay close. Must be set
    // BEFORE focus so it's in place when iOS evaluates on keyboard-open.
    function setTallEditor(on: boolean) {
      const content = getContent()
      if (!content) return
      content.style.minHeight = on ? 'calc(100dvh - 175px)' : ''
      if (on) void content.offsetHeight // reflow now
    }

    // Apply the small resting margin as soon as the article mounts (the keyboard
    // is down at rest). The full room is reserved on engage.
    let restingTries = 0
    const applyRestingSpace = () => {
      if (getArticle()) reserveScrollRoom(false)
      else if (restingTries++ < 40) requestAnimationFrame(applyRestingSpace)
    }
    requestAnimationFrame(applyRestingSpace)

    // --- toolbar reveal ------------------------------------------------------
    // The toolbar stays off-screen (CSS default) until revealed — either at its
    // real keyboard-tracked position, or, if no keyboard shows up within
    // NO_KEYBOARD_FALLBACK_MS (a device with no touch keyboard), pinned to the
    // screen bottom. Reacting to whether a keyboard ACTUALLY showed up is more
    // robust than trying to predict touch capability up front.
    let toolbarRevealed = false
    // Set once the keyboard has actually been measured up this cycle, so the
    // geometry-driven teardown (in syncToolbar) can tell "keyboard hasn't opened
    // yet" apart from "keyboard was dismissed".
    let keyboardWasUp = false
    let noKeyboardFallbackTimer: number | null = null
    const NO_KEYBOARD_FALLBACK_MS = 120
    const TOOLBAR_FADE_DELAY_MS = 200

    function revealToolbar(y: number) {
      toolbarRevealed = true
      if (noKeyboardFallbackTimer) clearTimeout(noKeyboardFallbackTimer)
      toolbar!.style.transform = `translate(0px, ${y}px)`
      toolbar!.style.transition = 'none'
      toolbar!.style.opacity = '0'
      requestAnimationFrame(() => {
        setTimeout(() => {
          toolbar!.style.transition = ''
          toolbar!.style.opacity = '1'
        }, TOOLBAR_FADE_DELAY_MS)
      })
    }

    // The single source of truth for whether the toolbar should be up: the
    // keyboard geometry plus whether the editor is focused. Driven by
    // visualViewport resize/scroll and the post-focus polls. This is what makes
    // teardown reliable and immediate — the toolbar hides exactly when the
    // keyboard leaves (including via the keyboard's own hide button, which keeps
    // DOM focus and never fires a blur), with no timer, and re-engages if the
    // keyboard reopens on a still-focused editor without a fresh focusin.
    function syncToolbar() {
      if (!vv) return
      const measuredKbHeight = layoutH() - vv.height
      const focused = Boolean(getContent()?.contains(document.activeElement))
      const holdingDropdown = performance.now() - dropdownArmedAt < 600 || dropdownOpen()
      if (measuredKbHeight > 100 && focused) {
        keyboardWasUp = true
        // Only remember/persist a plausible height. A mid-animation frame is
        // smaller than the settled height; don't let it shrink the remembered
        // value (which drives the pre-keyboard estimate and reserved room).
        if (measuredKbHeight >= lastKeyboardHeight * 0.75) {
          lastKeyboardHeight = measuredKbHeight
          localStorage.setItem('kb-height', String(measuredKbHeight))
        }
        if (!toolbar!.classList.contains('kb-visible')) toolbar!.classList.add('kb-visible')
        reserveScrollRoom()
        const x = vv.offsetLeft
        const y = vv.offsetTop + vv.height - toolbar!.offsetHeight
        if (!toolbarRevealed) { debug(`reveal kbH=${Math.round(measuredKbHeight)}`); revealToolbar(y) }
        else toolbar!.style.transform = `translate(${x}px, ${y}px)`
      } else if (measuredKbHeight <= 60 && keyboardWasUp && !holdingDropdown && toolbar!.classList.contains('kb-visible')) {
        debug('hide')
        // Keyboard dismissed. Hysteresis (up >100, gone <=60) avoids flicker
        // near the threshold. A dropdown deliberately collapses the keyboard
        // while staying open, so it's exempt (watchDropdownClose owns that).
        hideToolbar()
      }
    }

    // visualViewport's resize/scroll can fire late after the keyboard
    // animation — poll a few times after focus to catch the real geometry.
    const POLL_DELAYS = [16, 40, 90, 180, 320]
    let pollTimers: number[] = []

    // --- caret geometry ------------------------------------------------------
    const CARET_TOP_MARGIN = 40
    const CARET_BOTTOM_MARGIN = 50

    // A collapsed Range's rect can be all-zero on an empty/boundary line (right
    // after Enter or a delete) — fall back to the actual DOM element.
    function getCaretRect(sel: Selection): DOMRect {
      const content = getContent()
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!(rect.width === 0 && rect.height === 0 && rect.top === 0)) return rect
      let node: Node | null = sel.anchorNode
      if (node && node.nodeType === Node.TEXT_NODE) node = (node as Text).parentElement
      if (node && node.nodeType === Node.ELEMENT_NODE && node !== content) {
        return (node as Element).getBoundingClientRect()
      }
      return rect
    }

    // Drives the scroll animation directly (not native `behavior:'smooth'`) so
    // speed scales with distance and main.scrollTop is always the true current
    // position, not an ambiguous commanded target.
    let scrollAnimFrame: number | null = null
    function animateScrollTo(target: number) {
      if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame)
      const start = main!.scrollTop
      const distance = target - start
      if (distance === 0) return
      const PX_PER_MS = 3.4
      const duration = Math.min(380, Math.max(70, Math.abs(distance) / PX_PER_MS))
      const startTime = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        main!.scrollTop = start + distance * eased
        scrollAnimFrame = t < 1 ? requestAnimationFrame(step) : null
      }
      scrollAnimFrame = requestAnimationFrame(step)
    }

    // Trailing-edge throttle: a call mid-window schedules a follow-up for when
    // the window ends, so the caret's latest position always gets corrected.
    let lastCorrectionAt = 0
    let pendingCorrectionTimer: number | null = null
    const CORRECTION_THROTTLE_MS = 24

    function maybeCorrectCaretScroll() {
      const now = performance.now()
      const elapsed = now - lastCorrectionAt
      if (elapsed >= CORRECTION_THROTTLE_MS) {
        lastCorrectionAt = now
        correctCaretScroll()
      } else if (!pendingCorrectionTimer) {
        pendingCorrectionTimer = window.setTimeout(() => {
          pendingCorrectionTimer = null
          lastCorrectionAt = performance.now()
          correctCaretScroll()
        }, CORRECTION_THROTTLE_MS - elapsed)
      }
    }

    function correctCaretScroll() {
      // During/just after a swipe-dismiss the editor is being torn down — a
      // correction here (esp. on a blank line's degenerate rect) scrolls the
      // wrong way and drags in the iOS pan. Stay out of the way.
      if (justDismissed()) return
      if (correctionsSuppressed()) return
      if (!toolbar!.classList.contains('kb-visible')) return
      const content = getContent()
      const sel = window.getSelection()
      if (!content || !sel || sel.rangeCount === 0 || !content.contains(sel.anchorNode)) return
      const rect = getCaretRect(sel)
      if (rect.width === 0 && rect.height === 0 && rect.top === 0) return

      const zone = getSafeZone(currentOrEstimatedToolbarTop())
      let target: number | null = null
      if (rect.bottom > zone.bottom) target = main!.scrollTop + (rect.bottom - zone.bottom)
      else if (rect.top < zone.top) target = main!.scrollTop - (zone.top - rect.top)
      if (target !== null) debug(`corr  ${Math.round(main!.scrollTop)}→${Math.round(target)}`)
      if (target === null) return
      animateScrollTo(target)
    }

    function pollSyncToolbar() {
      pollTimers.forEach(clearTimeout)
      // Only re-sync the toolbar geometry here. Caret placement is owned by the
      // preempt / land; poll-driven caret corrections re-measured a reconciled
      // empty block and spuriously scrolled.
      pollTimers = POLL_DELAYS.map((ms) => window.setTimeout(syncToolbar, ms))
    }

    // Captures where a tap landed, in absolute scroll-content coordinates,
    // before focus fires — plain arithmetic on the tap point is more reliable
    // than re-deriving it from the DOM after.
    let pendingTapY: number | null = null

    // The caret's on-screen [top, bottom] for the land correction. Prefer the
    // LIVE selection — the land is deferred a frame (see beginEngagement) so by
    // the time this runs the browser has placed the caret at the tap and the
    // selection is accurate. Fall back to the tap coordinate only if the
    // selection isn't usable yet (or there was no tap, e.g. programmatic focus).
    function getCaretScreenSpan(tapY: number | null): [number, number] | null {
      const content = getContent()
      const sel = window.getSelection()
      if (content && sel && sel.rangeCount > 0 && content.contains(sel.anchorNode)) {
        const rect = getCaretRect(sel)
        if (!(rect.width === 0 && rect.height === 0 && rect.top === 0)) return [rect.top, rect.bottom]
      }
      if (tapY !== null) {
        const mainTop = main!.getBoundingClientRect().top
        const ESTIMATED_LINE_HEIGHT = 28
        const approxTop = tapY - main!.scrollTop + mainTop
        return [approxTop, approxTop + ESTIMATED_LINE_HEIGHT]
      }
      return null
    }

    // Real toolbar position once revealed; otherwise the same estimate used to
    // reveal it, so callers never read the off-screen default as if it were real.
    function currentOrEstimatedToolbarTop() {
      if (toolbarRevealed) return toolbar!.getBoundingClientRect().top
      return layoutH() - (lastKeyboardHeight + KEYBOARD_ESTIMATE_SAFETY) - toolbar!.offsetHeight
    }

    function getSafeZone(toolbarTopY: number) {
      const mainTop = main!.getBoundingClientRect().top
      return { top: mainTop + CARET_TOP_MARGIN, bottom: toolbarTopY - CARET_BOTTOM_MARGIN }
    }

    // Moves scrollTop only if the span falls outside the given zone — instant,
    // not animated. iOS briefly pans the whole page to compensate if the caret
    // is still behind the keyboard mid-animation, so landing before the keyboard
    // opens is what avoids that.
    function correctIfOutsideSafeZone(span: [number, number] | null, zone: { top: number; bottom: number }) {
      if (!span) return
      else if (span[1] > zone.bottom) main!.scrollTop += span[1] - zone.bottom
      else if (span[0] < zone.top) main!.scrollTop -= zone.top - span[0]
    }

    // --- event handlers ------------------------------------------------------
    const onPointerDown = (e: PointerEvent) => {
      pendingTapY = main.scrollTop + (e.clientY - main.getBoundingClientRect().top)
    }

    // Reopen-while-focused (keyboard dismissed but Lexical kept focus) is handled
    // by onMouseDown's preempt too — mousedown fires for taps only, and AFTER
    // pointerup, so a separate pointerup reopen path would double-engage and
    // fight the preempt.

    const caretRangeFromPoint = (x: number, y: number): Range | null => {
      const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y)
      const pos = doc.caretPositionFromPoint?.(x, y)
      if (!pos) return null
      const r = document.createRange()
      r.setStart(pos.offsetNode, pos.offset)
      r.collapse(true)
      return r
    }

    // Beat iOS to the punch. iOS runs its "will the keyboard obscure the caret?"
    // check at FOCUS time and pans the visual viewport if so — a pan that can't
    // be undone. To win the race we do everything synchronously in the tap,
    // BEFORE focus: preventDefault iOS's own caret placement, focus (the caret
    // defaults to the top = visible, so iOS's check finds nothing to reveal and
    // doesn't pan), then place the caret at the tapped character and scroll it
    // into the safe zone ourselves. Only for a fresh tap into the keyboard
    // danger zone; an already-focused editor can't be preempted (preventDefault
    // would block the keyboard from reopening), and taps above the danger zone
    // need no scroll so we leave them to the browser.
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      const content = getContent()
      if (!content || !target) return
      // Skip real controls / links / page-link pills so they act normally.
      if (target.closest('button, a, input, textarea, [role="toolbar"], .page-ref, .page-ref-host')) return
      // Handle taps in the editor content AND the empty space below it (the
      // article / resting space) — a spacer tap's target is the <article>, not
      // the content.
      if (!target.closest(CONTENT_SELECTOR) && !target.closest('article')) return
      if (justDismissed()) { e.preventDefault(); return }
      // Preempt a fresh tap (unfocused) AND a reopen (focused but keyboard
      // dismissed) — both re-run iOS's focus scroll/pan. Only leave taps alone
      // while actively editing (focused + keyboard up), so selection gestures
      // (double-tap, drag) work normally.
      const alreadyFocused = content.contains(document.activeElement)
      const keyboardDown = !vv || layoutH() - vv.height <= 100
      if (alreadyFocused && !keyboardDown) return
      const zone = getSafeZone(currentOrEstimatedToolbarTop())
      const box = content.getBoundingClientRect()
      // Clamp to the ACTUAL last line, not box.bottom — with min-height:40dvh the
      // editor box extends far below the text into empty space, and clamping to
      // its bottom put the caret (and the scroll target) down there instead of on
      // the real last line, sliding the note up.
      const lastEl = content.lastElementChild
      const textBottom = lastEl ? Math.min(lastEl.getBoundingClientRect().bottom, box.bottom) : box.bottom
      const cx = Math.min(Math.max(e.clientX, box.left + 1), box.right - 1)
      const cy = Math.min(Math.max(e.clientY, box.top + 1), textBottom - 1)
      e.preventDefault()
      pendingTapY = null
      // Expand the editor BEFORE focus so iOS sees a full scroll surface (no
      // document pan on short notes).
      setTallEditor(true)
      const belowLast = e.clientY > textBottom
      // Resolve the click to a DOM range NOW, on the current layout — before
      // placeCaretAtStart scrolls the content (which would make a later
      // coordinate re-resolution land on the wrong line). Node-based, so it
      // survives the scroll.
      let clickRange = belowLast ? null : caretRangeFromPoint(e.clientX, e.clientY)
      if (clickRange && !content.contains(clickRange.startContainer)) clickRange = caretRangeFromPoint(cx, cy)
      if (clickRange && !content.contains(clickRange.startContainer)) clickRange = null
      // Capture scroll BEFORE placement/focus and restore after, so nothing slides.
      const savedScroll = main.scrollTop
      if (editorAdapter.hasEditor()) {
        // Place the caret THROUGH Lexical so it becomes Lexical's OWN selection —
        // nothing reconciles over it (that fixed the empty-block restore). ORDER
        // matters for the pan: park the caret at the TOP first, so when we focus,
        // iOS's obscure-check sees a visible caret and doesn't pan. THEN place it
        // at the click (no new focus event, so no pan), and our correction below
        // scrolls it into the safe zone.
        editorAdapter.placeCaretAtStart()
        if (alreadyFocused) editorAdapter.blur()
        editorAdapter.focus()
        if (!clickRange || !editorAdapter.placeCaretAtRange(clickRange)) editorAdapter.placeCaretAtEnd()
      } else {
        // DOM fallback (no Lexical present): resolve + set the caret directly.
        let range = e.clientY <= textBottom ? caretRangeFromPoint(e.clientX, e.clientY) : null
        if (!range || !content.contains(range.startContainer)) range = caretRangeFromPoint(cx, cy)
        if (!range || !content.contains(range.startContainer)) {
          range = document.createRange(); range.selectNodeContents(content); range.collapse(false)
        }
        const s = window.getSelection()
        if (s) { s.removeAllRanges(); s.addRange(range) }
        if (alreadyFocused) content.blur()
        content.focus({ preventScroll: true })
        if (s && content.contains(range.startContainer)) { s.removeAllRanges(); s.addRange(range) }
      }
      if (main.scrollTop !== savedScroll) main.scrollTop = savedScroll
      reserveScrollRoom()
      // Measure the placed caret. getCaretRect falls back to the block's element
      // rect on an empty/degenerate line (its true position, not box.bottom).
      const sel = window.getSelection()
      const rect = sel && sel.rangeCount ? getCaretRect(sel) : null
      const span: [number, number] | null = !rect || (rect.width === 0 && rect.height === 0 && rect.top === 0) ? null : [rect.top, rect.bottom]
      const before = main.scrollTop
      correctIfOutsideSafeZone(span, zone)
      // This correction is authoritative — suppress the follow-up land/poll
      // corrections that would re-measure a Lexical-reconciled empty block and
      // yank the caret to a wrong position.
      suppressCorrectionUntil = performance.now() + 450
      debug(`preempt y=${Math.round(e.clientY)} zoneB=${Math.round(zone.bottom)} ${Math.round(before)}→${Math.round(main.scrollTop)}`)
    }

    // Tapping a formatting button must NOT blur the contenteditable — otherwise
    // the field loses focus, the keyboard closes, and our focusout teardown
    // fires. Preventing the pointerdown default keeps the selection/focus in
    // the editor while the button still receives its `click`. Controls that
    // legitimately need focus (an input inside a toolbar popup) are exempt.
    // touch-action:pan-x on the toolbar still governs its horizontal scroll,
    // which this does not cancel.
    // Set the instant a dropdown trigger is pressed — before the blur it
    // causes — so onFocusOut knows a dropdown is opening even though Radix
    // mounts its portal a tick later. Without this the toolbar tears down on
    // open and then re-reveals, a visible flicker.
    let dropdownArmedAt = 0

    const onToolbarPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      // A dropdown trigger (block-type select, `aria-haspopup`) must keep its
      // default so Radix opens and manages the listbox normally — suppressing
      // it is what broke the block-type menu. Same for real focusable inputs.
      if (target.closest('input, textarea, select, [aria-haspopup], [contenteditable="true"]')) {
        if (target.closest('[aria-haspopup]')) dropdownArmedAt = performance.now()
        return
      }
      e.preventDefault()
    }
    toolbar.addEventListener('pointerdown', onToolbarPointerDown)

    // Runs the land-before-keyboard setup for a new keyboard session. Called
    // from focusin (fresh open) AND from pointerdown when reopening the keyboard
    // on an already-focused editor — Lexical keeps DOM focus when the keyboard
    // is dismissed, so that reopen fires NO focusin and this is the only signal.
    // The land is deferred until the caret is actually placed (the next
    // selectionchange), not a guessed frame — see beginEngagement.
    let landArmed = false
    let landTapY: number | null = null
    let landFallbackTimer: number | null = null
    // When the preempt (onMouseDown) has placed the caret and scrolled it
    // itself, its correction is authoritative. Suppress the auto-corrections
    // (land + polls) briefly after — they re-measure the caret once Lexical has
    // reconciled an empty/degenerate block and yank it to a wrong position.
    let suppressCorrectionUntil = 0
    const correctionsSuppressed = () => performance.now() < suppressCorrectionUntil

    function landNow() {
      landArmed = false
      if (landFallbackTimer) { clearTimeout(landFallbackTimer); landFallbackTimer = null }
      if (correctionsSuppressed()) return
      if (!toolbar!.classList.contains('kb-visible')) return
      const landSpan = getCaretScreenSpan(landTapY)
      const landZone = getSafeZone(currentOrEstimatedToolbarTop())
      const scrollBefore = main!.scrollTop
      correctIfOutsideSafeZone(landSpan, landZone)
      debug(`land  ${Math.round(scrollBefore)}→${Math.round(main!.scrollTop)}`)
    }

    function beginEngagement(tapY: number | null) {
      toolbar!.classList.add('kb-visible')
      setTallEditor(true)
      lastCorrectionAt = 0
      keyboardWasUp = false
      if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame)
      scrollAnimFrame = null
      if (pendingCorrectionTimer) clearTimeout(pendingCorrectionTimer)
      pendingCorrectionTimer = null
      toolbarRevealed = false

      // Reserve room now (padding below the caret never shifts its line), then
      // ARM the land instead of scrolling immediately. iOS places the caret at
      // the tap LATE — sometimes after a rAF — so scrolling before placement
      // shifts the content under the finger and the caret lands below the tapped
      // line. The `selectionchange` that fires when the caret is placed is the
      // deterministic "now it's safe to scroll" signal (see onSelectionChange).
      // A short timeout is the fallback for when the caret didn't move (no
      // selectionchange), e.g. reopening on the exact same spot.
      reserveScrollRoom()
      landArmed = true
      landTapY = tapY
      if (landFallbackTimer) clearTimeout(landFallbackTimer)
      landFallbackTimer = window.setTimeout(() => { if (landArmed) landNow() }, 90)

      // If the measured path hasn't revealed the toolbar yet, reveal it at the
      // ESTIMATED keyboard line (we remember kb-height across visits) rather
      // than pinned to the screen bottom. On a rapid reopen the visualViewport
      // geometry can arrive late/mid-animation, so waiting for it left the
      // toolbar hidden or wrongly placed; syncToolbar refines this estimate the
      // moment real geometry lands. Only when we've never measured a keyboard
      // (no touch keyboard at all) does the estimate fall back to the bottom.
      if (noKeyboardFallbackTimer) clearTimeout(noKeyboardFallbackTimer)
      noKeyboardFallbackTimer = window.setTimeout(() => {
        if (toolbarRevealed) return
        const measuredBefore = localStorage.getItem('kb-height') !== null
        revealToolbar(measuredBefore ? currentOrEstimatedToolbarTop() : layoutH() - toolbar!.offsetHeight)
      }, NO_KEYBOARD_FALLBACK_MS)

      pollSyncToolbar()
    }

    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(CONTENT_SELECTOR)) return
      // A refocus during the dismiss window (Lexical/iOS re-grabbing focus after
      // our blur) is what kept the keyboard open. Immediately blur it back.
      if (justDismissed()) { debug('focusin -> reblur'); (e.target as HTMLElement).blur?.(); return }
      // Already engaged → a Lexical focus churn, not a fresh open. Skip so we
      // don't reset scroll/toolbar mid-edit. A genuine reopen after the keyboard
      // was dismissed always tore down first (kb-visible removed), so it falls
      // through here — or, if focus was retained, is handled on pointerdown.
      if (toolbar.classList.contains('kb-visible')) return
      debug(`focus tap=${pendingTapY == null ? '-' : Math.round(pendingTapY)}`)
      const tapY = pendingTapY
      pendingTapY = null
      beginEngagement(tapY)
    }

    // The block-type dropdown (Radix Select) portals its listbox outside the
    // toolbar and pulls focus into it, so opening it looks like a real blur.
    // It also sets onCloseAutoFocus:preventDefault, so after a selection focus
    // is dropped entirely and the keyboard would never come back on its own.
    const DROPDOWN_SELECTOR = '.mdxeditor-select-content'
    const dropdownOpen = () => Boolean(document.querySelector(DROPDOWN_SELECTOR))
    let dropdownWatch: number | null = null

    // Hold the toolbar in place while a toolbar dropdown is open, then hide it
    // cleanly once the menu closes. We do NOT try to refocus the editor: mobile
    // won't reopen the software keyboard without a real user gesture, so a
    // programmatic focus just triggers the no-keyboard fallback and drops the
    // toolbar to the screen bottom. The keyboard is already gone once the menu
    // took focus — the user taps back into the text to resume, which restores
    // both keyboard and toolbar the normal way.
    function watchDropdownClose() {
      if (dropdownWatch) return
      let sawOpen = false
      dropdownWatch = window.setInterval(() => {
        if (dropdownOpen()) { sawOpen = true; return }
        // The portal mounts a tick after arming — keep waiting until it has
        // actually appeared (or the arm window lapses without it ever opening).
        if (!sawOpen && performance.now() - dropdownArmedAt < 600) return
        clearInterval(dropdownWatch!)
        dropdownWatch = null
        // If focus somehow returned to the editor, leave everything up.
        if (getContent()?.contains(document.activeElement)) return
        hideToolbar()
      }, 60)
    }

    const onFocusOut = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(CONTENT_SELECTOR)) return
      // A focus moving to another element inside the editor (a toolbar button or
      // an open dropdown listbox) isn't a real blur — the keyboard stays up.
      const next = e.relatedTarget
      if (next instanceof Element && (next.closest(CONTENT_SELECTOR) || toolbar.contains(next) || next.closest(DROPDOWN_SELECTOR))) return
      // A dropdown was just pressed (portal not mounted yet) or is already open:
      // hold the toolbar and wait for the menu to close rather than tearing down.
      if (performance.now() - dropdownArmedAt < 600 || dropdownOpen()) { watchDropdownClose(); return }
      // Focus moved to another real, focusable control (the title field, a
      // sidebar button that took focus): a deterministic blur — tear down now.
      if (next instanceof Element) { hideToolbar(); return }
      // relatedTarget is null: this is EITHER Lexical's focus churn (focus
      // returns immediately, keyboard stays up) OR a genuine dismiss. We don't
      // guess and we don't use a timer — syncToolbar's geometry teardown hides
      // the toolbar precisely when the keyboard actually leaves, and leaves it
      // untouched when the churn keeps the keyboard up.
    }

    function hideToolbar() {
      toolbar!.classList.remove('kb-visible')
      toolbar!.style.transform = 'translateY(-9999px)'
      // Collapse the editor back to its compact resting height (backlinks close).
      setTallEditor(false)
      toolbarRevealed = false
      keyboardWasUp = false
      landArmed = false
      if (landFallbackTimer) { clearTimeout(landFallbackTimer); landFallbackTimer = null }
      if (noKeyboardFallbackTimer) clearTimeout(noKeyboardFallbackTimer)
      // Reset instantly (not via the fade) so the next focus's fade-in starts
      // clean from 0 — already off-screen, so no visible effect on the hide.
      toolbar!.style.transition = 'none'
      toolbar!.style.opacity = '0'
      requestAnimationFrame(() => {
        toolbar!.style.transition = ''
      })
      // Collapse the reserved room back to the small resting margin (no scroll
      // needed with the keyboard down — a big reserve is just dead space).
      reserveScrollRoom(false)
      if (pendingCorrectionTimer) clearTimeout(pendingCorrectionTimer)
      pendingCorrectionTimer = null
      if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame)
      scrollAnimFrame = null
      pollTimers.forEach(clearTimeout)
    }

    // `input` is deferred a frame (unlike `selectionchange`, corrected
    // synchronously): Safari runs its own "keep caret visible" pass right after
    // an edit, and correcting in the same tick lets that pass cancel ours.
    const onInput = () => requestAnimationFrame(maybeCorrectCaretScroll)
    const onSelectionChange = () => {
      // The first selectionchange after engaging is the caret being placed at
      // the tap — do the deferred land now (scroll after placement). Otherwise
      // keep the caret in the safe zone as it moves (arrow keys, taps while the
      // keyboard is open). This is stable again now that placement goes through
      // Lexical; the correction is guarded (justDismissed / suppressed-after-
      // preempt) against the empty-block over-scroll that made me disable it.
      if (landArmed) { landNow(); return }
      maybeCorrectCaretScroll()
    }

    // Diagnostic: log which surface actually moves during the slide. `doc` =
    // document/window (iOS app-pull), `main` = our caret scroll, `vv` = visual
    // viewport offset. Only logs meaningful changes to keep it readable.
    let lastScrollLog = ''
    const onAnyScroll = (e: Event) => {
      if (!toolbar.classList.contains('kb-visible')) return
      const se = document.scrollingElement as HTMLElement | null
      const doc = se ? Math.round(se.scrollTop) : 0
      const vvTop = Math.round(vv?.offsetTop || 0)
      // Only the pan cases are interesting; a plain <main> scroll (all others 0)
      // just floods the log.
      if (doc === 0 && window.scrollY === 0 && vvTop === 0) return
      const msg = `PAN doc=${doc} win=${Math.round(window.scrollY)} vv=${vvTop} main=${Math.round(main.scrollTop)}`
      if (msg !== lastScrollLog) { debug(msg); lastScrollLog = msg }
    }
    window.addEventListener('scroll', onAnyScroll, true)

    // Swipe-down-to-dismiss, like iOS's interactive keyboard dismissal: dragging
    // the content downward into the bottom band (just above the keyboard) blurs
    // the editor so the keyboard closes. Fires during the drag, the moment it
    // crosses the threshold. The refocus that a blur provokes (Lexical/iOS
    // re-grabbing focus) is handled by the dismiss window below + the reblur in
    // onFocusIn — that, not the blur timing, was what kept the keyboard open.
    let touchStartY: number | null = null
    // Set when a swipe-dismiss blurs the editor; suppresses the immediate
    // re-engagement (focus / reopen / preempt) from the tail of that gesture.
    let dismissedAt = 0
    const justDismissed = () => performance.now() - dismissedAt < 500
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? null }
    const onTouchMove = (e: TouchEvent) => {
      if (touchStartY == null || !toolbar.classList.contains('kb-visible')) return
      const y = e.touches[0]?.clientY
      if (y == null) return
      const viewportBottom = vv ? vv.offsetTop + vv.height : layoutH()
      if (y - touchStartY > 50 && y > viewportBottom - 10) {
        const active = document.activeElement as HTMLElement | null
        if (active && getContent()?.contains(active)) {
          debug('swipe-dismiss')
          active.blur()
          touchStartY = null
          dismissedAt = performance.now()
          const swallow = (ev: Event) => { ev.preventDefault(); ev.stopPropagation() }
          window.addEventListener('click', swallow, { capture: true, once: true })
          window.setTimeout(() => window.removeEventListener('click', swallow, true), 500)
        }
      }
    }
    main.addEventListener('touchstart', onTouchStart, { passive: true })
    main.addEventListener('touchmove', onTouchMove, { passive: true })

    main.addEventListener('pointerdown', onPointerDown)
    main.addEventListener('mousedown', onMouseDown)
    // focusin/focusout bubble (unlike focus/blur), so one listener on <main>
    // catches the content element even though it mounts/remounts inside.
    main.addEventListener('focusin', onFocusIn)
    main.addEventListener('focusout', onFocusOut)
    main.addEventListener('input', onInput)
    document.addEventListener('selectionchange', onSelectionChange)
    if (vv) {
      vv.addEventListener('resize', syncToolbar)
      vv.addEventListener('scroll', syncToolbar)
    }

    return () => {
      panPin.remove()
      window.removeEventListener('scroll', onAnyScroll, true)
      main.removeEventListener('touchstart', onTouchStart)
      main.removeEventListener('touchmove', onTouchMove)
      main.removeEventListener('pointerdown', onPointerDown)
      main.removeEventListener('mousedown', onMouseDown)
      toolbar.removeEventListener('pointerdown', onToolbarPointerDown)
      main.removeEventListener('focusin', onFocusIn)
      main.removeEventListener('focusout', onFocusOut)
      main.removeEventListener('input', onInput)
      document.removeEventListener('selectionchange', onSelectionChange)
      if (vv) {
        vv.removeEventListener('resize', syncToolbar)
        vv.removeEventListener('scroll', syncToolbar)
      }
      pollTimers.forEach(clearTimeout)
      if (dropdownWatch) clearInterval(dropdownWatch)
      if (landFallbackTimer) clearTimeout(landFallbackTimer)
      if (noKeyboardFallbackTimer) clearTimeout(noKeyboardFallbackTimer)
      if (pendingCorrectionTimer) clearTimeout(pendingCorrectionTimer)
      if (scrollAnimFrame) cancelAnimationFrame(scrollAnimFrame)
      // Leave the toolbar in a clean resting state if we tore down mid-focus
      // (e.g. resized to desktop): clear the inline overlay styles so the CSS
      // default (or desktop layout) takes over.
      toolbar.classList.remove('kb-visible')
      toolbar.style.transform = ''
      toolbar.style.transition = ''
      toolbar.style.opacity = ''
      const article = getArticle()
      if (article) article.style.paddingBottom = ''
      const content = getContent()
      if (content) content.style.minHeight = ''
    }
  }, [toolbar, main, enabled, noteId])
}
