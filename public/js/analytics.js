// Client-side analytics loader.
// Fetches /api/public-config once per page load and conditionally installs
// Microsoft Clarity (session replays + heatmaps) when an admin has set a
// Clarity Project ID in the admin Settings view. If no ID is configured,
// this file is a no-op.
//
// Vercel Web Analytics is installed separately as a static <script> tag in
// every HTML file because it's a zero-config tracker enabled in the Vercel
// dashboard — no runtime config needed.
(function () {
  'use strict';

  function loadClarity(projectId) {
    if (!projectId || window.clarity) return;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', projectId);
  }

  // Non-blocking fetch — page rendering never waits on this
  fetch('/api/public-config', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (cfg && cfg.clarityProjectId) loadClarity(cfg.clarityProjectId);
    })
    .catch(function () { /* silent — analytics failures never break the page */ });
})();
