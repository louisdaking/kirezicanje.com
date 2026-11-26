export function hasInboxNumber(text) {
  return /\p{N}/u.test(String(text || ''))
}

export function hasInboxLink(text) {
  const value = String(text || '').trim()
  if (!value) return false

  return /(?:https?:\/\/|ftp:\/\/|\/\/|www\.)/i.test(value)
    || /(^|[^a-z0-9])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?=$|[^a-z0-9])/i.test(value)
    || /(?:^|[^a-z0-9])(?:localhost|[a-z0-9-]+:[a-z0-9]+)/i.test(value)
}

export function inboxPolicyError(text) {
  if (hasInboxNumber(text)) return 'Numbers are not allowed in messages.'
  if (hasInboxLink(text)) return 'Links are not allowed in messages.'
  return ''
}
