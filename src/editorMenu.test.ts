import { describe, expect, it } from 'vitest'
import { isDividerShortcut } from './editorMenu'

describe('divider typing shortcut', () => {
  it.each(['---', '----', '***', '____'])('accepts %s without a trailing space', (value) => {
    expect(isDividerShortcut(value)).toBe(true)
  })

  it.each(['—-', '-—', '–-', '-–'])('accepts the mobile smart-punctuation form %s', (value) => {
    expect(isDividerShortcut(value)).toBe(true)
  })

  it.each(['--', '—', '--- ', 'text---'])('does not accept %s', (value) => {
    expect(isDividerShortcut(value)).toBe(false)
  })
})
