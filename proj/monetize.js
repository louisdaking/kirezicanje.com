// Creator dashboard. Shows what /api/creator returns. All rules and all money live on the server.
import { api, el, clear, money, num, date, toast, badge } from './mz-common.js'

const app = document.getElementById('app')
const TIPS = {
  account_age: 'Keep your account active. This grows by itself every day.',
  followers: 'Share your profile and post things people enjoy. Only real accounts older than a few days count.',
  new_followers: 'Post regularly and reply to people. Buying or swapping followers does not count and can get you suspended.',
  posts: 'Publish at least this many posts in the last 30 days.',
  avg_likes: 'Make posts people like. Likes from your own account or very new accounts do not count.',
  conversations: 'Answer people who write to you. We count only HOW MANY people wrote, never what they wrote.',
  profile: 'Complete your name, photo, place and age in your profile.',
  standing: 'Follow the community rules to keep your account in good standing.',
  traffic: 'Only real visitors count. Bots and fake traffic make an account ineligible.'
}
const STATUS_TEXT = {
  not_eligible: 'you are not eligible yet. Follow the progress below. Your estimate is a projection only.',
  under_review: 'You meet every requirement 🎉 An administrator is reviewing your account quality.',
  approved: 'You are approved. New rewards are added after each verified revenue period.',
  suspended: 'Your monetization is suspended. New rewards are paused. Your earlier records are kept.',
  rejected: 'Your application was not approved.'
}

const stat = (label, value, note, cls) => el('div', { class: 'card stat ' + (cls || '') }, el('div', { class: 'l' }, label), el('div', { class: 'v' }, value), note ? el('div', { class: 'n' }, note) : null)

function chart(earnings, cur) {
  const rows = earnings.slice().reverse()
  if (!rows.length) return el('div', { class: 'empty' }, 'No earnings yet. Your monthly rewards will appear here.')
  const max = Math.max(...rows.map(r => Number(r.gross_reward)), 0.01), W = 300, H = 120, bw = W / rows.length
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 24}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Monthly rewards')
  rows.forEach((r, i) => {
    const h = Math.max(2, Number(r.gross_reward) / max * H)
    const rect = document.createElementNS(ns, 'rect')
    rect.setAttribute('x', i * bw + bw * .15); rect.setAttribute('y', H - h); rect.setAttribute('width', bw * .7); rect.setAttribute('height', h)
    rect.setAttribute('rx', 4); rect.setAttribute('fill', '#FF2E93')
    const t = document.createElementNS(ns, 'title'); t.textContent = `${String(r.revenue_period).slice(0, 7)}: ${money(r.gross_reward, cur)}`; rect.append(t)
    const lab = document.createElementNS(ns, 'text')
    lab.setAttribute('x', i * bw + bw / 2); lab.setAttribute('y', H + 16); lab.setAttribute('text-anchor', 'middle'); lab.setAttribute('font-size', '10'); lab.setAttribute('fill', '#8E7284')
    lab.textContent = String(r.revenue_period).slice(5, 7) + '/' + String(r.revenue_period).slice(2, 4)
    svg.append(rect, lab)
  })
  return svg
}

