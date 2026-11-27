// KIREZI CANJE - shared helpers for the monetization pages.
// This file is deliberately "dumb": it shows what the server says. It holds NO secrets and makes NO money decisions.
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
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNkemRmemhtb21mb2NzdmxkZGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyNDE4OTQsImV4cCI6MjA4NDgxNzg5NH0.vk0KP5FZwesUqm86MgHep3VZCClIgIGEwyU_2Y0L8X4'   // public by design; Row Level Security protects the data
// same login as the main app (it is stored by the browser), but this page never refreshes it itself
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, detectSessionInUrl: false } })

export async function api(path, { method = 'GET', body } = {}) {
  const { data } = await sb.auth.getSession()
  const token = data && data.session && data.session.access_token
  if (!token) { location.href = 'index.html'; throw new Error('not logged in') }
  const res = await fetch(path, {
    method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store'
  })
  if (res.status === 401) { location.href = 'index.html'; throw new Error('login expired') }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/csv')) return { blob: await res.blob() }
  const json = await res.json().catch(() => ({ ok: false, error: 'Bad answer from server' }))
  if (!res.ok || !json.ok) { const e = new Error(json.error || 'Request failed'); e.status = res.status; throw e }
  return json
}

// build DOM safely: text is ALWAYS set with textContent, so user-written names can never run as HTML
export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') n.className = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)))
  return n
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n }
export const money = (v, cur = 'USD') => (v === null || v === undefined) ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(Number(v))
export const num = (v) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Number(v || 0))
export const date = (v) => v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

let toastT
export function toast(msg, bad) {
  let t = document.getElementById('toast')
  if (!t) { t = el('div', { id: 'toast', role: 'status' }); document.body.append(t) }
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '')
  clearTimeout(toastT); toastT = setTimeout(() => { t.className = '' }, 3800)
}
export const badge = (status) => el('span', { class: 'badge b-' + status }, ({
  not_eligible: 'Not eligible', under_review: 'Under review', approved: 'Approved', suspended: 'Suspended', rejected: 'Rejected',
  pending: 'Pending', processing: 'Processing', paid: 'Paid', open: 'Open', dismissed: 'Dismissed', confirmed: 'Confirmed'
})[status] || status)
