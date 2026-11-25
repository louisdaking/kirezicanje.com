// Admin screen. It only DISPLAYS and SENDS requests. The server checks every call (token + admin list),
// so opening this page without being an administrator shows "Not authorized" and nothing else.
import { api, el, clear, money, num, date, toast, badge } from './mz-common.js'

const view = document.getElementById('view'), tabsEl = document.getElementById('tabs'), dlg = document.getElementById('dlg')
const TABS = [['overview', 'Overview'], ['applications', 'Creators'], ['withdrawals', 'Withdrawals'], ['revenue', 'Revenue'], ['flags', 'Suspicious'], ['settings', 'Settings'], ['reports', 'Reports']]
let current = 'overview'

const table = (heads, rows, empty) => rows.length
  ? el('div', { class: 'card scroll' }, el('table', {}, el('thead', {}, el('tr', {}, heads.map(h => el('th', {}, h)))), el('tbody', {}, rows)))
  : el('div', { class: 'card empty' }, empty || 'Nothing here.')
const stat = (l, v, n) => el('div', { class: 'card stat' }, el('div', { class: 'l' }, l), el('div', { class: 'v' }, v), n ? el('div', { class: 'n' }, n) : null)
const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r } catch (e) { toast(e.message, true); return null } }

function ask(title, fields, confirmText = 'Confirm') {      // small safe form dialog
  return new Promise(resolve => {
    const inputs = fields.map(f => ({ f, i: f.type === 'select' ? el('select', {}, f.options.map(o => el('option', { value: o[0] }, o[1]))) : el('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', maxlength: 300 }) }))
    const done = (v) => { dlg.close(); resolve(v) }
    clear(dlg).append(el('form', { class: 'f', method: 'dialog', onsubmit: (e) => { e.preventDefault(); done(Object.fromEntries(inputs.map(x => [x.f.name, x.i.value]))) } },
      el('h2', { style: 'margin-top:0' }, title), inputs.map(x => el('label', {}, x.f.label, x.i)),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'submit' }, confirmText), el('button', { class: 'btn alt', type: 'button', onclick: () => done(null) }, 'Cancel'))))
    dlg.showModal()
  })
}

