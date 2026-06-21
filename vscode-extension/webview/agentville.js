// Agentville Launcher — injected webview script.
// Runs inside the Claude Code panel DOM (appended to webview/index.js by the host
// extension). Wrapped in an IIFE so it never pollutes Claude's globals.
//
// It docks a 🌍 globe button into a SHARED toolbar div (#orb-tools) in the footer.
// The button is a REAL <a href="vscode://…"> link: a genuine user click on it is
// intercepted by VSCode's built-in webview link handler and routed to env.openExternal
// -> our UriHandler -> openPanel (the same method the status-bar item uses). The link
// MUST be a real element clicked by the user — a *synthesized* a.click() arrives with
// event.view === null, so VSCode's handler bails and the sandboxed frame self-navigates
// to the vscode: URI, blanking Claude's chat. The status-bar item + command palette are
// the guaranteed fallback.
(function () {
  'use strict';

  // Guard against double-injection in the same document.
  if (window.__AGENTVILLE_ACTIVE__) return;
  window.__AGENTVILLE_ACTIVE__ = true;

  // The URI the host extension's UriHandler listens for. Authority MUST equal the
  // launcher manifest's "<publisher>.<name>" lowercased.
  var OPEN_URI = 'vscode://orbenozio.agentville-launcher/open';

  // Carry the button's DESIRED on/off state so the host can reconcile (the host can't
  // message back into Claude's webview, so the link tells it what it wants: open or close).
  function uriFor(desiredOn) {
    return OPEN_URI + '?on=' + (desiredOn ? '1' : '0');
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
      '#agentville-btn{display:inline-flex;align-items:center;background:transparent;border:none;cursor:pointer;' +
      'padding:3px 6px;line-height:0;vertical-align:middle;border-radius:6px;text-decoration:none;' +
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

  // Point the link at the action THIS activation should request: open when the town is
  // off, close when it's on. Set on pointer/key DOWN — i.e. BEFORE the click — so VSCode's
  // link interceptor reads the right URI. Critically, this is NOT done from applyLit (which
  // runs inside the click handler, before VSCode reads href): doing so rewrote href to the
  // NEXT click's value and made every open/close land one click late.
  function aimHref() {
    var b = document.getElementById('agentville-btn');
    if (b) b.setAttribute('href', uriFor(!townOn));
  }


  function injectButton() {
    if (document.getElementById('agentville-btn')) {
      // Button exists — but make sure it's still docked in the live toolbar.
      var bar0 = ensureToolbar();
      var btn0 = document.getElementById('agentville-btn');
      if (bar0 && btn0 && btn0.parentNode !== bar0) bar0.appendChild(btn0);
      applyLit(); // keep the lit state + href across Claude's footer re-renders
      return;
    }
    var bar = ensureToolbar();
    if (!bar) return;
    ensureStyle();

    // A REAL anchor — VSCode intercepts a genuine click on it and opens the vscode: URI
    // via openExternal, without the sandboxed frame ever navigating. (A <button> +
    // synthesized a.click() does NOT get intercepted and blanks the chat — see header.)
    var btn = document.createElement('a');
    btn.id = 'agentville-btn';
    btn.setAttribute('role', 'button');
    btn.href = uriFor(!townOn); // off -> next click opens (on=1)
    btn.title = 'Open Agentville 🏘️ — live town view of your Claude agents';
    btn.setAttribute('aria-label', 'Open Agentville');
    // Inline globe SVG (Material "public"), coloured via currentColor so it renders
    // deterministically in the webview (emoji rendered grey/inconsistently).
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93' +
      'c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54' +
      'c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2' +
      'v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
    btn.setAttribute('aria-pressed', 'false'); // it's a toggle

    // Aim the href at THIS activation's desired state on pointer/key DOWN (fires before
    // click, so VSCode reads the right URI), and keep the composer focused. Do NOT
    // preventDefault or stopPropagation on the click itself — VSCode's handler must
    // receive it to open the link instead of letting the sandboxed frame self-navigate.
    btn.addEventListener('mousedown', function (e) {
      e.preventDefault(); // keep the message composer focused
      aimHref();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') aimHref();
    });
    btn.addEventListener('click', function () {
      townOn = !townOn; // optimistic toggle, in lockstep with the host
      applyLit();       // lit class only — must NOT touch href (VSCode may read it after)
      // no preventDefault: let VSCode open the href via env.openExternal
    });
    bar.appendChild(btn);
    applyLit(); // re-applied on every re-inject so the lit state survives re-renders
  }

  // Boot: re-inject if Claude re-renders the footer (same cadence as Nonstop).
  setInterval(injectButton, 1500);
  injectButton();
})();
