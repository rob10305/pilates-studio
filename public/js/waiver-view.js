// Extracted from the waiver view's inline onclick to keep the CSP free of
// 'unsafe-inline' scripts. The button always exists when this file is served.
document.addEventListener('DOMContentLoaded', function () {
  var btn = document.getElementById('printBtn');
  if (btn) btn.addEventListener('click', function () { window.print(); });
});
