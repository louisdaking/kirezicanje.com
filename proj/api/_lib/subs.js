'use strict'
// Where the phones are remembered.
// No new table and no SQL: every user's phones are kept inside his own login record (Supabase Auth "app_metadata").
// Only this server (service-role key) can read or write app_metadata, so a user can never edit it from the browser.
const sb = require('./sb')
const wp = require('./webpush')

const MAX_PHONES = 5                 // phones / browsers per user (the oldest one is dropped)
const enc = encodeURIComponent

const getUser = (id) => sb.call('/auth/v1/admin/users/' + enc(id))
const setMeta = (id, patch) => sb.call('/auth/v1/admin/users/' + enc(id), { method: 'PUT', body: { app_metadata: patch } })
const listUsers = (page, perPage) => sb.call(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`)

const clean = (list) => (Array.isArray(list) ? list : []).filter(s => s && s.e && s.p && s.a)
const asSub = (s) => ({ endpoint: s.e, p256dh: s.p, auth: s.a })

async function getSubs(userId) {
  try { return clean(((await getUser(userId)).app_metadata || {}).kc_push) } catch (e) { if (e.status === 404) return []; throw e }
}

async function saveSub(userId, { endpoint, p256dh, auth }) {
  if (!wp.endpointAllowed(endpoint)) throw new Error('bad endpoint')
  const keep = (await getSubs(userId)).filter(s => s.e !== endpoint)
  keep.unshift({ e: endpoint, p: p256dh, a: auth, t: Date.now() })
  await setMeta(userId, { kc_push: keep.slice(0, MAX_PHONES) })
}

async function removeSubs(userId, endpoints) {
  const gone = new Set(endpoints)
  const all = await getSubs(userId)
  const keep = all.filter(s => !gone.has(s.e))
  if (keep.length !== all.length) await setMeta(userId, { kc_push: keep })
}

// sends to every phone of one user, and forgets the phones that no longer exist
async function sendToUser(userId, payload, opts) {
  const list = await getSubs(userId)
  return pushTo(userId, list, payload, opts)
}
async function pushTo(userId, list, payload, opts) {
  if (!list.length) return 0
  const results = await Promise.all(list.map(s => wp.send(asSub(s), payload, opts)))
  const dead = list.filter((s, i) => results[i].gone).map(s => s.e)
  if (dead.length) { try { await removeSubs(userId, dead) } catch { /* next time */ } }
  return results.filter(r => r.ok).length
}

// everybody who has at least one phone registered: [{ id, subs, sex }]   (scans the users page by page)
const PAGE = 1000
let indexCache = { at: 0, rows: null }
async function allSubscribers({ maxMs = 12000, fresh = false } = {}) {
  if (!fresh && indexCache.rows && Date.now() - indexCache.at < 60_000) return indexCache.rows
  const t0 = Date.now(), rows = []
  for (let page = 1; page <= 200; page++) {
    const r = await listUsers(page, PAGE)
    const users = (r && r.users) || []
    for (const u of users) {
      const subs = clean((u.app_metadata || {}).kc_push)
      if (subs.length) rows.push({ id: u.id, subs, metaSex: (u.user_metadata || {}).sex })
    }
    if (users.length < PAGE || Date.now() - t0 > maxMs) break
  }
  indexCache = { at: Date.now(), rows }
  return rows
}
const forgetIndex = () => { indexCache = { at: 0, rows: null } }

module.exports = { getUser, setMeta, getSubs, saveSub, removeSubs, sendToUser, pushTo, allSubscribers, forgetIndex, MAX_PHONES }
