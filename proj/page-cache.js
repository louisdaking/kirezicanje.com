const CACHE_PREFIX = 'kc-page-snapshot:v3:'
const shell = document.getElementById('kcShell')

if (document.documentElement.style) document.documentElement.style.backgroundColor = '#1B0A17'
if (document.body) document.body.style.backgroundColor = '#1B0A17'

function cacheKey() {
  const url = new URL(location.href)
  url.searchParams.sort()
  return CACHE_PREFIX + url.pathname + url.search
}

function currentUserId() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue
      const session = JSON.parse(localStorage.getItem(key) || 'null')
      if (session?.user?.id) return session.user.id
    }
  } catch (error) {
    console.warn('[kirezi] unable to identify page snapshot owner', error)
  }
  return null
}

function restorePage() {
  try {
    const saved = sessionStorage.getItem(cacheKey())
    if (!saved || !shell) return
    const snapshot = JSON.parse(saved)
    const userId = currentUserId()
    if (!userId || snapshot.userId !== userId || typeof snapshot.html !== 'string') {
      sessionStorage.removeItem(cacheKey())
      return
    }
    shell.innerHTML = snapshot.html
    const controls = [...shell.querySelectorAll('input, textarea, select')]
      .filter(control => control.type !== 'password' && control.type !== 'file')
    controls.forEach((control, index) => {
      const state = snapshot.controls?.[index]
      if (!state) return
      control.value = state.value
      if ('checked' in control) control.checked = state.checked
      if (control.tagName === 'SELECT') control.selectedIndex = state.selectedIndex
    })
    const elements = shell.querySelectorAll('*')
    snapshot.scroll?.forEach(([index, top]) => {
      if (elements[index]) elements[index].scrollTop = top
    })
    if (window.scrollTo && Number.isFinite(snapshot.scrollY)) window.scrollTo(0, snapshot.scrollY)
    shell.dataset.snapshotRestored = 'true'
  } catch (error) {
    console.warn('[kirezi] unable to restore page snapshot', error)
  }
}

function savePage() {
  if (!document.documentElement.classList.contains('kc-has-session') || !shell) return
  try {
    const userId = currentUserId()
    if (!userId) return
    const controls = [...shell.querySelectorAll('input, textarea, select')]
      .filter(control => control.type !== 'password' && control.type !== 'file')
      .map(control => ({
        value: control.value,
        checked: 'checked' in control ? control.checked : undefined,
        selectedIndex: control.tagName === 'SELECT' ? control.selectedIndex : undefined
      }))
    const scroll = [...shell.querySelectorAll('*')]
      .map((element, index) => element.scrollTop ? [index, element.scrollTop] : null)
      .filter(Boolean)
    const snapshotShell = shell.cloneNode(true)
    const welcome = snapshotShell.querySelector('#kcWelcome')
    if (welcome) {
      welcome.hidden = true
      welcome.classList.remove('open')
      welcome.setAttribute('aria-hidden', 'true')
    }
    sessionStorage.setItem(cacheKey(), JSON.stringify({
      userId,
      html: snapshotShell.innerHTML,
      controls,
      scroll,
      scrollY: window.scrollY
    }))
  } catch (error) {
    console.warn('[kirezi] unable to save page snapshot', error)
  }
}

window.kcClearPageCache = () => {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('kc-page-snapshot:')) sessionStorage.removeItem(key)
    }
  } catch (error) {
    console.warn('[kirezi] unable to clear page snapshots', error)
  }
}

restorePage()
window.addEventListener('pagehide', savePage)
window.addEventListener('beforeunload', savePage)
document.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePage()
})

document.addEventListener?.('click', (event) => {
  const link = event.target?.closest?.('a[href]')
  if (!link) return
  const destination = new URL(link.href, location.href)
  if (destination.origin !== location.origin) return
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  savePage()
})
