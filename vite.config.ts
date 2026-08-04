import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function motionServiceWorker() {
  return {
    name: 'motion-service-worker',
    apply: 'build' as const,
    generateBundle(_: unknown, bundle: Record<string, unknown>) {
      const assets = Object.keys(bundle)
        .filter((fileName) => !fileName.endsWith('.map') && fileName !== 'sw.js')
        .map((fileName) => `/${fileName}`)
      const precache = [...new Set(['/', '/index.html', '/manifest.webmanifest', '/icon.svg', ...assets])]
      const cacheVersion = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync('src/sw.template.js', 'utf8').replace(
        '/* __MOTION_PRECACHE__ */',
        `const CACHE = 'motion-shell-${cacheVersion}'\nconst PRECACHE = ${JSON.stringify(precache)}`
      )
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    motionServiceWorker()
  ]
})
