'use strict'
// Administrator API. Every call: verified login token -> user must exist in monetization_admins (checked here AND
// all writes go through service-role-only database functions). Hiding buttons in the page is NOT the protection.
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireAdmin, isUuid, safeMessage, limited } = require('./_lib/http')
const { validateSettingsPatch, csvOf, firstOfMonth } = require('./_lib/rules')

const strictId = (v) => (/^\d{1,15}$/.test(String(v)) ? parseInt(v, 10) : NaN)   // "1;drop" is refused, not read as 1
const lim = (q, d = 50) => Math.min(Math.max(parseInt(q, 10) || d, 1), 200)
const names = async (ids) => {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (!uniq.length) return {}
  const rows = await sb.select('profiles', { id: 'in.(' + uniq.join(',') + ')' }, { select: 'id,full_name' })
  return Object.fromEntries(rows.map(r => [r.id, r.full_name]))
}

async function reevaluateSome(max = 150, budgetMs = 8000) {   // after settings change: refresh now, rest is finished by the daily cron
  const t0 = Date.now()
  const rows = await sb.select('creator_eligibility', {}, { select: 'user_id', order: 'last_evaluated_at.asc.nullsfirst', limit: max })
  let done = 0
  for (const r of rows) {
    if (Date.now() - t0 > budgetMs) break
    try { await sb.rpc('mz_evaluate', { p_user: r.user_id }); done++ } catch { /* continue */ }
  }
  if (done < rows.length) await sb.upsert('mz_dirty', rows.slice(done).map(r => ({ user_id: r.user_id })), 'user_id')
  return done
}

const handlers = {
  async whoami() { return { admin: true } },   // reaching this line means requireAdmin passed

  async overview() {
    const [periods, elig, flags, wd] = await Promise.all([
      sb.select('monetization_periods', {}, { order: 'period.desc', limit: 60 }),
      sb.select('creator_eligibility', {}, { select: 'eligibility_status', limit: 100000 }),
      sb.select('creator_flags', { status: 'eq.open' }, { select: 'id', limit: 1000 }),
      sb.select('creator_withdrawals', { withdrawal_status: 'in.(pending,approved,processing)' }, { select: 'amount,withdrawal_status', limit: 5000 })
    ])
    const sum = (k, f = () => true) => periods.filter(f).reduce((a, p) => a + Number(p[k] || 0), 0)
    const counts = {}
    elig.forEach(e => { counts[e.eligibility_status] = (counts[e.eligibility_status] || 0) + 1 })
    return {
      revenue: { total_provider: sum('provider_revenue'), platform_share: sum('platform_share', p => p.status === 'distributed'),
                 creator_pool: sum('creator_pool', p => p.status === 'distributed'),
                 undistributed: sum('provider_revenue', p => p.status !== 'distributed') },
      creators: counts, open_flags: flags.length,
      withdrawals_open: { count: wd.length, amount: wd.reduce((a, w) => a + Number(w.amount), 0) },
      periods
    }
  },

  async applications(q) {
    const f = {}
    if (q.status) {
      if (!['not_eligible', 'under_review', 'approved', 'suspended', 'rejected'].includes(q.status)) throw new Error('invalid status')
      f.eligibility_status = 'eq.' + q.status
    }
    const rows = await sb.select('creator_eligibility', f, { order: 'updated_at.desc', limit: lim(q.limit), offset: parseInt(q.offset, 10) || 0 })
    const ids = rows.map(r => r.user_id)
    const [stats, nm] = await Promise.all([
      ids.length ? sb.select('creator_stats', { user_id: 'in.(' + ids.join(',') + ')' }) : [],
      names(ids)
    ])
    const sm = Object.fromEntries(stats.map(s => [s.user_id, s]))
    return { items: rows.map(r => ({ ...r, name: nm[r.user_id] || null, stats: sm[r.user_id] || null })) }
  },

  async creator(q) {
    if (!isUuid(q.user_id)) throw new Error('invalid status')
    const eq = { user_id: 'eq.' + q.user_id }
    const [el, st, bal, earn, wd, flags, nm] = await Promise.all([
      sb.select('creator_eligibility', eq), sb.select('creator_stats', eq), sb.select('creator_balances', eq),
      sb.select('creator_earnings', eq, { order: 'revenue_period.desc', limit: 24 }),
      sb.select('creator_withdrawals', eq, { order: 'requested_at.desc', limit: 50 }),
      sb.select('creator_flags', eq, { order: 'created_at.desc', limit: 50 }), names([q.user_id])
    ])
    const s = st[0] || {}
    return { name: nm[q.user_id] || null, eligibility: el[0] || null, stats: st[0] || null, balance: bal[0] || null,
      earnings: earn, withdrawals: wd, flags,
      quality: { raw_followers: s.raw_followers, genuine_followers: s.total_followers,
                 filtered_followers: (s.raw_followers || 0) - (s.total_followers || 0) } }
  },

  async withdrawals(q) {
    const f = {}
    if (q.status) {
      if (!['pending', 'approved', 'processing', 'paid', 'rejected'].includes(q.status)) throw new Error('invalid status')
      f.withdrawal_status = 'eq.' + q.status
    }
    const rows = await sb.select('creator_withdrawals', f, { order: 'requested_at.desc', limit: lim(q.limit) })
    const nm = await names(rows.map(r => r.user_id))
    return { items: rows.map(r => ({ ...r, name: nm[r.user_id] || null })) }
  },

  async flags(q) {
    const rows = await sb.select('creator_flags', { status: 'eq.' + (q.status || 'open') }, { order: 'created_at.desc', limit: lim(q.limit) })
    const nm = await names(rows.map(r => r.user_id))
    return { items: rows.map(r => ({ ...r, name: nm[r.user_id] || null })) }
  },

  async settings() { return { settings: (await sb.select('monetization_settings', { id: 'eq.1' }))[0] } },

  async export(q, res) {
    const kinds = {
      withdrawals: ['creator_withdrawals', 'requested_at.desc'], earnings: ['creator_earnings', 'created_at.desc'],
      periods: ['monetization_periods', 'period.desc'], ledger: ['creator_ledger', 'id.desc'], revenue: ['creator_revenue', 'revenue_period.desc']
    }
    const k = kinds[q.type]
    if (!k) throw new Error('invalid status')
    const rows = await sb.select(k[0], {}, { order: k[1], limit: 20000 })
    res.status(200)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="kirezi-${q.type}-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.end(csvOf(rows))
    return null
  }
}

