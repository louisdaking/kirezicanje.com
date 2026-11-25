

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { initSocial } from './social.js'
import { initCalls } from './calls.js'
import { uploadPhoto, compress } from './imgload.js'   // blur-up loading, data saver, smaller uploads   // search, gallery, full-screen viewer, user chooser, likes
import { offlineFetch, setCacheUser, clearOfflineCache, forceFresh, outbox, jobs, isNetworkError, savedSession, stale, initConnectionBar, registerServiceWorker } from './offline.js'   // works without internet
import { initPush, enablePush, disablePush } from './push.js'   // notifications when the app is closed
import { initBackNav } from './backnav.js'   // phone Back button: closes things, goes back, asks before leaving
import { trackProfile } from './track.js'   // creator monetization: counts genuine profile visits (server decides what counts)
const SUPABASE_URL = "https://sdzdfzhmomfocsvlddli.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkemRmemhtb21mb2NzdmxkZGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNDE4OTQsImV4cCI6MjA4NDgxNzg5NH0.vk0KP5FZwesUqm86MgHep3VZCClIgIGEwyU_2Y0L8X4";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: offlineFetch } })
const profileCache = {}   // user id -> profile row (so a chat header can be drawn instantly)

// =====================================================
// UNREAD / READ SYSTEM + OFFLINE OUTBOX (module level)
// =====================================================
let watcher = null, watcherUser = null, watcherHooks = null, badgeTimer = null, flushing = false
let callClient = null
let onBackOnlineHandler = null
let openUrlHandler = null
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'kc-open' && openUrlHandler) openUrlHandler(e.data.url) })
const pendingReads = new Set()

function setBadge(n) {
  const el = document.getElementById('navBadge')
  if (el) { el.textContent = n > 99 ? '99+' : String(n); el.classList.toggle('on', n > 0) }
  try { if (navigator.setAppBadge) { if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge() } } catch { /* not supported */ }
}
// number of unread messages, shown on the messages button (visible from every screen)
function refreshBadge() {
  clearTimeout(badgeTimer)
  badgeTimer = setTimeout(async () => {
    if (!watcherUser) return
    const { data: rows, error } = await supabase.from('message').select('sender_id').eq('receiver_id', watcherUser).is('read_at', null)
    if (!error && rows) setBadge(rows.length)
  }, 250)
}
// tells the server "I read everything from this person"
async function markRead(other) {
  const { error } = await supabase.rpc('mark_read', { p_other: other })
  if (error) { pendingReads.add(other); return }
  pendingReads.delete(other)
  refreshBadge()
}
// sends the waiting messages (every message is saved on the phone first, then sent in the background)
async function flushOutbox() {
  if (flushing || !navigator.onLine || !watcherUser) return
  flushing = true
  let sentAny = false
  try {
    for (;;) {
      const it = outbox.all().find(i => i.sender_id === watcherUser)
      if (!it) break
      const { tries, ...row } = it
      // a message that waited a long time keeps the time it was written; a fresh one gets the server time
      if (Date.now() - new Date(it.created_at).getTime() < 30000) delete row.created_at
      const { error } = await supabase.from('message').insert([row])
      if (!error) queuePush({ type: 'message', client_id: row.client_id })
      if (error && error.code !== '23505') {
        if (isNetworkError(error)) break                          // no internet: it stays, with the clock 🕓
        console.error('[kirezi] message not sent', error)
        if (outbox.bump(it.client_id) >= 8) { outbox.remove(it.client_id); showmessage('Message yanse kuza. Ongera uyandike.'); sentAny = true; continue }
        break
      }
      outbox.remove(it.client_id); sentAny = true
    }
  } finally { flushing = false }
  if (sentAny && watcherHooks) watcherHooks.afterFlush()
  await runJobs()
}
function stopWatcher() {
  if (watcher) { supabase.removeChannel(watcher); watcher = null }
  watcherUser = null; watcherHooks = null
  setCacheUser(null)
  setBadge(0)
}
// listens to ALL new messages for me (not only the open chat)
function startMessageWatcher(me, hooks) {
  watcherHooks = hooks
  if (watcher && watcherUser === me) return
  if (watcher) supabase.removeChannel(watcher)
  watcherUser = me
  if (!window.__kcRetry) window.__kcRetry = setInterval(() => { if (watcherUser && navigator.onLine && (outbox.all().length || jobs.list().length)) flushOutbox() }, 12000)
  let t = null
  watcher = supabase.channel('kc-global-' + me)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message', filter: `receiver_id=eq.${me}` }, (payload) => {
      const m = payload.new
      if (!watcherHooks) return
      if (!watcherHooks.chatOpenWith(m.sender_id)) {
        const p = profileCache[m.sender_id]
        showmessage('new message' + (p ? ' from ' + p.full_name : '') + ' :\n' + (m.audio_url ? '🎤 Voice message' : m.file_url ? '📎 ' + (m.file_name || 'File') : m.content))
      }
      watcherHooks.incoming(m)
      refreshBadge()
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me}` }, (payload) => {
      const n = payload.new
      showmessage((n.title || 'KIREZI CANJE') + (n.body ? '\n' + n.body : ''))     // his name + what he did
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'message', filter: `sender_id=eq.${me}` }, (payload) => {
      const m = payload.new
      if (!watcherHooks || !m.read_at) return
      clearTimeout(t)
      t = setTimeout(() => {         // someone read my messages: update the ticks
        if (watcherHooks.chatOpenWith(m.receiver_id)) watcherHooks.openChat(m.receiver_id)
        watcherHooks.myMessageRead(m)
      }, 300)
    })
    .subscribe()
}

// what was done without internet is sent by these, one by one, when the internet is back
const safeName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_')
jobs.on('post', async (p, blob) => {
  let path, type = p.type
  if ((p.type || '').startsWith('image/')) {
    // the photo is made smaller first (and gets a light copy + a tiny preview), so it loads fast for everybody
    const r = await uploadPhoto(supabase, 'posts', p.user_id, blob)
    path = r.path; type = r.type
  } else {
    path = `${p.user_id}/${crypto.randomUUID()}-${safeName(p.name)}`
    const up = await supabase.storage.from('posts').upload(path, blob, { contentType: p.type, upsert: false })
    if (up.error) throw up.error
    path = up.data.path
  }
  const { data: url } = supabase.storage.from('posts').getPublicUrl(path)
  const ins = await supabase.from('posts').insert([{ user_id: p.user_id, kind: p.kind, media_url: url.publicUrl, media_type: type, caption: p.caption || null }])
  if (ins.error) throw ins.error
})
jobs.on('chatfile', async (p, blob) => {
  if ((p.type || '').startsWith('image/')) {          // a photo in a chat: smaller file, same look
    const c = await compress(blob, { maxSide: 1280, quality: 0.78 })
    if (c && c.main.size < blob.size) { blob = c.main; p = { ...p, type: 'image/jpeg', name: safeName(p.name).replace(/\.[^.]+$/, '') + '.jpg', size: c.main.size } }
  }
  const path = `${p.sender_id}/${crypto.randomUUID()}-${safeName(p.name)}`
  const up = await supabase.storage.from('files').upload(path, blob, { contentType: p.type || 'application/octet-stream', upsert: false })
  if (up.error) throw up.error
  const { data: url } = supabase.storage.from('files').getPublicUrl(up.data.path)
  const ins = await supabase.from('message').insert([{ client_id: p.client_id, sender_id: p.sender_id, receiver_id: p.receiver_id,
    content: (p.type || '').startsWith('image/') ? '📷 Photo' : '📎 ' + p.name, file_url: url.publicUrl, file_name: p.name, file_type: p.type, file_size: p.size }])
  if (ins.error && ins.error.code !== '23505') throw ins.error
  if (!ins.error) queuePush({ type: 'message', client_id: p.client_id })
})
jobs.on('voice', async (p, blob) => {
  const path = `${p.sender_id}/${crypto.randomUUID()}.${p.ext}`
  const up = await supabase.storage.from('voices').upload(path, blob, { contentType: p.mime, upsert: false })
  if (up.error) throw up.error
  const { data: url } = supabase.storage.from('voices').getPublicUrl(up.data.path)
  vpState[url.publicUrl] = { status: 'done', pct: 1, blobUrl: URL.createObjectURL(blob) }     // the sender plays it without downloading again
  const ins = await supabase.from('message').insert([{ client_id: p.client_id, sender_id: p.sender_id, receiver_id: p.receiver_id, content: '🎤 Voice message', audio_url: url.publicUrl }])
  if (ins.error && ins.error.code !== '23505') throw ins.error
  if (!ins.error) queuePush({ type: 'message', client_id: p.client_id })
})
async function runJobs() {
  if (!watcherUser) return
  const done = await jobs.run(watcherUser)
  if (done.length && watcherHooks) watcherHooks.afterJobs(done)
}

initConnectionBar(() => { if (onBackOnlineHandler) onBackOnlineHandler() })
registerServiceWorker()
initBackNav()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !watcherHooks) return
  const id = watcherHooks.currentChat()
  if (id) watcherHooks.openChat(id)     // reloads the chat and marks it as read
  refreshBadge()
  flushOutbox()
})

// ---------- settings you can change ----------
const PHONE_MIN = 8, PHONE_MAX = 12      // phone number length
const PASS_MIN = 6                       // password length
const MIN_AGE = 18, MAX_AGE = 100        // allowed age
const STATUS_IMAGE_MS = 5000             // a photo status stays 5 seconds, then goes to the next one
const STATUS_VIDEO_MAX_MS = 30000        // a video status plays to its end (max 30 seconds)

// ---------- small helpers ----------
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function fmtClock(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtTime(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return fmtClock(iso)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'ejo hahise'
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}
function fmtSize(n) {
  if (!n) return ''
  return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB'
}
function setNav(name) {
  document.querySelectorAll('.divi button').forEach(b => b.classList.remove('active'))
  if (name) {
    const b = document.querySelector('.divi .' + name)
    if (b) b.classList.add('active')
  }
}
function search() { showmessage('Search is coming soon') }
window.search = search

// show a preview of the chosen profile picture on the sign-up form
const picInput = document.getElementById('profilepic')
if (picInput) {
  picInput.addEventListener('change', () => {
    const f = picInput.files[0]
    if (f) picInput.style.backgroundImage = `url('${URL.createObjectURL(f)}')`
  })
}

// phone: digits only, never more than PHONE_MAX
const phoneInput = document.getElementById('email')
if (phoneInput) {
  phoneInput.addEventListener('input', () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, PHONE_MAX)
  })
}

// eye button: show / hide the password
const eyeBtn = document.getElementById('eyebtn')
if (eyeBtn) {
  eyeBtn.addEventListener('click', () => {
    const pw = document.getElementById('password')
    const show = pw.type === 'password'
    pw.type = show ? 'text' : 'password'
    eyeBtn.classList.toggle('on', show)
    eyeBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
  })
}

function hideHTML(ID) {
  document.getElementById(ID).style.display = 'none'
} window.hideHTML = hideHTML

function showHTML(ID) {
  document.getElementById(ID).style.display = 'flex'
} window.showHTML = showHTML

function getidSvalue(ID) {
  return document.getElementById(ID).value
};
window.getidSvalue = getidSvalue

let notifTimer = null
function showmessage(text) {
  showHTML('animation')
  document.getElementById('not_mess').textContent = text
  clearTimeout(notifTimer)
  notifTimer = setTimeout(() => hideHTML('animation'), 4000)
}
async function requestPush(event) {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session) return
  const response = await fetch('/api/notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + data.session.access_token
    },
    body: JSON.stringify(event)
  })
  let result = {}
  try { result = await response.json() } catch { /* handled as an API response error below */ }
  if (!response.ok) throw new Error(result.error || 'Notification delivery failed')
  return result
}
async function requestCallInvite(invite) {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (!data.session) throw new Error('Please sign in again before calling.')
  const response = await fetch('/api/call-signal', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + data.session.access_token
    },
    body: JSON.stringify(invite)
  })
  let result = {}
  try { result = await response.json() } catch { /* handled as an API response error below */ }
  if (!response.ok) throw new Error(result.error || 'Could not deliver the call invitation.')
  return result
}
function queuePush(event) {
  requestPush(event).catch(error => console.error('[kirezi] push notification failed', error))
}

// ---------- developer errors go to the console only (users never see them) ----------
window.addEventListener('error', (e) => { console.error('[kirezi]', e.message, e.error) })
window.addEventListener('unhandledrejection', (e) => {
  console.error('[kirezi]', e.reason && e.reason.message ? e.reason.message : e.reason)
  e.preventDefault()
})
window.alert = function (msg) { showmessage(String(msg)) }
// a technical error (Supabase, network...) is written in the console; the user only gets a short friendly line
function softError(err, where) {
  console.error('[kirezi]', where || '', err)
  showmessage(!navigator.onLine || isNetworkError(err) ? 'Nta internet. Bizoherezwa internet nigaruka.' : 'Habaye ikibazo. Ongera ugerageze.')
}
window.softError = softError
function authError(err) {
  const m = String((err && err.message) || '')
  console.error('[kirezi]', m)
  if (/invalid login/i.test(m)) showmessage('Nimero canke password si byo')
  else if (/already registered|already exists/i.test(m)) showmessage('Iyi nimero yamaze kwiyandikisha. Injira.')
  else if (/password/i.test(m) && /(least|short|weak)/i.test(m)) showmessage('Password igomba kuba ndende (byibuze inyuguti 6)')
  else softError(err, 'auth')
}

// grey placeholders (only if there is nothing saved yet): no loading screen
const skelCards = (n) => Array.from({ length: n }, () => `<div class="post skel"><div class="userinfos"><span class="sk-av"></span><div style="flex:1"><i class="sk-l w40"></i><i class="sk-l w25"></i></div></div><div class="sk-media"></div></div>`).join('')
const skelRows = (n) => Array.from({ length: n }, () => `<div class="user skel"><span class="sk-av"></span><div class="umid"><i class="sk-l w50"></i><i class="sk-l w70"></i></div></div>`).join('')

// the fresh copy arrived in the background: the screen you are on updates quietly
let freshHandler = null, freshTimer = null
const freshKeys = new Set()
window.addEventListener('kc-fresh', (e) => {
  if (e.detail && e.detail.url) freshKeys.add(e.detail.url)
  clearTimeout(freshTimer)
  freshTimer = setTimeout(() => { const keys = [...freshKeys]; freshKeys.clear(); if (freshHandler) freshHandler(keys) }, 350)
})
// somebody is already logged in: show the app at once, not the login page
if (savedSession()) document.documentElement.classList.add('kc-has-session')

function waitAsec(values) {
  showHTML('loading')
  if (values) {
    hideHTML('loading')
  }
}

// ---------- helpers for voice messages ----------
function vpBars(seedStr) {
  // deterministic pseudo-random "waveform" so each voice message keeps its own look
  let h = 2166136261
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) }
  let out = ''
  for (let i = 0; i < 38; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)
    const r = ((h >>> 0) % 1000) / 1000
    const height = 18 + Math.round(r * 82)
    out += `<i style="height:${height}%"></i>`
  }
  return out
}

function messageBodyHTML(m, cls) {
  if (m.audio_url) {
    return `
