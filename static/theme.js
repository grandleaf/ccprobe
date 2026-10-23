// Runs before first paint: resolve the theme and motion settings so the page never flashes the wrong theme.
(function () {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('ccprobe.settings') || '{}') || {}; } catch (e) { s = {}; }
  var root = document.documentElement;
  var t = s.theme || 'system';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.setAttribute('data-theme', t);
  var m = s.motion || (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full');
  root.setAttribute('data-motion', m);
  if (s.compact) root.setAttribute('data-compact', '1');
})();
