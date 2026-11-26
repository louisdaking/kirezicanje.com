// =====================================================================
// KIREZI CANJE - OFFLINE ENGINE (works like WhatsApp)
//  1) offlineFetch : every "read" from Supabase is saved on the phone. No internet?
//                    the app shows the last saved copy, so all pages still open.
//  2) outbox       : messages written without internet wait on the phone and are
//                    sent automatically when the internet comes back.
//  3) connection bar + service worker registration
// =====================================================================

const DB_NAME = 'kc-offline', STORE = 'gets', JOB_STORE = 'jobs', MAX_ENTRIES = 200, FETCH_TIMEOUT_MS = 15000
let cacheUser = null
let saves = 0

export const stale = { v: false }   // true when the screen shows saved data (no internet)
export function setCacheUser(id) { cacheUser = id || null }

// ---------- tiny IndexedDB helpers ----------
let dbp = null
function db() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no idb'))
    const r = indexedDB.open(DB_NAME, 2)
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'key' })
      if (!r.result.objectStoreNames.contains(JOB_STORE)) r.result.createObjectStore(JOB_STORE, { keyPath: 'id', autoIncrement: true })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return dbp
}
async function idbGet(key) {
  try {
    const d = await db()
    return await new Promise((res) => { const q = d.transaction(STORE).objectStore(STORE).get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null) })
  } catch { return null }
}
async function idbPut(row) {
  try {
    const d = await db()
    await new Promise((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(row); t.oncomplete = res; t.onerror = res })
  } catch { /* storage full or blocked: the app still works online */ }
}
async function idbPrune() {
  try {
    const d = await db()
    const all = await new Promise((res) => { const q = d.transaction(STORE).objectStore(STORE).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]) })
    if (all.length <= MAX_ENTRIES) return
    all.sort((a, b) => a.t - b.t)
    const t = d.transaction(STORE, 'readwrite')
    all.slice(0, all.length - MAX_ENTRIES).forEach(r => t.objectStore(STORE).delete(r.key))
  } catch { /* ignore */ }
}
export async function clearOfflineCache() {
  try { const d = await db(); d.transaction(STORE, 'readwrite').objectStore(STORE).clear() } catch { /* ignore */ }
}

// ---------- 1) the fetch used by the Supabase client ----------
// ----- stale-while-revalidate: the screen opens at once from the copy saved on the phone,
// the fresh copy is fetched quietly in the background (event "kc-fresh" tells the screen) -----
const freshUntil = new Map()
const revalidating = new Set()
let bypassUntil = 0
export function forceFresh(ms = 6000) { bypassUntil = Date.now() + ms }     // right after I changed something: ask the server first
const isSwrUrl = (u) => u.includes('/rest/v1/profiles') || u.includes('/rest/v1/posts?') || u.includes('/rest/v1/follows?') ||
  (u.includes('/rest/v1/message?') && !u.includes('and('))                  // lists only; an open chat always asks the server

async function revalidate(input, init, key, oldBody) {
  if (revalidating.has(key)) return
  revalidating.add(key)
  try {
    const res = await fetch(input, init)
    if (!res.ok) return
    const body = await res.text()
    await idbPut({ key, t: Date.now(), body, ct: res.headers.get('content-type'), cr: res.headers.get('content-range') })
    freshUntil.set(key, Date.now() + 6000)
    if (body !== oldBody) window.dispatchEvent(new CustomEvent('kc-fresh', { detail: { url: key } }))
  } catch { /* no internet: the saved copy stays */ }
  finally { revalidating.delete(key) }
}

export async function offlineFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url
  const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase()
  const isRead = method === 'GET' && url.includes('/rest/v1/') && !!cacheUser
  const key = isRead ? cacheUser + '|' + url : null

  const fromCache = async () => {
    const hit = await idbGet(key)
    if (!hit) return null
    const headers = { 'content-type': hit.ct || 'application/json' }
    if (hit.cr) headers['content-range'] = hit.cr
    stale.v = true
    return new Response(hit.body, { status: 200, headers })
  }

  if (isRead && !navigator.onLine) {
    const c = await fromCache()
    if (c) return c
  }

  // the saved copy answers at once, the server answers later
  if (isRead && navigator.onLine && typeof input === 'string' && isSwrUrl(url) && Date.now() > bypassUntil && !(init && init.signal)) {
    const hit = await idbGet(key)
    if (hit) {
      if ((freshUntil.get(key) || 0) < Date.now()) revalidate(input, init, key, hit.body)
      const headers = { 'content-type': hit.ct || 'application/json' }
      if (hit.cr) headers['content-range'] = hit.cr
      return new Response(hit.body, { status: 200, headers })
    }
  }

  try {
    let opts = init
    let timer = null
    if (isRead && !(init && init.signal) && typeof AbortController !== 'undefined') {
      const ctl = new AbortController()
      timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
      opts = Object.assign({}, init || {}, { signal: ctl.signal })
    }
    const res = await fetch(input, opts)
    if (timer) clearTimeout(timer)
    if (isRead && res.ok) {
      const copy = res.clone()
      copy.text().then(body => {
        idbPut({ key, t: Date.now(), body, ct: copy.headers.get('content-type'), cr: copy.headers.get('content-range') })
        if (++saves % 25 === 0) idbPrune()
      }).catch(() => {})
    }
    return res
  } catch (err) {
    if (isRead) {
      const c = await fromCache()
      if (c) return c
    }
    throw err
  }
}

