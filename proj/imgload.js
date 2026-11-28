// =====================================================
// IMGLOAD.JS  (new file)  -  pictures that load like Instagram / Facebook
//
//  1. It feels the network (2G / 3G / 4G / Data Saver / real speed it measured)
//     and picks a LIGHT picture on a weak connection, a sharp one on a good one.
//  2. Blur-up: first a tiny blurry preview (about 1 KB), then the real picture
//     fades in on top. No empty white boxes, no jumping.
//  3. Pictures load only when they are near the screen, a few at a time
//     (2 at a time on 2G, 8 on Wi-Fi) so the first ones appear first.
//  4. Avatars always use a small copy (they are only 50 px wide!).
//  5. In the full-screen viewer on a weak network you see the light copy at once
//     and a small "HD" button loads the sharp one only if you want it.
//  6. New photos are shrunk BEFORE upload (max 1440 px) and get a 640 px copy, a
//     160 px avatar copy and a tiny preview next to them. Old photos keep working exactly as before.
//
// No change in Supabase is needed. If your Supabase plan has "image transformations"
// they are used for OLD photos too; if not, the app notices once and stops trying.
//
// Use in templates:   kcImg(url, { cls: 'postmedia', full: false, attrs: '' })
// =====================================================

const SUPA = /\/storage\/v1\/object\/public\//
const KC_FILE = /-kc\.jpg(\?.*)?$/                  // photos uploaded by this version: they have .t.jpg and .s.jpg copies
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const TF_KEY = 'kc_tf'                              // '1' = image transformations work, '0' = they do not, none = unknown
const SAVER_KEY = 'kc_datasaver'                    // 'on' | 'off' | none (= automatic)

const ls = {
  get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------------------------------------------------
// 1. the network
// ---------------------------------------------------
const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
const speed = { kbps: 0, n: 0 }                      // what we really measured while loading pictures

function connTier() {
  if (!conn) return 'high'
  const t = conn.effectiveType
  if (t === 'slow-2g' || t === '2g') return 'low'
  if (t === '3g') return 'mid'
  if (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 0.7) return 'low'
  if (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 1.6) return 'mid'
  return 'high'
}
function measuredTier() {
  if (speed.n < 3) return null
  if (speed.kbps < 350) return 'low'
  if (speed.kbps < 1400) return 'mid'
  return 'high'
}
const RANK = { low: 0, mid: 1, high: 2 }
let lastTier = ''
export function tier() {
  const pref = ls.get(SAVER_KEY)
  if (pref === 'on') return 'low'
  if (conn && conn.saveData && pref !== 'off') return 'low'
  const a = connTier(), b = measuredTier()
  const t = b && RANK[b] < RANK[a] ? b : a
  if (navigator.onLine === false) return 'low'
  return t
}
function refreshTier() {
  const t = tier()
  document.documentElement.dataset.net = t                      // CSS can react: html[data-net="low"] { ... }
  document.documentElement.classList.toggle('kc-lite', t === 'low')
  if (lastTier && t !== lastTier && typeof window.showmessage === 'function') {
    if (t === 'low') window.showmessage('🐢 Internet ni nke — amafoto ari mu buryo bworoshe (data saver)')
    else if (lastTier === 'low' && t === 'high') window.showmessage('⚡ Internet yongeye kwihuta')
  }
  lastTier = t
  MAX_PARALLEL = t === 'low' ? 2 : t === 'mid' ? 4 : 8
  pump()
}
if (conn && conn.addEventListener) conn.addEventListener('change', refreshTier)
window.addEventListener('online', refreshTier)
window.addEventListener('offline', refreshTier)

// measure real speed from the pictures the page already downloaded
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.initiatorType !== 'img' && e.initiatorType !== 'css' && e.initiatorType !== 'other') continue
      if (!e.transferSize || e.transferSize < 6000 || e.duration < 30) continue            // cache hits and tiny files say nothing
      const kbps = (e.transferSize * 8) / e.duration
      speed.kbps = speed.n ? speed.kbps * 0.7 + kbps * 0.3 : kbps
      speed.n++
    }
    const t = tier()
    if (t !== lastTier) refreshTier()
  }).observe({ type: 'resource', buffered: false })
} catch (e) { /* old browser: we only use the connection type */ }

