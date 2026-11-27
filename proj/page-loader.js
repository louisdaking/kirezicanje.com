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

async function start() {
  if (routeLegacyUrl()) return
  if (!document.getElementById('kcShell').dataset.snapshotRestored) {
    const response = await fetch('shared-shell.html')
    if (!response.ok) throw new Error(`Shared app shell failed to load (${response.status})`)
    const shell = new DOMParser().parseFromString(await response.text(), 'text/html')
    shell.body.querySelectorAll('script').forEach(script => script.remove())
    // keep every view in the page: main.js looks them all up by id, and each one is hidden by CSS until it is opened
    document.getElementById('kcShell').replaceWith(...shell.body.childNodes)
  }
  // optional parts must never stop the app from starting
  await import('./install.js').catch(error => console.warn('[kirezi] install button failed', error))
  await import('./main.js')
  await import('./glow.js').catch(error => console.warn('[kirezi] glow effects failed', error))
}

function showLoadError() {
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
  document.body.appendChild(box)
}

start().catch(error => {
  console.error('[kirezi] app page failed to start', error)
  window.kcClearPageCache?.()
  showLoadError()
})
