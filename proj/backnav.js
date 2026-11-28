// =====================================================================
// KIREZI CANJE - BACK BUTTON (phone "back" / browser back)
//  Back closes the top-most thing first (photo viewer, menus, chat ...),
//  then goes back to the page you were on before, and on the first page
//  it asks "Do you really want to leave?" (Yes / No).
// =====================================================================

const $ = id => document.getElementById(id)
const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.style.display !== 'none'

// ---------- where is the user now (main pages) ----------
function currentPage() {
  if (shown($('searchPage'))) return 'search'
  const st = $('statusPage')
  if (st && st.style.transform === 'scale(1)') return 'status'
  if (shown($('userJournal'))) return 'profile'
  if (shown($('messenger'))) return 'messages'
  if (shown($('allofthem'))) return 'home'
  return null
}

let trail = []                 // pages visited before the current one
let lastPage = null, restoring = false, restoreT = null
let profileUid = null          // which profile is open

function trackPages() {
  const cur = currentPage()
  if (!cur || cur === lastPage) return
  if (!restoring && lastPage) {
    trail.push({ page: lastPage, uid: lastPage === 'profile' ? profileUid : null })
    if (trail.length > 25) trail.shift()
  }
  lastPage = cur
}

function openPage(entry) {
  restoring = true
  clearTimeout(restoreT)
  restoreT = setTimeout(() => { restoring = false; trackPages() }, 900)
  const w = window
  if (entry.page === 'messages' && w.onpenmessages) w.onpenmessages(true)
  else if (entry.page === 'status' && w.openstatus) w.openstatus(true)
  else if (entry.page === 'profile' && w.openuser) w.openuser(entry.uid || undefined)
  else if (entry.page === 'search' && w.openSearch) w.openSearch()
  else if (w.peek) w.peek()
}

// ---------- the "leave?" window ----------
let dlg = null
function buildDialog() {
  const css = document.createElement('style')
  css.textContent = `
  #kcExit { position: fixed; inset: 0; z-index: 9000; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(27,10,23,.62); }
  #kcExit.on { display: flex; }
  #kcExit .box { width: 100%; max-width: 330px; background: #fff; border-radius: 22px; padding: 26px 20px 18px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.4); animation: kcpop .18s ease; font-family: system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
  @keyframes kcpop { from { transform: scale(.9); opacity: 0; } }
  #kcExit .em { width: 64px; height: 64px; margin: 0 auto 12px; border-radius: 50%; background: linear-gradient(135deg,#FF2E93,#FF7A59); display: flex; align-items: center; justify-content: center; font-size: 30px; box-shadow: 0 8px 22px rgba(255,46,147,.4); }
  #kcExit h3 { margin: 0 0 6px; font-size: 20px; font-weight: 800; color: #1B0A17; }
  #kcExit p { margin: 0 0 18px; font-size: 14.5px; color: #8E7284; line-height: 1.4; }
  #kcExit .row { display: flex; gap: 10px; }
  #kcExit button { flex: 1; padding: 14px 8px; border: 0; border-radius: 14px; font: 800 16px system-ui,sans-serif; cursor: pointer; }
  #kcExit .no { background: linear-gradient(135deg,#FF2E93,#FF7A59); color: #fff; box-shadow: 0 6px 18px rgba(255,46,147,.35); }
  #kcExit .yes { background: #FFF1F6; color: #c2185b; }
  #kcExit button small { display: block; font-weight: 600; font-size: 11px; opacity: .85; margin-top: 2px; }`
  document.head.appendChild(css)
  dlg = document.createElement('div')
  dlg.id = 'kcExit'
  dlg.innerHTML = `<div class="box" role="alertdialog" aria-modal="true">
    <div class="em">👋</div>
    <h3>Urashaka gusohoka koko?</h3>
    <p>Do you really want to leave KIREZI CANJE?</p>
    <div class="row">
      <button class="no" type="button" id="kcExitNo">OYA<small>No, stay</small></button>
      <button class="yes" type="button" id="kcExitYes">EGO<small>Yes, leave</small></button>
    </div></div>`
  document.body.appendChild(dlg)
  $('kcExitNo').onclick = hideDialog
  $('kcExitYes').onclick = leave
  dlg.addEventListener('click', e => { if (e.target === dlg) hideDialog() })
}
const dialogOpen = () => dlg && dlg.classList.contains('on')
function showDialog() { if (!dlg) buildDialog(); dlg.classList.add('on') }
function hideDialog() { if (dlg) dlg.classList.remove('on') }

