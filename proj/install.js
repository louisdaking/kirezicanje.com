import { loadStats, fillStats, mountReviews, registerDownload, who } from './appstore.js'

const openBtn = document.getElementById('openInstallBtn')
const modal = document.getElementById('installModal')
const closeBtn = document.getElementById('closeInstallBtn')
const installBtn = document.getElementById('installBtn')
const installHint = document.getElementById('installHint')
const defaultHint = 'Install on phone. More devices available.'
const appPage = 'app.html'
const ua = navigator.userAgent || ''
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
let deferredPrompt = null
let reviewsMounted = false

function isInstalledApp() {
  let standalone = false
  try {
    standalone = ['standalone', 'fullscreen', 'minimal-ui']
      .some(mode => window.matchMedia(`(display-mode: ${mode})`).matches)
  } catch (error) {
    console.warn('[kirezi] unable to detect installed app mode', error)
  }
  return standalone || window.navigator.standalone === true ||
    (document.referrer || '').startsWith('android-app://') || /; wv\)/i.test(ua)
}

function resetButton() {
  installBtn.disabled = false
  installBtn.innerText = 'INSTALL'
  installBtn.style.opacity = '1'
}

function showHint(text, isTip = false) {
  installHint.innerText = text
  installHint.className = isTip ? 'ios-tip' : ''
}

function closeInstall() {
  modal.classList.remove('open')
  document.body.style.overflow = ''
}

function openInstall() {
  if (isInstalledApp()) return
  resetButton()
  showHint(defaultHint)
  if (isIOS) showHint('To install on iPhone/iPad: tap the Share button, then "Add to Home Screen".', true)
  modal.classList.add('open')
  modal.scrollTop = 0
  document.body.style.overflow = 'hidden'
}

function hideEverything() {
  closeInstall()
  openBtn.style.display = 'none'
}

function openStore() {
  loadStats().then(fillStats).catch(error => console.error('[kirezi] app store stats failed to load', error))
  if (!reviewsMounted) {
    reviewsMounted = true
    mountReviews(document.getElementById('storeReviews'))
  }
}

openBtn.style.display = isInstalledApp() ? 'none' : 'inline-flex'
openBtn.addEventListener('click', openInstall)
openBtn.addEventListener('click', openStore)
closeBtn.addEventListener('click', closeInstall)
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && modal.classList.contains('open')) closeInstall()
})
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault()
  deferredPrompt = event
})
window.addEventListener('appinstalled', () => {
  deferredPrompt = null
  hideEverything()
})

installBtn.addEventListener('click', () => {
  if (deferredPrompt) {
    installBtn.disabled = true
    installBtn.innerText = 'INSTALLING...'
    deferredPrompt.prompt()
    deferredPrompt.userChoice.then(choice => {
      deferredPrompt = null
      if (choice && choice.outcome === 'accepted') {
        if (window.kcRegisterPwa) window.kcRegisterPwa()
        hideEverything()
      } else {
        resetButton()
      }
    }).catch(error => {
      console.error('[kirezi] PWA install prompt failed', error)
      location.href = appPage
    })
    return
  }
  if (isIOS) {
    showHint('Tap the Share button (square with arrow), then choose "Add to Home Screen".', true)
    return
  }
  installBtn.disabled = true
  installBtn.innerText = 'OPENING…'
  location.href = appPage
})

window.kcRegisterPwa = () => {
  const person = who()
  return registerDownload('pwa', person.name, person.phone)
}
