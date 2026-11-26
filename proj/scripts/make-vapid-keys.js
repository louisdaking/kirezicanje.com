'use strict'
// Run once:  node scripts/make-vapid-keys.js
// Then copy the 3 lines into Vercel > Project > Settings > Environment Variables (never into a file you commit).
const crypto = require('crypto')
const ecdh = crypto.createECDH('prime256v1')
ecdh.generateKeys()
console.log('VAPID_PUBLIC_KEY=' + ecdh.getPublicKey().toString('base64url'))
console.log('VAPID_PRIVATE_KEY=' + ecdh.getPrivateKey().toString('base64url'))
console.log('VAPID_SUBJECT=mailto:your-email@example.com')
