// KIREZI CANJE - voice & video calls
// How it works (no server and no database change needed):
//  - the phones talk directly to each other with WebRTC (audio / video)
//  - to "ring" the other person, a tiny message goes through Supabase Realtime "broadcast"
// Ringing works while the app is open (like a chat that is online).
// When the other phone has the app CLOSED, the server sends a phone notification ("X is calling you"); the ring signal is repeated
// every 3 seconds, so when he taps the notification and the app opens, the call screen appears.
import { notifyServer } from './push.js'

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
    // Optional, for the few networks where a direct link is impossible: add a TURN server here, for example
    // { urls: 'turn:YOUR_TURN_HOST:443?transport=tcp', username: '...', credential: '...' }
  ]
}
const RING_TIMEOUT = 45000      // nobody answers -> call stops (and a "missed call" line is written in the chat)

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ICONS = {
  phone: '<svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
  hang: '<svg viewBox="0 0 24 24" style="transform:rotate(135deg)"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>',
  micoff: '<svg viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M20 4h-3.17L15 2H9L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 13c-2.76 0-5-2.24-5-5H5l2.5-2.5L10 12H8c0 2.21 1.79 4 4 4 .7 0 1.36-.18 1.93-.5l1.07 1.07c-.88.56-1.93.93-3 .93zm4.5-2.5L14 12h2c0-2.21-1.79-4-4-4-.7 0-1.36.18-1.93.5L9 7.43C9.88 6.87 10.93 6.5 12 6.5c2.76 0 5 2.24 5 5h2l-2.5 3z"/></svg>'
}

const CSS = `
#kcCall{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;align-items:center;justify-content:space-between;
  background:radial-gradient(120% 90% at 50% 0%,#4a1a3c 0%,#1B0A17 60%);color:#fff;font-family:var(--body,system-ui,sans-serif);
  padding:calc(40px + env(safe-area-inset-top,0px)) 20px calc(36px + env(safe-area-inset-bottom,0px));overflow:hidden}
#kcCall.on{display:flex;animation:kcCallIn .25s ease}
@keyframes kcCallIn{from{opacity:0;transform:scale(1.04)}to{opacity:1;transform:none}}
#kcCall .kcRemote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:none}
#kcCall.video.live .kcRemote{display:block}
#kcCall .kcLocal{position:absolute;right:14px;top:calc(14px + env(safe-area-inset-top,0px));width:96px;height:136px;object-fit:cover;border-radius:14px;
  background:#222;border:2px solid rgba(255,255,255,.7);box-shadow:0 6px 20px rgba(0,0,0,.4);display:none;z-index:3;transform:scaleX(-1)}
#kcCall.video .kcLocal{display:block}
#kcCall .kcTop{position:relative;z-index:2;text-align:center;text-shadow:0 2px 12px rgba(0,0,0,.5)}
#kcCall .kcAva{width:116px;height:116px;border-radius:50%;margin:0 auto 16px;background:#3a2233 center/cover no-repeat;box-shadow:0 0 0 4px rgba(255,46,147,.55);position:relative}
#kcCall.ringing .kcAva::after,#kcCall.ringing .kcAva::before{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(255,46,147,.7);animation:kcPulse 1.8s ease-out infinite}
#kcCall.ringing .kcAva::before{animation-delay:.9s}
@keyframes kcPulse{to{transform:scale(1.7);opacity:0}}
#kcCall.video.live .kcAva{display:none}
#kcCall .kcName{font-family:var(--display,inherit);font-weight:800;font-size:26px;margin:0}
#kcCall .kcState{margin:6px 0 0;font-size:15px;opacity:.85}
#kcCall .kcBtns{position:relative;z-index:2;display:flex;gap:22px;align-items:center;justify-content:center;flex-wrap:wrap}
#kcCall .kcB{width:64px;height:64px;border-radius:50%;border:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.18);
  backdrop-filter:blur(8px);color:#fff;cursor:pointer;transition:transform .12s}
#kcCall .kcB:active{transform:scale(.9)}
#kcCall .kcB svg{width:28px;height:28px;fill:#fff}
#kcCall .kcB.on{background:#fff}#kcCall .kcB.on svg{fill:#1B0A17}
#kcCall .kcB.red{background:#E5484D}#kcCall .kcB.green{background:#25D366;animation:kcShake 1.2s ease infinite}
@keyframes kcShake{0%,60%,100%{transform:none}10%,30%{transform:rotate(-12deg)}20%,40%{transform:rotate(12deg)}}
#kcCall .kcB.hide{display:none}
.kcCallBtn{flex:none;width:38px;height:38px;border-radius:50%;border:0;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.kcCallBtn svg{width:21px;height:21px;fill:#fff}
.kcCallBtn:active{transform:scale(.9)}
`

