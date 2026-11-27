const routes = {
  home: 'index.html',
  messages: 'messages.html',
  status: 'status.html',
  profile: 'profile.html',
  search: 'search.html'
}
const prefetchedPages = new Set()

function prefetchPage(event) {
  const link = event.target?.closest?.('.navigation a[href]')
  if (!link || navigator.onLine === false || navigator.connection?.saveData) return
  const connection = navigator.connection
  if (connection && /^(slow-2g|2g)$/.test(connection.effectiveType || '')) return
  const url = new URL(link.href, location.href)
  const page = url.pathname.split('/').pop()
  if (url.origin !== location.origin || !Object.values(routes).includes(page) || prefetchedPages.has(page)) return
  if (page === location.pathname.split('/').pop()) return

  prefetchedPages.add(page)
  const hint = document.createElement('link')
  hint.rel = 'prefetch'
  hint.href = url.pathname
  hint.as = 'document'
  document.head.appendChild(hint)
}

document.addEventListener('pointerover', prefetchPage, { passive: true })
document.addEventListener('focusin', prefetchPage)
document.addEventListener('touchstart', prefetchPage, { passive: true })

function routeLegacyUrl() {
  const params = new URLSearchParams(location.search)
  let destination
  if (params.has('chat')) {
    destination = 'messages.html'
  } else if (params.has('user')) {
    destination = 'profile.html'
  } else if (params.has('page')) {
    destination = routes[params.get('page')] || 'index.html'
  }
  if (!destination || destination === location.pathname.split('/').pop()) return false
  params.delete('page')
  location.replace(destination + (params.size ? '?' + params.toString() : '') + location.hash)
  return true
}

// ---------- attractive loading (dating-app look) ----------
const heartSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
function loaderBox(id, text) {
  const box = document.createElement('div')
  box.id = id
  box.className = 'kc-loader'
  box.setAttribute('role', 'status')
  box.innerHTML = `<div class="kc-loader-hearts"><span>${heartSvg}</span><span>${heartSvg}</span></div><b>KIREZI CANJE</b><small>${text || ''}</small><span class="kc-dots"><i></i><i></i><i></i></span>`
  return box
}
// small "please wait" for actions (uploading a photo, ...): const done = kcBusy('text'); ...; done()
window.kcBusy = (text) => {
  const box = loaderBox('kcBusy' + Date.now(), text)
  box.classList.add('kc-busy')
  document.body.appendChild(box)
  let closed = false
  const done = () => { if (closed) return; closed = true; box.classList.add('out'); setTimeout(() => box.remove(), 250) }
  setTimeout(done, 60000)   // never stuck
  return done
}
function showSplash() {
  const shellEl = document.getElementById('kcShell')
  if (shellEl && shellEl.dataset.snapshotRestored) return   // the last screen is already visible
  const box = loaderBox('kcSplash', 'Meet your soulmate')
  document.body.appendChild(box)
  let gone = false
  const hide = () => {
    if (gone) return
    gone = true
    box.classList.add('out')
    setTimeout(() => box.remove(), 350)
  }
  const root = document.documentElement
  const check = () => { if (root.classList.contains('kc-auth-ready')) { setTimeout(hide, 250); return true } return false }
  if (!check()) {
    const mo = new MutationObserver(() => { if (check()) mo.disconnect() })
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
  }
  setTimeout(hide, 12000)   // failsafe
  window.kcHideSplash = hide
}

async function start() {
  showSplash()
  if (routeLegacyUrl()) return
  if (!document.getElementById('kcShell').dataset.snapshotRestored) {
    const response = await fetch('shared-shell.html')
    if (!response.ok) throw new Error(`Shared app shell failed to load (${response.status})`)
    const shell = new DOMParser().parseFromString(await response.text(), 'text/html')
    shell.body.querySelectorAll('script').forEach(script => script.remove())
    // keep every view in the page: main.js looks them all up by id, and each one is hidden by CSS until it is opened
    const host = document.getElementById('kcShell')
    host.style.display = 'contents'   // wrapper stays in the page (page-cache saves it) but does not affect layout
    host.replaceChildren(...shell.body.childNodes)
  }
  // optional parts must never stop the app from starting
  await import('./install.js').catch(error => console.warn('[kirezi] install button failed', error))
  await import('./main.js')
  await import('./glow.js').catch(error => console.warn('[kirezi] glow effects failed', error))
}

function showLoadError(error) {
  window.kcHideSplash?.()
  if (document.getElementById('kcLoadError')) return
  const box = document.createElement('div')
  box.id = 'kcLoadError'
  box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background:#1B0A17;color:#fff;font:600 16px system-ui,sans-serif'
  box.innerHTML = '<div>KIREZI CANJE could not load.<br>Check your connection and try again.</div>'
  const btn = document.createElement('button')
  btn.textContent = 'Try again'
  btn.style.cssText = 'padding:12px 28px;border:0;border-radius:999px;background:linear-gradient(135deg,#FF2E93,#FF7A59);color:#fff;font:800 16px system-ui,sans-serif'
  btn.onclick = () => { window.kcClearPageCache?.(); location.reload() }
  box.appendChild(btn)
  const detail = document.createElement('small')
  detail.style.cssText = 'max-width:320px;opacity:.6;font:12px monospace;word-break:break-word'
  detail.textContent = String(error && error.message || error || '')
  box.appendChild(detail)
  document.body.appendChild(box)
}

start().catch(error => {
  console.error('[kirezi] app page failed to start', error)
  window.kcClearPageCache?.()
  showLoadError(error)
})
