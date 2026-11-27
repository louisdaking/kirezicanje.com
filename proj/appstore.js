// =====================================================================
// KIREZI CANJE - "store" logic shared by app.html and the install popup
//  downloads counter, rating, reviews, helpful votes, comments
//  Everything goes through Supabase functions (see 6_appstore_setup.sql)
// =====================================================================
const SB_URLS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://esm.sh/@supabase/supabase-js@2',
  'https://unpkg.com/@supabase/supabase-js@2/dist/module/index.js?module'
]
let createClient
for (const url of SB_URLS) {
  try { ({ createClient } = await import(url)); break } catch (error) { console.warn('[kirezi] could not load Supabase from', url, error) }
}
if (!createClient) throw new Error('Could not load the Supabase library from any source')

const SUPABASE_URL = 'https://sdzdfzhmomfocsvlddli.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkemRmemhtb21mb2NzdmxkZGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNDE4OTQsImV4cCI6MjA4NDgxNzg5NH0.vk0KP5FZwesUqm86MgHep3VZCClIgIGEwyU_2Y0L8X4'

// separate "anonymous" client: it never touches the login of the main app
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'kc-store-anon' }
})

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ls = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
}

// every phone gets a random id (so one phone = one review / one download)
export const deviceId = (() => {
  let d = ls.get('kc_device')
  if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now() + Math.random().toString(16).slice(2)); ls.set('kc_device', d) }
  return d
})()

// name / phone of the person if he is logged in the main app
export function who() {
  let name = ls.get('kc_store_name') || '', phone = ls.get('kc_store_phone') || ''
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        const s = JSON.parse(localStorage.getItem(k))
        if (s && s.user) {
          name = (s.user.user_metadata && s.user.user_metadata.full_name) || name
          phone = String(s.user.email || '').replace('@gmail.com', '') || phone
        }
      }
    }
  } catch { /* ignore */ }
  return { name, phone }
}
export function rememberWho(name, phone) { if (name) ls.set('kc_store_name', name); if (phone) ls.set('kc_store_phone', phone) }

export const fmtNum = n => Number(n || 0).toLocaleString('en-US')
const stars = n => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n))
const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// ---------- stats ----------
export async function loadStats() {
  const { data, error } = await sb.rpc('app_stats')
  if (error) throw error
  return data
}
export function fillStats(s) {
  const set = (k, v) => document.querySelectorAll(`[data-store="${k}"]`).forEach(e => { e.textContent = v })
  set('rating', s.reviews ? Number(s.avg).toFixed(1) : '—')
  set('reviews', fmtNum(s.reviews))
  set('downloads', fmtNum(s.downloads))
  set('stars', stars(s.avg))
}
export async function registerDownload(source, name, phone) {
  rememberWho(name, phone)
  try { await sb.rpc('app_register_download', { p_device: deviceId, p_name: name || null, p_phone: phone || null, p_source: source, p_ua: navigator.userAgent }) } catch { /* the download must never fail because of the counter */ }
}

