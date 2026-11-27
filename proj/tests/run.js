'use strict'
// node tests/run.js   - no packages, no network: Supabase and the push services are simulated.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const vm = require('vm')
const wp = require('../api/_lib/webpush')

let passed = 0
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ' + name) } catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1 } }
const u = (s) => Buffer.from(s, 'base64url')
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()

function runPageCache({ authenticated, snapshot = null, authUserId = 'user-1' } = {}) {
  const storage = {}
  const authStorage = { [`sb-test-auth-token`]: JSON.stringify({ user: { id: authUserId } }) }
  Object.defineProperties(authStorage, {
    length: { get() { return Object.keys(this).length } },
    key: { value(index) { return Object.keys(this)[index] || null } },
    getItem: { value(key) { return Object.hasOwn(this, key) ? this[key] : null } }
  })
  Object.defineProperties(storage, {
    getItem: { value(key) { return Object.hasOwn(this, key) ? this[key] : null } },
    setItem: { value(key, value) { this[key] = String(value) } },
    removeItem: { value(key) { delete this[key] } }
  })
  const shell = {
    innerHTML: '',
    dataset: {},
    querySelectorAll: () => [],
    cloneNode() {
      snapshotWelcome = {
        hidden: false,
        open: true,
        ariaHidden: 'false',
        classList: { remove(name) { if (name === 'open') snapshotWelcome.open = false } },
        setAttribute(name, value) { if (name === 'aria-hidden') snapshotWelcome.ariaHidden = value }
      }
      return { innerHTML: this.innerHTML, querySelector: () => snapshotWelcome }
    }
  }
  let snapshotWelcome = null
  const handlers = {}
  const sandbox = {
    URL,
    location: { href: 'https://kirezicanje.com/messages.html?chat=ana', pathname: '/messages.html', search: '?chat=ana' },
    sessionStorage: storage,
    localStorage: authStorage,
    document: {
      getElementById: () => shell,
      documentElement: { classList: { contains: () => authenticated } }
    },
    window: { addEventListener: (name, handler) => { handlers[name] = handler }, scrollY: 0, scrollTo() {} },
    console: { warn() {} }
  }
  const key = 'kc-page-snapshot:v4:/messages.html?chat=ana'
  if (snapshot) storage[key] = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)
  vm.runInNewContext(fs.readFileSync(require.resolve('../page-cache.js'), 'utf8'), sandbox)
  return { shell, handlers, storage, key, window: sandbox.window, snapshotWelcome: () => snapshotWelcome }
}

// a phone: makes its own keys and can decrypt what the server sends (written separately from the server code, straight from RFC 8291 section 3.4)
function makePhone() {
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const auth = crypto.randomBytes(16)
  return {
    p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url'),
    decrypt(body) {
      const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen)
      const secret = e.computeSecret(asPub)
      const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), e.getPublicKey(), asPub, Buffer.from([1])])).subarray(0, 32)
      const prk = hmac(salt, ikm)
      const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
      const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
      d.setAuthTag(ct.subarray(ct.length - 16))
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
      assert.strictEqual(plain[plain.length - 1], 2, 'padding delimiter')
      return JSON.parse(plain.subarray(0, plain.length - 1).toString())
    }
  }
}

// server keys
const vk = crypto.createECDH('prime256v1'); vk.generateKeys()
process.env.VAPID_PUBLIC_KEY = vk.getPublicKey().toString('base64url')
process.env.VAPID_PRIVATE_KEY = vk.getPrivateKey().toString('base64url')
process.env.VAPID_SUBJECT = 'mailto:test@example.com'
process.env.SUPABASE_URL = 'https://fake.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