const pages = {
  async overview() {
    const d = await api('/api/admin?action=overview'), r = d.revenue, c = d.creators
    return [el('div', { class: 'grid g4', style: 'margin-top:14px' },
      stat('Ad revenue (verified)', money(r.total_provider)), stat('Platform share', money(r.platform_share)), stat('Creator pool paid', money(r.creator_pool)), stat('Waiting to distribute', money(r.undistributed)),
      stat('Under review', num(c.under_review || 0)), stat('Approved', num(c.approved || 0)), stat('Open withdrawals', num(d.withdrawals_open.count), money(d.withdrawals_open.amount)), stat('Suspicious flags', num(d.open_flags))),
      el('h2', {}, 'Revenue periods'), periodsTable(d.periods)]
  },
  async applications() {
    const holder = el('div'), sel = el('select', { onchange: () => fill() }, [['under_review', 'Under review'], ['approved', 'Approved'], ['suspended', 'Suspended'], ['rejected', 'Rejected'], ['not_eligible', 'Not eligible'], ['', 'All']].map(o => el('option', { value: o[0] }, o[1])))
    const fill = async () => { clear(holder).append(el('div', { class: 'skeleton' })); const d = await run(() => api('/api/admin?action=applications&status=' + sel.value)); if (!d) return
      clear(holder).append(table(['Creator', 'Status', 'Followers', 'Posts', 'Avg likes', 'Chats', ''], d.items.map(i => el('tr', {}, el('td', {}, i.name || i.user_id.slice(0, 8)), el('td', {}, badge(i.eligibility_status)),
        el('td', {}, num(i.stats?.total_followers)), el('td', {}, num(i.stats?.posts_30_days)), el('td', {}, num(i.stats?.average_likes_per_post)), el('td', {}, num(i.stats?.unique_conversations_30_days)),
        el('td', {}, el('button', { class: 'btn alt', onclick: () => openCreator(i.user_id) }, 'Open')))), 'No creators in this list.')) }
    fill(); return [el('div', { style: 'margin-top:14px' }, sel), holder]
  },
  async withdrawals() {
    const holder = el('div'), sel = el('select', { onchange: () => fill() }, [['pending', 'Pending'], ['approved', 'Approved'], ['processing', 'Processing'], ['paid', 'Paid'], ['rejected', 'Rejected'], ['', 'All']].map(o => el('option', { value: o[0] }, o[1])))
    const next = { pending: ['approved', 'rejected'], approved: ['processing', 'rejected'], processing: ['paid', 'rejected'] }
    const act = async (w, status) => {
      const fields = status === 'paid' ? [{ name: 'reference', label: 'Payment reference (required)' }] : status === 'rejected' ? [{ name: 'note', label: 'Reason shown to the creator' }] : []
      const v = fields.length ? await ask(`${status} withdrawal`, fields) : {}
      if (v === null) return
      if (await run(() => api('/api/admin?action=withdrawal', { method: 'POST', body: { id: w.id, status, ...v } }), 'Updated')) fill()
    }
    const fill = async () => { const d = await run(() => api('/api/admin?action=withdrawals&status=' + sel.value)); if (!d) return
      clear(holder).append(table(['Date', 'Creator', 'Amount', 'Method / details', 'Status', 'Actions'], d.items.map(w => el('tr', {}, el('td', {}, date(w.requested_at)), el('td', {}, w.name || w.user_id.slice(0, 8)), el('td', {}, money(w.amount)),
        el('td', {}, w.payment_method + ' · ' + w.payment_details), el('td', {}, badge(w.withdrawal_status), w.transaction_reference ? el('div', { class: 'muted' }, w.transaction_reference) : null),
        el('td', {}, (next[w.withdrawal_status] || []).map(s => el('button', { class: 'btn ' + (s === 'rejected' ? 'bad' : 'ok'), style: 'margin:2px;padding:8px 10px', onclick: () => act(w, s) }, s))))), 'No withdrawals.')) }
    fill(); return [el('div', { style: 'margin-top:14px' }, sel), holder]
  },
  async revenue() {
    const d = await api('/api/admin?action=overview'), s = (await api('/api/admin?action=settings')).settings
    const month = el('input', { type: 'month', required: true }), amt = el('input', { type: 'number', step: '0.01', min: 0, required: true, placeholder: 'e.g. 123.45' }), note = el('input', { required: true, placeholder: 'Source, e.g. Monetag payout report Oct 2026' })
    return [el('div', { class: 'notice' }, 'Enter ONLY real revenue shown in your ad provider’s own report. The platform never invents revenue. Creator share: ' + s.creator_percent + '%. Distribution is blocked until monetization is enabled AND provider approval is confirmed (Settings).'),
      el('h2', {}, 'Record verified revenue'),
      el('form', { class: 'card f', onsubmit: async (e) => { e.preventDefault(); if (await run(() => api('/api/admin?action=record_revenue', { method: 'POST', body: { period: month.value, provider_revenue: Number(amt.value), source_note: note.value } }), 'Recorded')) show('revenue') } },
        el('label', {}, 'Month', month), el('label', {}, 'Verified net revenue (USD)', amt), el('label', {}, 'Source', note), el('button', { class: 'btn', type: 'submit' }, 'Save')),
      el('h2', {}, 'Periods'), periodsTable(d.periods, true)]
  },
  async flags() {
    const d = await api('/api/admin?action=flags&status=open')
    const resolve = async (f, status) => { if (await run(() => api('/api/admin?action=resolve_flag', { method: 'POST', body: { id: f.id, status } }), 'Saved')) show('flags') }
    return [el('div', { style: 'margin-top:14px' }), table(['Date', 'Creator', 'Reason', 'Details', ''], d.items.map(f => el('tr', {}, el('td', {}, date(f.created_at)),
      el('td', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openCreator(f.user_id) } }, f.name || f.user_id.slice(0, 8))), el('td', {}, f.reason.replace(/_/g, ' ')), el('td', {}, JSON.stringify(f.details)),
      el('td', {}, el('button', { class: 'btn alt', style: 'margin:2px', onclick: () => resolve(f, 'dismissed') }, 'Dismiss'), el('button', { class: 'btn bad', style: 'margin:2px', onclick: () => resolve(f, 'confirmed') }, 'Confirm')))), 'No open flags 🎉')]
  },
  async settings() {
    const s = (await api('/api/admin?action=settings')).settings
    const fields = [['min_account_age_days', 'Min account age (days)'], ['min_followers', 'Min genuine followers'], ['min_new_followers', 'Min new followers (period)'], ['min_posts', 'Min posts (period)'], ['min_avg_likes', 'Min average likes / post'],
      ['min_unique_conversations', 'Min unique conversations'], ['min_profile_completion', 'Min profile completion %'], ['evaluation_period_days', 'Evaluation period (days)'], ['genuine_account_age_days', 'Genuine account age (days)'],
      ['min_messages_per_conversation', 'Messages needed to count a conversation'], ['spam_recipient_limit', 'Ignore senders who message more than N people'], ['platform_percent', 'Platform %'], ['creator_percent', 'Creator pool %'],
      ['min_withdrawal', 'Minimum withdrawal'], ['hold_days', 'Hold days before available']]
    const ins = Object.fromEntries(fields.map(f => [f[0], el('input', { type: 'number', step: 'any', value: s[f[0]] })]))
    const methods = el('input', { value: s.payment_methods.join(', ') })
    const enabled = el('input', { type: 'checkbox', style: 'width:auto' }), approved = el('input', { type: 'checkbox', style: 'width:auto' }); enabled.checked = s.monetization_enabled; approved.checked = s.provider_approval_confirmed
    return [el('form', { class: 'card f', style: 'margin-top:14px', onsubmit: async (e) => { e.preventDefault()
      const patch = Object.fromEntries(fields.map(f => [f[0], Number(ins[f[0]].value)])); patch.payment_methods = methods.value.split(',').map(x => x.trim()).filter(Boolean)
      patch.provider_approval_confirmed = approved.checked; patch.monetization_enabled = enabled.checked
      const r = await run(() => api('/api/admin?action=settings', { method: 'POST', body: { patch } })); if (r) { toast('Saved. Re-checked ' + r.reevaluated + ' creators.'); show('settings') } } },
      el('div', { class: 'notice' }, 'Changing requirements re-checks creators automatically. Platform % + creator % must equal 100.'),
      fields.map(f => el('label', {}, f[1], ins[f[0]])), el('label', {}, 'Payment methods (comma separated)', methods),
      el('label', { style: 'display:flex;gap:8px;align-items:center' }, approved, 'Ad provider (Monetag) CONFIRMED in writing that this revenue-sharing model is allowed'),
      el('label', { style: 'display:flex;gap:8px;align-items:center' }, enabled, 'Monetization ENABLED (needs the box above)'),
      el('button', { class: 'btn', type: 'submit' }, 'Save settings'))]
  },
  async reports() {
    const dl = async (type) => { const r = await run(() => api('/api/admin?action=export&type=' + type)); if (!r) return
      const a = el('a', { href: URL.createObjectURL(r.blob), download: `kirezi-${type}.csv` }); document.body.append(a); a.click(); a.remove() }
    return [el('h2', {}, 'Export financial reports (CSV)'), el('div', { class: 'card actions' }, ['periods', 'revenue', 'earnings', 'withdrawals', 'ledger'].map(t => el('button', { class: 'btn alt', onclick: () => dl(t) }, t)))]
  }
}

