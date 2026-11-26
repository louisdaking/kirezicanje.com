'use strict'
const sb = require('./sb')

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}
const fail = (res, status, message) => send(res, status, { ok: false, error: message })

function bodyOf(req) {
  const b = req.body
  if (!b) return {}
  if (typeof b === 'string') { try { return JSON.parse(b) } catch { return {} } }
  return typeof b === 'object' ? b : {}
}

// the app and the API live on the same Vercel domain, so cross-site browser calls are refused
function sameSite(req) {
  const origin = req.headers.origin
  if (!origin) return true                       // same-origin GETs / server calls carry no Origin
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function requireUser(req, res) {
  if (!sb.ready()) { fail(res, 500, 'Server is not configured'); return null }
  if (!sameSite(req)) { fail(res, 403, 'Forbidden'); return null }
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  const user = await sb.userFromToken(token)
  if (!user) { fail(res, 401, 'Please log in again'); return null }
  return user
}

async function requireAdmin(req, res) {
  const user = await requireUser(req, res)
  if (!user) return null
  const rows = await sb.select('monetization_admins', { user_id: 'eq.' + user.id }, { select: 'user_id' })
  if (!rows.length) { fail(res, 403, 'Not authorized'); return null }
  return user
}

// small in-memory limiter (per server instance: slows abuse; the database still enforces the real limits)
const buckets = new Map()
function limited(key, max, windowMs) {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now - b.t > windowMs) { buckets.set(key, { t: now, n: 1 }); if (buckets.size > 5000) buckets.clear(); return false }
  b.n++
  return b.n > max
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v) => typeof v === 'string' && UUID.test(v)

// maps database errors to safe, human text (never leaks SQL)
function safeMessage(e) {
  const m = String((e && e.message) || '')
  const known = ['monetization is disabled', 'only approved creators', 'invalid amount', 'minimum withdrawal',
    'payment method not supported', 'payment details required', 'insufficient available balance',
    'already distributed', 'no verified revenue', 'provider approval', 'cannot change', 'payment reference required',
    'reason required', 'only under-review', 'does not meet every requirement', 'withdrawal not found', 'invalid status']
  return known.some(k => m.includes(k)) ? m : 'Something went wrong. Please try again.'
}

module.exports = { send, fail, bodyOf, requireUser, requireAdmin, limited, isUuid, safeMessage, sameSite }
