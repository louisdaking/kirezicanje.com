'use strict'
// Phones <-> server.
//   GET  /api/push                                   -> { key }   the public key the phone needs to subscribe
//   POST /api/push {action:'subscribe', subscription}  -> remembers this phone for the logged-in user
//   POST /api/push {action:'unsubscribe', endpoint}    -> forgets this phone (logout)
// Identity ALWAYS comes from the verified login token.
const subs = require('./_lib/subs')
const wp = require('./_lib/webpush')
const { send, fail, bodyOf, requireUser, limited } = require('./_lib/http')

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!wp.configured()) return fail(res, 503, 'Notifications are not set up on the server yet')
      return send(res, 200, { ok: true, key: wp.publicKey() })
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return fail(res, 405, 'Method not allowed') }
    const user = await requireUser(req, res)
    if (!user) return
    if (limited('p:' + user.id, 30, 60_000)) return fail(res, 429, 'Too many requests')

    const b = bodyOf(req)
    if (b.action === 'subscribe') {
      const s = b.subscription || {}
      const k = s.keys || {}
      if (typeof s.endpoint !== 'string' || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || !wp.endpointAllowed(s.endpoint)) return fail(res, 400, 'Bad subscription')
      await subs.saveSub(user.id, { endpoint: s.endpoint, p256dh: k.p256dh, auth: k.auth })
      subs.forgetIndex()
      return send(res, 200, { ok: true })
    }
    if (b.action === 'test') {                       // "send me a test notification" (shows what each phone answered)
      if (limited('pt:' + user.id, 6, 60_000)) return fail(res, 429, 'Too many requests')
      const list = await subs.getSubs(user.id)
      const results = await Promise.all(list.map(s => wp.send({ endpoint: s.e, p256dh: s.p, auth: s.a },
        { kc: 1, force: 1, title: '🔔 KIREZI CANJE', body: 'Notifications work! ✅', tag: 'kc-test', url: '/' }, { ttl: 60, urgency: 'high' })))
      return send(res, 200, { ok: true, phones: list.length, status: results.map(r => r.status) })
    }
    if (b.action === 'unsubscribe') {
      if (typeof b.endpoint !== 'string') return fail(res, 400, 'Bad request')
      await subs.removeSubs(user.id, [b.endpoint])
      subs.forgetIndex()
      return send(res, 200, { ok: true })
    }
    return fail(res, 400, 'Bad request')
  } catch (e) {
    console.error('push api:', e.message)
    return fail(res, 500, 'Something went wrong. Please try again.')
  }
}
