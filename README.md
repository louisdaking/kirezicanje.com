# kirezicanje.com

## Calls and notifications

- Calls use browser WebRTC audio/video and private Supabase Realtime broadcast channels. Invites are forwarded by the authenticated Node.js [`proj/api/call-signal.js`](./proj/api/call-signal.js) endpoint; SDP and ICE remain in participant-only rooms. Run [`proj/call-realtime-setup.sql`](./proj/call-realtime-setup.sql) once in Supabase SQL Editor and enable private Realtime channels. Calls need HTTPS and microphone/camera permission; some restrictive networks may also require a TURN server.
- Push delivery runs through the Node.js [`proj/api/notify.js`](./proj/api/notify.js) endpoint. Set `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel. The VAPID public key must match the key in `proj/push.js`; generate a new key pair and update both sides if you do not have its matching private key. The endpoint validates message, like, and follow events against Supabase before sending, and never includes message text.
- New opposite-sex members appear through the existing people recommendations; no new-member push alerts are sent.

## Inbox restrictions

Run [`proj/block-external-message.sql`](./proj/block-external-message.sql) once in the Supabase SQL Editor. It blocks numeric and link-based content in inbox messages, including direct Supabase API insert/update attempts.