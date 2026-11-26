# Phone notifications (Node.js only, no SQL)

Works when the app is closed: new message, like, follow, incoming call (+ missed call), new account of the other sex.

## One-time setup (Vercel > Project > Settings > Environment Variables, then Redeploy)
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   (make new ones with: node scripts/make-vapid-keys.js)
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already used by the creator API.

## How it works
1. The phone subscribes (`push.js` -> `POST /api/push`). It is saved in the user's own login record (Auth app_metadata): no table.
2. When someone does something, the app tells the server (`notifyServer(...)` -> `POST /api/notify`).
3. The server checks in Supabase that it really happened, encrypts the message (`api/_lib/webpush.js`) and sends it to Google / Apple / Mozilla.
4. `push/sw.js` shows it on the phone, even when the app is closed. Tapping it opens the chat / profile.

Change the words people see: top of `api/notify.js` (`const T`). Test everything: `npm test`.