// ---------------------------------------------------
// 2. which file for which situation
// ---------------------------------------------------
const tfOK = () => ls.get(TF_KEY) !== '0'
const isSupa = (u) => SUPA.test(u || '')
const isKc = (u) => KC_FILE.test(u || '')
function strip(u) { return String(u).split('?')[0] }
function transform(u, w, q) {
  return strip(u).replace('/storage/v1/object/public/', '/storage/v1/render/image/public/') + `?width=${w}&quality=${q}&resize=contain`
}

// returns { tiny, steps[], hd } : tiny = blurry preview, steps = files to try in order, hd = sharp original
// kind: 'feed' (big card) | 'small' (grid square) | 'full' (full screen)
export function plan(url, kind) {
  const t = tier()
  const hd = url
  if (!isSupa(url)) return { tiny: '', steps: [url], hd }
  const u = strip(url)
  if (isKc(u)) {
    const thumb = u + '.t.jpg', tiny = u + '.s.jpg'
    if (kind === 'small') return { tiny, steps: [thumb, u], hd }                         // a grid square never needs more than 640 px
    if (kind === 'full') return { tiny, steps: [t === 'low' ? thumb : u, u], hd }       // weak network: light copy now, HD on demand
    if (t === 'high') return { tiny, steps: [u, thumb], hd }
    return { tiny, steps: [thumb, u], hd }                                              // 3G / 2G / data saver
  }
  // old photos: the original is all we have, unless image transformations work
  if (tfOK() && (t !== 'high' || kind === 'small')) {
    const w = kind === 'small' ? 360 : kind === 'full' ? (t === 'low' ? 720 : 1080) : (t === 'low' ? 480 : 720)
    const q = t === 'low' ? 42 : kind === 'small' ? 55 : 62
    return { tiny: transform(u, 24, 20), steps: [transform(u, w, q), url], hd }
  }
  return { tiny: '', steps: [url], hd }
}
// for code that builds its own <img> (status viewer): the best single file for now
export function pick(url, kind) {
  const p = plan(url, kind || 'full')
  return p.steps[0]
}

// ---------------------------------------------------
// 3. the loader (queue + only when near the screen)
// ---------------------------------------------------
let MAX_PARALLEL = 6
let running = 0
const queue = []

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift()
    running++
    job().finally(() => { running--; pump() })
  }
}
const enqueue = (job, urgent) => { urgent ? queue.unshift(job) : queue.push(job); pump() }

function preload(src) {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.decoding = 'async'
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('img'))
    im.src = src
  })
}

async function loadInto(img) {
  if (img.__kc) return
  img.__kc = 1
  const url = img.dataset.kc
  const kind = img.dataset.kcKind || 'feed'
  const full = kind === 'full'
  const p = plan(url, kind)
  img.classList.add('kc-loading')

  // a) tiny blurry preview first (about 1 KB)
  if (p.tiny) {
    preload(p.tiny).then(() => {
      if (!img.classList.contains('kc-ready')) { img.src = p.tiny; img.classList.add('kc-blur') }
    }).catch(() => { if (p.tiny.includes('/render/image/')) ls.set(TF_KEY, '0') })
  }

  // b) the real picture: try each file in order until one works
  let shown = ''
  for (let i = 0; i < p.steps.length; i++) {
    const src = p.steps[i]
    if (src.includes('/render/image/') && !tfOK()) continue                               // we just learned they do not work
    try {
      await preload(src)
      shown = src
      break
    } catch (e) {
      if (src.includes('/render/image/')) ls.set(TF_KEY, '0')                           // transformations are not available: never try again
    }
  }
  if (!shown) {                                                                        // offline / broken file
    img.classList.remove('kc-loading', 'kc-blur')
    img.classList.add('kc-failed')
    img.__kc = 0
    img.addEventListener('click', () => { if (!img.__kc) { img.classList.remove('kc-failed'); loadInto(img) } }, { once: true })
    return
  }
  if (shown.includes('/render/image/') && ls.get(TF_KEY) == null) ls.set(TF_KEY, '1')
  img.src = shown
  img.classList.remove('kc-blur', 'kc-loading')
  img.classList.add('kc-ready')
  img.dataset.kcShown = shown

  // c) weak network + full screen: offer the sharp version on demand
  if (full && shown !== p.hd && tier() === 'low') addHdButton(img, p.hd)
}

