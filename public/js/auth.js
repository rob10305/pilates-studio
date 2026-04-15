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
        // Add Admin link to mobile bottom-nav
        const bottomNav = document.querySelector('.bottom-nav');
        if (bottomNav) {
          const adminLink = document.createElement('a');
          adminLink.href = 'admin.html';
          adminLink.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>' +
            'Admin';
          if (window.location.pathname.includes('admin.html')) adminLink.classList.add('active');
          bottomNav.appendChild(adminLink);
        }
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

// ── FAQ section — injected above footer on every page ──
(function () {
  var footer = document.querySelector('footer');
  if (!footer) return;
  // Skip admin page
  if (window.location.pathname.includes('admin.html')) return;
  var faqs = [
    { q: 'Do I need to bring my own mat?', a: 'Yes! Please bring your own pilates mat to every class. If you forget, let us know and we\'ll do our best to help.' },
    { q: 'What should I wear?', a: 'Comfortable clothing you can move freely in — think leggings, fitted tops, and grip socks (optional but recommended).' },
    { q: 'I\'m a complete beginner — is that okay?', a: 'Absolutely. Our classes are designed to be welcoming and suitable for all levels. Your instructor will offer modifications throughout.' },
    { q: 'How do I cancel or reschedule?', a: 'You can cancel from your <a href="my-schedule.html" style="color:var(--red)">My Account</a> page or via the link in your confirmation email. Cancellations more than 24 hours before class are fully refundable.' },
    { q: 'Where is the studio located?', a: '43 Main Street South, Suite 2B, Campbellville, ON, inside Glow By Nelly. Ample free parking available.' },
  ];
  var faqHtml = '<section class="faq-section">' +
    '<h2 style="font-family:\'Playfair Display\',Georgia,serif;font-size:1.6rem;text-align:center;margin-bottom:2rem;color:var(--charcoal)">Frequently Asked Questions</h2>' +
    '<div class="faq-list">' +
    faqs.map(function (f, i) {
      return '<details class="faq-item">' +
        '<summary class="faq-q">' + f.q + '</summary>' +
        '<p class="faq-a">' + f.a + '</p>' +
        '</details>';
    }).join('') +
    '</div></section>';
  footer.insertAdjacentHTML('beforebegin', faqHtml);
})();