const posts = {
  // an administrator removes ANY post (service role: the owner-only rules of the "posts" table do not apply here)
  async delete_post(b, admin) {
    const id = String(b.post_id || '')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Object.assign(new Error('invalid post'), { public: true })
    const rows = await sb.select('posts', { id: 'eq.' + id }, { select: 'id,user_id,media_url,kind' })
    if (!rows.length) throw Object.assign(new Error('Post not found'), { public: true })
    const row = rows[0]
    await sb.call('/rest/v1/post_likes?post_id=eq.' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {})
    await sb.call('/rest/v1/posts?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
    const m = String(row.media_url || '').match(/\/object\/public\/posts\/([^?]+)/)
    if (m) await sb.call('/storage/v1/object/posts/' + m[1].split('/').map(encodeURIComponent).join('/'), { method: 'DELETE' }).catch(() => {})
    await sb.rpc('mz_audit', { p_actor: admin.id, p_action: 'post_deleted', p_target: id, p_details: { owner: row.user_id } }).catch(() => {})
    return { deleted: id }
  },

  async decide(b, admin) {
    if (!isUuid(b.user_id)) throw new Error('invalid status')
    const e = await sb.rpc('mz_set_creator_status', {
      p_user: b.user_id, p_status: String(b.status), p_actor: admin.id, p_reason: b.reason ? String(b.reason).slice(0, 500) : null,
      p_can_reappeal: b.can_reappeal !== false, p_reapply_days: Math.min(Math.max(parseInt(b.reapply_days, 10) || 30, 1), 365)
    })
    return { eligibility: e }
  },

  async withdrawal(b, admin) {
    const id = strictId(b.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('withdrawal not found')
    const w = await sb.rpc('mz_set_withdrawal', {
      p_id: id, p_status: String(b.status), p_actor: admin.id,
      p_reference: b.reference ? String(b.reference).slice(0, 120) : null, p_note: b.note ? String(b.note).slice(0, 300) : null
    })
    return { withdrawal: w }
  },

  async settings(b, admin) {
    const [cur] = await sb.select('monetization_settings', { id: 'eq.1' })
    const { patch, error } = validateSettingsPatch(b.patch || {}, cur)
    if (error) { const e = new Error(error); e.public = true; throw e }
    if (!Object.keys(patch).length) return { settings: cur }
    patch.updated_at = new Date().toISOString(); patch.updated_by = admin.id
    const [row] = await sb.update('monetization_settings', { id: 'eq.1' }, patch)
    await sb.rpc('mz_audit', { p_actor: admin.id, p_action: 'settings_changed', p_target: 'settings', p_details: patch })
    const reevaluated = await reevaluateSome()      // eligibility is recalculated when requirements change
    return { settings: row, reevaluated }
  },

  async record_revenue(b, admin) {
    const period = firstOfMonth(b.period)
    const amount = Number(b.provider_revenue)
    if (!period) throw Object.assign(new Error('Invalid month'), { public: true })
    if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) throw Object.assign(new Error('Invalid revenue amount'), { public: true })
    const note = String(b.source_note || '').trim()
    if (note.length < 5) throw Object.assign(new Error('Write where this number comes from (e.g. "Monetag report Oct 2026")'), { public: true })
    const [ex] = await sb.select('monetization_periods', { period: 'eq.' + period })
    if (ex && ex.status === 'distributed') throw Object.assign(new Error('This month is already distributed and locked'), { public: true })
    const row = { period, provider_revenue: Math.round(amount * 10000) / 10000, source_note: note.slice(0, 200), recorded_by: admin.id }
    const out = ex ? await sb.update('monetization_periods', { period: 'eq.' + period }, row) : await sb.insert('monetization_periods', [row])
    await sb.rpc('mz_audit', { p_actor: admin.id, p_action: 'revenue_recorded', p_target: period, p_details: { amount, note } })
    return { period: out[0] }
  },

  async distribute(b, admin) {
    const period = firstOfMonth(b.period)
    if (!period) throw Object.assign(new Error('Invalid month'), { public: true })
    return { result: await sb.rpc('mz_distribute_period', { p_period: period, p_actor: admin.id }) }
  },

  async resolve_flag(b, admin) {
    const id = strictId(b.id)
    if (!Number.isInteger(id) || !['dismissed', 'confirmed'].includes(b.status)) throw Object.assign(new Error('Bad request'), { public: true })
    const [row] = await sb.update('creator_flags', { id: 'eq.' + id }, { status: b.status, resolved_by: admin.id, resolved_at: new Date().toISOString() })
    await sb.rpc('mz_audit', { p_actor: admin.id, p_action: 'flag_' + b.status, p_target: String(id), p_details: {} })
    return { flag: row }
  },

  async set_quality(b, admin) {         // admin marks account standing / traffic quality (inputs of the eligibility rule)
    if (!isUuid(b.user_id)) throw Object.assign(new Error('Bad request'), { public: true })
    const patch = {}
    if (b.account_standing !== undefined) { if (!['good', 'warning', 'bad'].includes(b.account_standing)) throw Object.assign(new Error('Bad request'), { public: true }); patch.account_standing = b.account_standing }
    if (b.traffic_quality !== undefined) { if (!['genuine', 'suspicious', 'fraud'].includes(b.traffic_quality)) throw Object.assign(new Error('Bad request'), { public: true }); patch.traffic_quality = b.traffic_quality }
    await sb.rpc('mz_evaluate', { p_user: b.user_id })                // make sure the row exists
    await sb.update('creator_eligibility', { user_id: 'eq.' + b.user_id }, patch)
    await sb.rpc('mz_audit', { p_actor: admin.id, p_action: 'set_quality', p_target: b.user_id, p_details: patch })
    return { eligibility: await sb.rpc('mz_evaluate', { p_user: b.user_id }) }
  }
}

module.exports = async (req, res) => {
  try {
    const admin = await requireAdmin(req, res)
    if (!admin) return
    if (limited('a:' + admin.id, 120, 60_000)) return fail(res, 429, 'Too many requests')
    const action = String((req.query && req.query.action) || '')

    if (req.method === 'GET') {
      if (!Object.prototype.hasOwnProperty.call(handlers, action)) return fail(res, 404, 'Unknown action')
      const out = await handlers[action](req.query || {}, res)
      if (out === null) return                       // export already answered
      return send(res, 200, { ok: true, ...out })
    }
    if (req.method === 'POST') {
      if (!Object.prototype.hasOwnProperty.call(posts, action)) return fail(res, 404, 'Unknown action')
      return send(res, 200, { ok: true, ...(await posts[action](bodyOf(req), admin)) })
    }
    res.setHeader('Allow', 'GET, POST')
    return fail(res, 405, 'Method not allowed')
  } catch (e) {
    console.error('admin api:', e.message)
    return fail(res, 400, e.public ? e.message : safeMessage(e))
  }
}
