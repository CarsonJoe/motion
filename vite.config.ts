import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function padServiceWorker(): Plugin {
  return {
    name: 'pad-service-worker',
    apply: 'build',
    generateBundle(_: unknown, bundle: Record<string, unknown>) {
      const assets = Object.keys(bundle)
        .filter((fileName) => !fileName.endsWith('.map') && fileName !== 'sw.js')
        .map((fileName) => `/${fileName}`)
      const precache = [...new Set([
        '/', '/index.html', '/manifest.webmanifest', '/pad-icon.svg',
        '/pad-icon-180.png', '/pad-icon-192.png', '/pad-icon-512.png', '/pad-icon-maskable-512.png',
        ...assets
      ])]
      const cacheVersion = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync('src/sw.template.js', 'utf8').replace(
        '/* __PAD_PRECACHE__ */',
        `const CACHE = 'pad-shell-${cacheVersion}'\nconst PRECACHE = ${JSON.stringify(precache)}`
      )
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    padServiceWorker()
  ],
  // The Tallpond gateway allows the hosted app origin, but not arbitrary LAN
  // origins such as http://192.168.x.x:5173. Proxy it through Vite during local
  // development so offline-first work and sync probes behave the same way.
  server: {
    proxy: {
      '/tallpond': {
        target: 'https://api.tallpond.com',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/tallpond/, '')
      }
    }
  }
})
