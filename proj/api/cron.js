'use strict'
// Daily job (Vercel Cron, see vercel.json): release held earnings, re-check eligibility, raise suspicious-activity flags.
// Protected by CRON_SECRET: Vercel sends "Authorization: Bearer <CRON_SECRET>" automatically.
const crypto = require('crypto')
const sb = require('./_lib/sb')
const { send, fail } = require('./_lib/http')

function authorised(req) {
  const secret = process.env.CRON_SECRET || ''
  const got = (req.headers.authorization || '').replace(/^Bearer /, '')
  if (secret.length < 16 || !got) return false
  const a = Buffer.from(got), b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = async (req, res) => {
  if (!sb.ready() || !authorised(req)) return fail(res, 401, 'Unauthorized')
  const t0 = Date.now(), BUDGET = 22_000, report = { released: 0, evaluated: 0, flags: 0 }
  try {
    report.released = await sb.rpc('mz_release_pending')

    // 1) users whose followers / likes / posts / messages changed, then 2) the longest-unchecked creators
    const dirty = await sb.select('mz_dirty', {}, { select: 'user_id', order: 'marked_at.asc', limit: 400 })
    const old = await sb.select('creator_eligibility', {}, { select: 'user_id', order: 'last_evaluated_at.asc.nullsfirst', limit: 400 })
    const ids = [...new Set([...dirty, ...old].map(r => r.user_id))]
    for (const id of ids) {
      if (Date.now() - t0 > BUDGET) break
      try { await sb.rpc('mz_evaluate', { p_user: id }); report.evaluated++ } catch (e) { console.error('evaluate', id, e.message) }
    }

    // suspicious patterns -> flags for a human to review (nothing is punished automatically)
    const stats = await sb.select('creator_stats', { raw_followers: 'gte.20' }, { limit: 2000 })
    const openFlags = await sb.select('creator_flags', { status: 'eq.open' }, { select: 'user_id,reason', limit: 5000 })
    const has = new Set(openFlags.map(f => f.user_id + '|' + f.reason))
    const toFlag = []
    for (const s of stats) {
      const filtered = s.raw_followers - s.total_followers
      if (filtered / s.raw_followers >= 0.5 && !has.has(s.user_id + '|fake_followers_suspected'))
        toFlag.push({ user_id: s.user_id, reason: 'fake_followers_suspected', details: { raw: s.raw_followers, genuine: s.total_followers } })
      if (s.profile_visits >= 200 && s.qualified_impressions / s.profile_visits > 0.98 && !has.has(s.user_id + '|uniform_traffic'))
        toFlag.push({ user_id: s.user_id, reason: 'uniform_traffic', details: { visits: s.profile_visits, impressions: s.qualified_impressions } })
    }
    if (toFlag.length) { await sb.insert('creator_flags', toFlag, 'return=minimal'); report.flags = toFlag.length }
    return send(res, 200, { ok: true, ...report, ms: Date.now() - t0 })
  } catch (e) {
    console.error('cron:', e.message)
    return fail(res, 500, 'cron failed')
  }
}
