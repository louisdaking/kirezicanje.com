// =====================================================
// SOCIAL.JS  (new file)
// Everything that is new in this update lives here:
//   1. Search          (people + posts, filters, smart ranking)
//   2. Gallery         (a user's photos: posts, profile pictures, status)
//   3. Post viewer     (full screen, swipe, like, edit, delete)
//   4. User chooser    (tap an avatar -> "View profile" or "View status")
//   5. Likes           (feed, status, gallery and viewer all share one store)
//
// It does NOT need any change in Supabase. It only uses the tables
// you already have: profiles, posts, post_likes, message.
// main.js calls initSocial({...}) once the user is logged in.
// =====================================================

import { jobs, isNetworkError } from './offline.js'

export function initSocial(ctx) {
  const { supabase, me, profileCache, esc, fmtTime, showmessage, waitAsec, getTalkedMap, viewedSet } = ctx
  const $ = (id) => document.getElementById(id)
  const DAY = 24 * 60 * 60 * 1000

  // ---------------------------------------------------
  // small helpers
  // ---------------------------------------------------
  const isVideo = (p) => (p.media_type || '').startsWith('video/')
  // a post whose picture lives in the "avatars" bucket is a profile picture post
  const isPic = (p) => (p.media_url || '').includes('/avatars/')
  const kindOf = (p) => (isPic(p) ? 'profile' : p.kind === 'status' ? 'status' : 'feed')
  const avatarStyle = (u) => `style="background-image:url('${esc((u && u.profile_pic) || '')}')"`

  async function ensureProfile(uid) {
    if (profileCache[uid]) return profileCache[uid]
    const { data } = await supabase.from('profiles').select('*').eq('id', uid)
    if (data && data[0]) profileCache[uid] = data[0]
    return profileCache[uid] || {}
  }

  // "people I have talked to" is a heavy query, so remember it for one minute
  let talkedVal = {}, talkedAt = 0
  async function talkedMap() {
    if (Date.now() - talkedAt < 60000) return talkedVal
    talkedVal = await getTalkedMap(me)
    talkedAt = Date.now()
    return talkedVal
  }

  // ---------------------------------------------------
  // 5. LIKES  (one store, every screen reads from it)
  // ---------------------------------------------------
  const store = new Map()   // post id (as text) -> post row (with post_likes)
  function remember(list) {
    ;(list || []).forEach(p => { if (p && p.id != null) store.set(String(p.id), p) })
  }
  function likeState(id) {
    const p = store.get(String(id))
    const likes = (p && p.post_likes) || []
    return { n: likes.length, liked: likes.some(l => l.user_id === me) }
  }
  // paint the like button + counter of a post everywhere it is on screen
  function syncLikeUI(id) {
    id = String(id)
    const { n, liked } = likeState(id)
    document.querySelectorAll('[data-post]').forEach(el => {
      if (el.dataset.post !== id) return
      if (el.classList.contains('likebtn')) el.classList.toggle('liked', liked)
      if (el.classList.contains('likecount')) el.textContent = n + (n === 1 ? ' like' : ' likes')
    })
  }
  const likeBusy = new Set()
  async function toggleLike(id) {
    id = String(id)
    const p = store.get(id)
    if (!p || p.virtual || likeBusy.has(id)) return
    likeBusy.add(id)
    const had = likeState(id).liked
    const before = p.post_likes || []
    // we change the screen first (feels instant) and go back if Supabase says no
    p.post_likes = had ? before.filter(l => l.user_id !== me) : [...before, { user_id: me }]
    syncLikeUI(id)
    if (!had) {
      document.querySelectorAll('.likebtn[data-post]').forEach(el => {
        if (el.dataset.post !== id) return
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop')
      })
    }
    const res = had
      ? await supabase.from('post_likes').delete().eq('post_id', p.id).eq('user_id', me)
      : await supabase.from('post_likes').insert([{ post_id: p.id, user_id: me }])
    likeBusy.delete(id)
    if (res.error && isNetworkError(res.error)) {          // no internet: keep the heart, it is sent when the internet is back
      await jobs.add('like', { post_id: p.id, want: !had, user_id: me }, null, 'like:' + p.id, me)
      return
    }
    if (res.error) {
      p.post_likes = before
      syncLikeUI(id)
      window.softError(res.error, 'like failed')
    }
  }

  async function showLikers(id) {
    const list = $('likersList')
    $('likersTitle').textContent = 'Likes'
    list.innerHTML = '<p>...</p>'
    showHTML_flex('likersModal')
    if (window.__svHold) window.__svHold(true)       // pause a status while we look at the likes
    const { data: likes, error } = await supabase
      .from('post_likes').select('user_id, created_at').eq('post_id', id).order('created_at', { ascending: false })
    if (error) { list.innerHTML = ''; window.softError(error); return }
    if (!likes.length) { list.innerHTML = '<p>No likes yet</p>'; return }
    await Promise.all(likes.map(l => ensureProfile(l.user_id)))
    list.innerHTML = likes.map(l => {
      const u = profileCache[l.user_id] || {}
      return `<div class="liker" onclick="closeLikers();openUserChoice('${esc(l.user_id)}')">
        <button class="avatar" ${avatarStyle(u)}></button>
        <p>${esc(u.full_name || 'User')}</p>
      </div>`
    }).join('')
  }
  function closeLikers() {
    $('likersModal').style.display = 'none'
    if (window.__svHold) window.__svHold(false)
  }
  function showHTML_flex(id) { $(id).style.display = 'flex' }

  // what was liked / followed without internet is sent when it is back
  jobs.on('like', async (j) => {
    const r = j.want
      ? await supabase.from('post_likes').insert([{ post_id: j.post_id, user_id: j.user_id }])
      : await supabase.from('post_likes').delete().eq('post_id', j.post_id).eq('user_id', j.user_id)
    if (r.error && r.error.code !== '23505') throw r.error
  })
  jobs.on('follow', async (j) => {
    const r = j.want
      ? await supabase.from('follows').insert([{ follower_id: j.user_id, following_id: j.target }])
      : await supabase.from('follows').delete().eq('follower_id', j.user_id).eq('following_id', j.target)
    if (r.error && r.error.code !== '23505') throw r.error
  })

  // ---------------------------------------------------
  // FOLLOW  (needs 8_follow_push_setup.sql)
  // ---------------------------------------------------
  const following = new Set()             // people I follow
  const followBusy = new Set()
  const followLabel = (id) => (following.has(id) ? 'Following ✓' : '+ Follow')
  function syncFollowUI(id) {
    document.querySelectorAll('[data-follow]').forEach(el => {
      if (id && el.dataset.follow !== id) return
      el.classList.toggle('on', following.has(el.dataset.follow))
      el.textContent = followLabel(el.dataset.follow)
    })
  }
  async function loadFollows() {
    const { data, error } = await supabase.from('follows').select('following_id').eq('follower_id', me)
    if (!error && data) { following.clear(); data.forEach(r => following.add(r.following_id)) }
    syncFollowUI()
    return following
  }
  async function toggleFollow(id) {
    id = String(id)
    if (!id || id === me || followBusy.has(id)) return
    followBusy.add(id)
    const had = following.has(id)
    if (had) following.delete(id); else following.add(id)
    syncFollowUI(id)
    const res = had
      ? await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', id)
      : await supabase.from('follows').insert([{ follower_id: me, following_id: id }])
    followBusy.delete(id)
    if (res.error && isNetworkError(res.error)) {          // no internet: it is sent when the internet is back
      await jobs.add('follow', { target: id, want: !had, user_id: me }, null, 'follow:' + id, me)
      return
    }
    if (res.error && res.error.code !== '23505') {          // go back if Supabase said no
      if (had) following.add(id); else following.delete(id)
      syncFollowUI(id)
      window.softError(res.error, 'follow failed')
      return
    }
    if (!had) { const u = await ensureProfile(id); showmessage('You follow ' + (u.full_name || 'this person') + ' ✅') }
    followCounts(id)
  }
  // the numbers on a profile page
  async function followCounts(uid) {
    const a = $('fcFollowers'), b = $('fcFollowing')
    if (!a || !b || a.dataset.uid !== uid) return
    const [fo, fi] = await Promise.all([
      supabase.from('follows').select('follower_id').eq('following_id', uid),
      supabase.from('follows').select('following_id').eq('follower_id', uid)
    ])
    if (!fo.error) a.textContent = (fo.data || []).length
    if (!fi.error) b.textContent = (fi.data || []).length
  }
  // list of followers / following, with name and picture (same window as the likes)
  async function showFollowList(uid, kind) {
    const list = $('likersList')
    $('likersTitle').textContent = kind === 'followers' ? 'Followers' : 'Following'
    list.innerHTML = '<p>...</p>'
    showHTML_flex('likersModal')
    const col = kind === 'followers' ? 'follower_id' : 'following_id'
    const by = kind === 'followers' ? 'following_id' : 'follower_id'
    const { data: rows, error } = await supabase.from('follows').select(col + ', created_at').eq(by, uid).order('created_at', { ascending: false })
    if (error) { list.innerHTML = ''; window.softError(error); return }
    if (!rows.length) { list.innerHTML = kind === 'followers' ? '<p>No followers yet</p>' : '<p>Not following anybody yet</p>'; return }
    await Promise.all(rows.map(r => ensureProfile(r[col])))
    list.innerHTML = rows.map(r => {
      const id = r[col], u = profileCache[id] || {}
      return `<div class="liker" onclick="closeLikers();openUserChoice('${esc(id)}')">
        <button class="avatar" ${avatarStyle(u)}></button>
        <p>${esc(u.full_name || 'User')}</p>
        ${id === me ? '' : `<button class="followmini ${following.has(id) ? 'on' : ''}" data-follow="${esc(id)}" onclick="event.stopPropagation();toggleFollow('${esc(id)}')">${followLabel(id)}</button>`}
      </div>`
    }).join('')
  }

  // ---------------------------------------------------
  // generic bottom sheet (used by chooser, edit, delete)
  // ---------------------------------------------------
  function openSheet(html) {
    $('sheetBox').innerHTML = html
    showHTML_flex('sheetModal')
  }
  function closeSheet() { $('sheetModal').style.display = 'none' }

  // ---------------------------------------------------
  // 4. USER CHOOSER: profile or status
  // ---------------------------------------------------
  const statusOf = {}   // user id -> their status posts of the last 24 hours
  async function getStatusItems(uid) {
    // same rule as the Status page: you see yourself + people you have talked to
    if (uid !== me) {
      const talked = await talkedMap()
      if (!talked[uid]) return []
    }
    const since = new Date(Date.now() - DAY).toISOString()
    const { data, error } = await supabase
      .from('posts').select('*, post_likes(user_id)')
      .eq('user_id', uid).eq('kind', 'status').gte('created_at', since)
      .order('created_at', { ascending: true })
    if (error || !data) return []
    remember(data)
    // remember() keeps the object that is in the store, so likes stay in sync
    return data.map(p => store.get(String(p.id)))
  }

  async function openUserChoice(uid) {
    if (!uid) uid = me
    waitAsec()
    const [items] = await Promise.all([getStatusItems(uid), ensureProfile(uid)])
    waitAsec('x')
    if (!items.length) { window.openuser(uid); return }   // no status: nothing to choose, go to the profile

    statusOf[uid] = items
    const u = profileCache[uid] || {}
    const seen = viewedSet()
    const unseen = items.some(p => !seen.has(p.id))
    const last = items[items.length - 1]
    openSheet(`
      <div class="uc-head">
        <div class="sring ${unseen ? '' : 'seen'} uc-ring"><div class="sav" ${avatarStyle(u)}></div></div>
        <div><p class="uc-name">${esc(u.full_name || 'User')}</p><p class="uc-sub">📍 ${esc(u.address || '')}</p></div>
      </div>
      <button class="uc-row" onclick="ucGo('profile','${esc(uid)}')">
        <span class="uc-ic">👤</span><span><b> raba profile</b><small>amafoto, info and message</small></span>
      </button>
      <button class="uc-row" onclick="ucGo('status','${esc(uid)}')">
        <span class="uc-ic st">◎</span><span><b>raba status</b><small>${items.length} ${items.length === 1 ? 'statu' : 'status'} · ${fmtTime(last.created_at)}</small></span>
      </button>`)
  }
  function ucGo(what, uid) {
    closeSheet()
    if (what === 'status') ctx.openStatusViewer([{ uid, items: statusOf[uid] || [] }], 0)
    else window.openuser(uid)
  }

  // ---------------------------------------------------
  // 3. FULL SCREEN POST VIEWER
  // ---------------------------------------------------
  const pv = { list: [], i: 0, onChange: null, down: null }

  function openPostViewer(list, index, opts) {
    if (!list || !list.length) return
    // a video opens in REEL mode (full screen, swipe up for the next video)
    const first = list[Math.max(0, Math.min(index || 0, list.length - 1))]
    if (!(opts && opts.classic) && first && isVideo(first) && !first.virtual && openReels(list, index || 0, opts)) return
    pv.list = list.slice()
    pv.i = Math.max(0, Math.min(index || 0, pv.list.length - 1))
    pv.onChange = (opts && opts.onChange) || null
    $('pviewer').classList.remove('pv-hide')
    $('pviewer').style.display = 'block'
    pvRender()
  }
  // ---------------------------------------------------
  // REEL MODE
  // ---------------------------------------------------
  const rl = { list: [], src: null, opts: null, muted: false, io: null, clickT: null }
  function openReels(list, index, opts) {
    const vids = list.filter(p => isVideo(p) && !p.virtual)
    if (!vids.length) return false
    const cur = list[Math.max(0, Math.min(index, list.length - 1))]
    const start = Math.max(0, vids.findIndex(p => String(p.id) === String(cur.id)))
    rl.list = vids; rl.src = list; rl.opts = opts || null
    let box = $('reels')
    if (!box) { box = document.createElement('div'); box.id = 'reels'; document.body.appendChild(box) }
    box.innerHTML = `<div class="rl-top"><button type="button" onclick="closeReels()" aria-label="Back"></button><b>Reels</b></div>
      <div class="rl-scroll" id="rlScroll">${vids.map(reelHTML).join('')}</div>`
    box.style.display = 'block'
    const sc = $('rlScroll')
    sc.scrollTop = start * sc.clientHeight
    rl.io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        const item = en.target
        if (en.isIntersecting && en.intersectionRatio >= 0.6) playReel(item)
        else pauseReel(item)
      })
    }, { root: sc, threshold: [0, 0.6, 1] })
    sc.querySelectorAll('.rl-item').forEach(it => {
      rl.io.observe(it)
      const v = it.querySelector('video')
      v.addEventListener('timeupdate', () => { const b = it.querySelector('.rl-bar i'); if (b && v.duration) b.style.width = (v.currentTime / v.duration * 100) + '%' })
      v.addEventListener('waiting', () => it.classList.add('rl-wait'))
      v.addEventListener('playing', () => { it.classList.remove('rl-wait'); const l = it.querySelector('.rl-load'); if (l) l.style.display = 'none' })
      it.addEventListener('click', (e) => reelTap(e, it))
    })
    return true
  }
  function reelHTML(p, i) {
    const u = profileCache[p.user_id] || {}
    const { n, liked } = likeState(p.id)
    const own = p.user_id === me
    const fol = window.kcIsFollowing && window.kcIsFollowing(p.user_id)
    return `<section class="rl-item" data-i="${i}" data-id="${esc(p.id)}">
      <video class="rl-vid" data-src="${esc(p.media_url)}" loop playsinline preload="none"></video>
      <div class="rl-load"></div><div class="rl-pause"></div>
      <div class="rl-side">
        <button class="rl-av" type="button" ${avatarStyle(u)} onclick="closeReels();openUserChoice('${esc(p.user_id)}')" aria-label="Profile"></button>
        <button class="likebtn ${liked ? 'liked' : ''}" type="button" data-post="${esc(p.id)}" onclick="toggleLike('${esc(p.id)}')" aria-label="Like"></button>
        <button class="likecount" type="button" data-post="${esc(p.id)}">${n} ${n === 1 ? 'like' : 'likes'}</button>
        ${own ? `<button class="rl-more" type="button" onclick="reelsMore('${esc(p.id)}')" aria-label="More"></button>`
              : `<button class="rl-msg" type="button" onclick="closeReels();openm('${esc(p.user_id)}')" aria-label="Message"></button>`}
        <button class="rl-mute ${rl.muted ? 'off' : ''}" type="button" onclick="reelsMute()" aria-label="Sound"></button>
      </div>
      <div class="rl-info">
        <div class="rl-who"><b onclick="closeReels();openUserChoice('${esc(p.user_id)}')">${esc(u.full_name || '')}</b>
          ${own ? '' : `<button class="followmini ${fol ? 'on' : ''}" type="button" data-follow="${esc(p.user_id)}" onclick="toggleFollow('${esc(p.user_id)}')">${fol ? 'Following ✓' : '+ Follow'}</button>`}</div>
        ${p.caption ? `<p class="rl-cap">${esc(p.caption)}</p>` : ''}
      </div>
      <div class="rl-bar"><i></i></div>
    </section>`
  }
  function reelLoad(item) {
    if (!item) return
    const v = item.querySelector('video')
    if (v && !v.getAttribute('src')) { v.setAttribute('src', v.dataset.src); v.preload = 'auto' }
  }
  function playReel(item) {
    reelLoad(item); reelLoad(item.previousElementSibling); reelLoad(item.nextElementSibling)   // the next one is ready before you swipe
    const v = item.querySelector('video')
    item.classList.remove('paused')
    v.muted = rl.muted
    const p = v.play()
    if (p && p.catch) p.catch(() => { v.muted = true; rl.muted = true; syncMute(); v.play().catch(() => {}) })   // sound blocked: play without sound
  }
  function pauseReel(item) {
    const v = item.querySelector('video')
    if (v && !v.paused) v.pause()
  }
  function syncMute() {
    document.querySelectorAll('#reels .rl-mute').forEach(b => b.classList.toggle('off', rl.muted))
    document.querySelectorAll('#reels video').forEach(v => { v.muted = rl.muted })
  }
  function reelsMute() { rl.muted = !rl.muted; syncMute() }
  // one tap = pause / play, two taps = like
  function reelTap(e, item) {
    if (e.target.closest('.rl-side, .rl-info, .rl-top')) return
    if (rl.clickT) {
      clearTimeout(rl.clickT); rl.clickT = null
      const id = item.dataset.id
      if (!likeState(id).liked) toggleLike(id)
      const b = document.createElement('div'); b.className = 'rl-burst'; item.appendChild(b); setTimeout(() => b.remove(), 700)
      return
    }
    rl.clickT = setTimeout(() => {
      rl.clickT = null
      const v = item.querySelector('video')
      if (v.paused) { v.play().catch(() => {}); item.classList.remove('paused') } else { v.pause(); item.classList.add('paused') }
    }, 260)
  }
  // my own video: open the normal viewer (it has the edit / delete menu)
  function reelsMore(id) {
    const list = rl.src || [], opts = Object.assign({}, rl.opts || {}, { classic: true })
    const k = list.findIndex(p => String(p.id) === String(id))
    closeReels()
    if (k >= 0) openPostViewer(list, k, opts)
  }
  function closeReels() {
    const box = $('reels')
    if (!box) return
    if (rl.io) { rl.io.disconnect(); rl.io = null }
    box.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load() })
    box.style.display = 'none'
    box.innerHTML = ''
  }
  function closePostViewer() {
    const box = $('pviewer')
    box.querySelectorAll('video').forEach(v => v.pause())
    box.style.display = 'none'
    box.innerHTML = ''
  }
  function pvNav(step) {
    const n = pv.i + step
    if (n < 0 || n >= pv.list.length) return
    pv.i = n
    pvRender()
  }

  async function pvRender() {
    const box = $('pviewer')
    const p = pv.list[pv.i]
    if (!p) { closePostViewer(); return }
    const u = profileCache[p.user_id] || {}
    const own = p.user_id === me && !p.virtual
    const kind = kindOf(p)
    const label = kind === 'profile' ? 'Profile photo' : kind === 'status' ? 'Status' : ''
    const media = isVideo(p)
      ? `<video src="${esc(p.media_url)}" controls autoplay playsinline></video>`
      : `<img src="${esc(p.media_url)}" alt="" draggable="false">`
    const { n, liked } = p.virtual ? { n: 0, liked: false } : likeState(p.id)
    const when = p.created_at ? fmtTime(p.created_at) : ''

    box.innerHTML = `
      <div class="pv-top">
        <button class="pv-btn" onclick="closePostViewer()" aria-label="Close">←</button>
        <div class="pv-who" onclick="openUserChoice('${esc(p.user_id)}')">
          <span class="pv-av" ${avatarStyle(u)}></span>
          <span class="pv-name"><b>${esc(u.full_name || '')}</b><small>${[label, when].filter(Boolean).join(' · ')}</small></span>
        </div>
        ${own ? `<button class="pv-btn" onclick="pvMenu()" aria-label="More">⋯</button>` : ''}
      </div>
      <div class="pv-stage" id="pvStage">${media}</div>
      ${pv.list.length > 1 && pv.i > 0 ? `<button class="pv-arrow l" onclick="pvNav(-1)" aria-label="Previous">‹</button>` : ''}
      ${pv.list.length > 1 && pv.i < pv.list.length - 1 ? `<button class="pv-arrow r" onclick="pvNav(1)" aria-label="Next">›</button>` : ''}
      <div class="pv-bottom">
        ${p.caption ? `<p class="pv-caption">${esc(p.caption)}</p>` : ''}
        <div class="pv-actions">
          ${p.virtual ? '' : `<button class="likebtn ${liked ? 'liked' : ''}" data-post="${esc(p.id)}" onclick="toggleLike('${esc(p.id)}')" aria-label="Like"></button>
          <button class="likecount" data-post="${esc(p.id)}" onclick="showLikers('${esc(p.id)}')">${n} ${n === 1 ? 'like' : 'likes'}</button>`}
          <span class="pv-counter">${pv.list.length > 1 ? (pv.i + 1) + ' / ' + pv.list.length : ''}</span>
        </div>
      </div>`

    const v = box.querySelector('video')
    if (v) v.play().catch(() => { v.muted = true; v.play().catch(() => {}) })   // browser blocked sound: play muted

    // make sure we know the owner (name + photo in the top bar)
    if (!profileCache[p.user_id]) {
      await ensureProfile(p.user_id)
      if (pv.list[pv.i] === p && box.style.display === 'block') pvRender()
    }
  }

  // swipe left/right = next/previous, swipe down = close, tap on a photo = hide/show the bars
  ;(function attachViewerGestures() {
    const box = $('pviewer')
    if (!box) return
    box.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.pv-stage') || e.target.tagName === 'VIDEO') { pv.down = null; return }
      pv.down = { x: e.clientX, y: e.clientY, t: e.target }
    })
    box.addEventListener('pointerup', (e) => {
      const d = pv.down
      pv.down = null
      if (!d) return
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) pvNav(dx < 0 ? 1 : -1)
      else if (dy > 110 && Math.abs(dy) > Math.abs(dx)) closePostViewer()
      else if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && d.t.tagName === 'IMG') box.classList.toggle('pv-hide')
    })
    box.addEventListener('pointercancel', () => { pv.down = null })
  })()
  document.addEventListener('keydown', (e) => {
    const box = $('pviewer')
    if (!box || box.style.display !== 'block' || $('sheetModal').style.display === 'flex') return
    if (e.key === 'Escape') closePostViewer()
    else if (e.key === 'ArrowRight') pvNav(1)
    else if (e.key === 'ArrowLeft') pvNav(-1)
  })

  // ----- the "..." menu: only for MY posts -----
  function currentOwnPost() {
    const p = pv.list[pv.i]
    return p && !p.virtual && p.user_id === me ? p : null
  }
  function pvMenu() {
    const p = currentOwnPost()
    if (!p) return
    const pic = isPic(p)
    openSheet(`
      <h4>Manage this post</h4>
      <button class="uc-row" onclick="pvEdit()"><span class="uc-ic">✏️</span><span><b>Edit caption</b></span></button>
      ${pic ? '' : `<button class="uc-row" onclick="pvMove()"><span class="uc-ic">🔁</span><span><b>${p.kind === 'status' ? 'yipostinge ino status' : 'yimurire kuri status '}</b><small>${p.kind === 'status' ? 'Everyone sees it on home screen' : 'It shows on Status instead of post'}</small></span></button>`}
      <button class="uc-row" onclick="pvSave()"><span class="uc-ic">💾</span><span><b>yishire muri gallery</b></span></button>
      <button class="uc-row danger" onclick="pvConfirmDelete()"><span class="uc-ic">🗑️</span><span><b>FUTA</b></span></button>`)
  }
  function pvEdit() {
    const p = currentOwnPost()
    if (!p) return
    openSheet(`
      <h4>Edit caption</h4>
      <textarea id="editCaption" maxlength="500" placeholder="Write something...">${esc(p.caption || '')}</textarea>
      <div class="sheetbtns">
        <button class="btn-cancel" onclick="closeSheet()">Cancel</button>
        <button class="btn-pub" onclick="pvSaveCaption()">Save</button>
      </div>`)
    setTimeout(() => { const t = $('editCaption'); if (t) t.focus() }, 50)
  }

  // change a post in Supabase. Supabase answers "no error" but changes nothing when a rule blocks
  // you, so we also check that a row really came back.
  async function updatePost(p, fields) {
    waitAsec()
    const { data, error } = await supabase.from('posts').update(fields).eq('id', p.id).eq('user_id', me).select()
    waitAsec('x')
    if (error) { window.softError(error, 'Not saved'); return false }
    if (!data || !data.length) {
      showmessage('Supabase did not allow this change. The "posts" table needs an UPDATE rule for the owner.')
      return false
    }
    Object.assign(p, fields)
    return true
  }
  async function pvSaveCaption() {
    const p = currentOwnPost()
    if (!p) return
    const caption = $('editCaption').value.trim() || null
    if (!(await updatePost(p, { caption }))) return
    closeSheet()
    showmessage('Caption saved ✅')
    pvRender()
    if (pv.onChange) pv.onChange(p, 'update')
  }
  async function pvMove() {
    const p = currentOwnPost()
    if (!p) return
    const kind = p.kind === 'status' ? 'feed' : 'status'
    if (!(await updatePost(p, { kind }))) return
    closeSheet()
    showmessage(kind === 'status' ? 'Moved to Status ✅' : 'Moved to Feed ✅')
    pvRender()
    if (pv.onChange) pv.onChange(p, 'update')
  }
  async function pvSave() {
    const p = currentOwnPost()
    closeSheet()
    if (!p) return
    try {
      const blob = await (await fetch(p.media_url)).blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'kirezi-' + Date.now() + (isVideo(p) ? '.mp4' : '.jpg')
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    } catch (e) {
      window.open(p.media_url, '_blank')
    }
  }
  function pvConfirmDelete() {
    const p = currentOwnPost()
    if (!p) return
    openSheet(`
      <h4>Delete this ${isVideo(p) ? 'video' : 'photo'}?</h4>
      <p class="sheet-note">${isPic(p)
        ? 'This removes the post and its likes. Your current profile picture stays the same.'
        : 'It will be removed with all its likes. This cannot be undone.'}</p>
      <div class="sheetbtns">
        <button class="btn-cancel" onclick="closeSheet()">Cancel</button>
        <button class="btn-del" onclick="pvDelete()">Delete</button>
      </div>`)
  }
  async function pvDelete() {
    const p = currentOwnPost()
    if (!p) return
    waitAsec()
    const del = () => supabase.from('posts').delete().eq('id', p.id).eq('user_id', me).select()
    let { data, error } = await del()
    if (error && (error.code === '23503' || /foreign key/i.test(error.message))) {
      // likes still point to this post: remove them first, then try again
      await supabase.from('post_likes').delete().eq('post_id', p.id)
      ;({ data, error } = await del())
    }
    waitAsec('x')
    if (error) { window.softError(error, 'Not deleted'); return }
    if (!data || !data.length) {
      showmessage('Supabase did not allow this. The "posts" table needs a DELETE rule for the owner.')
      return
    }
    // clean the file too (best effort: a profile picture file is kept, it is still your avatar)
    const m = (p.media_url || '').match(/\/object\/public\/posts\/([^?]+)/)
    if (m) supabase.storage.from('posts').remove([decodeURIComponent(m[1])]).catch(() => {})

    store.delete(String(p.id))
    pv.list.splice(pv.i, 1)
    if (pv.i >= pv.list.length) pv.i = pv.list.length - 1
    closeSheet()
    showmessage('Deleted ✅')
    if (pv.onChange) pv.onChange(p, 'delete')
    pvRender()
  }

  // ---------------------------------------------------
  // 2. GALLERY  (photos of one user)
  // ---------------------------------------------------
  const g = { uid: null, items: [], filter: 'all', loading: false }
  const FILTERS = [['all', 'All'], ['feed', 'Posts'], ['profile', 'Profile'], ['status', 'Status']]
  const play = '<span class="g-play">▶</span>'

  function galleryList() {
    return g.filter === 'all' ? g.items : g.items.filter(p => kindOf(p) === g.filter)
  }
  function thumbHTML(p, i, click) {
    const kind = kindOf(p)
    const n = p.virtual ? 0 : likeState(p.id).n
    const media = isVideo(p)
      ? `<video src="${esc(p.media_url)}#t=0.1" muted playsinline preload="metadata"></video>`
      : `<img src="${esc(p.media_url)}" alt="" loading="lazy">`
    return `<button class="g-item" onclick="${click}(${i})">
      ${media}
      ${isVideo(p) ? play : ''}
      ${kind === 'status' ? '<span class="g-tag st">Status</span>' : kind === 'profile' ? '<span class="g-tag">Profile</span>' : ''}
      ${n ? `<span class="g-likes">♥ ${n}</span>` : ''}
    </button>`
  }

  function renderGallery() {
    const page = $('galleryPage')
    const own = g.uid === me
    const u = profileCache[g.uid] || {}
    const counts = { all: g.items.length }
    g.items.forEach(p => { const k = kindOf(p); counts[k] = (counts[k] || 0) + 1 })
    const list = galleryList()
    page.innerHTML = `
      <div class="g-head">
        <button class="pv-btn dark" onclick="closeGallery()" aria-label="Back">←</button>
        <div class="g-title"><h3>${own ? 'photos zanje' : esc((u.full_name || 'User').split(' ')[0]) + "'s photos"}</h3>
          <small>${g.loading ? 'hinge gato...' : counts.all + (counts.all === 1 ? ' photo/video' : ' photos/videos')}</small></div>
        ${own ? `<button class="addpost" onclick="openPostModal()" aria-label="Add">+</button>` : ''}
      </div>
      <div class="g-chips">
        ${FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, label]) =>
          `<button class="chip ${g.filter === k ? 'on' : ''}" onclick="galleryFilter('${k}')">${label} <i>${counts[k] || 0}</i></button>`).join('')}
      </div>
      ${g.loading
        ? `<div class="g-grid">${'<div class="g-item sk"></div>'.repeat(12)}</div>`
        : list.length
          ? `<div class="g-grid">${list.map((p, i) => thumbHTML(p, i, 'galleryOpen')).join('')}</div>`
          : `<div class="empty"><p>No photos yet</p><span>${own ? 'Tap + to share your first photo or video.' : 'This person has not posted anything yet.'}</span></div>`}`
  }

  async function openGallery(uid) {
    g.uid = uid || me
    g.filter = 'all'
    g.items = []
    g.loading = true
    $('galleryPage').style.display = 'flex'
    renderGallery()
    await ensureProfile(g.uid)
    const { data, error } = await supabase
      .from('posts').select('*, post_likes(user_id)')
      .eq('user_id', g.uid).order('created_at', { ascending: false })
    if (error) window.softError(error)
    remember(data)
    let items = (data || []).map(p => store.get(String(p.id)))
    // the current profile picture is always part of the gallery, even if it has no post
    const u = profileCache[g.uid] || {}
    if (u.profile_pic && !items.some(p => p.media_url === u.profile_pic)) {
      items.push({
        id: 'pp-' + g.uid, virtual: true, kind: 'profile', user_id: g.uid, media_url: u.profile_pic,
        media_type: 'image/jpeg', caption: null, created_at: u.created_at || null, post_likes: []
      })
    }
    const time = (p) => (p.created_at ? new Date(p.created_at).getTime() : 0)
    items.sort((a, b) => time(b) - time(a))
    g.items = items
    g.loading = false
    renderGallery()
  }
  function closeGallery() { $('galleryPage').style.display = 'none' }
  function galleryFilter(k) { g.filter = k; renderGallery() }
  function galleryOpen(i) {
    openPostViewer(galleryList(), i, {
      onChange: (p, what) => {
        if (what === 'delete') g.items = g.items.filter(x => x !== p)
        renderGallery()
      }
    })
  }

  // ---------------------------------------------------
  // 1. SEARCH
  // ---------------------------------------------------
  const RECENT_KEY = 'kc_recent_search'
  const AGE_BANDS = { '18-24': [18, 24], '25-34': [25, 34], '35+': [35, 120] }
  const S = { all: null, at: 0, q: '', f: { sex: '', age: '', country: '' }, timer: null, seq: 0, posts: [], built: false }

  // lower case + no accents, same length as the original (so highlight positions stay correct)
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const ageOf = (p) => {
    if (p.age != null && p.age !== '' && isFinite(+p.age)) return +p.age
    if (p.birth_year && isFinite(+p.birth_year)) return new Date().getFullYear() - +p.birth_year
    return null
  }
  function lev(a, b) {            // number of typos between two words
    if (Math.abs(a.length - b.length) > 3) return 9
    const row = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]
      row[0] = i
      for (let j = 1; j <= b.length; j++) {
        const tmp = row[j]
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = tmp
      }
    }
    return row[b.length]
  }
  // how well does this person match what was typed? 0 = no match
  function scorePerson(p, tokens) {
    const name = norm(p.full_name)
    const words = name.split(/\s+/).filter(Boolean)
    const place = norm(p.address)
    let total = 0
    for (const t of tokens) {
      let best = 0
      for (const w of words) {
        if (w === t) best = Math.max(best, 100)
        else if (w.startsWith(t)) best = Math.max(best, 80)
        else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 45)
        else if (t.length >= 4) {
          const d = Math.min(lev(t, w), lev(t, w.slice(0, t.length)))
          if (d <= (t.length >= 7 ? 2 : 1)) best = Math.max(best, 30 - d * 5)    // typo friendly
        }
      }
      if (!best && place) {
        if (place.startsWith(t)) best = 22
        else if (t.length >= 3 && place.includes(t)) best = 15
      }
      if (!best) return 0         // every word typed must match something
      total += best
    }
    if (name.startsWith(tokens[0])) total += 10
    return total
  }
  function highlight(text, tokens) {
    const raw = String(text || '')
    const n = norm(raw)
    if (n.length !== raw.length || !tokens.length) return esc(raw)
    const mark = new Array(raw.length).fill(false)
    tokens.forEach(t => {
      let at = n.indexOf(t)
      if (at < 0 && t.length >= 4) at = n.indexOf(t.slice(0, 3))
      if (at < 0) return
      const len = n.indexOf(t) >= 0 ? t.length : 3
      for (let k = at; k < at + len; k++) mark[k] = true
    })
    let out = '', open = false
    for (let k = 0; k < raw.length; k++) {
      if (mark[k] && !open) { out += '<mark>'; open = true }
      if (!mark[k] && open) { out += '</mark>'; open = false }
      out += esc(raw[k])
    }
    return out + (open ? '</mark>' : '')
  }

  function getRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch (e) { return [] } }
  function addRecent(q) {
    q = (q || '').trim()
    if (q.length < 2) return
    try {
      const list = [q, ...getRecent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8)
      localStorage.setItem(RECENT_KEY, JSON.stringify(list))
    } catch (e) { /* storage blocked: no recent list, that is fine */ }
  }
  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY) } catch (e) { }
    runSearch()
  }

  async function loadProfiles(force) {
    if (S.all && !force && Date.now() - S.at < 60000) return S.all
    const { data, error } = await supabase.from('profiles').select('*')
    if (error) { window.softError(error); return S.all || [] }
    data.forEach(p => { profileCache[p.id] = p })
    S.all = data
    S.at = Date.now()
    return data
  }

  function passes(p) {
    const f = S.f
    if (f.sex && (p.sex || '') !== f.sex) return false
    if (f.country && (p.address || '') !== f.country) return false
    if (f.age) {
      const a = ageOf(p)
      const [lo, hi] = AGE_BANDS[f.age]
      if (a == null || a < lo || a > hi) return false
    }
    return true
  }

  function buildSearchShell() {
    $('searchPage').innerHTML = `
      <div class="s-head">
        <h3>Search</h3>
        <div class="s-box">
          <svg viewBox="0 0 24 24" class="s-ic"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="sInput" type="text" inputmode="search" enterkeyhint="search" placeholder="rondera abantu, ibihungu , posts" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="s-clear" id="sClear" aria-label="Clear">✕</button>
        </div>
        <div class="s-filters" id="sFilters"></div>
      </div>
      <div class="s-body" id="sBody"></div>`
    const input = $('sInput')
    input.addEventListener('input', () => {
      S.q = input.value
      $('sClear').style.display = S.q ? 'flex' : 'none'
      clearTimeout(S.timer)
      S.timer = setTimeout(runSearch, 220)         // wait until the user stops typing
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { addRecent(S.q); input.blur() }
    })
    $('sClear').addEventListener('click', () => {
      input.value = ''; S.q = ''; $('sClear').style.display = 'none'; input.focus(); runSearch()
    })
    $('sFilters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]')
      if (!b) return
      const k = b.dataset.k, v = b.dataset.v
      S.f[k] = S.f[k] === v ? '' : v               // tap again = turn the filter off
      renderFilters(); runSearch()
    })
    $('sFilters').addEventListener('change', (e) => {
      if (e.target.id === 'sCountry') { S.f.country = e.target.value; renderFilters(); runSearch() }
    })
    $('sClear').style.display = 'none'
    S.built = true
  }

  function renderFilters() {
    const people = (S.all || []).filter(p => p.id !== me)
    const sexes = [...new Set(people.map(p => p.sex).filter(Boolean))]
    const hasAge = people.some(p => ageOf(p) != null)
    const count = {}
    people.forEach(p => { if (p.address) count[p.address] = (count[p.address] || 0) + 1 })
    const countries = Object.keys(count).sort((a, b) => count[b] - count[a])
    const chip = (k, v, label) => `<button class="chip ${S.f[k] === v ? 'on' : ''}" data-k="${k}" data-v="${esc(v)}">${esc(label)}</button>`
    const mine = (profileCache[me] || {}).address
    let html = ''
    sexes.forEach(s => { html += chip('sex', s, s) })
    if (hasAge) Object.keys(AGE_BANDS).forEach(b => { html += chip('age', b, b) })
    if (mine && countries.includes(mine)) html += chip('country', mine, '📍 aba kwegereye')
    if (countries.length > 1) {
      html += `<select id="sCountry" class="chip sel ${S.f.country && S.f.country !== mine ? 'on' : ''}">
        <option value="">abava mugihugu kanaka</option>
        ${countries.map(c => `<option value="${esc(c)}" ${S.f.country === c ? 'selected' : ''}>${esc(c)} (${count[c]})</option>`).join('')}
      </select>`
    }
    $('sFilters').innerHTML = html
    $('sFilters').style.display = html ? 'flex' : 'none'
  }

  function personRow(p, tokens) {
    const a = ageOf(p)
    const sub = ['📍 ' + (p.address || '—'), a != null ? a + ' yrs' : ''].filter(Boolean).join(' · ')
    return `<div class="s-row" onclick="searchOpen('${esc(p.id)}')">
      <button class="avatar s-av" ${avatarStyle(p)} onclick="event.stopPropagation();openUserChoice('${esc(p.id)}')" aria-label="Open"></button>
      <div class="s-mid"><p class="s-name">${highlight(p.full_name || 'User', tokens)}</p><p class="s-sub">${esc(sub)}</p></div>
      <button class="s-msg" onclick="event.stopPropagation();searchMsg('${esc(p.id)}')">Message</button>
    </div>`
  }

  function hashNum(str) {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return (h >>> 0) % 100
  }

  async function runSearch() {
    if (!S.built || $('searchPage').style.display === 'none') return
    const body = $('sBody')
    const q = S.q.trim()
    const mySeq = ++S.seq

    if (!S.all) {
      body.innerHTML = '<div class="s-sk">' + '<div class="s-row sk"><i></i><b></b></div>'.repeat(6) + '</div>'
      await loadProfiles()
      renderFilters()
      if (mySeq !== S.seq) return
    }
    const pool = S.all.filter(p => p.id !== me && passes(p))
    const filtersOn = !!(S.f.sex || S.f.age || S.f.country)

    // ---------- nothing typed ----------
    if (!q) {
      S.posts = []
      let html = ''
      const recent = getRecent()
      if (recent.length && !filtersOn) {
        html += `<div class="s-sec"><h5>Recent</h5><button class="s-link" onclick="searchClearRecent()">Clear</button></div>
          <div class="s-recent">${recent.map(r => `<button class="chip" onclick="searchRecent(this)" data-q="${esc(r)}">🕘 ${esc(r)}</button>`).join('')}</div>`
      }
      const talked = filtersOn ? {} : await talkedMap()
      if (mySeq !== S.seq) return
      const mine = (profileCache[me] || {}).address
      const today = new Date().toDateString()
      const list = filtersOn
        ? pool.slice().sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)))
        : pool
          .map(p => ({ p, s: (p.address && p.address === mine ? 30 : 0) + (talked[p.id] ? 0 : 20) + hashNum(p.id + today) / 5 }))
          .sort((a, b) => b.s - a.s).map(x => x.p).slice(0, 40)
      html += `<div class="s-sec"><h5>${filtersOn ? pool.length + (pool.length === 1 ? ' umuntu' : ' abantu') : 'abantu ushobora gukunda ❤️'}</h5></div>`
      html += list.length ? list.map(p => personRow(p, [])).join('')
        : `<div class="empty"><p>ntanumwe araboneka</p><span>${filtersOn ? 'kuramwo filter.' : 'Come back soon.'}</span></div>`
      body.innerHTML = html
      return
    }

    // ---------- something typed ----------
    const tokens = norm(q).split(/\s+/).filter(Boolean)
    const talked = await talkedMap()
    if (mySeq !== S.seq) return
    const mine = (profileCache[me] || {}).address
    const people = pool
      .map(p => ({ p, s: scorePerson(p, tokens) }))
      .filter(x => x.s > 0)
      .map(x => ({ p: x.p, s: x.s + (talked[x.p.id] ? 3 : 0) + (x.p.address && x.p.address === mine ? 2 : 0) }))
      .sort((a, b) => b.s - a.s || String(a.p.full_name).localeCompare(String(b.p.full_name)))
      .slice(0, 60)

    const render = () => {
      let html = `<div class="s-sec"><h5>People</h5><span>${people.length}</span></div>`
      html += people.length ? people.map(x => personRow(x.p, tokens)).join('')
        : `<p class="s-none">ntawe twaronse yitwa “${esc(q)}”${filtersOn ? ' with these filters' : ''}.</p>`
      if (S.posts.length) {
        html += `<div class="s-sec"><h5>Posts</h5><span>${S.posts.length}</span></div>
          <div class="g-grid s-grid">${S.posts.map((p, i) => thumbHTML(p, i, 'searchPostOpen')).join('')}</div>`
      }
      $('sBody').innerHTML = html
    }
    S.posts = []
    render()

    // posts whose caption has the words (feed posts only, status stays private to its viewers)
    if (q.length >= 2) {
      const pattern = '%' + q.replace(/[%_\\,()]/g, ' ').trim() + '%'
      const { data } = await supabase
        .from('posts').select('*, post_likes(user_id)')
        .eq('kind', 'feed').ilike('caption', pattern)
        .order('created_at', { ascending: false }).limit(18)
      if (mySeq !== S.seq || !data) return
      remember(data)
      await Promise.all([...new Set(data.map(p => p.user_id))].map(ensureProfile))
      if (mySeq !== S.seq) return
      S.posts = data.map(p => store.get(String(p.id)))
      render()
    }
  }

  function openSearch() {
    closeOverlays()
    ;['allofthem', 'messenger', 'userJournal'].forEach(id => { $(id).style.display = 'none' })
    $('statusPage').style.transform = 'scale(0)'
    $('navigation').style.display = 'flex'
    ctx.setNav('search')
    $('searchPage').style.display = 'flex'
    if (!S.built) buildSearchShell()
    renderFilters()
    runSearch()
    if (window.matchMedia('(hover: hover)').matches) $('sInput').focus()   // on a phone we do not pop the keyboard up by itself
  }
  function searchOpen(uid) { addRecent(S.q); openUserChoice(uid) }
  function searchMsg(uid) { addRecent(S.q); window.openm(uid) }
  function searchRecent(btn) {
    const input = $('sInput')
    input.value = btn.dataset.q
    S.q = btn.dataset.q
    $('sClear').style.display = 'flex'
    runSearch()
  }
  function searchPostOpen(i) {
    openPostViewer(S.posts, i, { onChange: (p, what) => { if (what === 'delete') S.posts = S.posts.filter(x => x !== p) } })
  }

  // ---------------------------------------------------
  // closes everything that floats above the pages
  // (main.js calls this whenever the user goes to another page)
  // ---------------------------------------------------
  function closeOverlays() {
    closePostViewer()
    closeGallery()
    closeSheet()
    $('likersModal').style.display = 'none'
    $('searchPage').style.display = 'none'
  }

  // ---------------------------------------------------
  // let the HTML buttons find our functions
  // ---------------------------------------------------
  Object.assign(window, {
    kcRemember: remember, syncLikeUI, toggleLike, showLikers, closeLikers,
    openSheet, closeSheet,
    openUserChoice, ucGo,
    openPostViewer, closePostViewer, openReels, closeReels, reelsMute, reelsMore, pvNav, pvMenu, pvEdit, pvSaveCaption, pvMove, pvSave, pvConfirmDelete, pvDelete,
    openGallery, closeGallery, galleryFilter, galleryOpen,
    openSearch, searchOpen, searchMsg, searchRecent, searchClearRecent: clearRecent, searchPostOpen,
    closeOverlays,
    toggleFollow, showFollowList, followCounts, syncFollowUI,
    kcIsFollowing: (id) => following.has(String(id)),
    kcFollowsReady: loadFollows()
  })
  return { remember }
}
