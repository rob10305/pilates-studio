// Shared helper — mirrors server.js `safeReturnTo`. Rejects absolute URLs,
// protocol-relative URLs, and Windows paths so `?returnTo=https://evil.com`
// can't be used as an open redirect after login/signup/waiver flows.
// Always returns a same-origin path.
window.safeReturnTo = function (raw, fallback) {
  var DEFAULT = fallback || '/my-schedule.html';
  if (typeof raw !== 'string' || !raw) return DEFAULT;
  var v = raw.trim();
  if (!v) return DEFAULT;
  // Block anything that could escape the current origin.
  if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) return DEFAULT;   // http:, https:, javascript:, data:, etc.
  if (v.startsWith('//') || v.startsWith('\\')) return DEFAULT;
  // Normalise to a leading slash without losing legitimate query strings.
  return v.startsWith('/') ? v : '/' + v;
};

// Shared auth state — included on every page.
// Fills <li id="authNav"> with Sign In link or user greeting + Sign Out.
(async function () {
  const li = document.getElementById('authNav');
  if (!li) return;

  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  try {
    const res = await fetch('/auth/me');
    if (res.ok) {
      const { user } = await res.json();
      li.innerHTML = `
        <span class="nav-user-name">Hi, ${esc(user.firstName)}</span>
        <a href="#" id="signOutLink" class="nav-signout">Sign Out</a>
      `;
      document.getElementById('signOutLink').addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/auth/logout', { method: 'POST' });
        window.location.reload();
      });
      const mySchedNav = document.getElementById('myScheduleNav');
      if (mySchedNav) mySchedNav.style.display = 'list-item';
      if (user.isAdmin) {
        const adminNav = document.getElementById('adminNav');
        if (adminNav) adminNav.style.display = 'list-item';
      }
    } else {
      li.innerHTML = `<a href="login.html">Sign In</a>`;
    }
  } catch (_) {
    li.innerHTML = `<a href="login.html">Sign In</a>`;
  }
})();

// ── Mobile: auto-hide top nav on scroll down, show on scroll up ──
(function () {
  if (window.innerWidth > 680) return;
  const nav = document.querySelector('nav');
  if (!nav) return;
  let lastY = window.scrollY;
  let ticking = false;

  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      const y = window.scrollY;
      // Only hide after scrolling past the nav height
      if (y > 70 && y > lastY) {
        nav.classList.add('nav-hidden');
        // Close hamburger menu if open
        const toggle = document.getElementById('navToggle');
        const links = document.getElementById('navLinks');
        if (toggle) toggle.classList.remove('open');
        if (links) links.classList.remove('open');
      } else {
        nav.classList.remove('nav-hidden');
      }
      lastY = y;
      ticking = false;
    });
  }, { passive: true });
})();
