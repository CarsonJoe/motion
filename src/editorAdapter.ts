// The editor-agnostic surface the mobile-keyboard engine drives, and the
// registry the concrete adapter registers itself into.
//
// The engine has to be reachable from the app shell (App mounts the hook on
// every render, mobile or not), while the only implementation — ./lexicalBridge
// — lives inside the lazily-loaded editor chunk. Importing the implementation
// directly would pull Lexical and MDXEditor back into the entry bundle for the
// sake of a handful of caret calls. So the engine talks to this proxy instead:
// before the editor chunk loads, `hasEditor()` is false and every call is a
// no-op, which is exactly the state the engine already handles (no editor
// mounted yet).

export type EditorAdapter = {
  hasEditor: () => boolean
  rangeFromPoint: (x: number, y: number) => Range | null
  placeCaretAtRange: (range: Range) => boolean
  placeCaretAtEnd: () => boolean
  placeCaretAtStart: () => boolean
  focus: () => void
  blur: () => void
  isFocused: () => boolean
}

let current: EditorAdapter | null = null

export function registerEditorAdapter(adapter: EditorAdapter) { current = adapter }

export const editorAdapter: EditorAdapter = {
  hasEditor: () => current?.hasEditor() ?? false,
  rangeFromPoint: (x, y) => current?.rangeFromPoint(x, y) ?? null,
  placeCaretAtRange: (range) => current?.placeCaretAtRange(range) ?? false,
  placeCaretAtEnd: () => current?.placeCaretAtEnd() ?? false,
  placeCaretAtStart: () => current?.placeCaretAtStart() ?? false,
  focus: () => current?.focus(),
  blur: () => current?.blur(),
  isFocused: () => current?.isFocused() ?? false
}
