// Page Editor — client-side content loader.
//
// Swaps any element marked with a data-content-key attribute with the admin-
// configured value from /api/content. If the API is unreachable or the key is
// unset, the default HTML content stays put (graceful fallback).
//
// Text keys  : innerText is replaced verbatim (safe, no HTML injection risk)
// Markdown   : parsed with a tiny markdown→HTML converter and set as innerHTML
// Image keys : <img src="..."> is rewritten, or background-image style is set
//              (for elements carrying data-content-key + data-content-bg="true")
(function () {
  'use strict';

  function mdToHtml(src) {
    if (!src) return '';
    // Escape HTML first so user input can never inject markup
    let s = src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Headings (###, ##, #)
    s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    // Bold + italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    // Inline links [text](url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]*|mailto:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Unordered lists — consecutive lines starting with "- " or "* "
    s = s.replace(/(^(?:[-*]\s+.+(?:\n|$))+)/gm, m => {
      const items = m.trim().split(/\n/).map(l => l.replace(/^[-*]\s+/, '').trim());
      return '<ul>' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
    });
    // Blank-line-separated paragraphs
    s = s.split(/\n{2,}/).map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<(h[1-6]|ul|ol|li|p|div|blockquote)/.test(trimmed)) return trimmed;
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return s;
  }

  function applyContent(map) {
    document.querySelectorAll('[data-content-key]').forEach(el => {
      const key = el.getAttribute('data-content-key');
      const entry = map[key];
      if (!entry || !entry.value) return;   // leave default HTML
      // If this element was deliberately hidden pending content, reveal it now
      if (el.style.display === 'none') el.style.display = '';
      if (entry.type === 'image') {
        const url = entry.value + (entry.value.includes('?') ? '' : '?t=' + Date.now());
        if (el.getAttribute('data-content-bg') === 'true') {
          el.style.backgroundImage = `url("${url}")`;
        } else if (el.tagName === 'IMG') {
          el.src = url;
        } else {
          el.style.backgroundImage = `url("${url}")`;
        }
      } else if (entry.type === 'markdown') {
        el.innerHTML = mdToHtml(entry.value);
      } else {
        // text — HTML-escape the stored value so no markup can inject, then
        // preserve newlines as <br> so multi-line fields like headlines work
        const escaped = entry.value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        el.innerHTML = escaped.replace(/\n/g, '<br>');
      }
    });
  }

  fetch('/api/content', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : {})
    .then(applyContent)
    .catch(() => { /* silent — defaults stay in place */ });
})();
