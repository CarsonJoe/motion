import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// The editor's stylesheet is imported by ./markdownEditor, not here: it is the
// bulk of the CSS and is render-blocking wherever it is linked, so it rides
// with the editor chunk instead of holding up the shell's first paint.

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Browsers check this registration on each app load. Do not force a reload
    // on controller changes: it can turn a worker update into a reload loop.
    void navigator.serviceWorker.register('/sw.js?v=7', { updateViaCache: 'none' })
  })
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
