'use strict'
// Pure helper functions (no network) so they can be unit-tested.

// ---- settings validation: only these keys can be changed, with these limits -------------------------------
const RULES = {
  min_account_age_days:       { type: 'int',  min: 0,  max: 3650 },
  min_followers:              { type: 'int',  min: 0,  max: 1e7 },
  min_new_followers:          { type: 'int',  min: 0,  max: 1e7 },
  min_posts:                  { type: 'int',  min: 0,  max: 10000 },
  min_avg_likes:              { type: 'num',  min: 0,  max: 1e6 },
  min_unique_conversations:   { type: 'int',  min: 0,  max: 1e6 },
  min_profile_completion:     { type: 'int',  min: 0,  max: 100 },
  evaluation_period_days:     { type: 'int',  min: 7,  max: 365 },
  genuine_account_age_days:   { type: 'int',  min: 0,  max: 365 },
  min_messages_per_conversation: { type: 'int', min: 1, max: 100 },
  spam_recipient_limit:       { type: 'int',  min: 1,  max: 100000 },
  platform_percent:           { type: 'num',  min: 0,  max: 100 },
  creator_percent:            { type: 'num',  min: 0,  max: 100 },
  min_withdrawal:             { type: 'num',  min: 0.01, max: 100000 },
  hold_days:                  { type: 'int',  min: 0,  max: 365 },
  payment_methods:            { type: 'methods' },
  monetization_enabled:       { type: 'bool' },
  provider_approval_confirmed:{ type: 'bool' }
}

function validateSettingsPatch(input, current) {
  const patch = {}
  if (!input || typeof input !== 'object') return { error: 'Nothing to change' }
  for (const [k, v] of Object.entries(input)) {
    const r = RULES[k]
    if (!r) return { error: `"${k}" cannot be changed` }
    if (r.type === 'bool') { if (typeof v !== 'boolean') return { error: `${k} must be true or false` }; patch[k] = v }
    else if (r.type === 'methods') {
      if (!Array.isArray(v) || v.length > 12) return { error: 'payment_methods must be a list' }
      const clean = [...new Set(v.map(x => String(x).trim().toLowerCase()))]
      if (clean.some(x => !/^[a-z0-9_-]{2,20}$/.test(x))) return { error: 'Invalid payment method name' }
      patch[k] = clean
    } else {
      const n = Number(v)
      if (v === '' || v === null || !Number.isFinite(n) || n < r.min || n > r.max || (r.type === 'int' && !Number.isInteger(n)))
        return { error: `${k} must be ${r.type === 'int' ? 'a whole number' : 'a number'} between ${r.min} and ${r.max}` }
      patch[k] = n
    }
  }
  const merged = { ...current, ...patch }
  if ('platform_percent' in patch || 'creator_percent' in patch) {
    if (Math.abs(Number(merged.platform_percent) + Number(merged.creator_percent) - 100) > 1e-9)
      return { error: 'Platform % + creator % must equal 100' }
  }
  // the master switch can only be turned on after the ad provider's approval is confirmed
  if (merged.monetization_enabled && !merged.provider_approval_confirmed)
    return { error: 'Cannot enable monetization until the ad provider approval is confirmed' }
  return { patch }
}

// ---- CSV export with spreadsheet-formula injection guard --------------------------------------------------
function csvCell(v) {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function csvOf(rows) {
  if (!rows.length) return 'no data\n'
  const cols = Object.keys(rows[0])
  return [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n'
}

// "2026-10", "2026-10-17" -> "2026-10-01"  (null if not a real month)
function firstOfMonth(v) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(v || ''))
  if (!m) return null
  const y = +m[1], mo = +m[2]
  if (mo < 1 || mo > 12 || y < 2024 || y > 2100) return null
  return `${m[1]}-${m[2]}-01`
}

// ---- reference implementation of the payout rounding (same algorithm as the SQL), used by tests ------------
function distribute(poolCents, weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  if (!total || !poolCents) return {}
  const rows = Object.entries(weights).filter(([, w]) => w > 0).map(([id, w]) => {
    const exact = poolCents * w / total
    return { id, c: Math.floor(exact), frac: exact - Math.floor(exact) }
  })
  let left = poolCents - rows.reduce((a, r) => a + r.c, 0)
  rows.slice().sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1)).forEach(r => { if (left > 0) { r.c++; left-- } })
  return Object.fromEntries(rows.map(r => [r.id, r.c]))
}

module.exports = { validateSettingsPatch, csvOf, csvCell, firstOfMonth, distribute, RULES }
