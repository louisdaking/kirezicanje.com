// =====================================================================
// KIREZI CANJE - notifications on the phone (even when the app is closed)
// =====================================================================
const VAPID_PUBLIC_KEY = 'BAfOMyhz3lLo8WKSnqmwHoOgtBx0-1i4hlM_ulbqCbmM8-9YlwCCfRWiMt6QmUdHc6aijDFRk2E3XU-SN70tGTM'
const ASKED_KEY = 'kc_push_asked_at'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}
const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function getReg() {
  const existing = await navigator.serviceWorker.getRegistration('/push/')
  if (existing) return existing
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

// subscribe this phone and tell Supabase
async function subscribeAndSave(supabase) {
  const reg = await getReg()
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) })
  const j = sub.toJSON()
  const { error } = await supabase.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth })
  if (error) throw error
  return true
}

export async function enablePush(supabase, say) {
  if (!supported()) { say && say('This phone / browser cannot show notifications. Install the app first.'); return false }
  if (Notification.permission === 'denied') { say && say('Notifications are blocked. Open the browser settings for this site and allow them.'); return false }
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (p !== 'granted') return false
  try { await subscribeAndSave(supabase); say && say('Notifications are ON 🔔'); return true }
  catch (e) { say && say('Notifications failed: ' + (e.message || e)); return false }
}

// when the user logs out: this phone must stop receiving his notifications
export async function disablePush(supabase) {
  try {
    if (!supported()) return
    const reg = await navigator.serviceWorker.getRegistration('/push/')
    const sub = reg && await reg.pushManager.getSubscription()
    if (sub) { await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); await sub.unsubscribe() }
  } catch { /* ignore */ }
}

// small card (once in a while) asking to turn notifications on
export function initPush(supabase, say) {
  if (!supported()) return
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
