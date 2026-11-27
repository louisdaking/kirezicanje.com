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
    const pageViews = {
      home: 'allofthem',
      messages: 'messenger',
      status: 'statusPage',
      profile: 'userJournal',
      search: 'searchPage'
    }
    const pageView = pageViews[document.body.dataset.page] || pageViews.home
    for (const id of Object.values(pageViews)) {
      if (id !== pageView) shell.getElementById(id)?.remove()
    }
    document.getElementById('kcShell').replaceWith(...shell.body.childNodes)
  }
  await import('./install.js')
  await import('./main.js')
  await import('./glow.js')
}

start().catch(error => {
  console.error('[kirezi] app page failed to start', error)
  document.getElementById('kcShell').textContent = 'KIREZI CANJE could not load. Check your connection and refresh.'
})