// ---------- the "Ratings & Reviews" block ----------
export function mountReviews(root) {
  root.classList.add('ks')
  let sort = 'helpful', stats = null, reviews = [], myStars = 0, open = {}   // open: review id -> comments list
  root.innerHTML = `
    <h3 class="ks-h"><span class="ks-star">★</span> Ratings &amp; Reviews</h3>
    <div id="ksSummary"></div>
    <div class="ks-rate" id="ksRate"></div>
    <div class="ks-tabs"><button data-sort="helpful" class="on">Most Helpful</button><button data-sort="newest">Newest</button></div>
    <div id="ksList">${window.kcLoader.inline()}</div>`

  const $ = id => root.querySelector(id)

  function summary() {
    const s = stats || { reviews: 0, avg: 0, c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 }
    const max = Math.max(1, s.c1, s.c2, s.c3, s.c4, s.c5)
    $('#ksSummary').innerHTML = `
      <div class="ks-sum">
        <div class="ks-big"><b>${s.reviews ? Number(s.avg).toFixed(1) : '—'}</b><div class="ks-stars">${stars(s.avg)}</div><small>${fmtNum(s.reviews)} Ratings</small></div>
        <div class="ks-bars">${[5, 4, 3, 2, 1].map(n => `<div class="ks-bar"><span>${n}★</span><i><u style="width:${(s['c' + n] / max) * 100}%"></u></i></div>`).join('')}</div>
      </div>`
  }

  function rateBox() {
    const mine = reviews.find(r => r.mine)
    const w = who()
    if (mine && !myStars) myStars = mine.rating
    $('#ksRate').innerHTML = `
      <div class="ks-card">
        <b>${mine ? 'Your review' : 'Rate this app'}</b><small>${mine ? 'You can change it' : 'Tell others what you think'}</small>
        <div class="ks-pick">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" class="${n <= myStars ? 'on' : ''}">★</button>`).join('')}</div>
        <div id="ksForm" class="${myStars ? '' : 'ks-hide'}">
          <input id="ksName" maxlength="40" placeholder="Your name" value="${esc(mine ? mine.name : w.name)}">
          <textarea id="ksBody" maxlength="600" rows="3" placeholder="Write your review (optional)">${esc(mine ? mine.body || '' : '')}</textarea>
          <button class="ks-btn" id="ksSend" type="button">${mine ? 'Update review' : 'Send review'}</button>
          ${mine ? '<button class="ks-link" id="ksDelMine" type="button">Delete my review</button>' : ''}
          <div class="ks-err" id="ksErr"></div>
        </div>
      </div>`
  }

  function listHTML() {
    if (!reviews.length) return '<p class="ks-empty">No review yet. Be the first! ⭐</p>'
    return reviews.map(r => `
      <div class="ks-rev" data-id="${r.id}">
        <div class="ks-who"><span class="ks-av">${esc((r.name || '?').trim().charAt(0).toUpperCase())}</span>
          <div><b>${esc(r.name)}${r.mine ? ' <em>(you)</em>' : ''}</b><small>${fmtDate(r.created_at)}</small></div></div>
        <div class="ks-stars">${stars(r.rating)}</div>
        ${r.body ? `<p class="ks-body">${esc(r.body)}</p>` : ''}
        <div class="ks-acts">
          <button data-act="vote" class="${r.voted ? 'on' : ''}">👍 Helpful (${r.helpful})</button>
          <button data-act="comments">💬 Reply (${r.comments})</button>
        </div>
        <div class="ks-thread" id="ksT${r.id}">${open[r.id] ? threadHTML(r.id) : ''}</div>
      </div>`).join('')
  }

  function threadHTML(id) {
    const list = open[id] || []
    const w = who()
    return `${list.map(c => `
      <div class="ks-com"><b>${esc(c.name)}${c.mine ? ' <em>(you)</em>' : ''}</b><small> · ${fmtDate(c.created_at)}</small>
        <p>${esc(c.body)}</p>${c.mine ? `<button class="ks-link" data-act="delcom" data-cid="${c.id}">Delete</button>` : ''}</div>`).join('') || '<p class="ks-empty small">No comment yet.</p>'}
      <div class="ks-add">
        <input class="ks-cname" maxlength="40" placeholder="Your name" value="${esc(w.name)}">
        <div class="ks-line"><input class="ks-cbody" maxlength="400" placeholder="Write a comment…"><button class="ks-btn sm" data-act="sendcom" type="button">Send</button></div>
      </div>`
  }

  async function load() {
    try {
      const [s, l] = await Promise.all([loadStats(), sb.rpc('app_reviews_list', { p_device: deviceId, p_sort: sort })])
      if (l.error) throw l.error
      stats = s; reviews = l.data || []
      fillStats(s)
      summary(); rateBox()
      $('#ksList').innerHTML = listHTML()
    } catch (e) {
      $('#ksList').innerHTML = '<p class="ks-empty">No internet, or the store is not set up yet. Try again later.</p>'
    }
  }

  async function loadThread(id) {
    const { data, error } = await sb.rpc('app_comments_list', { p_device: deviceId, p_review: id })
    if (!error) open[id] = data || []
    const t = root.querySelector('#ksT' + id)
    if (t) t.innerHTML = threadHTML(id)
  }

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-sort]')
    if (tab) { sort = tab.dataset.sort; root.querySelectorAll('.ks-tabs button').forEach(b => b.classList.toggle('on', b === tab)); load(); return }

    const st = e.target.closest('[data-star]')
    if (st) { myStars = Number(st.dataset.star); root.querySelectorAll('.ks-pick button').forEach(b => b.classList.toggle('on', Number(b.dataset.star) <= myStars)); $('#ksForm').classList.remove('ks-hide'); return }

    if (e.target.id === 'ksSend') {
      const name = $('#ksName').value.trim(), body = $('#ksBody').value.trim(), err = $('#ksErr')
      if (!myStars) { err.textContent = 'Choose the stars first'; return }
      if (!name) { err.textContent = 'Write your name'; return }
      e.target.disabled = true; err.textContent = ''
      const w = who()
      const { error } = await sb.rpc('app_post_review', { p_device: deviceId, p_name: name, p_phone: w.phone || null, p_rating: myStars, p_body: body || null })
      e.target.disabled = false
      if (error) { err.textContent = error.message; return }
      rememberWho(name, w.phone)
      myStars = 0
      load()
      return
    }
    if (e.target.id === 'ksDelMine') {
      if (!confirm('Delete your review?')) return
      await sb.rpc('app_delete_review', { p_device: deviceId }); myStars = 0; load(); return
    }

    const rev = e.target.closest('.ks-rev')
    const act = e.target.closest('[data-act]')
    if (!rev || !act) return
    const id = Number(rev.dataset.id)
    if (act.dataset.act === 'vote') {
      const { data, error } = await sb.rpc('app_vote_review', { p_device: deviceId, p_review: id })
      if (!error) { act.classList.toggle('on', data.voted); act.textContent = `👍 Helpful (${data.helpful})` }
    } else if (act.dataset.act === 'comments') {
      if (open[id]) { delete open[id]; rev.querySelector('.ks-thread').innerHTML = '' } else await loadThread(id)
    } else if (act.dataset.act === 'sendcom') {
      const name = rev.querySelector('.ks-cname').value.trim(), body = rev.querySelector('.ks-cbody').value.trim()
      if (!name || !body) return
      act.disabled = true
      const { error } = await sb.rpc('app_post_comment', { p_device: deviceId, p_name: name, p_review: id, p_body: body })
      act.disabled = false
      if (error) { alert(error.message); return }
      rememberWho(name, '')
      await loadThread(id)
      const btn = rev.querySelector('[data-act="comments"]'); const m = /\((\d+)\)/.exec(btn.textContent); btn.textContent = `💬 Reply (${(m ? +m[1] : 0) + 1})`
    } else if (act.dataset.act === 'delcom') {
      if (!confirm('Delete this comment?')) return
      await sb.rpc('app_delete_comment', { p_device: deviceId, p_comment: Number(act.dataset.cid) })
      await loadThread(id)
    }
  })

  load()
  return { reload: load }
}
