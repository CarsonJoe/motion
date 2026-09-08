export type DiagnosticDomain = 'boot' | 'auth' | 'sync' | 'outbox' | 'realtime' | 'document' | 'storage' | 'sharing' | 'assets' | 'service-worker' | 'network' | 'keyboard'
export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticField = string | number | boolean | null
export type DiagnosticFields = Record<string, DiagnosticField | undefined>

export type DiagnosticEvent = {
  at: number
  mono: number
  boot: string
  domain: DiagnosticDomain
  name: string
  level: DiagnosticLevel
  operation?: string
  fields?: Record<string, DiagnosticField>
  repeats?: number
}

export type DiagnosticSnapshot = {
  sync?: string
  connected?: boolean
  fullSync?: boolean
  pending?: number
  docTransport?: string
  activeScope?: string
  notes?: number
  privateNotes?: number
  sharedNotes?: number
  roomNotes?: number
  deletedNotes?: number
  oldestPendingMs?: number
  pendingNotes?: number
  pendingUpdates?: number
  pendingBytes?: number
  invariantOk?: number
  invariantWarnings?: string[]
}

const STORAGE_KEY = 'pad-diagnostics-v1'
const UNLOCK_KEY = 'pad-diagnostics-unlocked'
const INSTALL_KEY = 'pad-diagnostics-install'
const MAX_EVENTS = 80
const MAX_STORAGE_BYTES = 48 * 1024
const MAX_REPORT_BYTES = 16 * 1024
const DETAIL_WINDOW_MS = 10 * 60 * 1000
const EXPIRES_MS = 7 * 24 * 60 * 60 * 1000
const boot = crypto.randomUUID().slice(0, 8)
const startedAt = Date.now()
const counters = new Map<string, number>()
const operations = new Map<string, number>()
const network = new Map<string, { count: number; errors: number; canceled: number; totalMs: number; maxMs: number }>()
let requestStarts: Array<{ at: number; signature: string }> = []
let requestsInFlight = 0
let peakRequestsInFlight = 0
let lastBurstAt = 0
const listeners = new Set<() => void>()
let events: DiagnosticEvent[] = []
let previousBoot: { boot: string; startedAt: number; endedAt?: number; lastActive?: string } | null = null
let snapshotProvider: (() => DiagnosticSnapshot | Promise<DiagnosticSnapshot>) | null = null
let persistTimer: number | null = null
let persistenceFailed = false
let summaryCache: { boot: string; startedAt: number; recent: DiagnosticEvent[]; lastError: DiagnosticEvent | null; unlocked: boolean } | null = null

const storage = (() => {
  try {
    const test = '__pad_diagnostics_test__'
    localStorage.setItem(test, '1')
    localStorage.removeItem(test)
    return localStorage
  } catch { return null }
})()

const installSalt = (() => {
  if (!storage) return boot
  let value = storage.getItem(INSTALL_KEY)
  if (!value) {
    value = crypto.randomUUID()
    try { storage.setItem(INSTALL_KEY, value) } catch { /* memory-only diagnostics */ }
  }
  return value
})()

function load() {
  if (!storage) return
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null') as {
      savedAt?: number
      current?: { boot: string; startedAt: number; lastActive?: string }
      previous?: { boot: string; startedAt: number; endedAt?: number; lastActive?: string }
      events?: DiagnosticEvent[]
    } | null
    if (!parsed || !parsed.savedAt || Date.now() - parsed.savedAt > EXPIRES_MS) return
    previousBoot = parsed.current ?? parsed.previous ?? null
    events = (parsed.events ?? []).filter((item) => item && typeof item.at === 'number').slice(-30)
  } catch { /* a corrupt debug capsule must not affect Pad */ }
}
load()
if (typeof location !== 'undefined' && /(?:\?|&)pad-diagnostics=1(?:&|$)/.test(location.search)) {
  try { storage?.setItem(UNLOCK_KEY, '1') } catch { /* URL still unlocks this visit */ }
}