// ---------------------------------------------------------------- the fake world
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const ME = uid(1), ANA = uid(2), BOB = uid(3), CARL = uid(4)     // Me & Bob = boys, Ana = girl, Carl = boy
const world = {
  tokens: { tokME: ME, tokANA: ANA, tokBOB: BOB, tokCARL: CARL },
  users: {}, tables: { profiles: [], message: [], posts: [], post_likes: [], follows: [] }, phones: {}, pushLog: [], deadEndpoints: new Set()
}
function addUser(id, name, sex, ageDays = 0, phones = 0) {
  world.users[id] = { id, email: id + '@gmail.com', created_at: new Date(Date.now() - ageDays * 86400000).toISOString(), app_metadata: {}, user_metadata: { full_name: name, sex, age: 22, address: 'Bujumbura' } }
  world.tables.profiles.push({ id, full_name: name, sex, profile_pic: 'https://img.example/' + name + '.jpg' })
  for (let i = 0; i < phones; i++) addPhone(id)
}
function addPhone(id) {
  const ph = makePhone(), endpoint = 'https://fcm.googleapis.com/fcm/send/' + crypto.randomBytes(8).toString('hex')
  world.phones[endpoint] = ph
  const meta = world.users[id].app_metadata
  meta.kc_push = [{ e: endpoint, p: ph.p256dh, a: ph.auth, t: Date.now() }, ...(meta.kc_push || [])]
  return endpoint
}
const reset = () => {
  world.users = {}; world.phones = {}; world.pushLog = []; world.deadEndpoints = new Set()
  for (const k of Object.keys(world.tables)) world.tables[k] = []
  addUser(ME, 'Me', 'umuhungu', 0, 0)
  addUser(ANA, 'Ana', 'umukobwa', 30, 1)
  addUser(BOB, 'Bob', 'umuhungu', 30, 1)
  addUser(CARL, 'Carl', 'umugabo', 30, 0)
}

function filterRows(rows, params) {
  return rows.filter(r => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue
      if (v.startsWith('eq.')) { if (String(r[k]) !== v.slice(3)) return false }
      else if (v.startsWith('in.(')) { if (!v.slice(4, -1).split(',').includes(String(r[k]))) return false }
    }
    return true
  })
}
const json = (status, data) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data), json: async () => data })

global.fetch = async (url, opts = {}) => {
  const U = new URL(url), method = opts.method || 'GET'
  if (U.hostname === 'fake.supabase.co') {
    const auth = (opts.headers || {}).Authorization || ''
    if (U.pathname === '/auth/v1/user') {
      const id = world.tokens[auth.replace('Bearer ', '')]
      return id ? json(200, { id, email: world.users[id].email, created_at: world.users[id].created_at }) : json(401, { msg: 'bad token' })
    }
    let m = U.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/)
    if (m) {
      const usr = world.users[decodeURIComponent(m[1])]
      if (!usr) return json(404, { msg: 'not found' })
      if (method === 'PUT') { const b = JSON.parse(opts.body); usr.app_metadata = { ...usr.app_metadata, ...b.app_metadata } }
      return json(200, usr)
    }
    if (U.pathname === '/auth/v1/admin/users') {
      const per = +U.searchParams.get('per_page'), page = +U.searchParams.get('page')
      return json(200, { users: Object.values(world.users).slice((page - 1) * per, page * per) })
    }
    m = U.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m) {
      const rows = filterRows(world.tables[m[1]] || [], U.searchParams)
      const lim = +U.searchParams.get('limit') || rows.length
      return json(200, rows.slice(0, lim))
    }
    throw new Error('unexpected supabase call ' + url)
  }
  const ph = world.phones[url]                                  // a push service
  if (ph) {
    if (world.deadEndpoints.has(url)) return json(410, {})
    const h = opts.headers
    assert.ok(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(h.Authorization), 'vapid header')
    assert.strictEqual(h['Content-Encoding'], 'aes128gcm')
    world.pushLog.push({ endpoint: url, ttl: +h.TTL, urgency: h.Urgency, msg: ph.decrypt(Buffer.from(opts.body)), headers: h })
    return json(201, {})
  }
  throw new Error('unexpected fetch ' + url)
}

// ---------------------------------------------------------------- tiny req / res
function call(handler, { method = 'POST', token, body, origin } = {}) {
  return new Promise(async (resolve) => {
    const res = { code: 0, headers: {}, status(c) { this.code = c; return this }, setHeader(k, v) { this.headers[k] = v; return this }, end(t) { resolve({ code: this.code, body: t ? JSON.parse(t) : null }) } }
    await handler({ method, headers: { authorization: token ? 'Bearer ' + token : '', host: 'kirezicanje.com', ...(origin ? { origin } : {}) }, body }, res)
  })
}
const notify = require('../api/notify')
const pushApi = require('../api/push')
const subs = require('../api/_lib/subs')
const N = (token, body) => call(notify, { token, body })

