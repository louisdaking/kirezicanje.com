// =====================================================
// GLOW.JS  (new file)  -  the small bits of JavaScript behind glow.css
//   - cards rise when they scroll into view (once per post)
//   - double tap on a photo = like + big heart (like Instagram)
//   - a burst of little hearts when you like
//   - a wave where you tap
//   - floating hearts behind the login page
// Nothing here is needed for the app to work: if this file fails, the app is
// only a bit less pretty.
// =====================================================

const root = document.documentElement
root.classList.add('kc-js')
const lite = () => root.classList.contains('kc-lite')
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------- helpers ----------
function spawn(cls, x, y, style) {
  const el = document.createElement('div')
  el.className = cls
  el.style.left = x + 'px'
  el.style.top = y + 'px'
  if (style) Object.keys(style).forEach(k => el.style.setProperty(k, style[k]))
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove(), { once: true })
  setTimeout(() => el.remove(), 1600)             // safety
  return el
}
function burst(x, y, n = 7) {
  if (reduce) return
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.6
    const d = 36 + Math.random() * 44
    spawn('kc-mini', x, y, { '--dx': Math.cos(a) * d + 'px', '--dy': Math.sin(a) * d - 24 + 'px', '--r': (Math.random() * 80 - 40) + 'deg' })
  }
}
function bigHeart(x, y) { if (!reduce) spawn('kc-bigheart', x, y) }

// ---------- 1. wave where you tap ----------
document.addEventListener('pointerdown', (e) => {
  if (reduce || lite()) return
  if (!e.target.closest || !e.target.closest('button, .chip, .s-row, .mediawrap, .g-item, a, [onclick]')) return
  spawn('kc-tap', e.clientX, e.clientY)
}, { passive: true })

// ---------- 2. double tap = like ----------
const DOUBLE_MS = 280
let tap = null                                    // { el, x, y, t, timer }
function postIdOf(wrap) {
  const post = wrap.closest('.post')
  return post ? post.id.replace(/^post-/, '') : ''
}
document.addEventListener('click', (e) => {
  const wrap = e.target.closest && e.target.closest('.mediawrap')
  if (!wrap || !wrap.closest('.post')) return
  // we take over the click: one tap opens the post (after a short wait), two taps like it
  e.stopImmediatePropagation()
  e.preventDefault()
  const id = postIdOf(wrap)
  const now = Date.now()
  if (tap && tap.el === wrap && now - tap.t < DOUBLE_MS) {
    clearTimeout(tap.timer)
    tap = null
    like(id, e.clientX, e.clientY)
    return
  }
  tap = {
    el: wrap, t: now,
    timer: setTimeout(() => { tap = null; if (typeof window.openFeedPost === 'function') window.openFeedPost(id) }, DOUBLE_MS)
  }
}, true)

function like(id, x, y) {
  bigHeart(x, y)
  const btn = document.querySelector(`.likebtn[data-post="${CSS.escape(id)}"]`)
  if (btn && !btn.classList.contains('liked') && typeof window.toggleLike === 'function') window.toggleLike(id)
}
// double tap inside the full-screen viewer (the single tap keeps doing what it did)
let vt = 0
document.addEventListener('click', (e) => {
  const stage = e.target.closest && e.target.closest('.pv-stage')
  if (!stage || e.target.closest('button')) return
  const now = Date.now()
  if (now - vt < DOUBLE_MS) {
    vt = 0
    bigHeart(e.clientX, e.clientY)
    const btn = document.querySelector('#pviewer .likebtn')
    if (btn && !btn.classList.contains('liked')) btn.click()
  } else vt = now
}, true)

// ---------- 3. little hearts when a like button turns on ----------
const watchLikes = new MutationObserver((list) => {
  for (const m of list) {
    const el = m.target
    if (!el.classList || !el.classList.contains('likebtn')) continue
    if (el.classList.contains('liked') && !(m.oldValue || '').includes('liked')) {
      const r = el.getBoundingClientRect()
      if (r.width) burst(r.left + r.width / 2, r.top + r.height / 2)
      el.classList.add('kc-pulse')
      setTimeout(() => el.classList.remove('kc-pulse'), 800)
    }
  }
})

// ---------- 4. cards rise once when they appear ----------
const seen = new Set()
const rise = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach(en => {
    if (!en.isIntersecting) return
    rise.unobserve(en.target)
    en.target.classList.add('kc-in')
    if (en.target.id) seen.add(en.target.id)
  })
}, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' }) : null
function reveal(el) {
  if (el.__kcr || reduce) return
  el.__kcr = 1
  if (!rise || (el.id && seen.has(el.id)) || lite()) { return }     // already seen / weak network: no entrance
  el.classList.add('kc-reveal')
  rise.observe(el)
  setTimeout(() => el.classList.add('kc-in'), 2500)                 // safety: never leave a card invisible
}
function scan(node) {
  if (node.nodeType !== 1) return
  if (node.matches && node.matches('.post')) reveal(node)
  if (node.querySelectorAll) node.querySelectorAll('.post').forEach(reveal)
}
const watchAdds = new MutationObserver((list) => list.forEach(m => m.addedNodes.forEach(scan)))

// ---------- 5. floating hearts behind the login page ----------
function buildHearts() {
  const layer = document.createElement('div')
  layer.className = 'kc-hearts'
  layer.setAttribute('aria-hidden', 'true')
  const N = 16
  for (let i = 0; i < N; i++) {
    const h = document.createElement('i')
    const s = 14 + Math.random() * 30
    h.style.cssText = `--x:${(Math.random() * 96).toFixed(1)}%;--s:${s.toFixed(0)}px;--d:${(9 + Math.random() * 9).toFixed(1)}s;--delay:${(-Math.random() * 16).toFixed(1)}s;--sway:${(Math.random() * 60 - 30).toFixed(0)}px;--b:${s < 20 ? 1.5 : 0}px`
    layer.appendChild(h)
  }
  document.body.appendChild(layer)
  const sync = () => {
    const lp = document.getElementById('loginpage')
    const on = lp && getComputedStyle(lp).display !== 'none' && !reduce && !lite()
    layer.style.display = on ? 'block' : 'none'
  }
  const lp = document.getElementById('loginpage')
  if (lp) new MutationObserver(sync).observe(lp, { attributes: true, attributeFilter: ['style', 'class'] })
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] })
  sync()
}

function start() {
  try {
    watchLikes.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
    scan(document.body)
    watchAdds.observe(document.body, { childList: true, subtree: true })
    buildHearts()
  } catch (e) { /* the app works without the sparkle */ }
}
if (document.body) start(); else document.addEventListener('DOMContentLoaded', start)
