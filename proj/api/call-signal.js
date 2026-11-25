'use strict'
// POST /api/call-signal {recipient_id, call_id, mode}. Forwards an invite without exposing SDP.
const { createClient } = require('@supabase/supabase-js')
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireUser, limited, isUuid } = require('./_lib/http')

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Method not allowed') }
    const user = await requireUser(req, res)
    if (!user) return
    if (limited('call:' + user.id, 12, 60_000)) return fail(res, 429, 'Too many call attempts')

    const body = bodyOf(req)
    if (!isUuid(body.recipient_id) || !isUuid(body.call_id) || !['audio', 'video'].includes(body.mode) || body.recipient_id === user.id) {
      return fail(res, 400, 'Invalid call invitation')
    }
    const [recipient] = await sb.select('profiles', { id: 'eq.' + body.recipient_id }, { select: 'id', limit: 1 })
    if (!recipient) return fail(res, 404, 'User not found')

    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
    const channel = client.channel('kc-call-inbox:' + body.recipient_id, {
      config: { private: true, broadcast: { self: false } }
    })
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Call invitation service timed out')), 8000)
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timeout)
            reject(new Error('Call invitation service is unavailable'))
          }
        })
      })
      const status = await channel.send({
        type: 'broadcast',
        event: 'invite',
        payload: {
          callId: body.call_id,
          caller: user.id,
          callee: body.recipient_id,
          mode: body.mode
        }
      })
      if (status !== 'ok') throw new Error('Call invitation was not delivered')
    } finally {
      await client.removeChannel(channel)
    }
    return send(res, 200, { ok: true })
  } catch (error) {
    console.error('call signal api:', error.message)
    return fail(res, 503, 'Could not deliver the call invitation')
  }
}
