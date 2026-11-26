'use strict'
// Creator-facing API.  GET /api/creator  -> dashboard data     POST /api/creator {action:'withdraw',...}
// Identity ALWAYS comes from the verified login token. Money is only ever changed by database functions.
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireUser, limited, safeMessage } = require('./_lib/http')

const STALE_MS = 10 * 60 * 1000

async function freshEligibility(userId) {
  const [el] = await sb.select('creator_eligibility', { user_id: 'eq.' + userId })
  const [dirty] = await sb.select('mz_dirty', { user_id: 'eq.' + userId })
  const old = !el || !el.last_evaluated_at || Date.now() - new Date(el.last_evaluated_at).getTime() > STALE_MS
  if (old || dirty) await sb.rpc('mz_evaluate', { p_user: userId })
}

async function dashboard(userId) {
  await freshEligibility(userId)
  const eq = { user_id: 'eq.' + userId }
  const [settings, stats, elig, balance, estimate, earnings, withdrawals, ledger] = await Promise.all([
    sb.select('monetization_settings', { id: 'eq.1' }),
    sb.select('creator_stats', eq),
    sb.select('creator_eligibility', eq),
    sb.select('creator_balances', eq),
    sb.rpc('mz_estimate_monthly', { p_user: userId }),
    sb.select('creator_earnings', eq, { order: 'revenue_period.desc', limit: 12 }),
    sb.select('creator_withdrawals', eq, { select: 'id,amount,payment_method,withdrawal_status,transaction_reference,admin_note,requested_at,processed_at', order: 'requested_at.desc', limit: 20 }),
    sb.select('creator_ledger', eq, { select: 'id,entry_type,amount,ref,created_at', order: 'id.desc', limit: 30 })
  ])
  const s = settings[0] || {}
  const b = balance[0] || { available: 0, pending: 0, lifetime: 0, withdrawn: 0 }
  const e = elig[0] || {}
  return {
    ok: true,
    program: {
      live: !!(s.monetization_enabled && s.provider_approval_confirmed),
      enabled: !!s.monetization_enabled,
      provider_approved: !!s.provider_approval_confirmed,
      currency: s.currency || 'USD', creator_percent: Number(s.creator_percent || 0),
      min_withdrawal: Number(s.min_withdrawal || 0), hold_days: s.hold_days, payment_methods: s.payment_methods || []
    },
    status: {
      value: e.eligibility_status || 'not_eligible', review_status: e.review_status,
      rejection_reason: e.rejection_reason, suspension_reason: e.suspension_reason,
      can_reappeal: e.can_reappeal, reapply_after: e.reapply_after, approved_at: e.approved_at, last_evaluated_at: e.last_evaluated_at
    },
    requirements: { met: e.requirements_met || [], missing: e.requirements_missing || [] },
    stats: stats[0] || null,
    money: {
      available: Number(b.available), pending: Number(b.pending), lifetime: Number(b.lifetime), withdrawn: Number(b.withdrawn),
      estimated_monthly: estimate === null ? null : Number(estimate)     // a projection, never withdrawable
    },
    earnings, withdrawals, ledger
  }
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return
    if (limited('c:' + user.id, 60, 60_000)) return fail(res, 429, 'Too many requests. Wait a moment.')

    if (req.method === 'GET') return send(res, 200, await dashboard(user.id))

    if (req.method === 'POST') {
      const b = bodyOf(req)
      if (b.action === 'withdraw') {
        if (limited('w:' + user.id, 5, 60_000)) return fail(res, 429, 'Too many requests. Wait a moment.')
        const amount = Number(b.amount)
        if (!Number.isFinite(amount)) return fail(res, 400, 'invalid amount')
        const w = await sb.rpc('mz_request_withdrawal', {
          p_user: user.id, p_amount: Math.round(amount * 100) / 100,
          p_method: String(b.method || '').slice(0, 20), p_details: String(b.details || '').slice(0, 120)
        })
        return send(res, 200, { ok: true, withdrawal: { id: w.id, amount: w.amount, status: w.withdrawal_status } })
      }
      return fail(res, 400, 'Unknown action')
    }
    res.setHeader('Allow', 'GET, POST')
    return fail(res, 405, 'Method not allowed')
  } catch (e) {
    console.error('creator api:', e.message)
    return fail(res, 400, safeMessage(e))
  }
}
