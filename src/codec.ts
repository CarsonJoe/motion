import * as Y from 'yjs'

export const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

export const mergeBase64Updates = (payloads: string[]) => toBase64(Y.mergeUpdates(payloads.map(fromBase64)))

// The editor hands us whole markdown strings. Applying the minimal middle diff
// keeps concurrent edits at different positions mergeable instead of turning
// every keystroke into a whole-document replacement.
export function patchYText(text: Y.Text, value: string) {
  const current = text.toString()
  if (current === value) return
  let start = 0
  const maxStart = Math.min(current.length, value.length)
  while (start < maxStart && current[start] === value[start]) start += 1
  let currentEnd = current.length
  let valueEnd = value.length
  while (currentEnd > start && valueEnd > start && current[currentEnd - 1] === value[valueEnd - 1]) {
    currentEnd -= 1
    valueEnd -= 1
  }
  if (currentEnd > start) text.delete(start, currentEnd - start)
  if (valueEnd > start) text.insert(start, value.slice(start, valueEnd))
}
