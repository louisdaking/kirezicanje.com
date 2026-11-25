// KIREZI CANJE - counts a genuine profile visit (and a qualified impression after a few seconds on screen).
// The server decides what really counts. This file only reports "this person opened that profile".
let timer = null
export function trackProfile(supabase, profileId, myId) {
  clearTimeout(timer)
  if (!profileId || profileId === myId) return
  const send = async (kind) => {
    try {
      const { data } = await supabase.auth.getSession()
      const token = data && data.session && data.session.access_token
      if (!token) return
      await fetch('/api/track', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ profile_id: profileId, kind }) })
    } catch { /* tracking must never disturb the app */ }
  }
  send('visit')
  timer = setTimeout(() => { if (document.visibilityState === 'visible') send('impression') }, 6000)
}
