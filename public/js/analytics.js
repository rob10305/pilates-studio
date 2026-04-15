// Client-side analytics + consent loader.
//
// Two jobs in one file because it's included on every page:
//
// 1. Show a lightweight, dismissible consent banner on first visit so users
//    can accept or decline optional session analytics (Microsoft Clarity).
//    Their choice is persisted in a first-party `rmm-consent` cookie.
//
// 2. Load Microsoft Clarity ONLY when the admin has configured it AND the
//    user has accepted. If no Clarity ID is configured or the user declined,
//    this module is a silent no-op. The admin dashboard is excluded
//    entirely — staff testing the backend shouldn't be session-recorded.
//
// Vercel Web Analytics is installed separately as a static <script> tag in
// every HTML file. It is first-party, cookieless page-view counting; the
// banner below does not gate it because it does not set identifiers.
(function () {
  'use strict';

  var CONSENT_COOKIE = 'rmm-consent';
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 365;   // 1 year
  // Paths where the banner + Clarity never run. Admins don't consent on
  // behalf of visitors, and the dedicated legal pages self-explain policy.
  // Match with or without the .html suffix because some hosts (Vercel clean
  // URLs, nginx try_files, etc.) strip the extension transparently.
  var SKIP_SLUGS = ['admin', 'privacy', 'terms', 'cancellation-policy'];
  var currentSlug = (location.pathname || '/').toLowerCase()
    .replace(/^\/+/, '')        // leading slashes
    .replace(/\/+$/, '')        // trailing slashes (/privacy/ → privacy)
    .replace(/\.html?$/, '');   // .html / .htm suffix
  var isSkipPath = SKIP_SLUGS.indexOf(currentSlug) !== -1;

  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(name, value) {
    // SameSite=Lax + secure-when-HTTPS mirrors the session cookie flags.
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(value)
      + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax' + secure;
  }

  function loadClarity(projectId) {
    if (!projectId || window.clarity) return;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', projectId);
  }

  function maybeLoadAnalytics() {
    if (isSkipPath) return;
    if (readCookie(CONSENT_COOKIE) !== 'accepted') return;
    // Consent is in — fetch public config and install Clarity if an ID is set.
    fetch('/api/public-config', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) { if (cfg && cfg.clarityProjectId) loadClarity(cfg.clarityProjectId); })
      .catch(function () { /* silent — analytics failures never break the page */ });
  }

  function showBanner() {
    if (isSkipPath) return;
    if (readCookie(CONSENT_COOKIE)) return;        // user has already chosen
    if (document.getElementById('rmmConsent')) return;

    var wrap = document.createElement('div');
    wrap.id = 'rmmConsent';
    // Inline styling keeps the banner independent of css/styles.css so it
    // still renders correctly if that stylesheet ever fails to load.
    wrap.style.cssText = [
      'position:fixed',
      'left:12px',
      'right:12px',
      'bottom:12px',
      'z-index:9999',
      'max-width:720px',
      'margin:0 auto',
      'padding:14px 18px',
      'background:#2a2a2a',
      'color:#f5f0e6',
      'border-radius:10px',
      'box-shadow:0 4px 18px rgba(0,0,0,0.25)',
      'font-family:Lato,Arial,sans-serif',
      'font-size:0.92rem',
      'line-height:1.5',
      'display:flex',
      'flex-wrap:wrap',
      'gap:10px 14px',
      'align-items:center',
      'justify-content:space-between'
    ].join(';');
    // On mobile the bottom-nav sits flush to 0; lift the banner above it.
    if (window.innerWidth <= 680) wrap.style.bottom = '76px';

    wrap.innerHTML =
      '<div style="flex:1 1 320px;min-width:240px">' +
        'We use a single session cookie to keep you signed in. ' +
        'With your permission we also use Microsoft Clarity to understand how the site is used — ' +
        'it never records sensitive waiver, health, or password fields. ' +
        'See our <a href="/privacy.html" style="color:#f5c200;text-decoration:underline">Privacy Policy</a>.' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" id="rmmConsentDecline" ' +
          'style="background:transparent;color:#f5f0e6;border:1px solid #f5f0e6;border-radius:20px;padding:6px 16px;font:inherit;cursor:pointer">Decline</button>' +
        '<button type="button" id="rmmConsentAccept" ' +
          'style="background:#B71C22;color:#fff;border:1px solid #B71C22;border-radius:20px;padding:6px 16px;font:inherit;cursor:pointer;font-weight:700">Accept</button>' +
      '</div>';

    document.body.appendChild(wrap);

    document.getElementById('rmmConsentAccept').addEventListener('click', function () {
      writeCookie(CONSENT_COOKIE, 'accepted');
      wrap.parentNode.removeChild(wrap);
      // Load immediately so the current pageview is captured.
      maybeLoadAnalytics();
    });
    document.getElementById('rmmConsentDecline').addEventListener('click', function () {
      writeCookie(CONSENT_COOKIE, 'declined');
      wrap.parentNode.removeChild(wrap);
    });
  }

  // Run after DOM is ready — banner needs <body> to append to, and we want
  // analytics to kick in as soon as the page is interactive.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { showBanner(); maybeLoadAnalytics(); });
  } else {
    showBanner();
    maybeLoadAnalytics();
  }
})();
