import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePublisher, useCellValue } from '@mdxeditor/gurx'
import { activePlugins$, allowedHeadingLevels$, convertSelectionToNode$, currentBlockType$, useTranslation } from '@mdxeditor/editor'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createParagraphNode } from 'lexical'

// A focus-preserving replacement for MDXEditor's <BlockTypeSelect />. That one
// is a Radix Select: it portals its listbox out of the toolbar and pulls focus
// into it, which on mobile closes the software keyboard and makes the floating
// toolbar lurch around. This drives the exact same MDXEditor internals
// (convertSelectionToNode$ / currentBlockType$) but every interactive element
// calls preventDefault on pointerdown, so the editor selection is never
// blurred — the keyboard stays up and the menu simply floats above the toolbar.

type Item = { label: string; value: string }

export function BlockTypeMenu() {
  const convertSelectionToNode = usePublisher(convertSelectionToNode$)
  const currentBlockType = useCellValue(currentBlockType$)
  const activePlugins = useCellValue(activePlugins$)
  const allowedHeadingLevels = useCellValue(allowedHeadingLevels$)
  const t = useTranslation()
  const hasQuote = activePlugins.includes('quote')
  const hasHeadings = activePlugins.includes('headings')

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'up' | 'down' } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Placement mirrors PageMenu in App.tsx: portal to body, position:fixed, and
  // decide up/down from the trigger's location. On mobile the toolbar floats
  // near the keyboard at the bottom, so the menu opens upward there.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const width = menuRef.current?.offsetWidth ?? 180
      const height = menuRef.current?.offsetHeight ?? 240
      const gap = 6
      let left = Math.min(rect.left, window.innerWidth - width - 8)
      if (left < 8) left = 8
      // Fit against the *visible* viewport (above the keyboard), not
      // window.innerHeight — otherwise "does it fit below?" counts the area
      // hidden behind the keyboard and the menu opens down into it. The toolbar
      // floats just above the keyboard, so this makes it open upward on mobile.
      const vv = window.visualViewport
      const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      const viewTop = vv ? vv.offsetTop : 0
      const openUp = rect.bottom + gap + height > viewBottom - 8
      const top = openUp ? Math.max(viewTop + 8, rect.top - gap - height) : rect.bottom + gap
      setPos({ top, left, placement: openUp ? 'up' : 'down' })
    }
    place()
    // Re-place after the menu has measured its real size, then keep it pinned.
    const frame = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place) }
  }, [open])

  // Dismiss on an outside press or scroll. The outside pointerdown is NOT
  // prevented, so tapping into the text closes the menu and moves the caret.
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    // Dismiss only when something OUTSIDE the menu scrolls (the page/editor).
    // Scrolling within the menu itself (it has a max-height) must not close it.
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', onScroll, true)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', onScroll, true); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!hasQuote && !hasHeadings) return null

  const items: Item[] = [{ label: t('toolbar.blockTypes.paragraph', 'Paragraph'), value: 'paragraph' }]
  if (hasQuote) items.push({ label: t('toolbar.blockTypes.quote', 'Quote'), value: 'quote' })
  if (hasHeadings) items.push(...allowedHeadingLevels.map((n) => ({ label: t('toolbar.blockTypes.heading', 'Heading {{level}}', { level: n }), value: `h${n}` })))

  const apply = (value: string) => {
    switch (value) {
      case 'quote': convertSelectionToNode(() => $createQuoteNode()); break
      case 'paragraph': convertSelectionToNode(() => $createParagraphNode()); break
      default: if (value.startsWith('h')) convertSelectionToNode(() => $createHeadingNode(value as Parameters<typeof $createHeadingNode>[0]))
    }
    setOpen(false)
  }

  const currentLabel = items.find((item) => item.value === currentBlockType)?.label ?? t('toolbar.blockTypeSelect.placeholder', 'Block type')

  // preventDefault on pointerdown keeps the editor selection/focus — this is the
  // whole point of the component. click still fires afterwards.
  const keepFocus = (event: React.PointerEvent) => event.preventDefault()

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="block-type-trigger"
      aria-expanded={open}
      aria-label={t('toolbar.blockTypeSelect.selectBlockTypeTooltip', 'Select block type')}
      title={t('toolbar.blockTypeSelect.selectBlockTypeTooltip', 'Select block type')}
      onPointerDown={keepFocus}
      onClick={() => setOpen((v) => !v)}
    >
      <span className="block-type-trigger-label">{currentLabel}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="block-type-trigger-caret"><path d="m7 10 5 5 5-5" /></svg>
    </button>
    {open && createPortal(
      <div
        ref={menuRef}
        className={`block-type-menu ${pos?.placement === 'up' ? 'placement-up' : 'placement-down'}`}
        role="menu"
        onPointerDown={keepFocus}
        style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      >
        {items.map((item) => <button
          key={item.value}
          type="button"
          role="menuitemradio"
          aria-checked={item.value === currentBlockType}
          className={`block-type-item ${item.value === currentBlockType ? 'active' : ''}`}
          onPointerDown={keepFocus}
          onClick={() => apply(item.value)}
        >{item.label}</button>)}
      </div>,
      document.body,
    )}
  </>
}