const sensitiveField = /(?:title|markdown|content|payload|token|ticket|cookie|authorization|header|invite|handle|display.?name|file.?path|url)/i
const redactString = (value: string) => value
  .replace(/https?:\/\/\S+/gi, '[url]')
  .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
  .replace(/\b(?:tpt|eyJ)[A-Za-z0-9._-]{16,}\b/g, '[secret]')
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
  .replace(/[\r\n\t]+/g, ' ')
  .slice(0, 180)

function cleanFields(input?: DiagnosticFields) {
  if (!input) return undefined
  const output: Record<string, DiagnosticField> = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (rawValue === undefined || sensitiveField.test(rawKey)) continue
    const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 36)
    output[key] = typeof rawValue === 'string' ? redactString(rawValue) : rawValue
  }
  return Object.keys(output).length ? output : undefined
}

function fingerprint(value: DiagnosticEvent) {
  return `${value.boot}:${value.level}:${value.domain}:${value.name}:${value.operation ?? ''}:${JSON.stringify(value.fields ?? {})}`
}

function notify() {
  summaryCache = null
  for (const listener of listeners) listener()
}

function capsule(lastActive?: string) {
  return JSON.stringify({
    schema: 1,
    savedAt: Date.now(),
    current: { boot, startedAt, lastActive },
    previous: previousBoot,
    events: events.slice(-30),
  })
}

function persist(lastActive?: string) {
  if (!storage || persistenceFailed) return
  try {
    let value = capsule(lastActive)
    while (new Blob([value]).size > MAX_STORAGE_BYTES && events.length > 8) {
      events = events.slice(Math.ceil(events.length / 4))
      value = capsule(lastActive)
    }
    storage.setItem(STORAGE_KEY, value)
  } catch {
    persistenceFailed = true
  }
}

function schedulePersist(immediate = false) {
  if (!storage || persistenceFailed) return
  if (immediate) {
    if (persistTimer !== null) globalThis.clearTimeout(persistTimer)
    persistTimer = null
    persist()
    return
  }
  if (persistTimer !== null) return
  persistTimer = globalThis.setTimeout(() => { persistTimer = null; persist() }, 2000)
}

export function diagnosticEvent(domain: DiagnosticDomain, name: string, fields?: DiagnosticFields, level: DiagnosticLevel = 'info', operation?: string) {
  try {
    const value: DiagnosticEvent = { at: Date.now(), mono: performance.now(), boot, domain, name: name.slice(0, 64), level, ...(operation ? { operation } : {}), ...(cleanFields(fields) ? { fields: cleanFields(fields) } : {}) }
    const prior = events.at(-1)
    if (prior && value.at - prior.at < 5000 && fingerprint(prior) === fingerprint(value)) {
      prior.repeats = (prior.repeats ?? 1) + 1
      prior.at = value.at
      prior.mono = value.mono
    } else {
      events.push(value)
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    }
    schedulePersist(level === 'error')
    notify()
  } catch { /* diagnostics are never allowed to break product code */ }
}

export const diagnosticWarn = (domain: DiagnosticDomain, name: string, fields?: DiagnosticFields, operation?: string) => diagnosticEvent(domain, name, fields, 'warn', operation)
export const diagnosticFailure = (domain: DiagnosticDomain, name: string, error: unknown, fields?: DiagnosticFields, operation?: string) => {
  const candidate = error as { name?: string; message?: string; status?: number; code?: string; requestId?: string | null; data?: Record<string, unknown> } | null
  const data = candidate?.data
  diagnosticEvent(domain, name, {
    ...fields,
    error: candidate?.message || candidate?.name || 'Unknown error',
    status: candidate?.status,
    code: candidate?.code,
    request: candidate?.requestId || undefined,
    upstream_status: typeof data?.upstream_status === 'number' ? data.upstream_status : undefined,
    upstream_request: typeof data?.upstream_request_id === 'string' ? data.upstream_request_id : undefined,
  }, 'error', operation)
}

