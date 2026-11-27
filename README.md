# kirezicanje.com

## Calls and notifications

- Calls use browser WebRTC audio/video with Supabase Realtime broadcasts. Signaling currently goes through the client’s Realtime channels; there is no separate `call-signal` API or call-specific SQL setup file in this repository. Calls need HTTPS and microphone/camera permission; some restrictive networks may also require a TURN server.
- Push delivery runs through the Node.js [`proj/api/notify.js`](./proj/api/notify.js) endpoint. Set `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel. The VAPID public key must match the key in `proj/push.js`; generate a new key pair and update both sides if you do not have its matching private key. The endpoint validates supported events against Supabase before sending and never includes message text.
- New opposite-sex members appear through the existing people recommendations; no new-member push alerts are sent.

## Inbox restrictions

Run [`proj/block-external-message.sql`](./proj/block-external-message.sql) once in the Supabase SQL Editor. It blocks numeric and link-based content in inbox messages, including direct Supabase API insert/update attempts.

## Main app pages

The app uses separate documents for each major section: [`index.html`](./proj/index.html), [`messages.html`](./proj/messages.html), [`status.html`](./proj/status.html), [`profile.html`](./proj/profile.html), and [`search.html`](./proj/search.html). Each page loads the shared shell from `proj/shared-shell.html`, while Supabase retains the authentication session across same-origin navigation. A per-tab snapshot restores each visited page immediately and refreshes it in the background; snapshots are cleared on logout. Old `?page=...` links and `?chat=...` / `?user=...` deep links are redirected to the matching page.