function addHdButton(img, hdUrl) {
  const host = img.parentElement
  if (!host || host.querySelector('.kc-hd')) return
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'kc-hd'
  b.textContent = 'HD'
  b.setAttribute('aria-label', 'Load the sharp photo')
  b.addEventListener('click', async (e) => {
    e.stopPropagation()
    b.classList.add('busy'); b.textContent = '…'
    try { await preload(hdUrl); img.src = hdUrl; b.remove() } catch (err) { b.classList.remove('busy'); b.textContent = 'HD' }
  })
  host.appendChild(b)
}

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return
      io.unobserve(en.target)
      const img = en.target
      if (img.dataset.kcBg) enqueue(() => loadBg(img), true)
      else enqueue(() => loadInto(img), true)
    })
  }, { rootMargin: '300px 0px' })
  : null

function watch(img) {
  if (img.__kcw) return
  img.__kcw = 1
  if (!io) { enqueue(() => loadInto(img)); return }
  io.observe(img)
}

// ---------------------------------------------------
// 4. avatars (background-image): always the small copy
// ---------------------------------------------------
const AV = '.avatar, .s-av, .sv-avatar, .pv-av, .profilepicturee, .g-av, .liker-av, .uc-av'
const URL_IN_STYLE = /url\((['"]?)([^'")]+)\1\)/

let el_big = false
function smallOf(u) {
  if (!isSupa(u)) return u
  const base = strip(u)
  const big = el_big
  if (isKc(base)) return base + (big ? '.t.jpg' : '.a.jpg')
  if (tfOK()) return transform(base, big ? 320 : 128, 60)
  return u
}
async function loadBg(el) {
  const m = URL_IN_STYLE.exec(el.style.backgroundImage || el.dataset.kcBg || '')
  const orig = el.dataset.kcBg || (m && m[2])
  if (!orig) return
  el_big = (el.offsetWidth || 0) > 90
  const small = smallOf(orig)
  try { await preload(small) } catch (e) {
    if (small.includes('/render/image/')) ls.set(TF_KEY, '0')
    try { await preload(orig); el.style.backgroundImage = `url('${orig}')` } catch (e2) { }
    return
  }
  if (small.includes('/render/image/') && ls.get(TF_KEY) == null) ls.set(TF_KEY, '1')
  el.style.backgroundImage = `url('${small}')`
  el.classList.add('kc-av-ready')
}
function optimiseAvatar(el) {
  if (el.__kcA) return
  const bg = el.style && el.style.backgroundImage
  if (!bg) return
  const m = URL_IN_STYLE.exec(bg)
  if (!m || !isSupa(m[2])) return
  el.__kcA = 1
  el.dataset.kcBg = m[2]
  el.style.backgroundImage = ''                                    // the pink silhouette from the CSS shows until the small picture is here
  if (io) io.observe(el); else enqueue(() => loadBg(el))
}

// ---------------------------------------------------
// 5. look at everything that is added to the page
// ---------------------------------------------------
function scan(node) {
  if (node.nodeType !== 1) return
  if (node.matches && node.matches('img[data-kc]')) watch(node)
  if (node.matches && node.matches(AV)) optimiseAvatar(node)
  if (node.querySelectorAll) {
    node.querySelectorAll('img[data-kc]').forEach(watch)
    node.querySelectorAll(AV).forEach(optimiseAvatar)
    if (tier() === 'low') node.querySelectorAll('video[preload="metadata"]').forEach(v => { v.preload = 'none' })   // do not download videos you did not tap
  }
}
const mo = new MutationObserver((list) => {
  for (const m of list) {
    if (m.type === 'childList') m.addedNodes.forEach(scan)
    else if (m.type === 'attributes' && m.target.matches && m.target.matches(AV)) {
      // main.js sets an avatar later with style="background-image:..."
      const el = m.target
      const cur = URL_IN_STYLE.exec(el.style.backgroundImage || '')
      if (cur && isSupa(cur[2]) && cur[2] !== el.dataset.kcBg && !/render\/image|\.(t|a|s)\.jpg/.test(cur[2])) { el.__kcA = 0; optimiseAvatar(el) }
    }
  }
})
function start() {
  refreshTier()
  scan(document.body)
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
}
if (document.body) start(); else document.addEventListener('DOMContentLoaded', start)

// ---------------------------------------------------
// 6. template helper
// ---------------------------------------------------
export function kcImg(url, opts = {}) {
  const cls = opts.cls ? ' ' + opts.cls : ''
  return `<img class="kc-img${cls}" data-kc="${esc(url)}" data-kc-kind="${opts.kind || 'feed'}" src="${BLANK}" alt="${esc(opts.alt || '')}" draggable="false" ${opts.attrs || ''}>`
}

// ---------------------------------------------------
// 7. shrink a photo before it is sent (saves the user's data and the server's)
// ---------------------------------------------------
async function draw(bitmap, maxSide, quality) {
  const r = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * r)), h = Math.max(1, Math.round(bitmap.height * r))
  let c
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h)
  else { c = document.createElement('canvas'); c.width = w; c.height = h }
  const g = c.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h)                      // transparent PNG -> white, not black
  g.drawImage(bitmap, 0, 0, w, h)
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality })
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', quality))
}
// returns { main, thumb, tiny, avatar } (JPEG blobs) or null when the file must be sent as it is (gif, svg, error)
export async function compress(file, opts = {}) {
  try {
    const type = (file && file.type) || ''
    if (!type.startsWith('image/') || /gif|svg/.test(type)) return null
    if (typeof createImageBitmap !== 'function') return null
    let bmp
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch (e) { bmp = await createImageBitmap(file) }
    const maxSide = opts.maxSide || 1440
    const main = await draw(bmp, maxSide, opts.quality || 0.8)
    const thumb = await draw(bmp, opts.thumbSide || 640, 0.66)
    const tiny = await draw(bmp, 24, 0.4)
    const avatar = await draw(bmp, 160, 0.7)
    if (bmp.close) bmp.close()
    if (!main || !main.size) return null
    // a tiny file that got bigger: keep the original quality but still use the new name rules
    return { main, thumb, tiny, avatar }
  } catch (e) { return null }
}
// upload one file with a real progress callback (0..1). Same result shape as supabase upload.
export async function putFile(supabase, bucket, path, blob, contentType, onPct) {
  const { data } = await supabase.auth.getSession()
  const tok = data && data.session && data.session.access_token
  return await new Promise((res, rej) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${supabase.supabaseUrl}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`)
    xhr.setRequestHeader('Authorization', 'Bearer ' + (tok || supabase.supabaseKey))
    xhr.setRequestHeader('apikey', supabase.supabaseKey)
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.setRequestHeader('cache-control', 'max-age=3600')
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onPct) onPct(e.loaded / e.total) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? res({ path }) : rej(new Error('upload failed (' + xhr.status + ') ' + String(xhr.responseText || '').slice(0, 160)))
    xhr.onerror = () => rej(new Error('Failed to fetch'))
    xhr.ontimeout = () => rej(new Error('timeout'))
    xhr.send(blob)
  })
}
// upload main + the two small copies. returns the storage path of the main file (or throws like supabase does)
export async function uploadPhoto(supabase, bucket, folder, file, extraOpts = {}) {
  const onPct = extraOpts.onProgress          // optional: (0..1) while the main file goes up
  const c = await compress(file, extraOpts)
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2)
  if (!c) {
    const ext = ((file.name || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `${folder}/${id}.${ext}`
    if (onPct) { await putFile(supabase, bucket, path, file, file.type, onPct); return { path, type: file.type, compressed: false } }
    const up = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false })
    if (up.error) throw up.error
    return { path: up.data.path, type: file.type, compressed: false }
  }
  const path = `${folder}/${id}-kc.jpg`
  const up = onPct
    ? { data: await putFile(supabase, bucket, path, c.main, 'image/jpeg', onPct) }
    : await supabase.storage.from(bucket).upload(path, c.main, { contentType: 'image/jpeg', upsert: false })
  if (up.error) throw up.error
  // the small copies are a bonus: if they fail the photo still works (the loader falls back)
  await Promise.all([
    supabase.storage.from(bucket).upload(path + '.t.jpg', c.thumb, { contentType: 'image/jpeg', upsert: false }).catch(() => { }),
    supabase.storage.from(bucket).upload(path + '.s.jpg', c.tiny, { contentType: 'image/jpeg', upsert: false }).catch(() => { }),
    supabase.storage.from(bucket).upload(path + '.a.jpg', c.avatar, { contentType: 'image/jpeg', upsert: false }).catch(() => { })
  ])
  return { path: up.data.path, type: 'image/jpeg', compressed: true, saved: Math.max(0, file.size - c.main.size) }
}

// data saver switch, usable from anywhere:  kcDataSaver('on' | 'off' | 'auto')
function setSaver(v) {
  if (v === 'on' || v === 'off') ls.set(SAVER_KEY, v)
  else { try { localStorage.removeItem(SAVER_KEY) } catch (e) { } }
  refreshTier()
}
Object.assign(window, { kcImg, kcPick: pick, kcTier: tier, kcCompress: compress, kcDataSaver: setSaver })