export function diagnosticCount(domain: DiagnosticDomain, name: string, amount = 1, dimensions = '') {
  const key = `${domain}.${name}${dimensions ? `.${dimensions}` : ''}`
  counters.set(key, (counters.get(key) ?? 0) + amount)
}

export async function diagnosticRequest<T>(signature: string, work: () => PromiseLike<T> | Promise<T>): Promise<T> {
  const safeSignature = signature.replace(/[^a-zA-Z0-9_.:/-]/g, '_').slice(0, 90)
  const began = performance.now()
  const now = Date.now()
  requestsInFlight += 1
  peakRequestsInFlight = Math.max(peakRequestsInFlight, requestsInFlight)
  requestStarts = [...requestStarts.filter((item) => now - item.at <= 2000), { at: now, signature: safeSignature }]
  if (requestStarts.length > 25 && now - lastBurstAt > 10000) {
    lastBurstAt = now
    const top = [...requestStarts.reduce((map, item) => map.set(item.signature, (map.get(item.signature) ?? 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, count]) => `${key}:${count}`).join(',')
    diagnosticWarn('network', 'request-burst', { requests: requestStarts.length, window_ms: 2000, peak: peakRequestsInFlight, top })
  }
  let outcome: 'ok' | 'error' | 'canceled' = 'ok'
  try {
    return await work()
  } catch (error) {
    outcome = error instanceof DOMException && error.name === 'AbortError' ? 'canceled' : 'error'
    if (outcome === 'error') diagnosticFailure('network', 'request-failed', error, { signature: safeSignature, ms: Math.round(performance.now() - began) })
    throw error
  } finally {
    requestsInFlight = Math.max(0, requestsInFlight - 1)
    const duration = performance.now() - began
    const aggregate = network.get(safeSignature) ?? { count: 0, errors: 0, canceled: 0, totalMs: 0, maxMs: 0 }
    aggregate.count += 1
    aggregate.errors += outcome === 'error' ? 1 : 0
    aggregate.canceled += outcome === 'canceled' ? 1 : 0
    aggregate.totalMs += duration
    aggregate.maxMs = Math.max(aggregate.maxMs, duration)
    network.set(safeSignature, aggregate)
    if (duration > 2000 && outcome === 'ok') diagnosticWarn('network', 'request-slow', { signature: safeSignature, ms: Math.round(duration) })
  }
}

export function diagnosticSpan(domain: DiagnosticDomain, name: string, fields?: DiagnosticFields) {
  const index = (operations.get(name) ?? 0) + 1
  operations.set(name, index)
  const operation = `${name.replace(/[^a-z]/gi, '').slice(0, 3).toLowerCase() || 'op'}${index}`
  const began = performance.now()
  diagnosticEvent(domain, `${name}.start`, fields, 'info', operation)
  let ended = false
  return {
    operation,
    end: (outcome: 'ok' | 'failed' | 'canceled' | 'partial' = 'ok', endFields?: DiagnosticFields, error?: unknown) => {
      if (ended) return
      ended = true
      const result = { ...endFields, outcome, ms: Math.round(performance.now() - began) }
      if (error) diagnosticFailure(domain, `${name}.end`, error, result, operation)
      else diagnosticEvent(domain, `${name}.end`, result, outcome === 'ok' ? 'info' : outcome === 'canceled' ? 'warn' : 'error', operation)
    }
  }
}

// A keyed, installation-local alias. It preserves correlation across boots but
// cannot be matched to a Pad/Tallpond id outside this installation.
export function diagnosticAlias(kind: 'note' | 'workspace' | 'room' | 'user', raw: string) {
  if (!raw) return kind === 'room' ? 'default' : 'private'
  let hash = 2166136261
  for (const character of `${installSalt}:${kind}:${raw}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `${kind}-${(hash >>> 0).toString(36).slice(0, 7)}`
}

export function setDiagnosticSnapshotProvider(provider: (() => DiagnosticSnapshot | Promise<DiagnosticSnapshot>) | null) {
  snapshotProvider = provider
}

export function subscribeDiagnostics(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getDiagnosticSummary() {
  summaryCache ??= {
    boot, startedAt, recent: events.slice(-8).reverse(),
    lastError: [...events].reverse().find((item) => item.level === 'error') ?? null,
    unlocked: diagnosticsUnlocked()
  }
  return summaryCache
}

export function diagnosticsUnlocked() {
  return storage?.getItem(UNLOCK_KEY) === '1' || (typeof location !== 'undefined' && /(?:\?|&)pad-diagnostics=1(?:&|$)/.test(location.search))
}

export function unlockDiagnostics() {
  try { storage?.setItem(UNLOCK_KEY, '1') } catch { /* remain unlocked for this URL */ }
  notify()
}

export function hideDiagnostics() {
  try { storage?.removeItem(UNLOCK_KEY) } catch { /* no-op */ }
  if (typeof location !== 'undefined' && typeof history !== 'undefined') {
    const url = new URL(location.href)
    if (url.searchParams.has('pad-diagnostics')) {
      url.searchParams.delete('pad-diagnostics')
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }
  notify()
}

export function clearDiagnostics() {
  events = []
  counters.clear()
  network.clear()
  requestStarts = []
  previousBoot = null
  try { storage?.removeItem(STORAGE_KEY) } catch { /* no-op */ }
  notify()
}

const formatDuration = (ms?: number) => {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  return `${minutes}m${Math.round((ms % 60000) / 1000)}s`
}

const fieldText = (fields?: Record<string, DiagnosticField>) => !fields ? '' : Object.entries(fields).map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`).join(' ')

function runtimeLine() {
  const standalone = matchMedia('(display-mode: standalone)').matches
  const ua = navigator.userAgent
  const browser = /CriOS|Chrome/.test(ua) ? 'Chromium' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'WebKit' : 'Other'
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other'
  return `runtime=${os}/${browser} mobile=${/Mobi|iPhone|iPad|Android/.test(ua) ? 'yes' : 'no'} mode=${standalone ? 'standalone' : 'browser'} online=${navigator.onLine ? 'yes' : 'no'} visible=${document.visibilityState}`
}

export async function buildDiagnosticReport(extraSections: string[] = []) {
  let snapshot: DiagnosticSnapshot = {}
  try {
    const provider = snapshotProvider?.()
    if (provider) {
      snapshot = await new Promise<DiagnosticSnapshot>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          diagnosticWarn('storage', 'snapshot.timeout')
          resolve({ invariantWarnings: ['diagnostic_snapshot_timeout'] })
        }, 2000)
        void Promise.resolve(provider).then((value) => { globalThis.clearTimeout(timer); resolve(value) }, (error) => { globalThis.clearTimeout(timer); reject(error) })
      })
    }
  } catch (error) { diagnosticFailure('storage', 'snapshot.failed', error) }
  const now = Date.now()
  const notable = events.filter((item) => now - item.at <= DETAIL_WINDOW_MS || item.level === 'error').slice(-35).reverse()
  const health = snapshot.invariantWarnings?.length || snapshot.sync === 'error' || snapshot.sync === 'auth-required' ? 'degraded' : 'ok'
  const build = typeof __PAD_BUILD__ === 'string' ? __PAD_BUILD__ : 'dev'
  const lines = [
    'PAD DIAGNOSTICS v1',
    `captured=${new Date(now).toISOString()} window=10m privacy=redacted`,
    `build=${build} sw=${navigator.serviceWorker?.controller ? 'controlled' : 'none'} boot=${boot}`,
    runtimeLine(),
    previousBoot ? `previous_boot=${previousBoot.boot} previous_active=${previousBoot.lastActive ?? 'unknown'}` : 'previous_boot=none',
    '',
    `HEALTH ${health}`,
    `sync=${snapshot.sync ?? 'unknown'} connected=${snapshot.connected ? 'yes' : 'no'} full_sync=${snapshot.fullSync ? 'yes' : 'no'} pending=${snapshot.pending ?? 0} oldest=${formatDuration(snapshot.oldestPendingMs)} doc=${snapshot.docTransport ?? 'unknown'} active=${snapshot.activeScope ?? 'none'}`,
    `local notes=${snapshot.notes ?? 0} private=${snapshot.privateNotes ?? 0} shared=${snapshot.sharedNotes ?? 0} rooms=${snapshot.roomNotes ?? 0} deleted=${snapshot.deletedNotes ?? 0}`,
    `outbox metadata=${snapshot.pendingNotes ?? 0} updates=${snapshot.pendingUpdates ?? 0} bytes=${snapshot.pendingBytes ?? 0}`,
    `invariants ok=${snapshot.invariantOk ?? 0} warnings=${snapshot.invariantWarnings?.length ?? 0}`,
    ...(snapshot.invariantWarnings ?? []).slice(0, 8).map((warning) => `warn ${warning}`),
    '',
    `COUNTERS ${[...counters.entries()].sort().map(([key, value]) => `${key}=${value}`).join(' ') || 'none'}`,
    '',
    `NETWORK requests=${[...network.values()].reduce((total, item) => total + item.count, 0)} failed=${[...network.values()].reduce((total, item) => total + item.errors, 0)} canceled=${[...network.values()].reduce((total, item) => total + item.canceled, 0)} peak_inflight=${peakRequestsInFlight}`,
    ...[...network.entries()].sort((a, b) => b[1].maxMs - a[1].maxMs).slice(0, 8).map(([signature, item]) => `  ${signature} n=${item.count} err=${item.errors} avg=${Math.round(item.totalMs / item.count)}ms max=${Math.round(item.maxMs)}ms`),
    '',
    'TIMELINE (newest first, notable only)',
    ...notable.map((item) => `${new Date(item.at).toISOString().slice(11, 19)} ${item.level} ${item.domain}.${item.name}${item.operation ? ` op=${item.operation}` : ''}${item.repeats ? ` repeats=${item.repeats}` : ''}${item.fields ? ` ${fieldText(item.fields)}` : ''}`),
    ...(notable.length ? [] : ['none']),
    ...extraSections.flatMap((section) => ['', section]),
  ]
  let report = `${lines.join('\n')}\n`
  if (new Blob([report]).size > MAX_REPORT_BYTES) {
    const marker = '\n[report truncated at 16KB]\n'
    const bytes = new TextEncoder().encode(report).slice(0, MAX_REPORT_BYTES - new TextEncoder().encode(marker).length)
    report = `${new TextDecoder().decode(bytes)}${marker}`
  }
  return report
}

export function formatDiagnosticEvent(item: DiagnosticEvent) {
  return `${new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${item.domain} · ${item.name}${item.fields?.error ? ` · ${item.fields.error}` : ''}`
}

function finishBoot(reason: string) {
  persist(reason)
}

if (typeof window !== 'undefined') {
  diagnosticEvent('boot', 'started', { build: typeof __PAD_BUILD__ === 'string' ? __PAD_BUILD__ : 'dev', online: navigator.onLine, visibility: document.visibilityState })
  window.addEventListener('error', (event) => diagnosticFailure('boot', 'uncaught', event.error ?? new Error(event.message)))
  window.addEventListener('unhandledrejection', (event) => diagnosticFailure('boot', 'unhandled-rejection', event.reason))
  window.addEventListener('online', () => diagnosticEvent('network', 'browser.online'))
  window.addEventListener('offline', () => diagnosticWarn('network', 'browser.offline'))
  document.addEventListener('visibilitychange', () => {
    diagnosticEvent('boot', `visibility.${document.visibilityState}`)
    if (document.visibilityState === 'hidden') finishBoot('hidden')
  })
  window.addEventListener('pagehide', () => finishBoot('pagehide'))
}
