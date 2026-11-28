// =====================================================================
// KIREZI CANJE - DAKING AI: a floating button on the home page + a chat screen (his own inbox)
// Talks only to /api/daking (the server holds the AI address and the secrets).
// =====================================================================
const AI_NAME = 'Daking AI'
const CSS = `
#kcAiFab{position:fixed;right:16px;bottom:calc(var(--nav-h,72px) + var(--safe-b,0px) + 18px);z-index:6;width:58px;height:58px;border:0;border-radius:50%;padding:0;cursor:pointer;display:none;place-items:center;
  background:linear-gradient(135deg,#FF2E93,#FF7A59);box-shadow:0 10px 26px rgba(255,46,147,.5),0 2px 8px rgba(27,10,23,.2);color:#fff;-webkit-tap-highlight-color:transparent}
#kcAiFab.on{display:grid;animation:kcaiPop .45s cubic-bezier(.2,1.4,.4,1)}
#kcAiFab::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px solid rgba(255,46,147,.55);animation:kcaiRing 2.2s ease-out infinite;pointer-events:none}
#kcAiFab svg{width:30px;height:30px}
#kcAiFab i{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;border-radius:10px;background:#fff;color:#E02483;font:800 10px/20px system-ui;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.2);font-style:normal;padding:0 4px}
#kcAi{position:fixed;inset:0;z-index:1000;display:none;flex-direction:column;background:#FFF5F9;font-family:var(--body,system-ui,sans-serif);color:#2B1024}
#kcAi.on{display:flex;animation:kcaiUp .28s ease}
#kcAi .hd{flex:none;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 10px 10px;background:linear-gradient(135deg,#FF2E93,#FF7A59);color:#fff;box-shadow:0 4px 18px rgba(255,46,147,.3)}
#kcAi .hd button{border:0;background:rgba(255,255,255,.2);color:#fff;width:38px;height:38px;border-radius:50%;font-size:20px;cursor:pointer;display:grid;place-items:center;padding:0}
#kcAi .ava{flex:none;width:42px;height:42px;border-radius:50%;background:#fff;display:grid;place-items:center;box-shadow:0 3px 10px rgba(0,0,0,.18)}
#kcAi .ava svg{width:24px;height:24px}
#kcAi .who{flex:1;min-width:0;line-height:1.2}
#kcAi .who b{display:block;font:800 16px var(--display,system-ui)}
#kcAi .who small{display:block;font:600 11.5px var(--body,system-ui);opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#kcAi .list{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 12px 8px;display:flex;flex-direction:column;gap:9px;background:radial-gradient(circle at 20% 0,#FFE3EF 0,transparent 45%),radial-gradient(circle at 90% 100%,#FFE9DF 0,transparent 40%),#FFF5F9}
#kcAi .m{max-width:84%;padding:10px 13px;border-radius:18px;font:500 14.5px/1.45 var(--body,system-ui);overflow-wrap:anywhere;animation:kcaiMsg .22s ease}
#kcAi .m.ai{align-self:flex-start;background:#fff;border:1px solid #F7D5E4;border-bottom-left-radius:5px;box-shadow:0 3px 10px rgba(255,46,147,.08)}
#kcAi .m.me{align-self:flex-end;color:#fff;background:linear-gradient(135deg,#FF2E93,#FF7A59);border-bottom-right-radius:5px;box-shadow:0 4px 12px rgba(255,46,147,.3)}
#kcAi .m pre{margin:8px 0;padding:10px;border-radius:10px;background:#2B1024;color:#FFE9F3;font:12.5px/1.45 ui-monospace,Menlo,monospace;overflow-x:auto;white-space:pre}
#kcAi .m code.i{background:#FFE9F3;color:#B3185F;padding:1px 5px;border-radius:5px;font:12.5px ui-monospace,Menlo,monospace}
#kcAi .m.me code.i{background:rgba(255,255,255,.25);color:#fff}
#kcAi .m.typing{padding:2px 14px}
#kcAi .m.typing .kc-inline{padding:6px 0}
#kcAi .m.typing .kc-inline small{color:#B07A95}
#kcAi .hello{align-self:center;text-align:center;max-width:320px;margin:18px 0 6px}
#kcAi .hello .big{width:76px;height:76px;margin:0 auto 10px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#FF2E93,#FF7A59);box-shadow:0 12px 30px rgba(255,46,147,.4);animation:kcaiBeat 1.6s ease-in-out infinite}
#kcAi .hello .big svg{width:40px;height:40px}
#kcAi .hello h3{margin:0 0 4px;font:800 20px var(--display,system-ui)}
#kcAi .hello p{margin:0;color:#7A5568;font:500 13.5px/1.4 var(--body,system-ui)}
#kcAi .chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
#kcAi .chips button{border:1.5px solid #FFB3D3;background:#fff;color:#C4207A;border-radius:99px;padding:8px 13px;font:700 12.5px var(--body,system-ui);cursor:pointer}
#kcAi .bar{flex:none;display:flex;align-items:flex-end;gap:8px;padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));background:#fff;border-top:1px solid #F7D5E4}
#kcAi textarea{flex:1;resize:none;border:1.5px solid #F7D5E4;border-radius:22px;padding:11px 15px;font:500 15px/1.35 var(--body,system-ui);max-height:120px;outline:none;background:#FFF9FC;color:#2B1024}
#kcAi textarea:focus{border-color:#FF2E93}
#kcAi .send{flex:none;width:44px;height:44px;border:0;border-radius:50%;background:linear-gradient(135deg,#FF2E93,#FF7A59);color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 5px 14px rgba(255,46,147,.4);padding:0}
#kcAi .send:disabled{opacity:.5;box-shadow:none}
#kcAi .send svg{width:21px;height:21px}
@keyframes kcaiPop{from{transform:scale(.3);opacity:0}to{transform:none;opacity:1}}
@keyframes kcaiRing{0%{transform:scale(.9);opacity:.9}100%{transform:scale(1.45);opacity:0}}
@keyframes kcaiUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
@keyframes kcaiMsg{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
@keyframes kcaiBeat{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
@media (prefers-reduced-motion:reduce){#kcAiFab::after,#kcAi .hello .big{animation:none}}`

