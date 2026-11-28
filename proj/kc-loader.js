// =====================================================================
// KC-LOADER.JS - the ONE loading style of KIREZI CANJE (two hearts + dots)
// Classic script (not a module) so every page can load it in <head>.
//
//   kcLoader.splash('Meet your soulmate')  -> returns hide()   full screen
//   kcLoader.busy('Updating your photo…')  -> returns done()   over the page
//   kcLoader.inline('Loading posts…')      -> HTML string       inside a list/area
//
// It also shows itself by itself:
//   * when a page opens (pages without page-loader.js)
//   * when you go to another page, go back, or reload (beforeunload)
// Pictures (.kc-img) and placeholder blocks get the hearts from kc-loader.css.
// =====================================================================
(function () {
  if (window.kcLoader) return
  var HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
  var HEARTS = '<div class="kc-loader-hearts"><span>' + HEART + '</span><span>' + HEART + '</span></div>'
  var DOTS = '<span class="kc-dots"><i></i><i></i><i></i></span>'
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function mount(el) { (document.body || document.documentElement).appendChild(el) }

  function box(id, text, extra) {
    var el = document.createElement('div')
    el.id = id
    el.className = 'kc-loader' + (extra ? ' ' + extra : '')
    el.setAttribute('role', 'status')
    el.innerHTML = HEARTS + '<b>KIREZI CANJE</b><small>' + esc(text) + '</small>' + DOTS
    return el
  }
  function closer(el, ms, max) {
    var closed = false
    function close() { if (closed) return; closed = true; el.classList.add('out'); setTimeout(function () { el.remove() }, ms) }
    setTimeout(close, max)            // never stuck
    return close
  }

  var kcLoader = {
    splash: function (text) { var el = box('kcSplash', text); mount(el); return closer(el, 350, 12000) },
    busy: function (text) { var el = box('kcBusy' + Date.now(), text, 'kc-busy'); mount(el); return closer(el, 250, 60000) },
    // hearts + a 0-100% bar:  var pr = kcLoader.progress('Posting…'); pr.set(40); pr.done()
    progress: function (text) {
      var el = box('kcProg' + Date.now(), text, 'kc-busy')
      var wrap = document.createElement('div')
      wrap.className = 'kc-prog'
      wrap.innerHTML = '<div class="kc-prog-bar"><i></i></div><span class="kc-prog-n">0%</span>'
      el.insertBefore(wrap, el.querySelector('.kc-dots'))
      mount(el)
      var fill = wrap.querySelector('i'), num = wrap.querySelector('.kc-prog-n'), cur = 0
      var close = closer(el, 300, 900000)
      function set(p) { p = Math.max(cur, Math.min(100, Math.round(p || 0))); cur = p; fill.style.width = p + '%'; num.textContent = p + '%' }
      return { set: set, text: function (t) { var sm = el.querySelector('small'); if (sm) sm.textContent = t }, done: function () { set(100); setTimeout(close, 450) }, close: close }
    },
    inline: function (text) { return '<div class="kc-inline" role="status">' + HEARTS + (text ? '<small>' + esc(text) + '</small>' : '') + '</div>' }
  }
  window.kcLoader = kcLoader
  window.kcBusy = kcLoader.busy                      // old name still works

  // ---- going to another page / back / reload: the hearts show until the next page paints ----
  var navDone = null
  function navStart() {
    if (navDone || document.getElementById('kcNavLoader')) return
    var el = box('kcNavLoader', '', 'kc-busy')
    mount(el)
    navDone = closer(el, 250, 10000)                 // external link / mailto / cancelled leave: never stuck
    var t = setTimeout(function () { navDone = null }, 10300); void t
  }
  function navEnd() { if (navDone) { navDone(); navDone = null } var e = document.getElementById('kcNavLoader'); if (e) e.remove() }
  window.addEventListener('beforeunload', navStart)
  window.addEventListener('pagehide', navStart)
  window.addEventListener('pageshow', navEnd)        // coming back from the back/forward cache
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') navEnd() })

  // ---- pages that do not use page-loader.js (it has its own splash): show the hearts while the page opens ----
  if (!document.querySelector('script[src*="page-loader"]') && document.documentElement.getAttribute('data-kc-splash') !== 'off') {
    var hide = kcLoader.splash('Meet your soulmate')
    var start = Date.now()
    window.addEventListener('load', function () { setTimeout(hide, Math.max(0, 500 - (Date.now() - start))) })
  }
})()
