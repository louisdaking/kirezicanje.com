'use strict'
// Daking AI inside KIREZI CANJE.
//   GET  /api/daking                      -> my conversation + messages left today
//   POST /api/daking {message}            -> ask Daking AI (history is kept per account in ai_chats)
//   POST /api/daking {action:'clear'}     -> start a new conversation
// The browser never sees the AI address or any secret. Identity comes from the verified login token only.
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireUser, limited } = require('./_lib/http')

const DAKING_URL = () => (process.env.DAKING_API_URL || 'https://daking-ai.vercel.app/api/chat').trim()
const DAILY = Number(process.env.DAKING_DAILY_LIMIT) || 40
const MAX_IN = 2000
const HISTORY = 14

const appContext = (name) => `You are chatting INSIDE the KIREZI CANJE app (a Burundian community and dating app, https://kirezicanje.com) with ${name ? 'a user called ' + name : 'a user'}. ` +
  'Answer in the language the user writes (Kirundi, French or English). Be warm, friendly and short (a chat, not an essay). ' +
  'You can help with: writing a good bio, first messages and icebreakers, conversation ideas, date ideas, safe dating, and how to use the app. ' +
  'Never ask for passwords, codes or money. Warn kindly about scams and about sending money to someone met online. Do not share personal details about other users.'

const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString() }

async function usedToday(uid) {
  const rows = await sb.select('ai_chats', { user_id: 'eq.' + uid, role: 'eq.user', created_at: 'gte.' + dayStart() }, { select: 'id', limit: DAILY + 1 })
  return rows.length
}

async function ask(contents, name) {
  const secret = (process.env.DAKING_PARTNER_SECRET || '').trim()
  const body = secret ? { contents, appContext: appContext(name) } : { contents, projectContext: appContext(name) }
  const res = await fetch(DAKING_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-daking-secret': secret } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(26_000)
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.answer) { const e = new Error(j.error || 'Daking AI is busy'); e.status = res.status; throw e }
  return String(j.answer)
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    if (req.method === 'GET') {
      const rows = await sb.select('ai_chats', { user_id: 'eq.' + user.id }, { select: 'role,content,created_at', order: 'created_at.desc', limit: 60 })
      const used = await usedToday(user.id)
      return send(res, 200, { ok: true, messages: rows.reverse(), left: Math.max(0, DAILY - used), daily: DAILY })
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return fail(res, 405, 'Method not allowed') }

    const b = bodyOf(req)
    if (b.action === 'clear') {
      await sb.call('/rest/v1/ai_chats?user_id=eq.' + encodeURIComponent(user.id), { method: 'DELETE' })
      return send(res, 200, { ok: true })
    }

    const text = typeof b.message === 'string' ? b.message.trim().slice(0, MAX_IN) : ''
    if (!text) return fail(res, 400, 'Write a message first')
    if (limited('ai:' + user.id, 8, 60_000)) return fail(res, 429, 'Slow down a little 💗 try again in a minute')
    const used = await usedToday(user.id)
    if (used >= DAILY) return fail(res, 429, `You used your ${DAILY} Daking AI messages for today. Come back tomorrow 💗`)

    const [prof] = await sb.select('profiles', { id: 'eq.' + user.id }, { select: 'full_name', limit: 1 }).catch(() => [])
    const past = (await sb.select('ai_chats', { user_id: 'eq.' + user.id }, { select: 'role,content', order: 'created_at.desc', limit: HISTORY })).reverse()
    while (past.length && past[0].role !== 'user') past.shift()
    const contents = [...past, { role: 'user', content: text }].map((m) => ({ role: m.role, parts: [{ text: m.content }] }))

    let answer
    try { answer = await ask(contents, prof && prof.full_name) }
    catch (e) { console.error('[daking] ', e.message); return fail(res, 502, 'Daking AI is resting for a moment. Try again 💗') }
    answer = answer.slice(0, 20000)

    const t = Date.now()
    await sb.insert('ai_chats', [
      { user_id: user.id, role: 'user', content: text, created_at: new Date(t).toISOString() },
      { user_id: user.id, role: 'model', content: answer, created_at: new Date(t + 1).toISOString() }
    ], 'return=minimal')
    return send(res, 200, { ok: true, answer, left: Math.max(0, DAILY - used - 1) })
  } catch (e) {
    console.error('[daking] failed', e && e.message)
    return fail(res, 500, 'Something went wrong. Please try again.')
  }
}