;(async () => {
  const messagePolicy = await import('../message-policy.mjs')
  console.log('message policy')
  await test('inbox rejects numbers and links', () => {
    assert.strictEqual(messagePolicy.inboxPolicyError('hello'), '')
    assert.strictEqual(messagePolicy.inboxPolicyError('call me on 123'), 'Numbers are not allowed in messages.')
    assert.strictEqual(messagePolicy.inboxPolicyError('visit example.com'), 'Links are not allowed in messages.')
    assert.strictEqual(messagePolicy.inboxPolicyError('https://example.com'), 'Links are not allowed in messages.')
    assert.strictEqual(messagePolicy.inboxPolicyError('www.example.com'), 'Links are not allowed in messages.')
  })
  console.log('page snapshots')
  await test('restores a visited page immediately and refreshes its snapshot on navigation', () => {
    const cache = runPageCache({ authenticated: true, snapshot: { userId: 'user-1', html: '<main>last visit</main>' + '<i></i>'.repeat(200) } })
    assert.ok(cache.shell.innerHTML.startsWith('<main>last visit</main>'))
    cache.shell.innerHTML = '<main>latest visit</main>'
    cache.handlers.pagehide()
    assert.strictEqual(JSON.parse(cache.storage[cache.key]).html, '<main>latest visit</main>')
    assert.strictEqual(JSON.parse(cache.storage[cache.key]).userId, 'user-1')
    assert.strictEqual(cache.snapshotWelcome().hidden, true)
    assert.strictEqual(cache.snapshotWelcome().open, false)
    assert.strictEqual(cache.snapshotWelcome().ariaHidden, 'true')
    cache.window.kcClearPageCache()
    assert.strictEqual(cache.storage[cache.key], undefined)
  })
  await test('does not save unauthenticated page content', () => {
    const cache = runPageCache({ authenticated: false })
    cache.shell.innerHTML = '<main>private content</main>'
    cache.handlers.pagehide()
    assert.strictEqual(cache.storage[cache.key], undefined)
  })
  await test('does not restore a snapshot owned by another signed-in user', () => {
    const cache = runPageCache({ authenticated: true, authUserId: 'user-2', snapshot: { userId: 'user-1', html: '<main>private</main>' + '<i></i>'.repeat(200) } })
    assert.strictEqual(cache.shell.innerHTML, '')
    assert.strictEqual(cache.storage[cache.key], undefined)
  })
  await test('does not restore a private page snapshot without a signed-in user', () => {
    const cache = runPageCache({ authenticated: true, authUserId: null, snapshot: { userId: 'user-1', html: '<main>private</main>' + '<i></i>'.repeat(200) } })
    assert.strictEqual(cache.shell.innerHTML, '')
    assert.strictEqual(cache.storage[cache.key], undefined)
  })

  console.log('crypto')
  await test('RFC 8291 test vector: secret, key material and nonce are exactly the RFC values', () => {
    const e = crypto.createECDH('prime256v1'); e.setPrivateKey(u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'))
    const ua = u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4')
    const out = wp.encrypt(Buffer.from('When I grow up, I want to be a watermelon'), ua.toString('base64url'), 'BTBZMqHH6r4Tts7J_aSIgg',
      { asPrivate: e.getPrivateKey(), salt: u('DGv6ra1nlYgDCS1FRnbzlw') })
    assert.strictEqual(out.subarray(0, 16).toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlw')                    // salt
    assert.strictEqual(out.subarray(21, 86).toString('base64url'), 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8')   // sender public key
    const secret = e.computeSecret(ua)
    assert.strictEqual(secret.toString('base64url'), 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs')
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, u('BTBZMqHH6r4Tts7J_aSIgg'), Buffer.concat([Buffer.from('WebPush: info\0'), ua, e.getPublicKey()]), 32))
    assert.strictEqual(ikm.toString('base64url'), 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg')
    assert.strictEqual(Buffer.from(crypto.hkdfSync('sha256', ikm, u('DGv6ra1nlYgDCS1FRnbzlw'), Buffer.from('Content-Encoding: nonce\0'), 12)).toString('base64url'), '4h_95klXJ5E_qnoN')
  })
  await test('a phone (independent decryptor) reads what the server encrypts, incl. emoji', () => {
    const ph = makePhone()
    const msg = { kc: 1, title: 'Ana ❤️', body: 'Muraho 👋 ' + 'x'.repeat(300) }
    assert.deepStrictEqual(ph.decrypt(wp.encrypt(Buffer.from(JSON.stringify(msg)), ph.p256dh, ph.auth)), msg)
  })
  await test('a wrong phone key cannot read it', () => {
    const a = makePhone(), b = makePhone()
    assert.throws(() => b.decrypt(wp.encrypt(Buffer.from('{"a":1}'), a.p256dh, a.auth)))
  })
  await test('VAPID signature verifies with the public key, audience = push service', () => {
    const h = wp.vapidHeader('https://fcm.googleapis.com/fcm/send/abc')
    const [, jwt, k] = h.match(/^vapid t=(\S+), k=(\S+)$/)
    assert.strictEqual(k, process.env.VAPID_PUBLIC_KEY)
    const [hd, bd, sg] = jwt.split('.')
    const raw = u(k), pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } })
    assert.ok(crypto.verify('sha256', Buffer.from(hd + '.' + bd), { key: pub, dsaEncoding: 'ieee-p1363' }, u(sg)))
    const c = JSON.parse(u(bd)); assert.strictEqual(c.aud, 'https://fcm.googleapis.com'); assert.ok(c.exp > Date.now() / 1000); assert.strictEqual(c.sub, 'mailto:test@example.com')
  })
  await test('only real push services are allowed (no calls to other sites)', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/x']) assert.ok(wp.endpointAllowed(ok), ok)
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.com/', 'https://fcm.googleapis.com.evil.com/', 'https://169.254.169.254/', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8080/x', 'nonsense']) assert.ok(!wp.endpointAllowed(bad), bad)
  })

  console.log('phones (subscribe)')
  reset()
  await test('GET /api/push gives the public key; without keys it says "not set up"', async () => {
    assert.strictEqual((await call(pushApi, { method: 'GET' })).body.key, process.env.VAPID_PUBLIC_KEY)
    const k = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY
    assert.strictEqual((await call(pushApi, { method: 'GET' })).code, 503)
    process.env.VAPID_PRIVATE_KEY = k
  })
  await test('subscribe stores the phone for the logged-in user only; bad token / bad endpoint refused', async () => {
    const ph = makePhone(), ep = 'https://fcm.googleapis.com/fcm/send/mine'
    world.phones[ep] = ph
    const sub = { endpoint: ep, keys: { p256dh: ph.p256dh, auth: ph.auth } }
    assert.strictEqual((await call(pushApi, { token: 'nope', body: { action: 'subscribe', subscription: sub } })).code, 401)
    assert.strictEqual((await call(pushApi, { token: 'tokME', body: { action: 'subscribe', subscription: { ...sub, endpoint: 'https://evil.com/x' } } })).code, 400)
    assert.strictEqual((await call(pushApi, { token: 'tokME', origin: 'https://evil.com', body: { action: 'subscribe', subscription: sub } })).code, 403)
    assert.strictEqual((await call(pushApi, { token: 'tokME', body: { action: 'subscribe', subscription: sub } })).code, 200)
    assert.strictEqual(world.users[ME].app_metadata.kc_push[0].e, ep)
    await call(pushApi, { token: 'tokME', body: { action: 'subscribe', subscription: sub } })               // twice = still one phone
    assert.strictEqual(world.users[ME].app_metadata.kc_push.length, 1)
    assert.strictEqual((await call(pushApi, { token: 'tokME', body: { action: 'unsubscribe', endpoint: ep } })).code, 200)
    assert.strictEqual(world.users[ME].app_metadata.kc_push.length, 0)
  })
  await test('"test" action: reports every phone and forgets the dead ones', async () => {
    reset()
    const dead = addPhone(ME), alive = addPhone(ME); world.deadEndpoints.add(dead)
    const r = await call(pushApi, { token: 'tokME', body: { action: 'test' } })
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.phones, 2); assert.deepStrictEqual(r.body.gone, [dead])
    assert.deepStrictEqual(world.users[ME].app_metadata.kc_push.map(s => s.e), [alive])
    assert.strictEqual(world.pushLog.at(-1).msg.force, 1)
  })
  await test('at most 5 phones per user (oldest dropped)', async () => {
    reset()
    for (let i = 0; i < 7; i++) { const ph = makePhone(); await subs.saveSub(ME, { endpoint: 'https://fcm.googleapis.com/fcm/send/p' + i, p256dh: ph.p256dh, auth: ph.auth }) }
    const l = world.users[ME].app_metadata.kc_push
    assert.strictEqual(l.length, 5); assert.ok(l[0].e.endsWith('p6') && !l.some(s => s.e.endsWith('p0')))
  })

  console.log('1) message')
  reset()
  await test('message -> the receiver gets name + text, tap opens the chat; sender is never notified', async () => {
    const cid = crypto.randomUUID()
    world.tables.message.push({ id: 1, client_id: cid, sender_id: BOB, receiver_id: ANA, content: 'Muraho Ana, amakuru?', created_at: new Date().toISOString() })
    const r = await N('tokBOB', { type: 'message', to: ANA, client_id: cid })
    assert.strictEqual(r.body.sent, 1)
    const p = world.pushLog[0]
    assert.strictEqual(p.msg.title, 'Bob'); assert.strictEqual(p.msg.body, 'Muraho Ana, amakuru?'); assert.strictEqual(p.msg.url, '/?chat=' + BOB)
    assert.strictEqual(p.msg.tag, 'msg-' + BOB); assert.strictEqual(p.msg.icon, 'https://img.example/Bob.jpg'); assert.strictEqual(p.urgency, 'high'); assert.strictEqual(p.msg.kc, 1)
    assert.strictEqual(world.pushLog.length, 1)
  })
  await test('same message announced twice -> only once', async () => {
    const cid = world.tables.message[0].client_id
    assert.strictEqual((await N('tokBOB', { type: 'message', to: ANA, client_id: cid })).body.sent, 0)
    assert.strictEqual(world.pushLog.length, 1)
  })
  await test('voice message and file messages show a readable text', async () => {
    const c1 = crypto.randomUUID(), c2 = crypto.randomUUID()
    world.tables.message.push({ id: 2, client_id: c1, sender_id: BOB, receiver_id: ANA, content: '🎤 Voice message', audio_url: 'https://x/v.webm', created_at: new Date().toISOString() })
    world.tables.message.push({ id: 3, client_id: c2, sender_id: BOB, receiver_id: ANA, content: '📷 Photo', file_url: 'https://x/p.jpg', created_at: new Date().toISOString() })
    await N('tokBOB', { type: 'message', to: ANA, client_id: c1 }); await N('tokBOB', { type: 'message', to: ANA, client_id: c2 })
    assert.deepStrictEqual(world.pushLog.slice(1).map(p => p.msg.body), ['🎤 Voice message', '📷 Photo'])
  })
  await test('FAKE message (nothing in the database) -> nobody is notified', async () => {
    const before = world.pushLog.length
    assert.strictEqual((await N('tokBOB', { type: 'message', to: ANA, client_id: crypto.randomUUID() })).body.sent, 0)
    assert.strictEqual((await N('tokBOB', { type: 'message', to: ANA })).body.sent, 0)
    assert.strictEqual(world.pushLog.length, before)
  })
  await test('long messages are shortened; messages to yourself / bad ids are ignored', async () => {
    const cid = crypto.randomUUID()
    world.tables.message.push({ id: 9, client_id: cid, sender_id: BOB, receiver_id: ANA, content: 'a'.repeat(900), created_at: new Date().toISOString() })
    await N('tokBOB', { type: 'message', to: ANA, client_id: cid })
    assert.ok(world.pushLog.at(-1).msg.body.length <= 140)
    const n = world.pushLog.length
    await N('tokBOB', { type: 'message', to: BOB }); await N('tokBOB', { type: 'message', to: 'x" or 1=1' })
    assert.strictEqual(world.pushLog.length, n)
  })

  console.log('2) like')
  reset()
  world.tables.posts.push({ id: 'p1', user_id: ANA }, { id: 'p2', user_id: BOB })
  await test('like -> the post owner is told who liked', async () => {
    world.tables.post_likes.push({ post_id: 'p1', user_id: BOB })
    assert.strictEqual((await N('tokBOB', { type: 'like', post_id: 'p1' })).body.sent, 1)
    const m = world.pushLog[0].msg
    assert.strictEqual(m.title, 'Bob liked your post ❤️'); assert.strictEqual(m.url, '/?user=' + BOB)
  })
  await test('like / unlike / like again -> one notification; own post -> none; fake like -> none', async () => {
    assert.strictEqual((await N('tokBOB', { type: 'like', post_id: 'p1' })).body.sent, 0)
    world.tables.post_likes.push({ post_id: 'p2', user_id: BOB })
    assert.strictEqual((await N('tokBOB', { type: 'like', post_id: 'p2' })).body.sent, 0)
    assert.strictEqual((await N('tokBOB', { type: 'like', post_id: 'p404' })).body.sent, 0)
    assert.strictEqual(world.pushLog.length, 1)
  })

  console.log('3) follow')
  reset()
  await test('follow -> the person is told; fake follow -> none', async () => {
    assert.strictEqual((await N('tokBOB', { type: 'follow', to: ANA })).body.sent, 0)                 // no row yet = fake
    world.tables.follows.push({ follower_id: BOB, following_id: ANA })
    assert.strictEqual((await N('tokBOB', { type: 'follow', to: ANA })).body.sent, 1)
    assert.strictEqual(world.pushLog[0].msg.title, 'Bob started following you 👤')
    assert.strictEqual((await N('tokBOB', { type: 'follow', to: ANA })).body.sent, 0)                 // repeated
    assert.strictEqual(world.pushLog.length, 1)
  })

  console.log('4) call')
  reset()
  await test('ring -> loud, stays on screen, 30 s TTL; missed call replaces it (same tag)', async () => {
    const id = crypto.randomUUID()
    assert.strictEqual((await N('tokBOB', { type: 'call', to: ANA, id, state: 'ring', video: true })).body.sent, 1)
    const r = world.pushLog[0]
    assert.strictEqual(r.msg.title, '📹 Bob is video calling you'); assert.strictEqual(r.msg.requireInteraction, true); assert.ok(r.msg.vibrate.length > 3)
    assert.strictEqual(r.ttl, 30); assert.strictEqual(r.urgency, 'high'); assert.strictEqual(r.msg.url, '/?chat=' + BOB)
    assert.strictEqual((await N('tokBOB', { type: 'call', to: ANA, id, state: 'ring', video: true })).body.sent, 0)   // same call: once
    assert.strictEqual((await N('tokBOB', { type: 'call', to: ANA, id, state: 'missed', video: true })).body.sent, 1)
    const m = world.pushLog[1]
    assert.strictEqual(m.msg.tag, r.msg.tag); assert.strictEqual(m.msg.title, '📵 Missed video call'); assert.ok(!m.msg.requireInteraction)
  })
  await test('voice call wording; calling yourself / spamming is limited', async () => {
    world.pushLog.length = 0
    await N('tokBOB', { type: 'call', to: ANA, id: 'c-voice', state: 'ring', video: false })
    assert.strictEqual(world.pushLog[0].msg.title, '📞 Bob is calling you')
    assert.strictEqual((await N('tokBOB', { type: 'call', to: BOB, id: 'c-self', state: 'ring' })).body.sent, 0)
    let total = 0
    for (let i = 0; i < 20; i++) total += (await N('tokBOB', { type: 'call', to: ANA, id: 'spam' + i, state: 'ring' })).body.sent
    assert.ok(total <= 8, 'limited, got ' + total)
  })

  console.log('5) new account')
  reset()
  addUser(uid(10), 'Zina', 'umukobwa', 0, 1)         // brand-new girl (she has a phone too)
  addUser(uid(11), 'Eve', 'umugore', 40, 2)          // a woman: must NOT be told about another girl
  addUser(uid(12), 'Dan', 'umugabo', 40, 1)          // a man with a phone: must be told
  world.tokens.tokZINA = uid(10)
  const phoneIds = (id) => (world.users[id].app_metadata.kc_push || []).map(s => s.e)
  await test('new girl -> only boys/men who have a phone are told (Bob, Dan); not girls, not herself', async () => {
    const r = await N('tokZINA', { type: 'newuser' })
    assert.strictEqual(r.body.people, 2); assert.strictEqual(r.body.sent, 2)
    const who = world.pushLog.map(p => p.endpoint).sort()
    assert.deepStrictEqual(who, [...phoneIds(BOB), ...phoneIds(uid(12))].sort())
    const m = world.pushLog[0].msg
    assert.strictEqual(m.title, '🔥 Zina just joined KIREZI CANJE'); assert.strictEqual(m.url, '/?user=' + uid(10)); assert.ok(m.body.includes('22 yrs'))
  })
  await test('the same account is announced only once (retry / second login)', async () => {
    const n = world.pushLog.length
    assert.strictEqual((await N('tokZINA', { type: 'newuser' })).body.skipped, 'already announced')
    assert.strictEqual(world.pushLog.length, n)
  })
  await test('new boy -> girls/women are told (Ana, Eve x2 phones)', async () => {
    addUser(uid(13), 'Tom', 'umuhungu', 0, 0); world.tokens.tokTOM = uid(13)
    world.pushLog.length = 0; subs.forgetIndex()
    const r = await N('tokTOM', { type: 'newuser' })
    assert.strictEqual(r.body.people, 3)               // Ana, Eve, Zina
    assert.strictEqual(r.body.sent, 4)                 // Ana 1 + Eve 2 + Zina 1 phones
  })
  await test('an old account (not new) never triggers an announcement; unknown sex neither', async () => {
    world.pushLog.length = 0
    assert.strictEqual((await N('tokBOB', { type: 'newuser' })).body.skipped, 'not new')
    addUser(uid(14), 'Who', '', 0, 0); world.tokens.tokWHO = uid(14)
    assert.strictEqual((await N('tokWHO', { type: 'newuser' })).body.skipped, 'unknown sex')
    assert.strictEqual(world.pushLog.length, 0)
  })

  console.log('safety nets')
  await test('a phone that was uninstalled (410) is forgotten automatically; the others still get it', async () => {
    reset()
    const dead = addPhone(ANA); const alive = addPhone(ANA)
    world.deadEndpoints.add(dead)
    const cid = crypto.randomUUID()
    world.tables.message.push({ id: 777, client_id: cid, sender_id: BOB, receiver_id: ANA, content: 'hi', created_at: new Date().toISOString() })
    assert.strictEqual((await N('tokBOB', { type: 'message', to: ANA, client_id: cid })).body.sent, 2)   // ANA had 1 + 2 added = 3 phones, 1 dead
    assert.ok(!phoneIds(ANA).includes(dead)); assert.ok(phoneIds(ANA).includes(alive)); assert.strictEqual(phoneIds(ANA).length, 2)
  })
  await test('not logged in -> 401; wrong method -> 405; unknown type -> nothing sent', async () => {
    assert.strictEqual((await call(notify, { token: 'bad', body: { type: 'message' } })).code, 401)
    assert.strictEqual((await call(notify, { method: 'GET', token: 'tokBOB' })).code, 405)
    assert.strictEqual((await N('tokBOB', { type: 'hack' })).body.skipped, 'unknown type')
  })
  await test('server without VAPID keys never breaks the app (200, nothing sent)', async () => {
    const k = process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_PRIVATE_KEY
    const r = await N('tokBOB', { type: 'follow', to: ANA })
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.skipped, 'not configured')
    process.env.VAPID_PRIVATE_KEY = k
  })
  await test('a crash inside the server is hidden from the app (still 200)', async () => {
    const real = global.fetch
    global.fetch = async (url, o) => { if (String(url).includes('/rest/v1/follows')) throw new Error('boom'); return real(url, o) }
    const r = await N('tokBOB', { type: 'follow', to: CARL })
    global.fetch = real
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.sent, 0)
  })

  console.log(`\n${passed} tests passed${process.exitCode ? ' — SOME FAILED' : ''}`)
})()