const SPARK = (c) => `<svg viewBox="0 0 24 24" fill="${c}" aria-hidden="true"><path d="M12 2.5l2.2 5.6 5.6 2.2-5.6 2.2L12 18.1l-2.2-5.6L4.2 10.3l5.6-2.2z"/><path d="M19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z" opacity=".9"/><path d="M5.5 14.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" opacity=".8"/></svg>`
const BUBBLE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 2C6.5 2 2 5.9 2 10.8c0 2.4 1.1 4.6 2.9 6.2-.2 1.3-.8 2.5-1.7 3.5 2.1-.1 3.9-.9 5.2-1.9 1.1.3 2.4.5 3.6.5 5.5 0 10-3.9 10-8.8S17.500 2 12 2z"/><path fill="#E02483" d="M12 5.5l1.3 3.2 3.2 1.3-3.2 1.3L12 14.5l-1.3-3.2L7.500 10l3.2-1.3z"/><path fill="#FF7A59" d="M16.500 12.500l.6 1.400 1.400.6-1.400.6-.6 1.400-.6-1.400-1.400-.6 1.400-.6z"/></svg>`
const SEND = `<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3.4 20.4l17.4-7.500a1 1 0 000-1.800L3.400 3.600a1 1 0 00-1.400 1.100L3.500 10l9 2-9 2-1.500 5.300a1 1 0 001.400 1.100z"/></svg>`

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// small, safe markdown: code blocks, `code`, **bold**, line breaks
function md(text) {
  return String(text).split(/```/).map((part, i) => {
    if (i % 2) { const nl = part.indexOf('\n'); const code = nl >= 0 && nl < 20 ? part.slice(nl + 1) : part; return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>` }
    return esc(part.replace(/^\n+|\n+$/g, '')).replace(/`([^`\n]+)`/g, '<code class="i">$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
  }).join('')
}

const STARTERS = ['Mfasha kwandika bio nziza 💗', 'Ideas for a first message 💌', 'Comment bien commencer une conversation ?', 'Dating safety tips 🛡️']

export function initDaking({ supabase, me, toast }) {
  if (window.__kcDaking && window.__kcDaking.me === me) return
  if (window.__kcDaking) window.__kcDaking.destroy()
  const say = toast || (() => {})
  if (!document.getElementById('kcAiCss')) { const st = document.createElement('style'); st.id = 'kcAiCss'; st.textContent = CSS; document.head.appendChild(st) }

  let msgs = [], loaded = false, busy = false, left = null, el = null, fab = null, timer = null

  async function api(method, body) {
    const { data } = await supabase.auth.getSession()
    const token = data && data.session && data.session.access_token
    if (!token) throw new Error('Please log in again')
    const res = await fetch('/api/daking', { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || j.ok === false) throw new Error(j.error || 'Something went wrong')
    return j
  }

  // ---------- floating button (home page only) ----------
  fab = document.createElement('button')
  fab.id = 'kcAiFab'; fab.type = 'button'; fab.setAttribute('aria-label', AI_NAME)
  fab.innerHTML = BUBBLE.replace('<svg ', '<svg style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.2))" ') + '<i>AI</i>'
  fab.addEventListener('click', open)
  document.body.appendChild(fab)
  const shown = (id) => { const n = document.getElementById(id); return !!n && getComputedStyle(n).display !== 'none' }
  function placeFab() {
    const home = shown('allofthem') && shown('navigation')
    const blocked = (el && el.classList.contains('on')) || shown('pviewer') || shown('reels') || shown('sviewer') || shown('postModal') || shown('inbox') || shown('loginpage')
    fab.classList.toggle('on', !!(home && !blocked))
  }
  timer = setInterval(placeFab, 500); placeFab()

  // ---------- chat screen ----------
  function build() {
    el = document.createElement('div'); el.id = 'kcAi'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', AI_NAME)
    el.innerHTML = `<div class="hd"><button type="button" id="kcAiBack" aria-label="Back">‹</button><div class="ava">${SPARK('#E02483')}</div>
      <div class="who"><b>${AI_NAME} 💗</b><small id="kcAiSub">Kirundi · English · Français</small></div><button type="button" id="kcAiNew" aria-label="New chat" title="New chat">🧹</button></div>
      <div class="list" id="kcAiList"></div>
      <div class="bar"><textarea id="kcAiIn" rows="1" maxlength="2000" placeholder="Write to ${AI_NAME}…" enterkeyhint="send"></textarea><button class="send" id="kcAiSend" type="button" aria-label="Send">${SEND}</button></div>`
    document.body.appendChild(el)
    el.querySelector('#kcAiBack').onclick = close
    el.querySelector('#kcAiSend').onclick = () => send()
    el.querySelector('#kcAiNew').onclick = clearChat
    const ta = el.querySelector('#kcAiIn')
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px' })
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer:fine)').matches) { e.preventDefault(); send() } })
  }
  const list = () => el.querySelector('#kcAiList')
  const toBottom = () => { const l = list(); l.scrollTop = l.scrollHeight }
  function sub() { const s = el.querySelector('#kcAiSub'); s.textContent = left == null ? 'Kirundi · English · Français' : `${left} message${left === 1 ? '' : 's'} left today 💗` }
  function bubble(role, text) { return `<div class="m ${role === 'user' ? 'me' : 'ai'}">${md(text)}</div>` }
  function render() {
    const l = list()
    if (!msgs.length) {
      l.innerHTML = `<div class="hello"><div class="big">${SPARK('#fff')}</div><h3>Muraho! I am ${AI_NAME} 💗</h3><p>Ask me anything: a bio, a first message, dating advice, or just chat. Mbwira mu Kirundi, English ou Français.</p>
        <div class="chips">${STARTERS.map((s) => `<button type="button">${esc(s)}</button>`).join('')}</div></div>`
      l.querySelectorAll('.chips button').forEach((b) => { b.onclick = () => send(b.textContent) })
    } else l.innerHTML = msgs.map((m) => bubble(m.role, m.content)).join('')
    toBottom()
  }
  function typing(on) {
    const l = list(); const old = l.querySelector('.typing'); if (old) old.remove()
    if (on) { l.insertAdjacentHTML('beforeend', `<div class="m ai typing">${window.kcLoader ? window.kcLoader.inline(AI_NAME + ' is typing…') : '…'}</div>`); toBottom() }
  }
  async function load() {
    if (loaded) return
    try { const j = await api('GET'); msgs = j.messages || []; left = j.left; loaded = true } catch (e) { if (!navigator.onLine) say('📴 No internet') }
    sub(); render()
  }
  async function send(preset) {
    const ta = el.querySelector('#kcAiIn')
    const text = String(preset != null ? preset : ta.value).trim()
    if (!text || busy) return
    if (!navigator.onLine) { say('📴 No internet. Try again when it is back.'); return }
    busy = true; el.querySelector('#kcAiSend').disabled = true
    if (preset == null) { ta.value = ''; ta.style.height = 'auto' }
    msgs.push({ role: 'user', content: text }); render(); typing(true)
    try {
      const j = await api('POST', { message: text })
      msgs.push({ role: 'model', content: j.answer }); left = j.left
    } catch (e) {
      msgs.pop()                                   // the question is not saved: put it back so nothing is lost
      if (preset == null) ta.value = text
      say(e.message || 'Daking AI is resting. Try again 💗')
    } finally { busy = false; el.querySelector('#kcAiSend').disabled = false; typing(false); sub(); render() }
  }
  async function clearChat() {
    if (!msgs.length || busy) return
    if (!window.confirm('Start a new chat? The old messages will be deleted.')) return
    try { await api('POST', { action: 'clear' }); msgs = []; render(); say('New chat ✨') } catch (e) { say(e.message) }
  }
  function open() {
    if (!el) build()
    el.classList.add('on'); fab.classList.remove('on')
    document.body.style.overflow = 'hidden'
    load().then(() => { sub(); render() }); render()
  }
  function close() { if (!el) return; el.classList.remove('on'); document.body.style.overflow = ''; placeFab() }
  function isOpen() { return !!el && el.classList.contains('on') }

  window.kcAiOpen = isOpen; window.kcAiClose = close; window.openDakingAI = open
  window.__kcDaking = { me, destroy() { clearInterval(timer); fab && fab.remove(); el && el.remove(); document.body.style.overflow = ''; window.__kcDaking = null } }
}