function requirements(d) {
  const all = [...d.requirements.met.map(r => ({ ...r, done: true })), ...d.requirements.missing.map(r => ({ ...r, done: false }))]
  const order = ['account_age', 'followers', 'new_followers', 'posts', 'avg_likes', 'conversations', 'profile', 'standing', 'traffic']
  all.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  if (!all.length) return el('div', { class: 'empty' }, 'Checking your account…')
  return all.map(r => {
    const bin = r.key === 'standing' || r.key === 'traffic'
    const pct = Math.min(100, r.required > 0 ? Number(r.current) / Number(r.required) * 100 : 100)
    return el('div', { class: 'req' },
      el('div', { class: 'row' }, el('span', {}, (r.done ? '✅ ' : '⬜ ') + r.label), el('span', {}, bin ? (r.done ? 'OK' : 'Needs attention') : `${num(r.current)} / ${num(r.required)}`)),
      bin ? null : el('div', { class: 'bar' + (r.done ? ' done' : ''), role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` })),
      r.done ? null : el('div', { class: 'tip' }, '💡 ' + (TIPS[r.key] || '')))
  })
}

function withdrawForm(d) {
  const p = d.program, can = d.status.value === 'approved' && p.live
  const amount = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: p.min_withdrawal, placeholder: `Min ${p.min_withdrawal}`, required: true, disabled: !can })
  const method = el('select', { disabled: !can }, p.payment_methods.map(m => el('option', { value: m }, m.charAt(0).toUpperCase() + m.slice(1))))
  const details = el('input', { type: 'text', maxlength: 120, placeholder: 'Phone number or PayPal e-mail', required: true, disabled: !can, autocomplete: 'off' })
  const btn = el('button', { class: 'btn', type: 'submit', disabled: !can }, 'Request withdrawal')
  const form = el('form', { class: 'f', onsubmit: async (ev) => {
    ev.preventDefault(); btn.disabled = true
    try {
      await api('/api/creator', { method: 'POST', body: { action: 'withdraw', amount: Number(amount.value), method: method.value, details: details.value } })
      toast('Withdrawal requested ✅ An administrator will process it.'); await load()
    } catch (e) { toast(e.message, true); btn.disabled = false }
  } },
    el('label', {}, `Amount (${p.currency}) — available: ${money(d.money.available, p.currency)}`, amount),
    el('label', {}, 'Payment method', method), el('label', {}, 'Where should we send it?', details), btn)
  const why = !p.live ? 'Withdrawals open when the program goes live.' : d.status.value !== 'approved' ? 'Only approved creators can withdraw. Estimated and pending money cannot be withdrawn.' : null
  return el('div', { class: 'card' }, form, why ? el('p', { class: 'muted' }, why) : el('p', { class: 'muted' }, `Only your available balance can be withdrawn. Payments are sent manually by an administrator after approval.`))
}

function render(d) {
  const p = d.program, cur = p.currency, s = d.stats || {}, st = d.status.value
  const status = document.getElementById('statusBadge'); clear(status).append(badge(st))
  clear(app)

  if (!p.live) app.append(el('div', { class: 'notice' }, '🔎 Preview mode. The creator revenue-sharing program is not live yet, so nothing is being paid. You can already see your progress and a projection.'))

  app.append(
    el('div', { class: 'card hero' }, el('small', {}, 'Available balance'), el('div', { class: 'big' }, money(d.money.available, cur)),
      el('small', {}, `Pending: ${money(d.money.pending, cur)} · held ${p.hold_days ?? ''} days before it becomes available`)),
    el('div', { class: 'notice ' + (st === 'approved' ? 'ok' : st === 'rejected' || st === 'suspended' ? 'bad' : '') }, STATUS_TEXT[st],
      st === 'rejected' ? el('div', {}, d.status.rejection_reason ? 'Reason: ' + d.status.rejection_reason : '', ' ',
        d.status.can_reappeal ? (d.status.reapply_after ? 'You can reapply after ' + date(d.status.reapply_after) + '.' : 'You can reapply.') : 'This decision is final.') : null,
      st === 'suspended' && d.status.suspension_reason ? el('div', {}, 'Reason: ' + d.status.suspension_reason) : null))

  app.append(el('h2', {}, 'Earnings'),
    el('div', { class: 'grid g3' },
      stat('Available', money(d.money.available, cur), 'Can be withdrawn'),
      stat('Pending', money(d.money.pending, cur), 'Waiting for the hold time'),
      stat('Lifetime earned', money(d.money.lifetime, cur)),
      stat('Withdrawn', money(d.money.withdrawn, cur)),
      stat('Estimated / month', d.money.estimated_monthly === null ? 'Not enough data' : money(d.money.estimated_monthly, cur),
        'Projection only — not real money and not withdrawable', 'proj')))

  app.append(el('h2', {}, 'Your performance (last 30 days)'),
    el('div', { class: 'grid g4' },
      stat('Genuine followers', num(s.total_followers)), stat('New followers', num(s.new_followers_30_days)),
      stat('Posts', num(s.posts_30_days)), stat('Avg likes / post', num(s.average_likes_per_post)),
      stat('People who messaged', num(s.unique_conversations_30_days)), stat('Profile visits', num(s.profile_visits)),
      stat('Qualified impressions', num(s.qualified_impressions)), stat('Profile complete', (s.profile_completion ?? 0) + '%')))

  app.append(el('h2', {}, 'Eligibility progress'), el('div', { class: 'card' }, requirements(d)),
    el('p', { class: 'muted' }, 'Rewards come only from real verified advertising revenue. Followers, likes and messages help you qualify, they do not create money by themselves. Earnings are never guaranteed.'))

  app.append(el('h2', {}, 'Monthly rewards'), el('div', { class: 'card' }, chart(d.earnings, cur)))
  app.append(el('h2', {}, 'Withdraw'), withdrawForm(d))

  app.append(el('h2', {}, 'Withdrawal history'), el('div', { class: 'card scroll' }, d.withdrawals.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ['Date', 'Amount', 'Method', 'Status', 'Reference'].map(h => el('th', {}, h)))),
        el('tbody', {}, d.withdrawals.map(w => el('tr', {}, el('td', {}, date(w.requested_at)), el('td', {}, money(w.amount, cur)), el('td', {}, w.payment_method),
          el('td', {}, badge(w.withdrawal_status), w.admin_note && w.withdrawal_status === 'rejected' ? el('div', { class: 'muted' }, w.admin_note) : null), el('td', {}, w.transaction_reference || '—')))))
    : el('div', { class: 'empty' }, 'No withdrawals yet.')))

  const names = { reward_pending: 'Reward added (pending)', reward_released: 'Reward released', withdrawal_hold: 'Withdrawal requested', withdrawal_refund: 'Withdrawal refunded', withdrawal_paid: 'Withdrawal paid', adjustment: 'Adjustment' }
  app.append(el('h2', {}, 'Transactions'), el('div', { class: 'card scroll' }, d.ledger.length
    ? el('table', {}, el('thead', {}, el('tr', {}, ['Date', 'Type', 'Amount'].map(h => el('th', {}, h)))),
        el('tbody', {}, d.ledger.map(l => el('tr', {}, el('td', {}, date(l.created_at)), el('td', {}, names[l.entry_type] || l.entry_type), el('td', {}, money(l.amount, cur))))))
    : el('div', { class: 'empty' }, 'Your transactions will appear here.')))
}

async function load() {
  try { render(await api('/api/creator')) }
  catch (e) { clear(app).append(el('div', { class: 'notice bad' }, e.message || 'Could not load. Check your internet and try again.'), el('p', {}, el('button', { class: 'btn', onclick: () => location.reload() }, 'Try again'))) }
}
load()