<div class="vp idle" data-url="${m.audio_url}">
  <audio preload="auto"></audio>
  <button class="vp-play" onclick="vpToggle(this)">
    <svg class="ic-dl" viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>
    <svg class="ic-ring" viewBox="0 0 40 40"><circle class="ring-bg" cx="20" cy="20" r="17"/><circle class="ring-fg" cx="20" cy="20" r="17"/></svg>
    <svg class="ic-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>
    <svg class="ic-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    <svg class="ic-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
  </button>
  <div class="vp-main">
    <div class="vp-wave" onpointerdown="vpWaveDown(event,this)">${vpBars(m.audio_url)}<b class="vp-dot"></b></div>
    <div class="vp-meta">
      <span class="vp-time">--:--</span>
      <button class="vp-speed" onclick="vpSpeed(this)">1x</button>
    </div>
  </div>
</div>`
  }
  if (m.file_url) {
    const type = m.file_type || ''
    if (type.startsWith('image/')) {
      return window.kcImg(m.file_url, { cls: 'chatimg', kind: 'feed', attrs: `onclick="window.open('${esc(m.file_url)}','_blank')"` })
    }
    if (type.startsWith('video/')) {
      return `<video class="chatimg" src="${esc(m.file_url)}" controls preload="metadata" playsinline></video>`
    }
    return `<a class="filecard" href="${esc(m.file_url)}" target="_blank" rel="noopener" download="${esc(m.file_name || '')}">
    <span class="fileic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg></span>
    <span class="fileinfo"><b>${esc(m.file_name || 'File')}</b><small>${fmtSize(m.file_size)}</small></span>
  </a>`
  }
  return `<p class="${cls}">${esc(m.content)}</p>`
}

function pendingVoiceHTML() {
  // a sent voice message that is still uploading: the button itself shows the progress ring
  return `
<div class="vp downloading" data-pending="1">
  <button class="vp-play" type="button">
    <svg class="ic-ring spin" viewBox="0 0 40 40"><circle class="ring-bg" cx="20" cy="20" r="17"/><circle class="ring-fg" cx="20" cy="20" r="17" style="stroke-dasharray:106.8;stroke-dashoffset:80"/></svg>
    <svg class="ic-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>
  </button>
  <div class="vp-main">
    <div class="vp-wave">${vpBars('pending' + Date.now())}</div>
    <div class="vp-meta"><span class="vp-time">--:--</span></div>
  </div>
