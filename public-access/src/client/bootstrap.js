// Runs in the visitor's browser before Home Assistant's frontend starts.
// 1. Gives the frontend a placeholder login so it never redirects to a login page. The server accepts
//    any token on /api/websocket and forwards nothing with it, so the placeholder authenticates nobody.
// 2. Hides the sidebar and the dashboard header: this is a public display, not the Home Assistant app.
(function () {
  var cfg = __PA_CONFIG__;
  try {
    localStorage.setItem('hassTokens', JSON.stringify({
      access_token: 'public-access-placeholder',
      token_type: 'Bearer',
      expires_in: 1800,
      hassUrl: location.origin,
      clientId: location.origin + '/',
      expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
      refresh_token: 'public-access-placeholder'
    }));
    localStorage.setItem('dockedSidebar', JSON.stringify('always_hidden'));
    // Without this the frontend falls back to its "home" panel, which does not exist here.
    localStorage.setItem('defaultPanel', JSON.stringify('lovelace'));
  } catch (e) { /* storage blocked: the frontend shows its own login page */ }

  if (!cfg.kiosk) return;
  var CSS = cfg.css;
  var styled = new WeakSet();
  // The header lives inside nested shadow roots, so a page stylesheet cannot reach it.
  // Walk the tree and add a stylesheet to the roots that need one.
  function visit(root, depth) {
    if (!root || depth > 12) return;
    var hosts = root.querySelectorAll('*');
    for (var i = 0; i < hosts.length; i++) {
      var el = hosts[i];
      var sr = el.shadowRoot;
      if (!sr) continue;
      var tag = el.localName;
      if ((tag === 'hui-root' || tag === 'ha-panel-lovelace' || tag === 'home-assistant-main' || tag === 'ha-drawer') && !styled.has(sr)) {
        styled.add(sr);
        var s = document.createElement('style');
        s.textContent = CSS;
        sr.appendChild(s);
      }
      visit(sr, depth + 1);
    }
  }
  var scheduled = false;
  function tick() {
    scheduled = false;
    visit(document, 0);
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(tick); } }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  var n = 0;
  var t = setInterval(function () { tick(); if (++n > 120) clearInterval(t); }, 500);
})();
