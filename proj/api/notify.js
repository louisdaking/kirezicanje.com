'use strict'
// POST /api/notify  - the app says "I just did X"; the server CHECKS it really happened, then pushes a phone notification.
//   {type:'message', to, client_id}   someone sent you a message
//   {type:'like',    post_id}         someone liked your post
//   {type:'follow',  to}              someone follows you
//   {type:'call',    to, id, state:'ring'|'missed', video}   someone is calling you / you missed a call
//   {type:'newuser'}                  a new account was created -> people of the other sex are told
// Nothing from the body is trusted: the sender is always the logged-in user, and likes / follows / messages are looked up in the database first.
const sb = require('./_lib/sb')
const subs = require('./_lib/subs')
const wp = require('./_lib/webpush')
const { send, bodyOf, requireUser, limited, isUuid } = require('./_lib/http')

// ---- the words people see (change them here) ----
const T = {
  follow: (n) => ({ title: `${n} started following you 👤`, body: 'Tap to see the profile' }),
  like: (n) => ({ title: `${n} liked your post ❤️`, body: 'Tap to see who' }),
  ring: (n, video) => ({ title: `${video ? '📹' : '📞'} ${n} is ${video ? 'video ' : ''}calling you`, body: 'Tap to answer' }),
  missed: (n, video) => ({ title: `📵 Missed ${video ? 'video ' : ''}call`, body: `${n} tried to reach you` }),
  newuser: (n, extra) => ({ title: `🔥 ${n} just joined KIREZI CANJE`, body: (extra ? extra + ' · ' : '') + 'Say hi 👋' })
}
const NEW_ACCOUNT_DAYS = 3        // only brand-new accounts are announced
const MAX_RECIPIENTS = 1500       // one new account tells at most this many people

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const SAFE_ID = /^[\w-]{1,64}$/

// same rule as the feed: boys/men <-> girls/women
function sexGroup(sex) {
  const x = String(sex || '').trim().toLowerCase()
  if (x === 'umuhungu' || x === 'umugabo') return 'm'
  if (x === 'umukobwa' || x === 'umugore') return 'f'
  return ''
}

const profileOf = async (id) => (await sb.select('profiles', { id: 'eq.' + id }, { select: 'id,full_name,profile_pic,sex', limit: 1 }))[0] || null
const nameOf = (p) => clip((p && p.full_name) || 'Someone', 40)

// a message / call is announced once (this server instance remembers; the app also only sends once)
const seen = new Set()
function firstTime(key) {
  if (seen.has(key)) return false
  if (seen.size > 3000) seen.clear()
  seen.add(key)
  return true
}

const skip = (why) => ({ sent: 0, skipped: why })

// ---------- 1. message ----------
async function onMessage(me, b) {
  if (!isUuid(b.to) || b.to === me) return skip('bad')
  const f = { sender_id: 'eq.' + me, receiver_id: 'eq.' + b.to }
  if (isUuid(b.client_id)) f.client_id = 'eq.' + b.client_id
  const [m] = await sb.select('message', f, { select: '*', order: 'created_at.desc', limit: 1 })
  if (!m) return skip('no message')
  if (!isUuid(b.client_id) && Date.now() - Date.parse(m.created_at) > 5 * 60_000) return skip('old')
  if (!firstTime('m:' + (m.id != null ? m.id : b.client_id || m.created_at))) return skip('again')
  const p = await profileOf(me)
  const body = m.audio_url ? '🎤 Voice message' : m.file_url ? (m.content || '📎 File') : m.content
  const n = await subs.sendToUser(b.to, {
    kc: 1, type: 'message', title: nameOf(p), body: clip(body, 140) || 'New message', icon: p && p.profile_pic,
    tag: 'msg-' + me, url: '/?chat=' + me
  }, { ttl: 24 * 3600, urgency: 'high' })
  return { sent: n }
}

// ---------- 2. like ----------
async function onLike(me, b) {
  if (typeof b.post_id !== 'string' && typeof b.post_id !== 'number') return skip('bad')
  const postId = String(b.post_id)
  if (!SAFE_ID.test(postId)) return skip('bad')
  const [like] = await sb.select('post_likes', { post_id: 'eq.' + postId, user_id: 'eq.' + me }, { select: 'post_id', limit: 1 })
  if (!like) return skip('no like')
  const [post] = await sb.select('posts', { id: 'eq.' + postId }, { select: 'id,user_id', limit: 1 })
  if (!post || post.user_id === me) return skip('own post')
  if (limited('like:' + me + ':' + postId, 1, 10 * 60_000)) return skip('again')     // like / unlike / like again = one notification
  const p = await profileOf(me)
  const t = T.like(nameOf(p))
  const n = await subs.sendToUser(post.user_id, { kc: 1, type: 'like', ...t, icon: p && p.profile_pic, tag: 'like-' + postId, url: '/?user=' + me }, { ttl: 24 * 3600 })
  return { sent: n }
}