</div>`
}

// ---------- voice message player (download first, then play) ----------
const vpState = {}          // url -> { status: 'idle'|'loading'|'done'|'fail', pct, blobUrl, controller }
const RING = 2 * Math.PI * 17

function vpFmt(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return m + ':' + (r < 10 ? '0' : '') + r
}
function vpAudio(el) { return el.closest('.vp').querySelector('audio') }

async function vpDownload(url, manual) {
  const st = vpState[url] = vpState[url] || { status: 'idle', pct: 0 }
  if (st.status === 'loading' || st.status === 'done') return
  st.status = 'loading'
  st.pct = 0
  st.controller = new AbortController()
  vpRefresh(url)
  try {
    const res = await fetch(url, { signal: st.controller.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const total = Number(res.headers.get('content-length')) || 0
    let blob
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader()
      const chunks = []
      let got = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.length
        st.pct = total ? got / total : -1
        vpRefresh(url)
      }
      blob = new Blob(chunks, { type: res.headers.get('content-type') || '' })
    } else {
      blob = await res.blob()
    }
    st.blobUrl = URL.createObjectURL(blob)
    st.status = 'done'
  } catch (e) {
    if (e.name === 'AbortError') {
      st.status = 'idle'
    } else {
      st.status = 'fail'
      if (manual) showmessage('nta internet — tap to retry')
    }
  }
  vpRefresh(url)
}

function vpRefresh(url) {
  const st = vpState[url]
  document.querySelectorAll('.vp').forEach(box => {
    if (box.dataset.url !== url) return
    const a = box.querySelector('audio')
    if (st && st.status === 'done' && a.getAttribute('src') !== st.blobUrl) a.src = st.blobUrl
    vpUI(a)
  })
}

function vpUI(a) {
  const box = a.closest('.vp')
  const st = vpState[box.dataset.url] || { status: 'idle' }
  const ready = st.status === 'done'
  const loading = st.status === 'loading'

  box.classList.toggle('ready', ready)
  box.classList.toggle('downloading', loading)
  box.classList.toggle('idle', !ready && !loading)
  box.classList.toggle('playing', ready && !a.paused)

  // download ring
  const fg = box.querySelector('.ring-fg')
  const ring = box.querySelector('.ic-ring')
  const unknown = loading && st.pct < 0
  ring.classList.toggle('spin', unknown)
  fg.style.strokeDasharray = RING
  fg.style.strokeDashoffset = unknown ? RING * 0.75 : RING * (1 - Math.max(0.04, st.pct || 0))

  const dur = ready && isFinite(a.duration) ? a.duration : 0
  const ratio = dur ? Math.min(1, a.currentTime / dur) : 0
  const bars = box.querySelectorAll('.vp-wave i')
  const lit = Math.round(ratio * bars.length)
  bars.forEach((b, i) => b.classList.toggle('on', i < lit))
  box.querySelector('.vp-dot').style.left = (ratio * 100) + '%'

  const t = box.querySelector('.vp-time')
  if (!ready) t.textContent = '--:--'
  else {
    const showTotal = a.paused && a.currentTime === 0
    t.textContent = vpFmt(showTotal ? dur : a.currentTime)
  }
}

function vpToggle(btn) {
  if (btn.closest('.vp').dataset.pending) return
  const a = vpAudio(btn)
  const box = a.closest('.vp')
  const url = box.dataset.url
  const st = vpState[url] || { status: 'idle' }

  // not downloaded yet: tap = download, tap again while downloading = cancel
  if (st.status === 'idle' || st.status === 'fail') { vpDownload(url, true); return }
  if (st.status === 'loading') { st.controller.abort(); return }

  // downloaded: play / pause
  if (!a.paused) { a.pause(); return }
  // only one voice message plays at a time
  document.querySelectorAll('.vp audio').forEach(o => { if (o !== a) o.pause() })
  a.play().catch(() => showmessage('cannot play this audio'))
}

function vpSeekFromEvent(e, wave) {
  const box = wave.closest('.vp')
  if (!box.classList.contains('ready')) return
  const a = vpAudio(wave)
  if (!isFinite(a.duration)) return
  const rect = wave.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  a.currentTime = ratio * a.duration
  vpUI(a)
}
function vpWaveDown(e, wave) {
  vpSeekFromEvent(e, wave)
  wave.setPointerCapture(e.pointerId)
  wave.onpointermove = (ev) => vpSeekFromEvent(ev, wave)
  wave.onpointerup = wave.onpointercancel = () => { wave.onpointermove = null }
}
function vpSpeed(btn) {
  const a = vpAudio(btn)
  const speeds = [1, 1.5, 2]
  const next = speeds[(speeds.indexOf(a.playbackRate) + 1) % speeds.length]
  a.playbackRate = next
  btn.textContent = next + 'x'
}

// called after the chat is drawn: reuse downloaded audio, auto-download the rest
function vpInitAll() {
  document.querySelectorAll('.vp').forEach(box => {
    if (box.dataset.pending) return
    vpRefresh(box.dataset.url)
  })
}

// internet is back: retry failed downloads automatically
window.addEventListener('online', () => {
  Object.keys(vpState).forEach(u => { if (vpState[u].status === 'fail') vpDownload(u, false) })
})

window.vpToggle = vpToggle
window.vpWaveDown = vpWaveDown
window.vpSpeed = vpSpeed

// audio events do not bubble, so listen in the capture phase
;['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'seeked', 'error'].forEach(evt => {
  document.addEventListener(evt, (e) => {
    const a = e.target
    if (!(a instanceof HTMLAudioElement) || !a.closest('.vp')) return
    const box = a.closest('.vp')
    // recorded webm often reports Infinity duration: force the browser to compute it
    if (evt === 'loadedmetadata' && a.duration === Infinity) {
      a.currentTime = 1e101
      a.addEventListener('timeupdate', function fix() {
        a.removeEventListener('timeupdate', fix)
        a.currentTime = 0
      })
    }
    if (evt === 'ended') a.currentTime = 0
    if (evt === 'error' && a.getAttribute('src')) {
      // the downloaded file is not playable: forget it so the user can download again
      delete vpState[box.dataset.url]
      a.removeAttribute('src')
      showmessage('audio not available')
    }
    vpUI(a)
  }, true)
})

// =====================================================
// FEED ALGORITHM
// =====================================================
// people I have talked to -> how many messages we exchanged
async function getTalkedMap(me) {
  const map = {}
  const { data: rows, error } = await supabase
    .from('message')
    .select('sender_id, receiver_id')
    .or(`sender_id.eq.${me},receiver_id.eq.${me}`)
  if (error || !rows) return map
  rows.forEach(r => {
    const other = r.sender_id === me ? r.receiver_id : r.sender_id
    map[other] = (map[other] || 0) + 1
  })
  return map
}

// bigger score = higher in the feed
// who sees whom first: boys/men see ALL girls/women first, girls/women see ALL boys/men first
function sexGroup(sex) {
  const x = String(sex || '').trim().toLowerCase()
  if (x === 'umuhungu' || x === 'umugabo') return 'm'
  if (x === 'umukobwa' || x === 'umugore') return 'f'
  return ''
}
function feedScore(p, me, talked) {
  const likes = (p.post_likes || []).length
  const hours = Math.max(0, (Date.now() - new Date(p.created_at).getTime()) / 3600000)
  const chats = p.user_id === me ? 0 : (talked[p.user_id] || 0)
  const closeness = (chats || p.user_id === me) ? 100 + Math.min(chats, 40) : 0  // people I talk to (and me) first
  const likeScore = likes * 10                                                     // most liked posts next
  const fresh = 40 * Math.pow(0.5, hours / 24)                                     // new posts get a boost that halves every day
  return closeness + likeScore + fresh
}

// ----- the feed changes at every refresh (like Facebook) -----
const FEED_PAGE = 19                              // posts shown first; the rest loads while you scroll
const SEEN_KEY = 'kc_feed_seen'
const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') } catch { return {} } }
function markSeen(ids) {
  try {
    const m = readSeen(), now = Date.now()
    ids.forEach(id => { m[id] = now })
    const keep = Object.entries(m).filter(([, t]) => now - t < 3 * 24 * 3600 * 1000).sort((a, b) => b[1] - a[1]).slice(0, 400)
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(keep)))
  } catch { /* ignore */ }
}
let feedOrder = null                              // order of this session (kept while you only come back from another page)

// 1) the other sex first: a boy sees every girl before the first boy (and the contrary)
// 2) inside each group: people I talk to, most liked, new posts + a little luck, and posts I already saw go down
function rankFeed(posts, me, talked, reshuffle) {
  const mineG = sexGroup((profileCache[me] || {}).sex)
  const seen = readSeen(), now = Date.now()
  let lastTop = []
  try { lastTop = JSON.parse(localStorage.getItem('kc_feed_top') || '[]') } catch { lastTop = [] }
  const prev = (!reshuffle && feedOrder) ? new Map(feedOrder.map((id, i) => [id, i])) : null
  const rows = posts.map(p => {
    const hisG = sexGroup((profileCache[p.user_id] || {}).sex)
    const tier = (!mineG || (hisG && hisG !== mineG)) ? 0 : 1
    let score
    if (prev) score = prev.has(String(p.id)) ? -prev.get(String(p.id)) : 1e6          // same order as before, new posts on top of their group
    else {
      score = feedScore(p, me, talked) + Math.random() * 60
      const t = seen[p.id]
      if (t && now - t < 3 * 24 * 3600 * 1000) score -= 90                                  // already seen: the unseen ones come first
      if (lastTop.includes(String(p.id))) score -= 220                                       // the posts that were on top last time never stay on top
    }
    return { p, tier, score }
  })
  rows.sort((a, b) => (a.tier - b.tier) || (b.score - a.score) || (new Date(b.p.created_at) - new Date(a.p.created_at)))
  const out = rows.map(r => r.p)
  feedOrder = out.map(p => String(p.id))
  if (!prev) { try { localStorage.setItem('kc_feed_top', JSON.stringify(feedOrder.slice(0, 3))) } catch { /* ignore */ } }
  return out
}

// =====================================================
// STATUS VIEWER (WhatsApp style: auto next, tap, hold to pause)
// =====================================================
const VIEWED_KEY = 'kc_viewed_status'
function viewedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]')) } catch (e) { return new Set() }
}
function markViewed(id) {
  try {
    const s = viewedSet()
    s.add(id)
    localStorage.setItem(VIEWED_KEY, JSON.stringify([...s].slice(-500)))
  } catch (e) { /* storage blocked: the ring just stays colored */ }
}

const sv = { groups: [], g: 0, i: 0, tick: null, elapsed: 0, ready: false, paused: false, vid: null, downAt: 0 }

function svStartIndex(items) {
  const seen = viewedSet()
  const k = items.findIndex(p => !seen.has(p.id))
  return k >= 0 ? k : 0
}

function openStatusViewer(groups, startGroup) {
  if (!groups || !groups.length) return
  sv.groups = groups
  sv.g = startGroup || 0
  sv.i = svStartIndex(groups[sv.g].items)
  document.getElementById('sviewer').style.display = 'block'
  svShow()
}

function svShow() {
  clearInterval(sv.tick)
  const grp = sv.groups[sv.g]
  const p = grp.items[sv.i]
  const u = profileCache[grp.uid] || {}

  document.getElementById('svBars').innerHTML =
    grp.items.map((_, k) => `<span><i style="width:${k < sv.i ? 100 : 0}%"></i></span>`).join('')
  document.getElementById('svAvatar').style.backgroundImage = `url('${esc(u.profile_pic || '')}')`
  document.getElementById('svName').textContent = u.full_name || ''
  document.getElementById('svTime').textContent = fmtTime(p.created_at)
  document.getElementById('svCaption').textContent = p.caption || ''
  markViewed(p.id)

  // like button of this status (the heart + counter are kept in sync by social.js)
  const lb = document.getElementById('svLike'), lc = document.getElementById('svLikeCount')
  if (lb && lc) {
    lb.dataset.post = p.id
    lc.dataset.post = p.id
    lb.onclick = () => window.toggleLike && window.toggleLike(p.id)
    lc.onclick = () => window.showLikers && window.showLikers(p.id)
    if (window.syncLikeUI) window.syncLikeUI(p.id)
  }

  const stage = document.getElementById('svStage')
  const isVideo = (p.media_type || '').startsWith('video/')
  sv.elapsed = 0
  sv.paused = false
  sv.vid = null
  sv.ready = false
  stage.innerHTML = ''

  if (isVideo) {
    const v = document.createElement('video')
    v.src = p.media_url
    v.playsInline = true
    v.autoplay = true
    v.onplaying = () => { sv.ready = true }
    v.onerror = () => { sv.ready = true; sv.elapsed = STATUS_IMAGE_MS }
    stage.appendChild(v)
    sv.vid = v
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}) })   // browser blocked sound: play muted
  } else {
    const img = document.createElement('img')
    img.alt = ''
    img.onload = () => { sv.ready = true }
    img.onerror = () => { if (img.src !== p.media_url) img.src = p.media_url; else sv.ready = true }   // light copy failed: the original
    img.src = window.kcPick ? window.kcPick(p.media_url, 'full') : p.media_url
    stage.appendChild(img)
  }

  const step = 50
  sv.tick = setInterval(() => {
    if (!sv.ready) return                      // wait until the photo / video is really on screen
    let pct
    if (sv.vid) {
      const v = sv.vid
      const total = Math.min((v.duration || 0) * 1000, STATUS_VIDEO_MAX_MS)
      sv.elapsed = v.currentTime * 1000
      pct = total ? sv.elapsed / total : 0
      if (v.ended || (total && sv.elapsed >= total)) { svNext(); return }
    } else {
      if (sv.paused) return
      sv.elapsed += step
      pct = sv.elapsed / STATUS_IMAGE_MS
      if (pct >= 1) { svNext(); return }
    }
    const bar = document.querySelectorAll('#svBars i')[sv.i]
    if (bar) bar.style.width = Math.min(100, pct * 100) + '%'
  }, step)
}

function svNext() {
  const grp = sv.groups[sv.g]
  if (sv.i < grp.items.length - 1) { sv.i++; svShow(); return }
  if (sv.g < sv.groups.length - 1) {           // like WhatsApp: continue with the next person
    sv.g++
    sv.i = svStartIndex(sv.groups[sv.g].items)
    svShow()
    return
  }
  closeStatusViewer()
}

function svPrev() {
  if (sv.i > 0) { sv.i--; svShow(); return }
  if (sv.g > 0) { sv.g--; sv.i = 0; svShow(); return }
  svShow()                                      // first status: start it again
}

function closeStatusViewer() {
  clearInterval(sv.tick)
  if (sv.vid) sv.vid.pause()
  sv.vid = null
  document.getElementById('svStage').innerHTML = ''
  document.getElementById('sviewer').style.display = 'none'
  // update the rings (seen / not seen), but only if the Status page is the one on screen
  const sp = document.getElementById('statusPage')
  if (sp && sp.style.transform === 'scale(1)' && window.__refreshStatus) window.__refreshStatus()
}

// pause / continue the status from outside (used while the "who liked" list is open)
window.__svHold = (on) => {
  const open = document.getElementById('sviewer').style.display === 'block'
  if (!open) return
  sv.paused = on
  if (sv.vid) { if (on) sv.vid.pause(); else sv.vid.play().catch(() => {}) }
}

// hold = pause, quick tap on the left = back, quick tap anywhere else = next
const svHit = document.getElementById('svHit')
if (svHit) {
  const resume = () => {
    sv.paused = false
    if (sv.vid) sv.vid.play().catch(() => {})
  }
  svHit.addEventListener('pointerdown', (e) => {
    sv.downAt = Date.now()
    sv.paused = true
    if (sv.vid) sv.vid.pause()
    try { svHit.setPointerCapture(e.pointerId) } catch (err) {}
  })
  svHit.addEventListener('pointerup', (e) => {
    const quick = Date.now() - sv.downAt < 250
    resume()
    if (!quick) return
    const rect = svHit.getBoundingClientRect()
    if ((e.clientX - rect.left) < rect.width * 0.3) svPrev(); else svNext()
  })
  svHit.addEventListener('pointercancel', resume)
}
document.addEventListener('keydown', (e) => {
  const open = document.getElementById('sviewer') && document.getElementById('sviewer').style.display === 'block'
  if (!open) return
  if (e.key === 'Escape') closeStatusViewer()
  else if (e.key === 'ArrowRight') svNext()
  else if (e.key === 'ArrowLeft') svPrev()
})
window.openStatusViewer = openStatusViewer
window.closeStatusViewer = closeStatusViewer

async function checkiflog() {
  let { data, error } = await supabase.auth.getSession();
  // no internet and the login cannot be refreshed: keep the saved login so the app still opens
  if ((error || !data.session) && (!navigator.onLine || (error && isNetworkError(error)))) {
    const saved = savedSession()
    if (saved) { data = { session: saved }; error = null }
  }
  if (error) {
    waitAsec('cancel')
    softError(error);
  } else if (data.session) {
    waitAsec('cancel')
    document.documentElement.classList.add('kc-has-session')
    showmessage("MURAHAWE IKAZE " + JSON.stringify(data.session.user.user_metadata.full_name));


    // =====================================================
    // POSTS (feed + status) AND LIKES
    // =====================================================

    // start the new features (search, gallery, viewer, chooser, likes)
    initSocial({
      supabase, me: data.session.user.id, profileCache, esc, fmtTime, showmessage, waitAsec,
      getTalkedMap, viewedSet, setNav, openStatusViewer,
      notifyActivity: queuePush
    })
    if (callClient) callClient.close()
    callClient = initCalls({
      supabase,
      me: data.session.user.id,
      getProfile: async (id) => {
        if (profileCache[id]) return profileCache[id]
        const { data: rows, error: profileError } = await supabase.from('profiles').select('*').eq('id', id)
        if (profileError) throw profileError
        if (rows && rows[0]) profileCache[id] = rows[0]
        return profileCache[id] || {}
      },
      sendInvite: requestCallInvite,
      showmessage
    })
    window.search = window.openSearch          // the search button in the bottom bar

    // the posts that are on the feed screen right now (the full-screen viewer swipes through them)
    let feedPosts = []

    // draws ONE post card of the feed
    function postHTML(p) {
      const me = data.session.user.id
      const u = profileCache[p.user_id] || {}
      const likes = p.post_likes || []
      const liked = likes.some(l => l.user_id === me)
      const isVideo = (p.media_type || '').startsWith('video/')
      // a post whose picture lives in the "avatars" bucket is a profile picture post
      const isPicPost = (p.media_url || '').includes('/avatars/')
      const captionText = p.caption || (isPicPost ? 'yashizeko profile nshasha' : '')
      // tap the photo / video = open it full screen
      const media = isVideo
        ? `<div class="mediawrap" data-media-post="${esc(p.id)}" onclick="openFeedPost('${esc(p.id)}')"><video class="postmedia" src="${esc(p.media_url)}#t=0.1" muted playsinline preload="metadata"></video><span class="playbadge">▶</span></div>`
        : `<div class="mediawrap" data-media-post="${esc(p.id)}" onclick="openFeedPost('${esc(p.id)}')">${window.kcImg(p.media_url, { cls: 'postmedia', kind: 'feed' })}</div>`
      return `
  <div class="post" id="post-${p.id}">
    <div class="userinfos">
      <button class="avatar" style="background-image: url('${esc(u.profile_pic || '')}');" onclick="openUserChoice('${p.user_id}')"></button>
      <div class="who" onclick="openUserChoice('${p.user_id}')">
        <p class="username">${esc(u.full_name || '')}</p>
        <p class="adresse">📍 ${esc(u.address || '')}</p>
      </div>
      <span class="ptime">${fmtTime(p.created_at)}</span>
      ${p.user_id === me ? '' : `<button class="followmini ${window.kcIsFollowing && window.kcIsFollowing(p.user_id) ? 'on' : ''}" data-follow="${p.user_id}" onclick="toggleFollow('${p.user_id}')">${window.kcIsFollowing && window.kcIsFollowing(p.user_id) ? 'Following ✓' : '+ Follow'}</button>`}
    </div>
    ${captionText ? `<p class="postcaption">${esc(captionText)}</p>` : ''}
    ${media}
    <div class="post-actions">
      <div class="likewrap">
        <button class="likebtn ${liked ? 'liked' : ''}" data-post="${p.id}" onclick="toggleLike('${p.id}')"></button>
        <button class="likecount" data-post="${p.id}" onclick="showLikers('${p.id}')">${likes.length} ${likes.length === 1 ? 'like' : 'likes'}</button>
      </div>
      <button class="share-post" onclick="sharePost('${esc(p.id)}')" aria-label="Share post">↗ Share</button>
      ${p.user_id === me ? '' : `<button class="msgbtn" onclick="openm('${p.user_id}')">Message</button>`}
    </div>
  </div>`
    }

    // open a feed post full screen
    function openFeedPost(id) {
      const k = feedPosts.findIndex(p => String(p.id) === String(id))
      if (k < 0) return
      window.openPostViewer(feedPosts, k, {
        onChange: (p, what) => {                       // edited / moved / deleted inside the viewer
          const el = document.getElementById('post-' + p.id)
          if (!el) return
          if (what === 'delete' || p.kind !== 'feed') {
            feedPosts = feedPosts.filter(x => x !== p)
            el.remove()
          } else {
            el.outerHTML = postHTML(p)
          }
        }
      })
    }
    window.openFeedPost = openFeedPost

    // ----- new post sheet -----
    function openPostModal(kind) {
      document.getElementById('postFile').value = ''
      window.resetPostPicker && window.resetPostPicker(profileCache[data.session.user.id])
      document.getElementById('postCaption').value = ''
      const radio = document.querySelector(`input[name="postkind"][value="${kind === 'status' ? 'status' : 'feed'}"]`)
      if (radio) radio.checked = true
      showHTML('postModal')
    }
    function closePostModal() { hideHTML('postModal') }
    window.openPostModal = openPostModal
    window.closePostModal = closePostModal

    async function publishPost() {
      const me = data.session.user.id
      const file = document.getElementById('postFile').files[0]
      const caption = document.getElementById('postCaption').value.trim()
      const kind = document.querySelector('input[name="postkind"]:checked').value

      if (!file) { showmessage('choose a photo or a video first'); return }
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        showmessage('only photos or videos'); return
      }
      if (file.size > 50 * 1024 * 1024) { showmessage('file is too big (max 50 MB)'); return }

      // saved on the phone, then sent in the background (also when there is no internet)
      await jobs.add('post', { user_id: me, kind, caption, name: file.name, type: file.type }, file, null, me)
      closePostModal()
      showmessage(navigator.onLine ? (kind === 'status' ? '📤 Status iriko irohererezwa…' : '📤 Post iriko irohererezwa…') : '📴 Nta internet. Izohererezwa internet nigaruka.')
      runJobs()
    }
    window.publishPost = publishPost

    // ----- FEED (Peek): only posts with kind = 'feed' -----
    let feedReshuffle = true           // true = the feed is mixed again (app start, tap on the feed button, pull down)
    let feedSorted = [], feedShown = 0, feedIO = null

    // draws the next 19 posts (or all of them when there is no internet)
    function renderFeedChunk(all) {
      const host = document.getElementById('allofthem')
      const sentinel = document.getElementById('feedSentinel')
      const next = all ? feedSorted.slice(feedShown) : feedSorted.slice(feedShown, feedShown + FEED_PAGE)
      if (!next.length) return
      const html = next.map(postHTML).join('')
      if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html); else host.insertAdjacentHTML('beforeend', html)
      feedShown += next.length
      markSeen(next.map(p => p.id))
      if (feedShown >= feedSorted.length) {
        if (feedIO) { feedIO.disconnect(); feedIO = null }
        if (sentinel) sentinel.remove()
      } else if (feedIO && sentinel) { feedIO.unobserve(sentinel); feedIO.observe(sentinel) }   // look again after each page
    }

    async function peek(quiet) {
      const hostEl = document.getElementById('allofthem')
      const quietMode = quiet === true
      // tapping the feed button while you are on the feed = refresh (a new mix)
      if (!quietMode && getComputedStyle(hostEl).display !== 'none' && hostEl.children.length) { feedReshuffle = true; forceFresh(6000) }
      if (!quietMode) window.closeOverlays()
      setNav('peekyourfav')
      // nothing saved yet (first time): grey placeholders instead of a loading screen
      let rendered = false
      if (!hostEl.children.length) setTimeout(() => { if (!rendered && !hostEl.children.length) hostEl.innerHTML = `<div class="pagebar"><h3 class="brandtitle">KIREZI CANJE</h3></div>` + skelCards(3) }, 150)
      document.getElementById('statusPage').style.transform = 'scale(0)'
      hideHTML('cre')
      hideHTML('loginpage')
      showHTML('navigation')
      hideHTML('userJournal')
      showHTML('allofthem')
      hideHTML('messenger')

      stale.v = false
      const { data: profs, error: pe } = await supabase.from('profiles').select('*')
      if (pe) { waitAsec('x'); softError(pe); return }
      profs.forEach(p => { profileCache[p.id] = p })

      const { data: posts, error } = await supabase
        .from('posts')
        .select('*, post_likes(user_id)')
        .eq('kind', 'feed')
        .order('created_at', { ascending: false })
      const talked = error ? {} : await getTalkedMap(data.session.user.id)
      if (error) { softError(error); return }
      rendered = true

      const offlineNow = !navigator.onLine || stale.v          // no internet: everything saved on the phone is shown at once
      const meId = data.session.user.id
      const sorted = rankFeed(posts, meId, talked, feedReshuffle)
      feedReshuffle = false

      window.kcRemember(sorted)
      feedPosts = sorted      // same objects as the like store, so hearts stay in sync
      feedSorted = sorted; feedShown = 0
      if (feedIO) { feedIO.disconnect(); feedIO = null }
      const host = document.getElementById('allofthem')
      host.innerHTML = `<div class="pagebar"><h3 class="brandtitle"><img src="/favicon.png" alt="" style="width:50px; height:100%;">KIREZI CANJE</h3><button class="addpost" onclick="openPostModal()">+</button></div>`
      if (!sorted.length) {
        host.insertAdjacentHTML('beforeend', `<div class="empty"><p>No posts yet</p><span>Tap + to share the first photo or video.</span></div>`)
        return
      }
      if (!offlineNow && sorted.length > FEED_PAGE) {
        host.insertAdjacentHTML('beforeend', `<div id="feedSentinel" class="feedmore">Loading more…</div>`)
        feedIO = new IntersectionObserver((en) => { if (en.some(e => e.isIntersecting)) renderFeedChunk(false) }, { rootMargin: '700px 0px' })     // the page itself scrolls
        feedIO.observe(document.getElementById('feedSentinel'))
        renderFeedChunk(false)
      } else {
        renderFeedChunk(true)
      }
    }

    // pull down on the feed = refresh (a new mix of posts)
    ;(() => {
      const host = document.getElementById('allofthem')
      if (!host || host.dataset.ptr) return
      host.dataset.ptr = '1'
      const ind = document.createElement('div'); ind.className = 'ptr'; ind.textContent = '↻'; document.body.appendChild(ind)
      let y0 = null, dy = 0
      host.addEventListener('touchstart', (e) => { y0 = (window.scrollY || document.documentElement.scrollTop || 0) <= 0 ? e.touches[0].clientY : null; dy = 0 }, { passive: true })
      host.addEventListener('touchmove', (e) => {
        if (y0 == null) return
        dy = e.touches[0].clientY - y0
        if (dy > 8) { ind.classList.add('on'); ind.style.transform = `translateY(${Math.min(dy, 120) * 0.55 - 40}px) rotate(${Math.min(dy, 120) * 3}deg)` }
      }, { passive: true })
      host.addEventListener('touchend', () => {
        if (y0 != null && dy > 95) {
          ind.style.transform = 'translateY(24px)'; ind.classList.add('spin')
          feedReshuffle = true; forceFresh(6000)
          peek().finally(() => { ind.classList.remove('spin', 'on'); ind.style.transform = 'translateY(-40px)' })
        } else { ind.classList.remove('on'); ind.style.transform = 'translateY(-40px)' }
        y0 = null; dy = 0
      })
    })()
    window.peek = peek
    peek()

    // ----- STATUS (WhatsApp style): my status + status of people I have talked to, last 24 hours -----
    async function openstatus(silent) {
      window.closeOverlays()
      setNav('status')
      document.getElementById('messenger').style.display = 'none'
      document.getElementById('allofthem').style.display = 'none'
      document.getElementById('userJournal').style.display = 'none'
      const page = document.getElementById('statusPage')
      page.style.transform = 'scale(1)'
      const me = data.session.user.id

      const [profRes, talked] = await Promise.all([
        supabase.from('profiles').select('*'),
        getTalkedMap(me)
      ])
      if (profRes.data) profRes.data.forEach(p => { profileCache[p.id] = p })

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data: posts, error } = await supabase
        .from('posts')
        .select('*, post_likes(user_id)')
        .eq('kind', 'status')
        .gte('created_at', since)
        .order('created_at', { ascending: true })     // oldest first, like WhatsApp
      waitAsec('x')
      if (error) { softError(error); return }
      window.kcRemember(posts)

      // me + people I have talked to + people I follow
      try { await window.kcFollowsReady } catch (e) { /* offline */ }
      const isF = (id) => !!(window.kcIsFollowing && window.kcIsFollowing(id))
      const byUser = {}
      posts.filter(p => p.user_id === me || talked[p.user_id] || isF(p.user_id))
        .forEach(p => { (byUser[p.user_id] = byUser[p.user_id] || []).push(p) })

      const seen = viewedSet()
      const mine = byUser[me] || []
      const others = Object.keys(byUser).filter(id => id !== me).map(id => ({
        uid: id,
        items: byUser[id],
        unseen: byUser[id].some(p => !seen.has(p.id)),
        latest: byUser[id][byUser[id].length - 1].created_at
      }))
      others.sort((a, b) => (Number(b.unseen) - Number(a.unseen)) || (Number(isF(b.uid)) - Number(isF(a.uid))) || (new Date(b.latest) - new Date(a.latest)))

      window.openStatusMine = () => mine.length
        ? openStatusViewer([{ uid: me, items: mine }], 0)
        : openPostModal('status')
      window.openStatusAt = (k) => openStatusViewer(others, k)

      const mu = profileCache[me] || {}
      let html = `<div class="pagebar"><h3>Status</h3><button class="addpost" onclick="openPostModal('status')">+</button></div>`
      html += `<div class="srow" onclick="openStatusMine()">
        <div class="sring ${mine.length ? '' : 'none'}"><div class="sav" style="background-image: url('${esc(mu.profile_pic || '')}');"></div></div>
        <div class="srow-mid">
          <p class="srow-name">My status</p>
          <p class="srow-sub">${mine.length ? mine.length + (mine.length === 1 ? ' update' : ' updates') + ' · ' + fmtTime(mine[mine.length - 1].created_at) : 'Tap + to add a status'}</p>
        </div>
      </div>`

      if (others.length) {
        html += `<p class="slabel">Recent updates</p>`
        others.forEach((g, k) => {
          const u = profileCache[g.uid] || {}
          html += `<div class="srow" onclick="openStatusAt(${k})">
            <div class="sring ${g.unseen ? '' : 'seen'}"><div class="sav" style="background-image: url('${esc(u.profile_pic || '')}');"></div></div>
            <div class="srow-mid">
              <p class="srow-name">${esc(u.full_name || 'User')}</p>
              <p class="srow-sub">${isF(g.uid) ? 'Following · ' : ''}${fmtTime(g.latest)}</p>
            </div>
          </div>`
        })
      } else {
        html += `<div class="empty"><p>nta status irajako</p><span>ubona ama status yabantu mumaze kuyaga canke mukurikira gusa. ama status arikurako inyuma yamasaha 24.</span></div>`
      }
      page.innerHTML = html
    }
    window.openstatus = openstatus
    window.__refreshStatus = () => openstatus(true)

    // ----- the list of chats lives in memory, so it can change at once (like WhatsApp) -----
    const convo = { messages: null }          // every message of mine, as loaded from Supabase
    const listVisible = () => { const e = document.getElementById('messenger'); return !!e && getComputedStyle(e).display !== 'none' }

    async function loadConvos() {
      const me = data.session.user.id
      const { data: messages, error: messErr } = await supabase.from('message').select('*').or(`sender_id.eq.${me},receiver_id.eq.${me}`)
      if (messErr) { softError(messErr, 'convos'); return false }
      const { data: profiles, error: proErr } = await supabase.from('profiles').select('*')
      if (proErr) { softError(proErr, 'profiles'); return false }
      profiles.forEach(p => { profileCache[p.id] = p })
      convo.messages = messages
      return true
    }

    // adds new messages / updates the ones we already have (for example "read")
    function mergeIntoConvo(list) {
      if (!convo.messages) return
      ;(list || []).forEach(m => {
        const i = m.id != null ? convo.messages.findIndex(x => x.id === m.id) : -1
        if (i >= 0) convo.messages[i] = { ...convo.messages[i], ...m }
        else convo.messages.push(m)
      })
    }
    const unreadTotal = () => convo.messages ? convo.messages.filter(m => m.receiver_id === data.session.user.id && m.read_at === null).length : 0
    // I opened a chat: its messages are read now, the red numbers go away at once
    function localMarkRead(other) {
      if (!convo.messages) return
      const me = data.session.user.id, now = new Date().toISOString()
      let changed = false
      convo.messages.forEach(m => { if (m.sender_id === other && m.receiver_id === me && m.read_at === null) { m.read_at = now; changed = true } })
      if (changed) { setBadge(unreadTotal()); if (listVisible()) renderConvos() }
    }

    // messages and files still waiting for internet (shown with a clock 🕓)
    function waitingMessages() {
      const me = data.session.user.id
      const out = outbox.all().filter(i => i.sender_id === me).map(i => ({ ...i, pending: true }))
      jobs.list().forEach(j => {
        if (j.type !== 'voice' && j.type !== 'chatfile') return
        out.push({ sender_id: me, receiver_id: j.payload.receiver_id, created_at: new Date(j.created).toISOString(), pending: true,
          content: j.type === 'voice' ? '🎤 Voice message' : '📎 ' + j.payload.name,
          audio_url: j.type === 'voice' ? 'pending' : null, file_url: null })
      })
      return out
    }

    function renderConvos() {
      if (!convo.messages) return
      const me = data.session.user.id
      const messages = convo.messages.concat(waitingMessages())
      if (messages.length && messages[0].created_at) {
        messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      }
      // unread messages per person
      const unread = {}
      messages.forEach(m => { if (m.receiver_id === me && m.read_at === null) unread[m.sender_id] = (unread[m.sender_id] || 0) + 1 })
      // latest message of each conversation
      const last = {}
      messages.forEach((m, i) => {
        const other = m.sender_id === me ? m.receiver_id : m.sender_id
        last[other] = { m, i }
      })
      const when = (x) => (x.m.created_at ? new Date(x.m.created_at).getTime() : 0)
      const ids = Object.keys(last).sort((a, b) => (when(last[b]) - when(last[a])) || (last[b].i - last[a].i))

      let html = ''
      ids.forEach(id => {
        const p = profileCache[id]
        if (!p) return
        const m = last[id].m
        const preview = m.audio_url ? '🎤 Voice message'
          : m.file_url ? ((m.file_type || '').startsWith('image/') ? '📷 Photo' : '📎 ' + esc(m.file_name || 'File'))
          : esc(m.content)
        const mine = m.sender_id === me
        const un = unread[id] || 0
        const tick = mine ? `<span class="tick${m.read_at ? ' read' : ''}">${m.pending ? '🕓' : (m.read_at ? '✓✓' : '✓')}</span> ` : ''
        html += `<div class="user${un ? ' unread' : ''}" onclick="openinbox('${id}')">
        <button class="avatar" style="background-image: url('${p.profile_pic}');" onclick="event.stopPropagation();openUserChoice('${id}')"></button>
        <div class="umid">
          <p class="hisname">${esc(p.full_name)}</p>
          <p class="lastmessage">${mine ? tick + '<span class="you">wewe: </span>' : ''}${preview}</p>
        </div>
        <div class="utimewrap"><span class="utime">${m.created_at ? fmtTime(m.created_at) : ''}</span>${un ? `<span class="ubadge">${un > 99 ? '99+' : un}</span>` : ''}</div>
      </div>`
      })
      document.getElementById('selectuser').innerHTML = html ||
        `<div class="empty"><p>No messages yet</p><span>Open the feed and say hi.</span></div>`
      setBadge(unreadTotal())
    }

    async function onpenmessages(silent) {
      window.closeOverlays()
      const had = !!convo.messages
      setNav('messages')
      showHTML('navigation')
      document.getElementById('statusPage').style.transform = 'scale(0)'
      hideHTML('allofthem')
      showHTML('messenger')
      hideHTML('userJournal')
      if (document.getElementById('inbox').style.display == 'flex') {
        document.getElementById('navigation').style.display = 'none'
      }
      if (had) renderConvos()                      // the list appears at once from memory
      else setTimeout(() => { if (!convo.messages) document.getElementById('selectuser').innerHTML = skelRows(5) }, 150)
      const ok = await loadConvos()                // and is refreshed quietly
      waitAsec('j')
      if (ok) renderConvos()
      refreshBadge()
    }
    window.onpenmessages = onpenmessages

    const msgCache = {}   // chat id -> messages already loaded (so the chat opens instantly next time)

    function msgKey(m) {
      return m.id != null ? 'id' + m.id : [m.created_at, m.sender_id, m.receiver_id, m.content, m.audio_url, m.file_url].join('|')
    }

    function msgHTML(m) {
      const mineMsg = m.sender_id === data.session.user.id
      const tk = mineMsg ? `<span class="tick${m.read_at ? ' read' : ''}">${m.read_at ? '✓✓' : '✓'}</span>` : ''
      const t = m.created_at ? `<span class="msgtime">${fmtClock(m.created_at)}${tk}</span>` : ''
      if (mineMsg) {
        return `<div class="sentmessage"><div class="sentmessinfos">${messageBodyHTML(m, 'amess')}${t}</div></div>`
      }
      return `<div class="receivedmessage"><div class="receimessinfos">${messageBodyHTML(m, 'themess')}${t}</div></div>`
    }

    // adds only the messages that are not on screen yet (no flicker, audio keeps playing)
    function paintMessages(mes) {
      const list = document.getElementById('messagesp2p')
      if (!list) return
      const firstPaint = list.dataset.painted !== '1'
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120
      const have = new Set(Array.from(list.children).map(c => c.dataset.k).filter(Boolean))
      const byK = {}
      Array.from(list.children).forEach(c => { if (c.dataset.k) byK[c.dataset.k] = c })
      let added = false
      let addedMine = false
      mes.forEach(m => {
        const k = msgKey(m)
        if (have.has(k)) {
          // my message was read meanwhile: ✓ becomes ✓✓ (blue)
          if (m.read_at && m.sender_id === data.session.user.id && byK[k]) {
            const tk = byK[k].querySelector('.tick:not(.read)')
            if (tk) { tk.classList.add('read'); tk.textContent = '✓✓' }
          }
          return
        }
        const holder = document.createElement('div')
        holder.innerHTML = msgHTML(m).trim()
        const el = holder.firstElementChild
        el.dataset.k = k
        list.appendChild(el)
        added = true
        if (m.sender_id === data.session.user.id) addedMine = true
      })
      // the temporary "uploading" bubble is replaced by the real message
      if (addedMine) {
        list.querySelectorAll('.vp[data-pending]').forEach(v => {
          const row = v.closest('.sentmessage')
          if (row) row.remove()
        })
      }
      if (added) vpInitAll()
      list.dataset.painted = '1'
      renderPending()
      if (firstPaint || nearBottom || addedMine) list.scrollTop = list.scrollHeight
    }

    // messages written with no internet: shown with a clock 🕓 until they are really sent
    function renderPending(scroll) {
      const list = document.getElementById('messagesp2p')
      const inbox = document.getElementById('inbox')
      if (!list || !inbox) return
      list.querySelectorAll('[data-ptext]').forEach(e => e.remove())
      const me = data.session.user.id
      outbox.all().filter(i => i.sender_id === me && i.receiver_id === inbox.dataset.chat).forEach(i => {
        const el = document.createElement('div')
        el.className = 'sentmessage'
        el.dataset.ptext = i.client_id
        el.innerHTML = `<div class="sentmessinfos"><p class="amess">${esc(i.content)}</p><span class="msgtime">${fmtClock(i.created_at)}<span class="tick">🕓</span></span></div>`
        list.appendChild(el)
      })
      jobs.list().filter(j => (j.type === 'voice' || j.type === 'chatfile') && j.payload.sender_id === me && j.payload.receiver_id === inbox.dataset.chat).forEach(j => {
        const el = document.createElement('div')
        el.className = 'sentmessage'
        el.dataset.ptext = 'job' + j.id
        el.innerHTML = j.type === 'voice'
          ? `<div class="sentmessinfos">${pendingVoiceHTML()}</div>`
          : `<div class="sentmessinfos"><p class="amess">📎 ${esc(j.payload.name)}</p><span class="msgtime">${fmtClock(new Date(j.created).toISOString())}<span class="tick">🕓</span></span></div>`
        list.appendChild(el)
      })
      if (scroll) list.scrollTop = list.scrollHeight
    }

    async function openinbox(value) {
      listenMessages(value);
      const inbox = document.getElementById('inbox')
      const me = data.session.user.id
      const alreadyOpen = inbox.style.display === 'flex' && inbox.dataset.chat === value

      // 1) open the conversation instantly, like WhatsApp (no loader)
      if (!alreadyOpen) {
        hideHTML('navigation')
        document.getElementById('selectuser').style.transform = 'scale(0)'
        showHTML('inbox')
        inbox.dataset.chat = value
        const p = profileCache[value] || {}
        inbox.innerHTML = `<div class="hisinfos">
        <button class="back" onclick="closeinbox()"></button>
        <button class="profilepicturee" style="background-image: url('${p.profile_pic || ''}');" onclick="openUserChoice('${value}')"></button>
        <p class="hisnamee" onclick="openUserChoice('${value}')">${esc(p.full_name || '')}</p>
        <div class="call-shortcuts" aria-label="Call controls">
          <button type="button" onclick="startCall('${value}','audio')" aria-label="Voice call">☎</button>
          <button type="button" onclick="startCall('${value}','video')" aria-label="Video call">▣</button>
        </div>
      </div>
      <div class="messagesp2p" id="messagesp2p"></div>
      <div class="attachmenu" id="attachmenu">
        <button onclick="pickFile('photo')"><span class="aic ph"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg></span>Photos &amp; videos</button>
        <button onclick="pickFile('doc')"><span class="aic dc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg></span>Document</button>
      </div>
      <input type="file" id="photoInput" accept="image/*,video/*" hidden onchange="sendFile('${value}', this)">
      <input type="file" id="docInput" hidden onchange="sendFile('${value}', this)">
      <div class="divFor" id="divFor">
        <button class="otherToSent" onclick="toggleAttach()"></button>
        <input type="text" class="wordsTo" id="wordsTo" placeholder="Message" autocomplete="off"
          oninput="this.parentElement.classList.toggle('typing', this.value.trim().length > 0)"
          onkeydown="if(event.key==='Enter')sent('${value}')">
        <div class="recbar">
          <span class="recdot"></span>
          <span id="recTime">0:00</span>
          <span class="rectext">Recording…</span>
          <button class="reccancel" onclick="cancelRecord()">✕</button>
        </div>
        <button class="mic" id="micBtn" onclick="toggleRecord('${value}')" aria-label="Voice message"></button>
        <button class="sent" onclick="sent('${value}')"></button>
      </div>`
        if (recorder && recorder.state === 'recording') {
          document.getElementById('micBtn').classList.add('recording')
          document.getElementById('divFor').classList.add('rec')
        }
        // messages we already know are shown at once
        if (msgCache[value]) paintMessages(msgCache[value])
      }

      // 2) fetch the latest messages quietly in the background
      const { data: mes, error } = await supabase
        .from('message')
        .select('*')
        .or(`and(sender_id.eq.${me},receiver_id.eq.${value}),and(sender_id.eq.${value},receiver_id.eq.${me})`)
      if (error) {
        softError(error, 'messages')
        return
      }
      if (mes.length && mes[0].created_at) {
        mes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      }
      msgCache[value] = mes
      if (inbox.dataset.chat !== value) return   // the user already left this chat
      paintMessages(mes)
      mergeIntoConvo(mes)                          // the chats list changes with this chat
      // everything the other person sent is now read
      if (document.visibilityState === 'visible' && mes.some(m => m.sender_id === value && m.read_at === null)) { localMarkRead(value); markRead(value) }
      else if (listVisible()) renderConvos()

      // 3) header details if we did not have them yet
      if (!profileCache[value]) {
        const { data: profs } = await supabase.from('profiles').select('*').eq('id', value)
        if (profs && profs[0] && inbox.dataset.chat === value) {
          profileCache[value] = profs[0]
          const pic = inbox.querySelector('.profilepicturee')
          const nm = inbox.querySelector('.hisnamee')
          if (pic) pic.style.backgroundImage = `url('${profs[0].profile_pic}')`
          if (nm) nm.textContent = profs[0].full_name
        }
      }
    }
    window.openinbox = openinbox

    async function sent(value) {
      const box = document.getElementById('wordsTo')
      const text = box.value.trim()
      if (!text) return
      box.value = ''
      box.parentElement.classList.remove('typing')
      const me = data.session.user.id
      // 1) saved on the phone (it stays even if the app is closed)  2) shown at once with a clock 🕓  3) sent in the background
      outbox.add({ client_id: crypto.randomUUID(), sender_id: me, receiver_id: value, content: text, created_at: new Date().toISOString() })
      renderPending(true)
      if (listVisible()) renderConvos()
      flushOutbox()
    }
    window.sent = sent

    // ---------- VOICE MESSAGES ----------
    let recorder = null
    let chunks = []

    let recTimer = null
    let recCancelled = false

    async function toggleRecord(value) {
      // second tap = stop and send
      if (recorder && recorder.state === 'recording') {
        recorder.stop()
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
        recorder = new MediaRecorder(stream, { mimeType: mime })
        chunks = []
        recCancelled = false
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop())
          clearInterval(recTimer)
          const bar = document.getElementById('divFor')
          if (bar) bar.classList.remove('rec')
          const b = document.getElementById('micBtn')
          if (b) b.classList.remove('recording')
          if (recCancelled) { recCancelled = false; return }
          await sendVoice(value, new Blob(chunks, { type: mime }), mime)
        }
        recorder.start()
        document.getElementById('micBtn').classList.add('recording')
        document.getElementById('divFor').classList.add('rec')
        let sec = 0
        document.getElementById('recTime').textContent = '0:00'
        recTimer = setInterval(() => {
          sec++
          const el = document.getElementById('recTime')
          if (el) el.textContent = vpFmt(sec)
        }, 1000)
      } catch (e) {
        softError(e, 'microphone')
      }
    }

    function cancelRecord() {
      if (recorder && recorder.state === 'recording') {
        recCancelled = true
        recorder.stop()
      }
    }
    window.cancelRecord = cancelRecord
    window.toggleRecord = toggleRecord

    async function sendVoice(value, blob, mime) {
      if (blob.size < 1000) {
        showmessage('ijwi ni rigufi cane')
        return
      }
      const me1 = data.session.user.id
      // the voice message appears at once; it is saved on the phone and sent in the background
      await jobs.add('voice', { client_id: crypto.randomUUID(), sender_id: me1, receiver_id: value, mime, ext: mime.includes('webm') ? 'webm' : 'mp4' }, blob, null, me1)
      renderPending(true); if (listVisible()) renderConvos()
      runJobs()
    }
    window.sendVoice = sendVoice

    // ---------- FILES & PHOTOS ----------
    function toggleAttach() {
      const m = document.getElementById('attachmenu')
      if (m) m.style.display = m.style.display === 'flex' ? 'none' : 'flex'
    }
    function pickFile(kind) {
      const m = document.getElementById('attachmenu')
      if (m) m.style.display = 'none'
      document.getElementById(kind === 'photo' ? 'photoInput' : 'docInput').click()
    }
    window.toggleAttach = toggleAttach
    window.pickFile = pickFile

    async function sendFile(value, input) {
      const file = input.files[0]
      input.value = ''
      if (!file) return
      if (file.size > 20 * 1024 * 1024) { showmessage('file is too big (max 20 MB)'); return }

      const me0 = data.session.user.id
      await jobs.add('chatfile', { client_id: crypto.randomUUID(), sender_id: me0, receiver_id: value, name: file.name, type: file.type, size: file.size }, file, null, me0)
      renderPending(true); if (listVisible()) renderConvos()
      runJobs()
    }
    window.sendFile = sendFile

    function closeinbox(param) {
      document.getElementById('navigation').style.display = 'flex'
      document.getElementById('selectuser').style.transform = 'scale(1)'
      document.getElementById('inbox').style.display = 'none'
      document.getElementById('inbox').dataset.chat = ''
    }
    window.closeinbox = closeinbox

    async function openuser(value) {
      if (!value) {
        openuser(data.session.user.id)
        return
      }

      const { data: pros, error: nouser } = await supabase.from('profiles').select('*').eq('id', value)
      if (nouser || !pros || !pros[0]) {
        softError(nouser || 'user not found', 'openuser')
        return
      }
      window.closeOverlays()
      const u = pros[0]
      profileCache[u.id] = u
      const mine = u.id === data.session.user.id
      setNav(mine ? 'profile' : '')
      if (!mine) trackProfile(supabase, u.id, data.session.user.id)   // monetization: one genuine visit per viewer per day (server-side)

      document.getElementById('statusPage').style.transform = 'scale(0)'
      hideHTML('messenger')
      hideHTML('allofthem')
      showHTML('userJournal')
      showHTML('navigation')

      document.getElementById('userJournal').innerHTML = `
    <button class="profil" style="background-image: url('${u.profile_pic}');"></button>
    <p class="pname">${esc(u.full_name)}</p>
    <p class="pplace">📍 ${esc(u.address)}</p>
    <div class="fcounts" id="followCounts">
      <button onclick="showFollowList('${u.id}','followers')"><b id="fcFollowers" data-uid="${u.id}">–</b>Followers</button>
      <button onclick="showFollowList('${u.id}','following')"><b id="fcFollowing" data-uid="${u.id}">–</b>Following</button>
    </div>
    <div class="allI">
      ${mine ? '' : `<button class="messag" onclick="openm('${u.id}')">Message</button>`}
      ${mine ? '' : `<button class="call-profile" onclick="startCall('${u.id}','audio')">Call</button>`}
      ${mine ? '' : `<button class="followbig ${window.kcIsFollowing && window.kcIsFollowing(u.id) ? 'on' : ''}" data-follow="${u.id}" onclick="toggleFollow('${u.id}')">${window.kcIsFollowing && window.kcIsFollowing(u.id) ? 'Following ✓' : '+ Follow'}</button>`}
      <button class="photos" onclick="openGallery('${u.id}')">${mine ? 'photos' : 'Photos'}</button>
      ${mine ? `<button class="photos" onclick="kcPushToggle()">🔔 Notification</button>` : ''}
      ${mine ? `<button class="photos" onclick="location.href='monetize.html'">monetization 🤑💰</button>` : ''}
      ${mine ? `<button class="photos" onclick="location.href='app.html#reviews'">⭐ Rate app</button>` : ''}
      ${mine ? `<button class="logout" onclick="logout()">deconnecte</button>` : ''}
    </div>`
      window.followCounts && window.followCounts(u.id)
    }
    window.openuser = openuser

    function openm(value) {
      onpenmessages(true)
      openinbox(value)
    }
    window.openm = openm

    async function logout() {
      if (callClient) { callClient.close(); callClient = null }
      await disablePush(supabase)
      const { data: logout, error: err } = await supabase.auth.signOut()
      waitAsec()

      if (err) {
        waitAsec('canc')
        softError(err, 'logout failed')
        return
      }
      waitAsec('canc')
      clearOfflineCache()
      showmessage('logout successfull :')
      showHTML('loginpage')
      hideHTML('navigation')
      hideHTML('userJournal')
      showHTML('cre')
      showHTML('brand_couple')
      checkiflog()
    }
    window.logout = logout

    // ---------- unread badge, offline outbox, back-online refresh ----------
    {
      const me = data.session.user.id
      const visible = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' }
      const hooks = {
        chatOpenWith: (id) => { const i = document.getElementById('inbox'); return i.style.display === 'flex' && i.dataset.chat === id },
        currentChat: () => { const i = document.getElementById('inbox'); return i.style.display === 'flex' ? i.dataset.chat : null },
        openChat: (id) => openinbox(id),
        // a new message came in: the chats list changes at once (new line on top, red number, preview)
        incoming: (m) => {
          if (convo.messages) { mergeIntoConvo([m]); setBadge(unreadTotal()) }
          if (visible('messenger')) { if (convo.messages) renderConvos(); else onpenmessages(true) }
        },
        // the other person read my messages: the ticks change at once
        myMessageRead: (m) => {
          if (convo.messages) mergeIntoConvo([m])
          if (visible('messenger') && convo.messages) renderConvos()
          const c = hooks.currentChat()
          if (c && c === m.receiver_id) openinbox(c)
        },
        refreshList: () => { if (visible('messenger')) { if (convo.messages) renderConvos(); else onpenmessages(true) } },
        afterFlush: () => {
          const c = hooks.currentChat()
          if (c) openinbox(c); else hooks.refreshList()
          refreshBadge()
        },
        // photos / videos / voice / files that were waiting have been sent
        afterJobs: (types) => {
          if (types.includes('post')) {
            forceFresh(8000)
            showmessage('Your post is published ✅')
            const st = document.getElementById('statusPage')
            if (st && st.style.transform === 'scale(1)' && window.__refreshStatus) window.__refreshStatus()
            else if (visible('allofthem')) peek()
          }
          const c = hooks.currentChat()
          if (c) openinbox(c)
          hooks.refreshList()
          renderPending()
        }
      }
      setCacheUser(me)
      startMessageWatcher(me, hooks)
      // fresh data arrived in the background: update the screen that is open, without a loading screen
      freshHandler = (keys) => {
        const has = (t) => keys.some(k => k.includes('/rest/v1/' + t))
        const shownEl = (id) => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' }
        const busy = shownEl('reels') || shownEl('pviewer') || shownEl('postModal') || shownEl('sviewer') || shownEl('inbox')
        if ((has('message?') || has('profiles')) && listVisible() && !shownEl('inbox')) loadConvos().then(ok => { if (ok) renderConvos() })
        if (has('posts?') || has('profiles')) {
          const st = document.getElementById('statusPage')
          if (st && st.style.transform === 'scale(1)') openstatus(true)
          else if (visible('allofthem') && (window.scrollY || 0) < 80 && !busy) peek(true)
        }
      }
      onBackOnlineHandler = async () => {
        try { await supabase.auth.getSession() } catch { /* ignore */ }
        await flushOutbox()
        pendingReads.forEach(id => markRead(id))
        refreshBadge()
        const c = hooks.currentChat()
        if (c) { openinbox(c); return }
        if (!stale.v) return
        stale.v = false                               // we were showing saved data: load the fresh data now
        if (visible('messenger')) onpenmessages(true)
        else if (visible('statusPage') && window.__refreshStatus && document.getElementById('statusPage').style.transform !== 'scale(0)') window.__refreshStatus()
        else if (visible('allofthem')) peek()
      }
      jobs.load().then(() => { renderPending(); if (listVisible()) renderConvos(); runJobs() })
      flushOutbox()
      refreshBadge()

      // ---------- notifications: ask once in a while, open the right screen when tapped ----------
      initPush(supabase, (t) => showmessage(t))
      openUrlHandler = async (url) => {
        try {
          const q = new URL(url, location.origin).searchParams
          if (q.get('chat')) openm(q.get('chat'))
          else if (q.get('user')) openuser(q.get('user'))
          else if (q.get('post')) {
            const { data: posts, error: postError } = await supabase.from('posts').select('*, post_likes(user_id)').eq('id', q.get('post')).limit(1)
            if (postError) { softError(postError, 'open post'); return }
            if (!posts || !posts[0]) { showmessage('This post is no longer available.'); return }
            const { data: profiles, error: profileError } = await supabase.from('profiles').select('*').eq('id', posts[0].user_id)
            if (profileError) { softError(profileError, 'open post profile'); return }
            if (profiles && profiles[0]) profileCache[profiles[0].id] = profiles[0]
            window.kcRemember([posts[0]])
            window.openPostViewer([posts[0]], 0)
          }
        } catch (error) {
          console.error('[kirezi] notification link failed', error)
          showmessage('Could not open this link.')
        }
      }
      window.kcPushToggle = () => enablePush(supabase, (t) => showmessage(t))
      if (location.search.includes('chat=') || location.search.includes('user=') || location.search.includes('post=')) {
        setTimeout(() => { openUrlHandler(location.href); history.replaceState(history.state, '', location.pathname) }, 900)
      }
    }

  } else {
    if (callClient) { callClient.close(); callClient = null }
    waitAsec('cancel')
    document.documentElement.classList.remove('kc-has-session')
    stopWatcher()
    showmessage("MURAHAWE IKAZE MURI KIREZI CANJE");
    hideHTML('allofthem')
    hideHTML('messenger')

    //function yi buto ya login
    async function login() {
      waitAsec()
      let email = `${getidSvalue('email')}@gmail.com`
      let password = getidSvalue('password')
      if (email == '@gmail.com' || !password) {
        if (email == '@gmail.com') {
          waitAsec('cancel')
          showmessage('shiramwo nimero ya terefone');
        }
        else if (!password) {
          waitAsec('cancel')
          showmessage('nta password wanditse');
        }
        return
      }

      const { error, data } = await supabase.auth.signInWithPassword({ email: email, password: password })

      if (error) {
        waitAsec('cancel')
        authError(error)
        return
      }

      waitAsec('cancel')
      showmessage('VYAKUNZE ✅✅✅')
      hideHTML('loginpage')
      showHTML('navigation')
      hideHTML('cre')
      hideHTML('brand_couple')

      checkiflog()
    }
    window.login = login

    function create() {
      let forcreate = document.querySelectorAll('.forcreate')

      for (var i = 0; i < forcreate.length; i++) {
        forcreate[i].style.display = 'flex'
      }
      document.getElementById('brand_couple').style.height = ''
      hideHTML('crea')
      showHTML('createACOUNT')
      hideHTML('creat')
    }
    window.create = create

    async function createACOUT() {
      waitAsec()
      try {
        const phone = getidSvalue('email').trim();
        const email = `${phone}@gmail.com`;
        const password = getidSvalue('password');
        const full_name = getidSvalue('full_name');
        const sex = getidSvalue('sex');
        const address = getidSvalue('address');
        const age = getidSvalue('age');
        const file = document.getElementById('profilepic').files[0];

        if (email == '@gmail.com' || !password || !full_name || !sex || !address || !age || !file) {
          waitAsec('cancel');
          if (!file) {
            showmessage('ntiwacaguye photo de profire')
          }
          else if (email == '@gmail.com') {
            showmessage('shiramwo nimero ya terefone');
          } else if (!full_name) {
            showmessage('shiramwo amazina yawe');
          } else if (!sex) {
            showmessage('umuhungu canke umukobwa?');
          } else if (!address) {
            showmessage('wibagiye kwandika igihugu uvamwo');
          } else if (!age) {
            showmessage('shiramwo imyaka ufise');
          } else if (!password) {
            showmessage('nta password wanditse');
          }
          return;
        }

        // ----- checks -----
        if (!/^\d+$/.test(phone) || phone.length < PHONE_MIN || phone.length > PHONE_MAX) {
          waitAsec('cancel')
          showmessage(`nimero ya terefone idakwiza ibiharuro ${PHONE_MIN} ntiyemewe`)
          return
        }
        const ageNum = Number(age)
        if (!Number.isInteger(ageNum) || ageNum < MIN_AGE || ageNum > MAX_AGE) {
          waitAsec('cancel')
          showmessage(`udakwiza imyaka  ${MIN_AGE} canke urenza imyaka ${MAX_AGE} ntiwemerewe`)
          return
        }
        if (password.length < PASS_MIN) {
          waitAsec('cancel')
          showmessage(`password igomba kuba ikwiza ibintu  ${PASS_MIN}`)
          return
        }
        const birth_year = new Date().getFullYear() - ageNum   // we keep the birth year, it does not get old like an age

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name,
              sex,
              address,
              age: ageNum,
              birth_year
            }
          }
        });

        if (error) {
          console.log(error)
          softError(error)
          waitAsec('cancel')
          return
        }
        if (!data.user) {
          showmessage('konte ntiyakozwe')
        };
        const user = data.user;

        if (!data.session) {
          waitAsec('cancel');
          showmessage('konte yakozwe. comfirmation email.');
        }

        // smaller picture + a 160 px avatar copy + tiny preview (throws like supabase if the upload fails)
        const uploaded = await uploadPhoto(supabase, 'avatars', user.id, file, { maxSide: 1080, quality: 0.82 });

        const { data: urlData } = supabase.storage
          .from('avatars')
          .getPublicUrl(uploaded.path);

        const profile_pic = urlData.publicUrl;

        const { data: updated, error: updateError } =
          await supabase
            .from('profiles')
            .update({ profile_pic })
            .eq('id', user.id)
            .select('id');

        if (updateError) throw updateError;

        if (!updated || updated.length === 0) {
          throw new Error('Profile row ntiyabonetse. Raba trigger yawe na user_id.');
        }

        // the new profile picture also shows in the feed as a post (same posts table, nothing new in Supabase)
        const { error: picPostError } = await supabase.from('posts').insert([{
          user_id: user.id,
          kind: 'feed',
          media_url: profile_pic,
          media_type: file.type,
          caption: null
        }])
        if (picPostError) console.log('profile picture post:', picPostError.message)

        waitAsec('cancel')
        showmessage('wiyandikishije vyakunze , kaze ' + full_name)

        hideHTML('loginpage')
        showHTML('navigation')
        hideHTML('cre')
        hideHTML('brand_couple')
        checkiflog()

      } catch (e) {
        authError(e)
        waitAsec('cancel')
      }
    }
    window.createACOUT = createACOUT

  }
}

// ---------- post sheet: visible "choose photo / video" buttons ----------
window.pickPostFile = (kind) => {
  const f = document.getElementById('postFile')
  f.accept = kind === 'video' ? 'video/*' : 'image/*'
  f.click()
}
window.resetPostPicker = (profile) => {
  const prev = document.getElementById('postPrev')
  if (prev) { prev.classList.remove('on'); prev.innerHTML = '' }
  const av = document.getElementById('postAvatar'), nm = document.getElementById('postName')
  if (av && profile) av.style.backgroundImage = `url('${profile.profile_pic || ''}')`
  if (nm && profile) nm.textContent = profile.full_name || ''
}
window.clearPostFile = () => {
  document.getElementById('postFile').value = ''
  window.resetPostPicker()
}
document.getElementById('postFile').addEventListener('change', (e) => {
  const f = e.target.files[0]
  const prev = document.getElementById('postPrev')
  if (!f) { window.resetPostPicker(); return }
  const url = URL.createObjectURL(f)
  const media = f.type.startsWith('video/') ? `<video src="${url}" controls muted playsinline></video>` : `<img src="${url}" alt="">`
  prev.innerHTML = `${media}<button type="button" class="pdel" onclick="clearPostFile()">✕</button><div class="pname">✅ ${esc(f.name)} (${(f.size / 1048576).toFixed(1)} MB)</div>`
  prev.classList.add('on')
})

checkiflog()


let messageChannel = null;
let listeningTo = null;

function listenMessages(value) {
  // already listening to this person: do nothing (prevents duplicate alerts)
  if (messageChannel && listeningTo === value) return;
  if (messageChannel) {
    supabase.removeChannel(messageChannel);
  }
  listeningTo = value;

  messageChannel = supabase
    .channel('new-messages-' + value)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'message'
      },
      async (payload) => {
        const msg = payload.new;

        const { data: sessionData } =
          await supabase.auth.getSession();

        const currentUserId = sessionData.session?.user.id;

        if (!currentUserId) return;

        if (
          (msg.sender_id === value &&
            msg.receiver_id === currentUserId) ||
          (msg.sender_id === currentUserId &&
            msg.receiver_id === value)
        ) {
          const inboxOpen = document.getElementById('inbox').style.display == 'flex'

          // Refresh the conversation
          if (inboxOpen) {
            openinbox(value)
          }
        }
      }
    )
    .subscribe();
}

window.listenMessages = listenMessages
