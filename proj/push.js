// =====================================================================
// KIREZI CANJE - notifications on the phone (even when the app is closed)
// =====================================================================
const ASKED_KEY = 'kc_push_asked_at'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}
const sameBytes = (a, b) => !!a && !!b && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i])

// every call to the server carries the login token (the server decides who you are, never the browser)
async function api(supabase, method, body) {
  const { data } = await supabase.auth.getSession()
  const token = data && data.session && data.session.access_token
  if (!token) throw new Error('not logged in')
  const res = await fetch('/api/push', { method, keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.ok === false) throw new Error(j.error || 'server error')
  return j
}

async function getReg() {
  const existing = await navigator.serviceWorker.getRegistration('/push/')
  if (existing) { existing.update().catch(() => {}); return existing }       // always fetch the newest notification worker
  const reg = await navigator.serviceWorker.register('/push/sw.js', { scope: '/push/' })
  if (reg.active) return reg
  await new Promise((res) => {
    const w = reg.installing || reg.waiting
    if (!w) return res()
    w.addEventListener('statechange', () => { if (w.state === 'activated') res() })
    setTimeout(res, 4000)
  })
  return reg
}

// subscribe this phone and tell the server (the public key comes from the server, so it is never copied by hand)
async function subscribeAndSave(supabase, force) {
  const k = await fetch('/api/push').then(r => r.json())
  if (!k || !k.key) throw new Error('notifications are not set up on the server yet')
  const key = b64ToBytes(k.key)
  const reg = await getReg()
  let sub = await reg.pushManager.getSubscription()
  if (sub && (force || !sameBytes(sub.options && sub.options.applicationServerKey, key))) { await sub.unsubscribe(); sub = null }   // key changed or registration dead: subscribe again
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api(supabase, 'POST', { action: 'subscribe', subscription: sub.toJSON() })
  return true
}

export async function enablePush(supabase, say) {
  if (!supported()) { say && say('This phone / browser cannot show notifications. Install the app first.'); return false }
  if (Notification.permission === 'denied') { say && say('Notifications are blocked. Open the browser settings for this site and allow them.'); return false }
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (p !== 'granted') return false
  try {
    await subscribeAndSave(supabase)
    let t = 'none yet'; try { t = localStorage.getItem('kc_last_notify') || t } catch { /* ignore */ }
    let test = ''
    try {
      let r = await api(supabase, 'POST', { action: 'test' })
      const reg = await getReg(), mine = await reg.pushManager.getSubscription()
      let healed = ''
      if (mine && (r.gone || []).includes(mine.endpoint)) {        // THIS phone's registration was dead: make a brand-new one and test again
        await subscribeAndSave(supabase, true)
        r = await api(supabase, 'POST', { action: 'test' })
        healed = ' (this phone was registered again)'
      }
      test = 'test sent to ' + r.phones + ' phone(s), push service says: ' + r.status.join(',') + healed
    } catch (e) { test = 'test failed: ' + (e.message || e) }
    say && say('Notifications are ON 🔔\n' + test + '\nlast action: ' + t)
    return true
  }
  catch (e) { say && say('Notifications failed: ' + (e.message || e)); return false }
}

// when the user logs out: this phone must stop receiving his notifications
export async function disablePush(supabase) {
  try {
    if (!supported()) return
    const reg = await navigator.serviceWorker.getRegistration('/push/')
    const sub = reg && await reg.pushManager.getSubscription()
    if (sub) { await api(supabase, 'POST', { action: 'unsubscribe', endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe() }
  } catch { /* ignore */ }
}

// "I just did something" -> the server checks it and notifies the other person (message, like, follow, call, new account).
// Fire and forget: it never slows down or breaks the app.
export function notifyServer(supabase, event) {
  (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data && data.session && data.session.access_token
      if (!token || !navigator.onLine) return
      const res = await fetch('/api/notify', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(event) })
      const j = await res.json().catch(() => ({}))
      try { localStorage.setItem('kc_last_notify', event.type + ' -> http ' + res.status + ', sent ' + (j.sent == null ? '?' : j.sent) + (j.skipped ? ' (' + j.skipped + ')' : '')) } catch { /* ignore */ }
    } catch { /* ignore */ }
  })()
}

// the people of the other sex are told about a brand-new account (once; the server also checks)
function announceNewUser(supabase) {
  (async () => {
    try {
      const { data } = await supabase.auth.getSession()
      const u = data && data.session && data.session.user
      if (!u || Date.now() - new Date(u.created_at).getTime() > 3 * 86400000) return
      const k = 'kc_announced_' + u.id
      if (localStorage.getItem(k)) return
      localStorage.setItem(k, '1')
      notifyServer(supabase, { type: 'newuser' })
    } catch { /* ignore */ }
  })()
}

// the app is open: phone notifications that are still on the screen are not needed any more
export async function clearShown() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/push/')
    if (!reg) return
    ;(await reg.getNotifications()).forEach(n => n.close())
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearShown() })

// small card (once in a while) asking to turn notifications on
export function initPush(supabase, say) {
  announceNewUser(supabase)
  if (!supported()) return
  clearShown()
  if (Notification.permission === 'granted') { subscribeAndSave(supabase).catch(() => {}); return }   // keep it fresh
  if (Notification.permission === 'denied') return
  const last = Number(localStorage.getItem(ASKED_KEY) || 0)
  if (Date.now() - last < 3 * 24 * 3600 * 1000) return
  setTimeout(() => {
    if (document.getElementById('kcPushAsk') || Notification.permission !== 'default') return
    const css = document.createElement('style')
    css.textContent = `#kcPushAsk{position:fixed;left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:3500;background:#fff;border-radius:20px;padding:16px;box-shadow:0 14px 40px rgba(27,10,23,.28);font-family:system-ui,-apple-system,sans-serif;border:1px solid #F3E1EA;animation:kcup .25s ease}
    @keyframes kcup{from{transform:translateY(30px);opacity:0}}
    #kcPushAsk b{display:block;font-size:16px;color:#1B0A17;margin-bottom:4px}#kcPushAsk p{margin:0 0 12px;font-size:13.5px;color:#8E7284;line-height:1.4}
    #kcPushAsk .r{display:flex;gap:10px}#kcPushAsk button{flex:1;padding:13px;border:0;border-radius:13px;font:800 15px system-ui,sans-serif;cursor:pointer}
    #kcPushAsk .y{background:linear-gradient(135deg,#FF2E93,#FF7A59);color:#fff}#kcPushAsk .n{background:#FFF1F6;color:#c2185b}`
    document.head.appendChild(css)
    const el = document.createElement('div')
    el.id = 'kcPushAsk'
    el.innerHTML = `<b>🔔 Emera notifications</b><p>Menya iyo bagukurikiye, bagukunze canke bakwandikiye, n'iyo app ifunze.<br><small>Get told when someone messages, follows or likes you — even when the app is closed.</small></p>
      <div class="r"><button class="n" type="button">Not now</button><button class="y" type="button">Allow 🔔</button></div>`
    document.body.appendChild(el)
    const close = () => { el.remove(); localStorage.setItem(ASKED_KEY, String(Date.now())) }
    el.querySelector('.n').onclick = close
    el.querySelector('.y').onclick = async () => { close(); await enablePush(supabase, say) }
  }, 9000)
}