// ---------- 3. follow ----------
async function onFollow(me, b) {
  if (!isUuid(b.to) || b.to === me) return skip('bad')
  const [row] = await sb.select('follows', { follower_id: 'eq.' + me, following_id: 'eq.' + b.to }, { select: 'follower_id', limit: 1 })
  if (!row) return skip('no follow')
  if (limited('follow:' + me + ':' + b.to, 1, 10 * 60_000)) return skip('again')
  const p = await profileOf(me)
  const t = T.follow(nameOf(p))
  const n = await subs.sendToUser(b.to, { kc: 1, type: 'follow', ...t, icon: p && p.profile_pic, tag: 'follow-' + me, url: '/?user=' + me }, { ttl: 24 * 3600 })
  return { sent: n }
}

// ---------- 4. call ----------
async function onCall(me, b) {
  if (!isUuid(b.to) || b.to === me) return skip('bad')
  const state = b.state === 'missed' ? 'missed' : 'ring'
  const video = !!b.video
  if (typeof b.id !== 'string' || !SAFE_ID.test(b.id)) return skip('bad')
  if (!firstTime('c:' + b.id + ':' + state)) return skip('again')
  if (limited('call:' + me + ':' + b.to, 8, 60_000)) return skip('too many')
  const p = await profileOf(me)
  const base = { kc: 1, type: 'call', icon: p && p.profile_pic, tag: 'call-' + me, url: '/?chat=' + me }
  if (state === 'ring') {
    // rings for 30 seconds only: a ring that arrives late is useless. requireInteraction keeps it on screen, vibrate makes the phone buzz.
    const n = await subs.sendToUser(b.to, { ...base, ...T.ring(nameOf(p), video), requireInteraction: true, vibrate: [400, 200, 400, 200, 400, 200, 400] }, { ttl: 30, urgency: 'high' })
    return { sent: n }
  }
  // the same tag replaces the ringing notification by "missed call"
  const n = await subs.sendToUser(b.to, { ...base, ...T.missed(nameOf(p), video), requireInteraction: false }, { ttl: 24 * 3600, urgency: 'high' })
  return { sent: n }
}

// ---------- 5. new account ----------
async function onNewUser(me) {
  const full = await subs.getUser(me)
  const meta = (full && full.app_metadata) || {}
  if (meta.kc_announced) return skip('already announced')
  if (!(Date.now() - Date.parse(full.created_at) < NEW_ACCOUNT_DAYS * 86400_000)) return skip('not new')
  const p = await profileOf(me)
  const um = full.user_metadata || {}
  const mine = sexGroup((p && p.sex) || um.sex)
  if (!mine) return skip('unknown sex')
  await subs.setMeta(me, { kc_announced: true })                 // first, so a retry can never announce twice
  const want = mine === 'm' ? 'f' : 'm'

  const all = (await subs.allSubscribers({ fresh: true })).filter(r => r.id !== me)
  const sexOf = {}
  for (let i = 0; i < all.length; i += 150) {                     // the profile table is the truth about sex
    const ids = all.slice(i, i + 150).map(r => r.id)
    const rows = await sb.select('profiles', { id: 'in.(' + ids.join(',') + ')' }, { select: 'id,sex', limit: 150 })
    rows.forEach(r => { sexOf[r.id] = r.sex })
  }
  const targets = all.filter(r => sexGroup(sexOf[r.id] || r.metaSex) === want).slice(0, MAX_RECIPIENTS)

  const extra = [um.age ? um.age + ' yrs' : '', clip(um.address, 30)].filter(Boolean).join(' · ')
  const payload = { kc: 1, type: 'newuser', ...T.newuser(nameOf(p || { full_name: um.full_name }), extra), icon: p && p.profile_pic, tag: 'newuser-' + me, url: '/?user=' + me }

  const t0 = Date.now()
  let sent = 0, i = 0
  const worker = async () => {
    while (i < targets.length && Date.now() - t0 < 20_000) {
      const r = targets[i++]
      try { const n = await subs.pushTo(r.id, r.subs, payload, { ttl: 24 * 3600 }); sent += n } catch { /* one bad phone never stops the others */ }
    }
  }
  await Promise.all(Array.from({ length: 20 }, worker))
  return { sent, people: targets.length }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'Method not allowed' }) }
    const user = await requireUser(req, res)
    if (!user) return
    if (!wp.configured()) return send(res, 200, { ok: true, sent: 0, skipped: 'not configured' })
    if (limited('n:' + user.id, 120, 60_000)) return send(res, 200, { ok: true, sent: 0, skipped: 'slow down' })
    const b = bodyOf(req)
    const out =
      b.type === 'message' ? await onMessage(user.id, b) :
      b.type === 'like' ? await onLike(user.id, b) :
      b.type === 'follow' ? await onFollow(user.id, b) :
      b.type === 'call' ? await onCall(user.id, b) :
      b.type === 'newuser' ? await onNewUser(user.id) : skip('unknown type')
    return send(res, 200, { ok: true, ...out })
  } catch (e) {
    console.error('notify api:', e.message)
    return send(res, 200, { ok: true, sent: 0 })      // a notification problem must never disturb the app
  }
}
