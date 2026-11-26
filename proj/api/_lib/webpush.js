'use strict'
// Web Push in plain Node.js (no npm package needed):
//   - VAPID  (RFC 8292): proves to Google / Apple / Mozilla that the message comes from YOUR server
//   - aes128gcm (RFC 8291): encrypts the message so only the user's phone can read it
// Keys live in Vercel env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  (make them with: node scripts/make-vapid-keys.js)
const crypto = require('crypto')

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url')

// the server only ever posts to the real push services (stops anybody from using this API to call other sites)
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,                    // Chrome, Edge, Brave, Samsung (Android + desktop)
  /(^|\.)push\.services\.mozilla\.com$/,       // Firefox
  /(^|\.)push\.apple\.com$/,                   // Safari / iPhone (app added to the home screen)
  /(^|\.)notify\.windows\.com$/                // Edge on Windows
]
function endpointAllowed(endpoint) {
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PUSH_HOSTS.some(r => r.test(u.hostname))
  } catch { return false }
}

const publicKey = () => (process.env.VAPID_PUBLIC_KEY || '').trim()
const configured = () => !!(publicKey() && (process.env.VAPID_PRIVATE_KEY || '').trim())

let keyCache = null
function privateKey() {
  const pub = publicKey(), d = (process.env.VAPID_PRIVATE_KEY || '').trim()
  if (keyCache && keyCache.pub === pub && keyCache.d === d) return keyCache.key
  const raw = unb64u(pub)
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a valid key')
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d } })
  keyCache = { pub, d, key }
  return key
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin
  const sub = (process.env.VAPID_SUBJECT || '').trim() || 'mailto:admin@kirezicanje.com'
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub }))
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKey(), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey()}`
}

const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len))

// encrypts one message for one phone (RFC 8291). `_t` is only for the tests (fixed keys).
function encrypt(plain, p256dh, auth, _t) {
  const ua = unb64u(p256dh), authSecret = unb64u(auth)
  if (ua.length !== 65 || ua[0] !== 4 || authSecret.length !== 16) throw new Error('bad subscription keys')
  if (plain.length > 3500) throw new Error('message too big')
  const ecdh = crypto.createECDH('prime256v1')
  if (_t && _t.asPrivate) ecdh.setPrivateKey(_t.asPrivate); else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(ua)
  const salt = (_t && _t.salt) || crypto.randomBytes(16)
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const data = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const head = Buffer.alloc(21)
  salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65
  return Buffer.concat([head, asPublic, data])
}

// sends one notification to one phone. Result: { ok, status, gone }  (gone = this phone is no longer subscribed)
async function send(sub, payload, { ttl = 3600, urgency = 'normal' } = {}) {
  if (!endpointAllowed(sub.endpoint)) return { ok: false, status: 400, gone: true }
  let body
  try { body = encrypt(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth) } catch { return { ok: false, status: 400, gone: true } }
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), body,
      headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency }
    })
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 }
  } catch (e) {
    return { ok: false, status: 0, gone: false }
  }
}

module.exports = { configured, publicKey, endpointAllowed, encrypt, send, vapidHeader, b64u, unb64u }
