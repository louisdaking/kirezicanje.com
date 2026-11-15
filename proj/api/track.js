'use strict'
// POST /api/track {profile_id, kind:'visit'|'impression'}
// Counts a genuine profile visit / qualified impression.  Privacy: no IP, no device info, no message content is stored.
// Dedupe: one row per (profile, viewer, day, kind) in the database, so repeating a request changes nothing.
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireUser, limited, isUuid } = require('./_lib/http')

const DAILY_CAP_PER_VIEWER = 300     // a real person cannot open more profiles than this per day
const MIN_DWELL_MS = 4000            // an impression is valid only if its visit was recorded >= 4s earlier

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Method not allowed') }
    const user = await requireUser(req, res)
    if (!user) return
    if (limited('t:' + user.id, 40, 60_000)) return send(res, 200, { ok: true, counted: false })

    const b = bodyOf(req)
    const kind = b.kind === 'impression' ? 'impression' : b.kind === 'visit' ? 'visit' : null
    if (!kind || !isUuid(b.profile_id)) return fail(res, 400, 'Bad request')
    if (b.profile_id === user.id) return send(res, 200, { ok: true, counted: false })       // own profile never counts

    const [settings] = await sb.select('monetization_settings', { id: 'eq.1' }, { select: 'genuine_account_age_days' })
    const minAge = (settings && settings.genuine_account_age_days) || 7
    const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000
    if (!(ageDays >= minAge)) return send(res, 200, { ok: true, counted: false })           // brand-new accounts: not genuine yet

    const today = new Date().toISOString().slice(0, 10)
    const mine = await sb.select('traffic_events', { viewer_id: 'eq.' + user.id, day: 'eq.' + today }, { select: 'profile_id', limit: DAILY_CAP_PER_VIEWER + 1 })
    if (mine.length > DAILY_CAP_PER_VIEWER) return send(res, 200, { ok: true, counted: false })   // looks automated

    if (kind === 'impression') {
      const [visit] = await sb.select('traffic_events', { profile_id: 'eq.' + b.profile_id, viewer_id: 'eq.' + user.id, day: 'eq.' + today, kind: 'eq.visit' }, { select: 'created_at' })
      if (!visit || Date.now() - new Date(visit.created_at).getTime() < MIN_DWELL_MS) return send(res, 200, { ok: true, counted: false })
    }

    const out = await sb.insert('traffic_events',
      [{ profile_id: b.profile_id, viewer_id: user.id, day: today, kind }], 'resolution=ignore-duplicates,return=representation')
    return send(res, 200, { ok: true, counted: Array.isArray(out) && out.length > 0 })
  } catch (e) {
    console.error('track api:', e.message)
    return send(res, 200, { ok: true, counted: false })   // tracking must never disturb the app
  }
}