export function initCalls({ supabase, me, getProfile, toast, flush }) {
  const t = toast || ((m) => console.log(m))
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style)
  const root = document.createElement('div'); root.id = 'kcCall'
  root.innerHTML = `
    <video class="kcRemote" autoplay playsinline></video>
    <video class="kcLocal" autoplay playsinline muted></video>
    <audio class="kcAudio" autoplay></audio>
    <div class="kcTop"><div class="kcAva"></div><p class="kcName"></p><p class="kcState"></p></div>
    <div class="kcBtns">
      <button class="kcB" data-a="mute" aria-label="Mute">${ICONS.mic}</button>
      <button class="kcB hide" data-a="flip" aria-label="Switch camera">${ICONS.flip}</button>
      <button class="kcB red" data-a="end" aria-label="End">${ICONS.hang}</button>
      <button class="kcB green hide" data-a="accept" aria-label="Answer">${ICONS.phone}</button>
    </div>`
  document.body.appendChild(root)
  const $ = (s) => root.querySelector(s)
  const elRemote = $('.kcRemote'), elLocal = $('.kcLocal'), elAudio = $('.kcAudio')

  let call = null            // { id, peer, video, role, pc, local, remote, state, timer, startedAt, tick, pendingIce, haveRemoteDesc }
  let myCh = null
  const out = {}             // peer id -> channel used to send to him
  const ended = new Set()    // calls that are over: a repeated ring signal of such a call is ignored

  // ---------- signaling ----------
  async function send(peer, payload) {
    let ch = out[peer]
    if (!ch) {
      ch = supabase.channel('kc-call-' + peer, { config: { broadcast: { self: false } } })
      out[peer] = ch
      await new Promise((res) => { ch.subscribe((s) => { if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') res(s) }) })
    }
    try { await ch.send({ type: 'broadcast', event: 'sig', payload: { ...payload, from: me } }) } catch (e) { console.error('[call] send', e) }
  }

  myCh = supabase.channel('kc-call-' + me, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'sig' }, ({ payload }) => { handle(payload).catch(e => console.error('[call]', e)) })
    .subscribe()

  async function handle(m) {
    if (!m || !m.from || m.from === me) return
    if (m.type === 'ring') {
      if (ended.has(m.id)) return
      if (call) {                                           // already in a call
        if (call.peer === m.from && call.id === m.id) return
        send(m.from, { type: 'busy', id: m.id }); return
      }
      call = newCall(m.id, m.from, !!m.video, 'callee')
      showUI(); setState('Incoming ' + (m.video ? 'video ' : 'voice ') + 'call…'); ringtone(true)
      try { navigator.vibrate && navigator.vibrate([400, 200, 400, 200, 400]) } catch { /* no vibration */ }
      call.timer = setTimeout(() => finish('missed', false), RING_TIMEOUT + 5000)
      send(m.from, { type: 'ringing', id: m.id })
      return
    }
    if (!call || call.id !== m.id || call.peer !== m.from) return
    switch (m.type) {
      case 'ringing': if (call.role === 'caller' && call.state === 'calling') setState('Ringing…'); break
      case 'accept': if (call.role === 'caller') await startOffer(); break
      case 'offer':
        if (call.role !== 'callee' || !call.pc) break
        await call.pc.setRemoteDescription(m.sdp); call.haveRemoteDesc = true; await flushIce()
        { const a = await call.pc.createAnswer(); await call.pc.setLocalDescription(a); send(call.peer, { type: 'answer', id: call.id, sdp: call.pc.localDescription.toJSON ? call.pc.localDescription.toJSON() : call.pc.localDescription }) }
        break
      case 'answer':
        if (call.role !== 'caller' || !call.pc) break
        await call.pc.setRemoteDescription(m.sdp); call.haveRemoteDesc = true; await flushIce(); break
      case 'ice':
        if (call.pc && call.haveRemoteDesc) { try { await call.pc.addIceCandidate(m.candidate) } catch { /* late candidate */ } }
        else call.pendingIce.push(m.candidate)
        break
      case 'decline': finish('declined', false); break
      case 'busy': finish('busy', false); break
      case 'cancel': finish('missed', false); break
      case 'end': finish('ended', false); break
    }
  }
  async function flushIce() { while (call && call.pendingIce.length) { try { await call.pc.addIceCandidate(call.pendingIce.shift()) } catch { /* ignore */ } } }

  // ---------- one call ----------
  function newCall(id, peer, video, role) {
    return { id, peer, video, role, pc: null, local: null, remote: null, state: 'calling', timer: null, startedAt: 0, tick: null, pendingIce: [], haveRemoteDesc: false, facing: 'user' }
  }
  async function getMedia(video, facing) {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: facing || 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    })
  }
  function makePC() {
    const pc = new RTCPeerConnection(ICE)
    call.local.getTracks().forEach(tr => pc.addTrack(tr, call.local))
    pc.onicecandidate = (e) => { if (e.candidate && call) send(call.peer, { type: 'ice', id: call.id, candidate: e.candidate.toJSON() }) }
    pc.ontrack = (e) => {
      call.remote = e.streams[0]
      elAudio.srcObject = call.remote
      elAudio.play().catch(() => {})
      if (call.video) { elRemote.srcObject = call.remote; elRemote.play().catch(() => {}) }
    }
    pc.onconnectionstatechange = () => {
      if (!call) return
      const s = pc.connectionState
      if (s === 'connected') onConnected()
      else if (s === 'disconnected') setState('Connection weak…')
      else if (s === 'failed') { t('Call lost. Check your internet.'); finish('failed', true) }
    }
    call.pc = pc
    return pc
  }
  function onConnected() {
    if (!call || call.startedAt) return
    call.startedAt = Date.now(); ringtone(false)
    root.classList.remove('ringing'); root.classList.add('live')
    clearTimeout(call.timer)
    const upd = () => { const s = Math.floor((Date.now() - call.startedAt) / 1000); setState(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'), true) }
    upd(); call.tick = setInterval(upd, 1000)
  }

  // caller: starts to ring
  async function start(peer, video) {
    if (call) { t('You are already in a call.'); return }
    if (!navigator.mediaDevices || !window.RTCPeerConnection) { t('Calls are not supported on this phone.'); return }
    if (!navigator.onLine) { t('No internet.'); return }
    const c = newCall(crypto.randomUUID(), peer, !!video, 'caller')
    call = c
    showUI(); setState('Starting…')
    try { c.local = await getMedia(c.video) }
    catch (e) { t(c.video ? 'Allow camera and microphone to call.' : 'Allow the microphone to call.'); finish('failed', false, true); return }
    if (call !== c) { c.local.getTracks().forEach(x => x.stop()); return }
    setState('Calling…'); ringtone(true, true)
    if (c.video) elLocal.srcObject = c.local
    send(peer, { type: 'ring', id: c.id, video: c.video })
    notifyServer(supabase, { type: 'call', to: peer, id: c.id, state: 'ring', video: c.video })       // phone notification if his app is closed
    c.ringer = setInterval(() => { if (call === c && !c.startedAt && !c.pc) send(peer, { type: 'ring', id: c.id, video: c.video }); else clearInterval(c.ringer) }, 3000)
    c.timer = setTimeout(() => { if (call === c && !c.startedAt) { t('No answer.'); finish('missed', true) } }, RING_TIMEOUT)
  }
  // caller: the other person answered -> make the offer
  async function startOffer() {
    if (!call || call.pc) return
    clearTimeout(call.timer); setState('Connecting…'); ringtone(false)
    const pc = makePC()
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer)
    send(call.peer, { type: 'offer', id: call.id, sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription })
    call.timer = setTimeout(() => { if (call && !call.startedAt) { t('Could not connect.'); finish('failed', true) } }, 25000)
  }
  // callee: pressed "answer"
  async function accept() {
    if (!call || call.role !== 'callee' || call.pc) return
    ringtone(false); setState('Connecting…'); clearTimeout(call.timer)
    try { call.local = await getMedia(call.video) }
    catch (e) { t(call.video ? 'Allow camera and microphone to answer.' : 'Allow the microphone to answer.'); finish('declined', true); return }
    if (call.video) elLocal.srcObject = call.local
    makePC(); syncButtons()
    send(call.peer, { type: 'accept', id: call.id })
    call.timer = setTimeout(() => { if (call && !call.startedAt) { t('Could not connect.'); finish('failed', true) } }, 30000)
  }
  function decline() { finish('declined', true) }

  // ends the call; "notify" = tell the other phone
  function finish(why, notify, silentNoUI) {
    const c = call; if (!c) return
    call = null
    ended.add(c.id); if (ended.size > 50) ended.delete(ended.values().next().value)
    clearTimeout(c.timer); clearInterval(c.tick); clearInterval(c.ringer); ringtone(false)
    if (notify) {
      const type = c.startedAt || c.pc ? 'end' : (c.role === 'caller' ? 'cancel' : 'decline')
      send(c.peer, { type, id: c.id })
      // nobody answered: his ringing notification turns into "Missed call"
      if (type === 'cancel') notifyServer(supabase, { type: 'call', to: c.peer, id: c.id, state: 'missed', video: c.video })
    }
    try { c.pc && c.pc.close() } catch { /* closed */ }
    ;[c.local, c.remote].forEach(s => s && s.getTracks().forEach(x => x.stop()))
    elRemote.srcObject = null; elLocal.srcObject = null; elAudio.srcObject = null
    const secs = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0
    // a line in the chat, so both people see what happened (uses the normal "message" table)
    if (c.role === 'caller' && !silentNoUI) {
      const kind = c.video ? 'Video call' : 'Voice call'
      let content = null
      if (secs) content = `📞 ${kind} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
      else if (why === 'missed') content = `📞 Missed ${kind.toLowerCase()}`
      else if (why === 'declined' || why === 'busy') content = `📞 ${kind} declined`
      if (content) supabase.from('message').insert([{ client_id: crypto.randomUUID(), sender_id: me, receiver_id: c.peer, content }]).then(() => { flush && flush() })
    }
    const msg = { declined: 'Call declined', busy: 'Line is busy', failed: '', missed: '', ended: secs ? 'Call ended' : '' }[why]
    if (msg && !silentNoUI) { setState(msg); setTimeout(() => { if (!call) root.classList.remove('on', 'live', 'video', 'ringing') }, 900) }
    else root.classList.remove('on', 'live', 'video', 'ringing')
  }

  // ---------- screen ----------
  function showUI() {
    const p = (getProfile && getProfile(call.peer)) || {}
    $('.kcName').textContent = p.full_name || ''
    $('.kcAva').style.backgroundImage = p.profile_pic ? `url("${String(p.profile_pic).replace(/"/g, '%22')}")` : 'none'
    root.className = 'on ringing' + (call.video ? ' video' : '')
    syncButtons()
  }
  function syncButtons() {
    const incoming = call && call.role === 'callee' && !call.pc
    $('[data-a=accept]').classList.toggle('hide', !incoming)
    $('[data-a=mute]').classList.toggle('hide', !!incoming)
    $('[data-a=flip]').classList.toggle('hide', !(call && call.video && !incoming))
    $('[data-a=mute]').classList.remove('on'); $('[data-a=mute]').innerHTML = ICONS.mic
  }
  function setState(txt, live) { if (call) call.state = txt === 'Calling…' ? 'calling' : call.state; $('.kcState').textContent = txt }
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return
    const a = b.dataset.a
    if (a === 'end') { if (call && call.role === 'callee' && !call.pc) decline(); else finish('ended', true) }
    else if (a === 'accept') accept()
    else if (a === 'mute' && call && call.local) {
      const on = !b.classList.contains('on'); b.classList.toggle('on', on)
      call.local.getAudioTracks().forEach(tr => { tr.enabled = !on }); b.innerHTML = on ? ICONS.micoff : ICONS.mic
    } else if (a === 'flip' && call && call.local && call.pc) {
      try {
        call.facing = call.facing === 'user' ? 'environment' : 'user'
        const ns = await getMedia(true, call.facing)
        const nt = ns.getVideoTracks()[0]
        const sender = call.pc.getSenders().find(s => s.track && s.track.kind === 'video')
        if (sender) await sender.replaceTrack(nt)
        call.local.getVideoTracks().forEach(x => { x.stop(); call.local.removeTrack(x) })
        call.local.addTrack(nt); elLocal.srcObject = call.local
        elLocal.style.transform = call.facing === 'user' ? 'scaleX(-1)' : 'none'
        ns.getAudioTracks().forEach(x => x.stop())
      } catch { t('Could not switch the camera.') }
    }
  })

  // ---------- ringtone (made with the browser, no sound file needed) ----------
  let actx = null, ringTimer = null
  function ringtone(on, caller) {
    clearInterval(ringTimer); ringTimer = null
    if (!on) return
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)()
      if (actx.state === 'suspended') actx.resume()
      const beep = () => {
        if (!actx) return
        const o = actx.createOscillator(), g = actx.createGain(), n = actx.currentTime
        o.frequency.value = caller ? 425 : 880; g.gain.setValueAtTime(0.0001, n)
        g.gain.exponentialRampToValueAtTime(caller ? 0.08 : 0.25, n + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, n + (caller ? 1.0 : 0.45))
        o.connect(g); g.connect(actx.destination); o.start(n); o.stop(n + 1.1)
      }
      beep(); ringTimer = setInterval(beep, caller ? 3000 : 1400)
    } catch { /* no sound */ }
  }

  window.addEventListener('pagehide', () => { if (call) finish('ended', true, true) })

  return {
    start,
    busy: () => !!call,
    destroy() {
      if (call) finish('ended', true, true)
      try { supabase.removeChannel(myCh) } catch { /* gone */ }
      Object.values(out).forEach(ch => { try { supabase.removeChannel(ch) } catch { /* gone */ } })
      root.remove(); style.remove()
    }
  }
}

// the two buttons shown in the chat header
export function callButtonsHTML(peerId) {
  const id = esc(peerId)
  return `<button class="kcCallBtn" aria-label="Voice call" onclick="kcCall('${id}',false)">${ICONS.phone}</button>
          <button class="kcCallBtn" aria-label="Video call" onclick="kcCall('${id}',true)">${ICONS.video}</button>`
}
