// Agentville Launcher — injected webview script.
// Runs inside the Claude Code panel DOM (appended to webview/index.js by the host
// extension). Wrapped in an IIFE so it never pollutes Claude's globals.
//
// It docks a 🌍 globe button into a SHARED toolbar div (#orb-tools) in the footer
// and, on click, asks the host extension to open the Agentville desktop app via a
// vscode: deep link (a synthesized anchor click — the only webview→host channel a
// sandboxed page is reliably allowed to use). The status-bar item + command
// palette are the guaranteed fallback path if the deep link is blocked.
(function () {
  'use strict';

  // Guard against double-injection in the same document.
  if (window.__AGENTVILLE_ACTIVE__) return;
  window.__AGENTVILLE_ACTIVE__ = true;

  // The URI the host extension's UriHandler listens for. Authority MUST equal the
  // launcher manifest's "<publisher>.<name>" lowercased.
  var OPEN_URI = 'vscode://orbenozio.agentville-launcher/open';

  // Carry the button's DESIRED on/off state so the host can reconcile (the host can't
  // message back into Claude's webview, so the button tells it what it wants: open or close).
  function buildUri() {
    return OPEN_URI + '?on=' + (townOn ? '1' : '0');
  }

  // Footer selectors — same conventions as Nonstop. Never hardcode full hashed
  // class names; always [class*="prefix_"].
  var FOOTER_SEL = '[class*="inputFooter_"]';
  var MODE_BTN_SEL = '[class*="footerButtonPrimary_"]';

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }

  // ── The shared toolbar div (the convention the user asked for) ────────────────
  // All of "my" buttons live in one container: if #orb-tools already exists
  // (created by this or a sibling tool), reuse it; otherwise create it and dock it
  // just to the LEFT of Claude's native mode button, falling back to the footer end.
  // Re-query every call (never cache) — Claude re-renders the footer and detaches it.
  function ensureToolbar() {
    var existing = document.getElementById('orb-tools');
    if (existing && existing.isConnected) return existing;

    var footer = $(FOOTER_SEL);
    if (!footer) return null;

    var bar = existing || document.createElement('div');
    bar.id = 'orb-tools';
    bar.style.cssText = 'display:inline-flex;align-items:center;gap:2px;';

    var modeBtn = footer.querySelector(MODE_BTN_SEL);
    var modeContainer = modeBtn ? modeBtn.parentElement : null;
    if (modeContainer && modeContainer.parentNode) {
      modeContainer.parentNode.insertBefore(bar, modeContainer);
    } else {
      footer.appendChild(bar);
    }
    return bar;
  }

  function ensureStyle() {
    if (document.getElementById('agentville-style')) return;
    var st = document.createElement('style');
    st.id = 'agentville-style';
    st.textContent =
      '#agentville-btn{background:transparent;border:none;cursor:pointer;' +
      'padding:3px 6px;line-height:0;vertical-align:middle;border-radius:6px;' +
      'color:#8a8a8a;opacity:.6;transition:color .15s,opacity .15s,background .15s;}' +
      '#agentville-btn svg{display:block;width:18px;height:18px;}' +
      '#agentville-btn:hover{opacity:1;color:#5bb26a;background:rgba(91,178,106,.16);}' +
      // ON: lit green accent on a subtle green background - overrides the dim base.
      '#agentville-btn.on{opacity:1;color:#5bb26a;background:rgba(91,178,106,.22);}' +
      '#agentville-btn:active{transform:scale(.92);}';
    document.head.appendChild(st);
  }

  // Optimistic "lit" state: the town lives in a separate (host-owned) webview tab, so
  // there is no host->button channel. The button toggles its own lit class in lockstep
  // with the strict open/close toggle on the host. (Caveat: closing the town via its
  // editor tab can't notify the button; the next click re-syncs.)
  var townOn = false;
  function applyLit() {
    var b = document.getElementById('agentville-btn');
    if (b) {
      if (townOn) b.classList.add('on'); else b.classList.remove('on');
      b.setAttribute('aria-pressed', townOn ? 'true' : 'false');
    }
  }

  // Open the app via a synthesized anchor click. The injected button runs inside
  // Claude's webview — which WE don't own (Claude holds acquireVsCodeApi), so there is
  // no postMessage channel to our host. The ONLY way to reach the extension is a
  // vscode: deep link: VSCode intercepts a same-frame <a> click to a non-http scheme
  // and routes it to env.openExternal, which fires our UriHandler -> openPanel (the very
  // method the status-bar item calls).
  //
  // Do NOT set target="_blank": for a vscode: URL it stops the click from reaching
  // openExternal, so nothing opens (the button just toggles its lit state). And do NOT
  // fall back to window.location.href — navigating the top frame to a vscode: URI blanks
  // Claude's webview. The host side (panel.js) is what guards against a broken open; here
  // we only need to deliver the deep link.
  function openAgentville() {
    try {
      var a = document.createElement('a');
      a.href = buildUri();
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} }, 0);
    } catch (e) {
      // No-op: the status-bar item + command palette remain the guaranteed open path.
    }
  }

  function injectButton() {
    if (document.getElementById('agentville-btn')) {
      // Button exists — but make sure it's still docked in the live toolbar.
      var bar0 = ensureToolbar();
      var btn0 = document.getElementById('agentville-btn');
      if (bar0 && btn0 && btn0.parentNode !== bar0) bar0.appendChild(btn0);
      applyLit(); // keep the lit state across Claude's footer re-renders
      return;
    }
    var bar = ensureToolbar();
    if (!bar) return;
    ensureStyle();

    var btn = document.createElement('button');
    btn.id = 'agentville-btn';
    btn.type = 'button';
    btn.title = 'Open Agentville 🏘️ — live town view of your Claude agents';
    btn.setAttribute('aria-label', 'Open Agentville');
    // Inline globe SVG (Material "public"), coloured via currentColor so it renders
    // deterministically in the webview (emoji rendered grey/inconsistently).
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93' +
      'c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54' +
      'c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2' +
      'v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
    btn.setAttribute('aria-pressed', 'false'); // it's a toggle button
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      townOn = !townOn; // optimistic toggle, in lockstep with the host
      applyLit();
      openAgentville();
    });
    bar.appendChild(btn);
    applyLit(); // re-applied on every re-inject so the lit state survives re-renders
  }

  // Boot: re-inject if Claude re-renders the footer (same cadence as Nonstop).
  setInterval(injectButton, 1500);
  injectButton();
})();