function periodsTable(periods, withAction) {
  const dist = async (p) => { if (!confirm(`Distribute ${p.period.slice(0, 7)} now? This can only be done once.`)) return
    const r = await run(() => api('/api/admin?action=distribute', { method: 'POST', body: { period: p.period } })); if (r) { toast(`Paid ${(r.result.paid_cents / 100).toFixed(2)} to ${r.result.creators} creators`); show('revenue') } }
  return table(['Month', 'Revenue', 'Platform', 'Creator pool', 'Status', withAction ? '' : null].filter(x => x !== null), periods.map(p => el('tr', {}, el('td', {}, p.period.slice(0, 7)), el('td', {}, money(p.provider_revenue)),
    el('td', {}, money(p.platform_share)), el('td', {}, money(p.creator_pool)), el('td', {}, badge(p.status === 'distributed' ? 'paid' : 'pending')),
    withAction ? el('td', {}, p.status !== 'distributed' ? el('button', { class: 'btn', style: 'padding:8px 10px', onclick: () => dist(p) }, 'Distribute') : null) : null)), 'No revenue recorded yet.')
}

async function openCreator(id) {
  const d = await run(() => api('/api/admin?action=creator&user_id=' + id)); if (!d) return
  const e = d.eligibility || {}, s = d.stats || {}
  const decide = async (status) => {
    const v = (status === 'rejected' || status === 'suspended') ? await ask(status === 'rejected' ? 'Reject application' : 'Suspend creator',
      [{ name: 'reason', label: 'Reason (shown to the creator)' }, ...(status === 'rejected' ? [{ name: 'reapply_days', label: 'Days before they can reapply', type: 'number', value: 30 }, { name: 'can_reappeal', label: 'Can reapply?', type: 'select', options: [['true', 'Yes'], ['false', 'No, final']] }] : [])]) : {}
    if (v === null) return
    if (await run(() => api('/api/admin?action=decide', { method: 'POST', body: { user_id: id, status, reason: v.reason, reapply_days: v.reapply_days, can_reappeal: v.can_reappeal !== 'false' } }), 'Saved')) { dlg.close(); show(current) } }
  clear(dlg).append(el('h2', { style: 'margin-top:0' }, d.name || 'Creator'), badge(e.eligibility_status || 'not_eligible'),
    el('p', { class: 'muted' }, `Followers ${num(s.total_followers)} (raw ${num(d.quality.raw_followers)}, filtered out ${num(d.quality.filtered_followers)}) · posts ${num(s.posts_30_days)} · avg likes ${num(s.average_likes_per_post)} · chats ${num(s.unique_conversations_30_days)} · visits ${num(s.profile_visits)} · impressions ${num(s.qualified_impressions)}`),
    el('p', { class: 'muted' }, `Balance: available ${money(d.balance?.available || 0)}, pending ${money(d.balance?.pending || 0)}, lifetime ${money(d.balance?.lifetime || 0)}, withdrawn ${money(d.balance?.withdrawn || 0)}`),
    (e.requirements_missing || []).length ? el('p', { class: 'muted' }, 'Missing: ' + e.requirements_missing.map(m => m.label).join(', ')) : null,
    d.flags.filter(f => f.status === 'open').length ? el('p', { class: 'notice bad' }, 'Open flags: ' + d.flags.filter(f => f.status === 'open').map(f => f.reason.replace(/_/g, ' ')).join(', ')) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn ok', onclick: () => decide('approved') }, 'Approve'), el('button', { class: 'btn bad', onclick: () => decide('rejected') }, 'Reject'),
      el('button', { class: 'btn bad', onclick: () => decide('suspended') }, 'Suspend'),
      el('button', { class: 'btn alt', onclick: async () => { const v = await ask('Traffic quality', [{ name: 'traffic_quality', label: 'Traffic quality', type: 'select', options: [['genuine', 'Genuine'], ['suspicious', 'Suspicious'], ['fraud', 'Fraud']] }]); if (v && await run(() => api('/api/admin?action=set_quality', { method: 'POST', body: { user_id: id, ...v } }), 'Saved')) dlg.close() } }, 'Traffic quality'),
      el('button', { class: 'btn alt', onclick: () => dlg.close() }, 'Close')))
  dlg.showModal()
}

async function show(name) {
  current = name
  clear(tabsEl).append(...TABS.map(t => el('button', { class: t[0] === name ? 'on' : '', onclick: () => show(t[0]) }, t[1])))
  clear(view).append(el('div', { class: 'skeleton' }))
  try { clear(view).append(...(await pages[name]())) }
  catch (e) { clear(view).append(el('div', { class: 'notice bad' }, e.status === 403 ? 'Not authorized.' : e.message)); if (e.status === 403) clear(tabsEl) }
}
show('overview')
