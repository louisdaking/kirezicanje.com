const routes = {
  home: 'index.html',
  messages: 'messages.html',
  status: 'status.html',
  profile: 'profile.html',
  search: 'search.html'
}

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
  await import('./install.js')
  await import('./main.js')
  await import('./glow.js')
}

start().catch(error => {
  console.error('[kirezi] app page failed to start', error)
  document.getElementById('kcShell').textContent = 'KIREZI CANJE could not load. Check your connection and refresh.'
})
