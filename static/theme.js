// Runs before first paint: resolve the theme and motion settings so the page never flashes the wrong theme.
(function () {
  var s = {};
  try { s = JSON.parse(localStorage.getItem('ccprobe.settings') || '{}') || {}; } catch (e) { s = {}; }
  var root = document.documentElement;
  var t = s.theme || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.setAttribute('data-theme', t);
  var m = s.motion || (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full');
  root.setAttribute('data-motion', m);
  if (s.compact) root.setAttribute('data-compact', '1');
  if (s.sideW > 0) root.style.setProperty('--side-w', Math.min(s.sideW, Math.max(280, innerWidth * 0.6)) + 'px');
  if (s.railW > 0) root.style.setProperty('--rail-w', Math.min(s.railW, Math.max(160, innerWidth * 0.35)) + 'px');
})();
