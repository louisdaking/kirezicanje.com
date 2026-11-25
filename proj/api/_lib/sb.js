'use strict'
// Tiny Supabase client for the SERVER only (no dependencies). Uses the service-role key from Vercel env vars.
const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || ''

function ready() { return !!(URL_() && KEY()) }

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(URL_() + path, {
    method,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error_description || data.msg)) || ('Supabase error ' + res.status))
    err.status = res.status
    err.code = data && data.code
    throw err
  }
  return data
}

// who is calling? the browser sends its login token; Supabase tells us the real user. Nothing from the body is trusted.
async function userFromToken(token) {
  if (!token) return null
  try {
    const res = await fetch(URL_() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } })
    if (!res.ok) return null
    const u = await res.json()
    return u && u.id ? { id: u.id, email: u.email || null, created_at: u.created_at } : null
  } catch { return null }
}

const enc = encodeURIComponent
// select('creator_stats', { user_id: 'eq.' + id }, { select: '*', order: 'created_at.desc', limit: 20 })
const select = (table, filters = {}, opts = {}) => {
  const q = new URLSearchParams({ select: opts.select || '*' })
  for (const [k, v] of Object.entries(filters)) q.set(k, v)
  if (opts.order) q.set('order', opts.order)
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.offset) q.set('offset', String(opts.offset))
  return call(`/rest/v1/${enc(table)}?` + q.toString())
}
const insert = (table, rows, prefer = 'return=representation') =>
  call(`/rest/v1/${enc(table)}`, { method: 'POST', body: rows, headers: { Prefer: prefer } })
const upsert = (table, rows, onConflict) =>
  call(`/rest/v1/${enc(table)}?on_conflict=${enc(onConflict)}`, { method: 'POST', body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' } })
const update = (table, filters, patch) => {
  const q = new URLSearchParams(filters)
  return call(`/rest/v1/${enc(table)}?` + q.toString(), { method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } })
}
const rpc = (fn, args = {}) => call(`/rest/v1/rpc/${enc(fn)}`, { method: 'POST', body: args })

module.exports = { ready, userFromToken, select, insert, upsert, update, rpc }
