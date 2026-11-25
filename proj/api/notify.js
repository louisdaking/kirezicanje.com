'use strict'
// POST /api/notify {type, ...}. Authenticated event owner only; push payloads never contain message text.
const webpush = require('web-push')
const sb = require('./_lib/sb')
const { send, fail, bodyOf, requireUser, limited, isUuid } = require('./_lib/http')

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BAfOMyhz3lLo8WKSnqmwHoOgtBx0-1i4hlM_ulbqCbmM8-9YlwCCfRWiMt6QmUdHc6aijDFRk2E3XU-SN70tGTM'
const ORIGIN = process.env.PUBLIC_APP_ORIGIN || 'https://kirezicanje.com'

async function actorName(id) {
  const [profile] = await sb.select('profiles', { id: 'eq.' + id }, { select: 'full_name', limit: 1 })
  return (profile && profile.full_name) || 'Someone'
}

async function notificationTarget(user, body) {
  if (body.type === 'message' && isUuid(body.client_id)) {
    const [message] = await sb.select('message', {
      client_id: 'eq.' + body.client_id,
      sender_id: 'eq.' + user.id
    }, { select: 'receiver_id', limit: 1 })
    if (message && message.receiver_id !== user.id) {
      return { userId: message.receiver_id, title: 'New message', text: 'Someone sent you a message', url: '/?chat=' + user.id, key: body.client_id }
    }
  }
  if (body.type === 'like' && isUuid(body.post_id)) {
    const [like] = await sb.select('post_likes', { post_id: 'eq.' + body.post_id, user_id: 'eq.' + user.id }, { select: 'post_id', limit: 1 })
    if (!like) return null
    const [post] = await sb.select('posts', { id: 'eq.' + body.post_id }, { select: 'user_id', limit: 1 })
    if (post && post.user_id !== user.id) {
      return { userId: post.user_id, title: 'Someone liked your post', text: (await actorName(user.id)) + ' liked your post', url: '/?post=' + body.post_id, key: body.post_id }
    }
  }
  if (body.type === 'follow' && isUuid(body.target_id)) {
    const [follow] = await sb.select('follows', { follower_id: 'eq.' + user.id, following_id: 'eq.' + body.target_id }, { select: 'following_id', limit: 1 })
    if (follow && body.target_id !== user.id) {
      return { userId: body.target_id, title: 'New follower', text: (await actorName(user.id)) + ' started following you', url: '/?user=' + user.id, key: user.id }
    }
  }
  return null
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail(res, 405, 'Method not allowed') }
    const user = await requireUser(req, res)
    if (!user) return
    if (limited('push:' + user.id, 40, 60_000)) return fail(res, 429, 'Too many notification requests')

    const body = bodyOf(req)
    const target = await notificationTarget(user, body)
    if (!target) return fail(res, 400, 'The notification event could not be verified')
    if (body.type !== 'message') {
      try {
        await sb.insert('notifications', [{
          user_id: target.userId,
          type: body.type,
          title: target.title,
          body: target.text
        }], 'return=minimal')
      } catch (error) {
        console.error('notification record:', error.message)
      }
    }
    if (!process.env.VAPID_PRIVATE_KEY) return fail(res, 503, 'Push notifications are not configured on the server')
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@kirezicanje.com', PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY)

    const subscriptions = await sb.select('push_subscriptions', { user_id: 'eq.' + target.userId }, {
      select: 'endpoint,p256dh,auth',
      limit: 100
    })
    const payload = JSON.stringify({
      kc: true,
      title: target.title,
      body: target.text,
      tag: 'kc-' + (body.type || 'event') + '-' + target.key,
      url: new URL(target.url, ORIGIN).href
    })
    let delivered = 0
    for (const row of subscriptions) {
      try {
        await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
        delivered++
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await sb.rpc('delete_push_subscription', { p_endpoint: row.endpoint })
        } else {
          console.error('push delivery:', error.message)
        }
      }
    }
    return send(res, 200, { ok: true, delivered })
  } catch (error) {
    console.error('notify api:', error.message)
    return fail(res, 500, 'Notification delivery failed')
  }
}
