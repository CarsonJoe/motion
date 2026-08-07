import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@mdxeditor/editor/style.css'
import './styles.css'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Browsers check this registration on each app load. Do not force a reload
    // on controller changes: it can turn a worker update into a reload loop.
    void navigator.serviceWorker.register('/sw.js?v=6', { updateViaCache: 'none' })
  })
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
