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
    } else {
      li.innerHTML = `<a href="login.html">Sign In</a>`;
    }
  } catch (_) {
    li.innerHTML = `<a href="login.html">Sign In</a>`;
  }
})();