// ---------- 2) outbox: messages waiting for the internet ----------
const OUTBOX_KEY = 'kc_outbox'
function readBox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]') } catch { return [] } }
function writeBox(a) { try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(a)) } catch { /* ignore */ } }
export const outbox = {
  all: () => readBox(),
  add: (item) => { const a = readBox(); a.push(item); writeBox(a) },
  remove: (clientId) => writeBox(readBox().filter(i => i.client_id !== clientId)),
  // counts a failed try; returns how many tries this message has had
  bump: (clientId) => { let n = 0; writeBox(readBox().map(i => { if (i.client_id === clientId) { i.tries = (i.tries || 0) + 1; n = i.tries } return i })); return n },
}
export function isNetworkError(err) {
  if (!navigator.onLine) return true
  const m = String((err && (err.message || err)) || '')
  return /failed to fetch|networkerror|network request|load failed|timeout|aborted|fetch/i.test(m)
}

// the saved login, used only when the internet is down and Supabase cannot refresh it
export function savedSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        const s = JSON.parse(localStorage.getItem(k))
        if (s && s.user && s.user.id) return s
      }
    }
  } catch { /* ignore */ }
  return null
}

// ---------- 2b) jobs: everything else done without internet ----------
// photos / videos / voice / files / likes / follows wait on the phone (with their file) and
// are sent one by one, in order, when the internet comes back.
const handlers = {}
let jobsMem = []          // light copy (no file) so the screen can show "waiting" bubbles at once
let jobsRunning = false
const asRow = (r) => ({ id: r.id, type: r.type, key: r.key, user: r.user, payload: r.payload, created: r.created })
async function jobsAll() {
  try {
    const d = await db()
    return await new Promise((res) => { const q = d.transaction(JOB_STORE).objectStore(JOB_STORE).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]) })
  } catch { return [] }
}
async function jobsPut(row) {
  const d = await db()
  return await new Promise((res, rej) => { const t = d.transaction(JOB_STORE, 'readwrite'); const q = t.objectStore(JOB_STORE).put(row); q.onsuccess = () => res(q.result); t.onerror = () => rej(t.error) })
}
async function jobsDel(id) {
  try { const d = await db(); await new Promise((res) => { const t = d.transaction(JOB_STORE, 'readwrite'); t.objectStore(JOB_STORE).delete(id); t.oncomplete = res; t.onerror = res }) } catch { /* ignore */ }
  jobsMem = jobsMem.filter(j => j.id !== id)
}
export const jobs = {
  on: (type, fn) => { handlers[type] = fn },
  load: async () => { jobsMem = (await jobsAll()).map(asRow) },
  list: (type) => jobsMem.filter(j => !type || j.type === type),
  // key: a later job with the same key replaces the older one (a like then an unlike = nothing to send)
  add: async (type, payload, blob, key, user) => {
    if (key) for (const j of jobsMem.filter(x => x.key === key)) await jobsDel(j.id)
    const row = { type, key: key || null, user: user || null, payload, blob: blob || null, created: Date.now(), tries: 0 }
    row.id = await jobsPut(row)
    jobsMem.push(asRow(row))
    return row.id
  },
  // sends everything that is waiting. returns the types that were sent.
  run: async (user) => {
    if (jobsRunning || !navigator.onLine) return []
    jobsRunning = true
    const done = []
    try {
      const rows = (await jobsAll()).filter(r => !r.user || r.user === user).sort((a, b) => a.id - b.id)
      for (const row of rows) {
        const fn = handlers[row.type]
        if (!fn) { await jobsDel(row.id); continue }
        try { await fn(row.payload, row.blob); await jobsDel(row.id); done.push(row.type) }
        catch (e) {
          if (isNetworkError(e)) break                       // internet went away again: stop, try later
          row.tries = (row.tries || 0) + 1
          console.error('[kirezi] job failed', row.type, e)
          if (row.tries >= 5) await jobsDel(row.id); else await jobsPut(row)
        }
      }
    } finally { jobsRunning = false }
    return done
  }
}

// ---------- 3) connection bar + service worker ----------
export function initConnectionBar(onBack) {
  const bar = document.createElement('div')
  bar.id = 'offlineBar'
  document.body.appendChild(bar)
  let hideT = null
  const show = (text, cls) => { clearTimeout(hideT); bar.textContent = text; bar.className = 'show ' + cls }
  const offline = () => show('📴 Nta internet — urakoresha ibiri kuri terefone', 'off')
  const online = () => {
    show('✅ Internet yagarutse', 'on')
    hideT = setTimeout(() => { bar.className = '' }, 2500)
    onBack && onBack()
  }
  window.addEventListener('offline', offline)
  window.addEventListener('online', online)
  if (!navigator.onLine) offline()
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js')
      await navigator.serviceWorker.ready
      // make sure the libraries loaded from the internet (supabase) are saved for offline use too
      const seen = performance.getEntriesByType('resource').map(r => r.name)
        .filter(n => n.startsWith('https://cdn.jsdelivr.net/') || n.startsWith('https://fonts.googleapis.com/') || n.startsWith('https://fonts.gstatic.com/'))
      for (const u of seen) { try { await fetch(u, { mode: 'cors' }) } catch { /* ignore */ } }
      if (reg.update) reg.update().catch(() => {})   // a failed update (for example a redirect on the host) must stay silent
    } catch (e) { /* the app works without the service worker, only not offline */ }
  })
}