// ---------- history ----------
let armed = false, leaving = false

function arm() { history.pushState({ kc: 'app' }, '') }

function leave() {
  hideDialog()
  leaving = true
  history.go(-1)            // -> popstate on the first entry -> history.back() leaves the app
}

// closes the top-most thing. returns true if it closed something
function closeTop() {
  const w = window
  // install screen
  const im = $('installModal')
  if (im && im.classList.contains('open')) { const b = $('closeInstallBtn'); b && b.click(); return true }
  // payment wall: go back inside it
  const wall = $('pwWall')
  if (wall) { const b = wall.querySelector('#pwBack'); if (b) { b.click(); return true } return false }
  // reel mode
  const rls = $('reels')
  if (rls && rls.style.display === 'block' && w.closeReels) { w.closeReels(); return true }
  // status viewer
  const sv = $('sviewer')
  if (sv && sv.style.display === 'block' && w.closeStatusViewer) { w.closeStatusViewer(); return true }
  // big photo viewer
  const pv = $('pviewer')
  if (pv && pv.style.display && pv.style.display !== 'none') {
    if (w.closePostViewer) w.closePostViewer()
    else { pv.querySelectorAll('video').forEach(v => v.pause()); pv.style.display = 'none'; pv.innerHTML = '' }
    return true
  }
  // Daking AI chat
  if (w.kcAiOpen && w.kcAiOpen()) { w.kcAiClose(); return true }
  // small windows
  if (shown($('sheetModal')) && w.closeSheet) { w.closeSheet(); return true }
  if (shown($('likersModal')) && w.closeLikers) { w.closeLikers(); return true }
  if (shown($('postModal')) && w.closePostModal) { w.closePostModal(); return true }
  if (shown($('galleryPage')) && w.closeGallery) { w.closeGallery(); return true }
  // the little attach menu inside a chat
  const att0 = $('attachmenu')
  if (att0 && att0.style.display === 'flex') { att0.style.display = 'none'; return true }
  // a chat
  const inbox = $('inbox')
  if (inbox && inbox.style.display === 'flex' && w.closeinbox) {
    w.closeinbox(); return true
  }
  // the page before
  if (shown($('navigation')) && lastPage) {
    while (trail.length && trail[trail.length - 1].page === lastPage && lastPage !== 'profile') trail.pop()
    const prev = trail.pop()
    if (prev) { openPage(prev); return true }
    if (lastPage !== 'home') { openPage({ page: 'home' }); return true }
  }
  return false
}

function onPop() {
  if (leaving) {                       // we are on the first entry: really leave now
    leaving = false
    history.back()
    setTimeout(() => {                 // still here (nothing to go back to): stay in the app
      try { window.close() } catch { /* ignore */ }
      arm()
    }, 500)
    return
  }
  if (dialogOpen()) { hideDialog(); arm(); return }          // back pressed while asking = "No"
  const done = closeTop()
  if (!done) showDialog()
  arm()                                // always keep one step in front, so Back stays inside the app
}

export function initBackNav() {
  // remember which profile is open (so Back can come back to it)
  const wrapUser = () => {
    const o = window.openuser
    if (o && !o.__kc) {
      const f = function (id) { profileUid = id || null; return o.apply(this, arguments) }
      f.__kc = true
      window.openuser = f
    }
  }
  setInterval(wrapUser, 1500); wrapUser()

  const mo = new MutationObserver(trackPages)
  ;['allofthem', 'messenger', 'userJournal', 'statusPage', 'searchPage'].forEach(id => { const e = $(id); if (e) mo.observe(e, { attributes: true, attributeFilter: ['style'] }) })
  document.addEventListener('click', () => setTimeout(trackPages, 80), true)

  // browsers only keep a history step that was added after a tap, so we add it at the first tap
  const first = () => {
    if (armed) return
    armed = true
    history.replaceState({ kc: 'base' }, '')
    arm()
  }
  document.addEventListener('pointerup', first, { once: true, capture: true })
  document.addEventListener('keydown', first, { once: true, capture: true })

  window.addEventListener('popstate', (e) => {
    if (!armed) return
    onPop()
  })
}
