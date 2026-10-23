'use strict';
// ccprobe page: draws the model the server streams (DESIGN.md §9). Read-only; all state is in memory or localStorage.

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (t, sec) => t ? new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined }) : '—';
const dur = s => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d`; };
const ago = (t, now) => !t ? '—' : (now - t < 45 ? 'just now' : dur(now - t) + ' ago');
const kfmt = n => n >= 1e6 ? parseFloat((n / 1e6).toFixed(2)) + 'M' : Math.round(n / 1e3) + 'k';
const modelName = m => (m || '').replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase());
const clip = (s, n) => { s = String(s ?? ''); if (s.length <= n) return s; let c = s.slice(0, n - 1); const sp = c.lastIndexOf(' '); if (sp > n * .6) c = c.slice(0, sp); return c.trimEnd() + '…'; };

// ---- status vocabulary: one mapping, icons from the sprite (no emoji in the UI chrome) ----
const STATUS = {
  running: ['i-run', 'green'], thinking: ['i-think', 'cyan'], polling: ['i-wait', 'slate'], waiting_window: ['i-park', 'amber'],
  ended: ['i-done', 'slate'], ended_bg: ['i-wait', 'slate'], stuck: ['i-stuck', 'amber'], dead: ['i-dead', 'red'],
  waiting_user: ['i-ask', 'rose'], idle: ['i-done', 'slate'], shell: ['i-wait', 'slate'], unknown: ['i-wait', 'slate'], parked: ['i-park', 'amber'],
};
const ROWKIND = {
  active: ['i-run', 'green'], queued: ['i-wait', 'slate'], paused: ['i-park', 'amber'], parked: ['i-park', 'amber'],
  asks: ['i-ask', 'rose'], done: ['i-done', 'green'], closed: ['i-done', 'slate'], other: ['i-wait', 'slate'],
};
// the hotter the colour, the higher the priority: HP rose, MP amber, LP green
const ROLECOL = { lead: 'cyan', worker: 'rose', mp: 'amber', lp: 'green', helper: 'violet' };
const TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write', 'SendMessage', 'Agent']);
const toolCls = t => TOOLS.has(t) ? t : (t === 'MultiEdit' || t === 'NotebookEdit' ? 'Edit' : 'other');
const icon = (id, cls = 'ico12') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

// ---- settings (localStorage, every access guarded) ----
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window: settings last for this visit */ } },
};
const reducedOS = matchMedia('(prefers-reduced-motion: reduce)').matches;
const settings = Object.assign({ v: 1, theme: 'system', motion: reducedOS ? 'reduced' : 'full', span: 2700, showFinished: true, compact: false, notify: false, railSort: 'attn' },
  store.get('ccprobe.settings', {}));
const saveSettings = () => store.set('ccprobe.settings', settings);
let dismissed = store.get('ccprobe.dismissed', {});    // alert key+title -> until (epoch s; 1e12 = for good)
let hidden = store.get('ccprobe.hidden', {});          // agent id -> server time the user hid it from the diagram

// ---- page state ----
const S = {
  model: null, sid: store.get('ccprobe.sid', null), sel: 'lead', tab: 'agent', lastMsgAt: 0, conn: 'connecting',
  seen: new Set(), first: true, prevState: new Map(), userPanned: false, vb: null, fitVb: null, away: 0,
  notified: new Set(), expandFinished: false, nodes: new Map(), edges: new Map(), cards: new Map(), res: new Map(),
  pos: new Map(), order: [], pulses: [], raf: 0, panelHtml: '', authFailed: false,
};

function applyTheme() {
  let t = settings.theme;
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.setAttribute('data-motion', settings.motion);
  document.documentElement.toggleAttribute('data-compact', !!settings.compact);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => settings.theme === 'system' && applyTheme());

// ---- svg helpers ----
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function setA(e, attrs) { for (const k in attrs) { const v = String(attrs[k]); if (e.getAttribute(k) !== v) e.setAttribute(k, v); } }
function setT(e, t) { t = String(t ?? ''); if (e.textContent !== t) e.textContent = t; }
const hexPts = r => Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 180 * (60 * k - 90); return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const measureCtx = document.createElement('canvas').getContext('2d');
const MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';
function textW(s, size = 11.5) { measureCtx.font = `${size}px ${MONO}`; return measureCtx.measureText(String(s)).width; }
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- connection: SSE, falling back to polling ----
let es = null, errs = 0, pollTimer = 0;
function connect() {
  try { es = new EventSource('/api/events'); } catch (e) { return startPolling(); }
  es.onmessage = e => { errs = 0; S.lastMsgAt = Date.now(); setConn('live'); try { onModel(JSON.parse(e.data)); } catch (x) { console.error(x); } };
  es.addEventListener('ping', e => {
    errs = 0; S.lastMsgAt = Date.now(); if (S.conn !== 'live') setConn('live');
    const t = parseFloat(e.data);
    if (S.model && t > S.model.now) { S.model.now = t; render(); }
  });
  es.onerror = () => {
    errs++;
    if (errs >= 3) { es.close(); es = null; checkAuthThenPoll(); }
  };
}
async function checkAuthThenPoll() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.status === 401) { S.authFailed = true; setConn('down'); return showEmpty('Not signed in: open the URL the ccprobe server printed (it carries the access token).'); }
  } catch (e) { /* server down: keep trying below */ }
  startPolling();
}
function startPolling() {
  clearTimeout(pollTimer);
  const tick = async () => {
    if (es && es.readyState === EventSource.OPEN) return;    // the stream is back: it takes over
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.status === 401) { S.authFailed = true; setConn('down'); return showEmpty('Not signed in: open the URL the ccprobe server printed.'); }
      const m = await r.json();
      S.lastMsgAt = Date.now(); setConn('live');
      if (!m.loading) onModel(m);
      if (!es && Date.now() % 5 < 1) connect();    // now and then, try the stream again
    } catch (e) { setConn('down'); }
    pollTimer = setTimeout(tick, 2000);
  };
  tick();
}
function setConn(c) { S.conn = c; updateConnPill(); }
function updateConnPill() {
  const age = (Date.now() - S.lastMsgAt) / 1000;
  let st = S.conn, txt;
  if (st === 'live' && age > 8) st = 'stale';
  if (st === 'connecting') txt = 'Connecting…';
  else if (st === 'live') txt = 'Live';
  else if (st === 'stale') txt = `Stale · ${Math.round(age)}s`;
  else txt = S.authFailed ? 'Not signed in' : 'Server unreachable · retrying';
  $('conn').dataset.state = st;
  setT($('connText'), txt);
  $('stage').classList.toggle('dimmed', st === 'down' && !!S.model);
  if (S.model) $('popFoot').textContent = `ccprobe ${S.model.server.version} · ${location.host} · tick ${S.model.server.tick_ms} ms · ${st}`;
}
setInterval(updateConnPill, 1000);

// ---- a new model ----
function onModel(m) {
  S.model = m;
  const ss = m.sessions || [];
  if (!ss.find(s => s.id === S.sid)) {
    const pick = ss.find(s => s.wts && s.status === 'busy') || ss.find(s => s.status === 'busy') || ss[0];
    S.sid = pick ? pick.id : null;
    S.sel = 'lead'; S.userPanned = false;
    clearGraph();   // a different graph: cut, never morph
  }
  // new messages become pulses (never the backlog on first load, never while the tab is hidden)
  const fresh = [];
  for (const x of ss) for (const msg of x.messages || []) {
    if (S.seen.has(msg.id)) continue;
    S.seen.add(msg.id);
    if (!S.first && x.id === S.sid && m.now - msg.t < 60) {
      if (document.hidden) S.away++; else fresh.push(msg);
    }
  }
  notify(m);
  render();               // first, so the edges of new agents and new pairs exist for their pulses
  fresh.forEach(queuePulse);
  S.first = false;
}
const cur = () => (S.model?.sessions || []).find(s => s.id === S.sid) || null;

function render() {
  const m = S.model, s = cur();
  renderHeader(m, s);
  renderRail(m);
  if (!m || !(m.sessions || []).length) {
    showEmpty(m ? 'No Claude Code sessions running. Start `claude` (in tmux to see its pane) and it appears here.' : 'Connecting to the ccprobe server…');
    clearGraph();
  } else if (s && s.error) {
    showEmpty(`This session could not be read: ${s.error}`);
    clearGraph();
  } else {
    $('empty').hidden = true;
    renderGraph(s);
  }
  renderPanel();
  renderTimeline(s);
}
function showEmpty(text) { $('empty').hidden = false; setT($('emptyText'), text); }

// ---- header ----
function renderHeader(m, s) {
  const w = s && s.wts && !s.wts.error ? s.wts : null;
  let h = '';
  if (w) {
    const win = w.window || {};
    h += win.held
      ? `<span class="chip win held c-red" data-tip="${esc('Window held by ' + win.who)}">${icon('i-lock')}<span>Window: ${esc(shortWho(win.who))} · ${dur(m.now - (win.since || m.now))}</span></span>`
      : `<span class="chip win c-green">${icon('i-unlock')}<span>Window free</span></span>`;
    const hp = w.hp_line || '';
    const [hi, hc] = /running/.test(hp) ? ['i-run', 'green'] : /PAUSED/i.test(hp) ? ['i-park', 'amber'] : /stopped/.test(hp) ? ['i-dead', 'slate'] : ['i-wait', 'slate'];
    h += `<span class="chip c-${hc}">${icon(hi)}HP ${esc(hp.replace(/^[^\w]+/, ''))}</span>`;
    for (const g of ['MP', 'LP']) {
      const mode = (w.modes || {})[g] || 'running';
      const [i, c] = mode === 'running' ? ['i-run', 'green'] : mode === 'desk' ? ['i-park', 'slate'] : ['i-park', 'amber'];
      h += `<span class="chip c-${c}">${icon(i)}${g} ${mode === 'desk' ? 'desk-only' : esc(mode)}</span>`;
    }
    h += `<span class="chip c-${w.caffeinate ? 'green' : 'amber'}" data-tip="caffeinate keeps the Mac awake">${icon('i-cup')}${w.caffeinate ? 'awake' : 'may sleep'}</span>`;
  }
  if ($('chips').innerHTML !== h) $('chips').innerHTML = h;
  const live = liveAlerts(m);
  const n = live.length, red = live.some(a => a.sev === 'red');
  for (const [id, cls] of [['alertCount', 'count'], ['tabCount', 'tcount']]) {
    const e = $(id); e.hidden = !n; e.textContent = n; e.className = cls + (red ? ' red' : '');
  }
  document.title = (n ? `(${n}) ` : '') + 'ccprobe';
}
const shortWho = who => String(who || '').replace(/\s+\w{3} \w{3}\s+\d+ [\d:]+ \w{3,4} \d{4}$/, '').replace(/\s+\w{3} \w{3}\s+\d+ /, ' ');

// ---- rail: the sessions, sorted four ways; in Custom the cards are dragged into place (iOS style) ----
let railOrder = store.get('ccprobe.railOrder', { v: 1, keys: [] });   // Custom: session keys (cwd) in the user's order
const railCards = new Map();      // session key -> its card
const RAIL_EASE = 'cubic-bezier(.2,.8,.2,1)';
Object.assign(S, { railShown: [], railOrderAt: 0, railHold: false, railMode: null, railForce: false, railDrag: null, railDirty: false });

const byAZ = (a, b) => a.project.localeCompare(b.project, undefined, { numeric: true, sensitivity: 'base' })
  || (a.cwd || '').localeCompare(b.cwd || '') || (a.started || 0) - (b.started || 0) || a.id.localeCompare(b.id);
const activity = s => Math.max(s.lead?.last_ts || 0, s.status_since || 0, ...(s.agents || []).map(a => a.last_ts || 0));
// a session's lasting identity: its directory (ids change on restart, project names can repeat); a second live
// session in the same directory, by start time, is "cwd#2"
function railEntries(ss) {
  const seen = new Map();
  return ss.slice().sort((a, b) => (a.started || 0) - (b.started || 0)).map(s => {
    const n = (seen.get(s.cwd) || 0) + 1; seen.set(s.cwd, n);
    return { s, key: n > 1 ? `${s.cwd}#${n}` : (s.cwd || s.id) };
  });
}
function sortRail(list, m, alerts) {
  const prev = new Map(S.railShown.map((k, i) => [k, i]));
  const recent = (x, y) => Math.floor(activity(y.s) / 30) - Math.floor(activity(x.s) / 30)
    || (prev.get(x.key) ?? 1e9) - (prev.get(y.key) ?? 1e9) || byAZ(x.s, y.s);   // 30 s buckets: busy pairs do not swap every tick
  const mode = settings.railSort;
  if (mode === 'az') return list.slice().sort((x, y) => byAZ(x.s, y.s));
  if (mode === 'recent') return list.slice().sort(recent);
  if (mode === 'custom') return customOrder(list);
  const rank = s => {
    const mine = alerts.filter(a => a.session === s.id);
    const st = s.lead?.state || {};
    if (!s.alive || s.error) return 4;
    if (mine.some(a => a.sev === 'red') || st.key === 'waiting_user') return 0;   // a question or plan for you
    if (mine.some(a => a.sev === 'amber')) return 1;
    return BUSY.includes(st.key) || s.status === 'busy' ? 2 : 3;
  };
  const r = new Map(list.map(x => [x.key, rank(x.s)]));
  return list.slice().sort((x, y) => r.get(x.key) - r.get(y.key) || recent(x, y));
}
// Custom: the saved order, with sessions it has never seen slotted in by A–Z (after their A–Z predecessor, else
// before their successor); with nothing saved it is A–Z
function customOrder(list) {
  const az = list.slice().sort((x, y) => byAZ(x.s, y.s));
  const at = new Map(list.map(x => [x.key, x]));
  const out = railOrder.keys.filter(k => at.has(k)).map(k => at.get(k));
  const placed = new Set(out.map(x => x.key));
  az.forEach((x, i) => {
    if (placed.has(x.key)) return;
    let j = -1;
    for (let p = i - 1; p >= 0 && j < 0; p--) if (placed.has(az[p].key)) j = out.findIndex(o => o.key === az[p].key) + 1;
    for (let q = i + 1; q < az.length && j < 0; q++) if (placed.has(az[q].key)) j = out.findIndex(o => o.key === az[q].key);
    out.splice(j < 0 ? out.length : j, 0, x); placed.add(x.key);
  });
  return out;
}
// saved only on a move by the user: the visible order, with sessions not running now kept after the key they followed
function saveCustom(keys) {
  const out = keys.slice(), vis = new Set(keys), old = railOrder.keys;
  old.forEach((k, i) => {
    if (vis.has(k)) return;
    const after = old.slice(0, i).reverse().find(p => out.includes(p));
    out.splice(after ? out.indexOf(after) + 1 : out.length, 0, k);
  });
  while (out.length > 100) { const i = out.findIndex(k => !vis.has(k)); if (i < 0) break; out.splice(i, 1); }
  railOrder = { v: 1, keys: out }; store.set('ccprobe.railOrder', railOrder);
}
function cardHtml(s, alerts, now) {
  const na = (s.agents || []).filter(a => !a.finished).length;
  const nal = alerts.filter(a => a.session === s.id && a.sev !== 'info').length;
  const st = s.alive ? s.status : 'dead';
  return `<div class="n"><span class="st ${esc(st)}"></span><span class="nm">${esc(s.project)}</span>${nal ? `<span class="b alert">${nal}</span>` : na ? `<span class="b">${na} agent${na > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="m">${esc(s.lead?.state?.label || st)} · ${ago(s.lead?.state?.since || s.status_since, now)}</div>
      <div class="m">${s.tmux ? 'tmux ' + esc(s.tmux.session) + ':' + esc(s.tmux.pane) : 'not in tmux'} · v${esc(s.version)}</div>`;
}
function renderRail(m) {
  const ss = m?.sessions || [];
  const alerts = liveAlerts(m);
  const nt = ss.filter(s => s.tmux).length;
  setT($('railCount'), `${ss.length} session${ss.length === 1 ? '' : 's'}`);
  $('railCount').dataset.tip = `${ss.length} session${ss.length === 1 ? '' : 's'} · ${nt} in tmux`;
  $('rail').classList.toggle('custom', settings.railSort === 'custom');
  const list = railEntries(ss);
  for (const { s, key } of list) {          // contents: every tick, each card only when its text changed
    let b = railCards.get(key);
    if (!b) { b = document.createElement('button'); b.className = 'sess'; b.setAttribute('role', 'listitem'); b.dataset.key = key; railCards.set(key, b); }
    const h = cardHtml(s, alerts, m.now);
    if (b._html !== h) { b.innerHTML = h; b._html = h; }
    b.dataset.sid = s.id; b.classList.toggle('on', s.id === S.sid);
    b.setAttribute('aria-label', `${s.project}, ${s.lead?.state?.label || s.status}`);
  }
  if (S.railDrag) { S.railDirty = true; return; }   // never reorder under a card being dragged
  const keys = new Set(list.map(x => x.key));
  for (const [k, b] of railCards) if (!keys.has(k)) { b.remove(); railCards.delete(k); }
  const want = sortRail(list, m, alerts).map(x => x.key);
  const dom = [...$('railList').children].map(b => b.dataset.key);
  const fresh = want.some(k => !railCards.get(k).isConnected);
  if (!fresh && want.join('\n') === dom.join('\n')) { S.railMode = settings.railSort; return; }
  const force = S.railForce || S.railMode !== settings.railSort;
  // live reorders wait: at most one every 4 s, and none while the pointer or focus is in the rail
  if (!force && !fresh && (S.railHold || performance.now() - S.railOrderAt < 4000)) return;
  applyRailOrder(want, dom.length > 0 && (force || settings.motion === 'full'));
  S.railMode = settings.railSort; S.railForce = false;
}
// FLIP: read every card, move the nodes, read again, then slide each from where it was
function applyRailOrder(keys, animate) {
  const listEl = $('railList');
  animate = animate && settings.motion !== 'off' && !document.hidden;
  const first = new Map();
  if (animate) for (const b of listEl.children) first.set(b.dataset.key, b.getBoundingClientRect());
  const focused = document.activeElement;
  keys.forEach((k, i) => { const b = railCards.get(k); if (listEl.children[i] !== b) listEl.insertBefore(b, listEl.children[i] || null); });
  if (focused && focused !== document.activeElement && listEl.contains(focused)) focused.focus();
  S.railShown = keys; S.railOrderAt = performance.now();
  if (!animate) return;
  const last = keys.map(k => [railCards.get(k), railCards.get(k).getBoundingClientRect(), first.get(k)]);
  const moved = [];
  for (const [b, l, f] of last) {
    if (!f) { b.classList.add('enter'); setTimeout(() => b.classList.remove('enter'), 250); continue; }
    const dx = f.left - l.left, dy = f.top - l.top;
    if (dx || dy) { b.style.transition = 'none'; b.style.translate = `${dx}px ${dy}px`; moved.push(b); }
  }
  if (!moved.length) return;
  void listEl.offsetHeight;
  const ms = settings.motion === 'full' ? 260 : 0;
  for (const b of moved) { b.style.transition = ms ? `translate ${ms}ms ${RAIL_EASE}` : 'none'; b.style.translate = ''; }
  setTimeout(() => moved.forEach(b => { b.style.transition = ''; }), ms + 50);
}
const railHold = on => {
  S.railHold = on;
  clearTimeout(S.railHoldTimer);
  if (!on) S.railHoldTimer = setTimeout(() => S.model && renderRail(S.model), 600);
};
$('rail').addEventListener('pointerenter', () => railHold(true));
$('rail').addEventListener('pointerleave', () => railHold($('rail').contains(document.activeElement)));
$('rail').addEventListener('focusin', () => railHold(true));
$('rail').addEventListener('focusout', e => { if (!$('rail').contains(e.relatedTarget)) railHold($('rail').matches(':hover')); });

$('railList').addEventListener('click', e => {
  const b = e.target.closest('.sess'); if (!b) return;
  selectSession(b.dataset.sid);
});

// ---- rail: drag to reorder (Custom only); the DOM stays put until the drop, the other cards slide aside ----
let railPress = null;
const railAxis = () => { const cs = getComputedStyle($('railList')); return cs.display.includes('flex') && cs.flexDirection === 'row' ? 'x' : 'y'; };   // the strip under 1100 px
const railTr = (axis, v) => v ? (axis === 'y' ? `0 ${v}px` : `${v}px 0`) : '';
$('railList').addEventListener('pointerdown', ev => {
  if (settings.railSort !== 'custom' || ev.button !== 0 || ev.pointerType === 'touch') return;
  const b = ev.target.closest('.sess');
  if (b) railPress = { b, id: ev.pointerId, x: ev.clientX, y: ev.clientY };
});
addEventListener('pointermove', ev => {
  if (S.railDrag) { S.railDrag.last = ev; railDragMove(); return; }
  if (railPress && ev.pointerId === railPress.id && Math.hypot(ev.clientX - railPress.x, ev.clientY - railPress.y) > 5) railDragStart(ev);
});
addEventListener('pointerup', () => { railPress = null; if (S.railDrag) railDragEnd(true); });
addEventListener('pointercancel', () => { railPress = null; if (S.railDrag) railDragEnd(false); });
addEventListener('blur', () => { if (S.railDrag) railDragEnd(false); });

function railDragStart(ev) {
  const b = railPress.b; railPress = null;
  const listEl = $('railList'), sc = $('rail'), axis = railAxis();
  const cards = [...listEl.children], from = cards.indexOf(b);
  const lo = axis === 'y' ? 'top' : 'left', hi = axis === 'y' ? 'bottom' : 'right';
  const scroll = () => axis === 'y' ? sc.scrollTop : sc.scrollLeft;
  const rects = cards.map(c => c.getBoundingClientRect());
  const s0 = scroll();
  const lows = rects.map(r => r[lo] + s0), highs = rects.map(r => r[hi] + s0);   // in content coordinates
  const gap = cards.length > 1 ? (from + 1 < cards.length ? lows[from + 1] - highs[from] : lows[from] - highs[from - 1]) : 0;
  const step = highs[from] - lows[from] + gap;
  S.railDrag = { b, cards, from, to: from, axis, lows, highs, step, start: axis === 'y' ? ev.clientY : ev.clientX, s0, scroll, last: ev, v: 0 };
  hideTip(); document.body.classList.add('sorting');
  const full = settings.motion === 'full';
  b.style.transition = full ? 'scale .15s, box-shadow .15s' : 'none';
  b.classList.add('lifted');
  for (const c of cards) if (c !== b) c.style.transition = full ? `translate 200ms ${RAIL_EASE}` : 'none';
  railDragMove();
}
function railDragMove() {
  const d = S.railDrag, sc = $('rail');
  const pos = d.axis === 'y' ? d.last.clientY : d.last.clientX;
  const n = d.cards.length, half = (d.highs[d.from] - d.lows[d.from]) / 2;
  let delta = pos - d.start + d.scroll() - d.s0;
  delta = Math.max(d.lows[0] - d.lows[d.from] - half, Math.min(d.highs[n - 1] - d.highs[d.from] + half, delta));
  d.b.style.translate = railTr(d.axis, delta);
  const mid = (d.lows[d.from] + d.highs[d.from]) / 2 + delta;
  let to = 0;
  for (let i = 0; i < n; i++) if (i !== d.from && (d.lows[i] + d.highs[i]) / 2 < mid) to++;
  if (to !== d.to) {
    d.to = to;
    d.cards.forEach((c, i) => {
      if (i === d.from) return;
      const shift = d.from < i && i <= to ? -d.step : to <= i && i < d.from ? d.step : 0;
      c.style.translate = railTr(d.axis, shift);
    });
  }
  // autoscroll near the ends (below the sticky header), faster the deeper in
  const r = sc.getBoundingClientRect(), head = d.axis === 'y' ? sc.querySelector('.rail-h').getBoundingClientRect().height : sc.querySelector('.rail-h').getBoundingClientRect().width;
  const a = (d.axis === 'y' ? r.top : r.left) + head, z = d.axis === 'y' ? r.bottom : r.right;
  d.v = pos < a + 32 ? -Math.min(12, (a + 32 - pos) / 32 * 12) : pos > z - 32 ? Math.min(12, (pos - z + 32) / 32 * 12) : 0;
  if (d.v && !d.raf) d.raf = requestAnimationFrame(function tick() {
    d.raf = 0;
    if (S.railDrag !== d || !d.v) return;
    if (d.axis === 'y') sc.scrollTop += d.v; else sc.scrollLeft += d.v;
    railDragMove();
  });
}
function railDragEnd(commit) {
  const d = S.railDrag; if (!d || d.ending) return;
  d.ending = true; d.v = 0;
  const to = commit ? d.to : d.from;
  const slot = to > d.from ? d.highs[to] - d.highs[d.from] : d.lows[to] - d.lows[d.from];
  const ms = settings.motion === 'full' ? 180 : 0;
  d.b.style.transition = ms ? `translate ${ms}ms ${RAIL_EASE}, scale ${ms}ms, box-shadow ${ms}ms` : 'none';
  d.b.style.translate = railTr(d.axis, slot);
  d.b.classList.remove('lifted');
  if (!commit) for (const c of d.cards) if (c !== d.b) c.style.translate = '';
  // the click that follows the drop must not select the card
  const eat = e => { e.stopPropagation(); e.preventDefault(); };
  addEventListener('click', eat, true); setTimeout(() => removeEventListener('click', eat, true), 0);
  setTimeout(() => {   // not transitionend: with motion off it never fires
    const listEl = $('railList');
    for (const c of d.cards) { c.style.transition = 'none'; c.style.translate = ''; }
    if (to !== d.from) {
      const rest = d.cards.filter(c => c !== d.b);
      listEl.insertBefore(d.b, rest[to] || null);
    }
    void listEl.offsetHeight;
    for (const c of d.cards) c.style.transition = '';
    document.body.classList.remove('sorting');
    S.railDrag = null;
    if (commit && to !== d.from) {
      const keys = [...listEl.children].map(c => c.dataset.key);
      saveCustom(keys); S.railShown = keys; S.railOrderAt = performance.now();
      railSay(d.b, to, keys.length);
    }
    if (S.railDirty) { S.railDirty = false; renderRail(S.model); }
  }, ms ? ms + 50 : 0);
}
function railSay(b, i, n) { setT($('railLive'), `${b.querySelector('.nm')?.textContent || 'session'} moved to ${i + 1} of ${n}`); }

// keyboard: arrows move the focus; in Custom, Alt+arrows move the card (Alt+Shift: to the end)
$('railList').addEventListener('keydown', e => {
  const b = e.target.closest('.sess'); if (!b) return;
  const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft', fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const ends = e.altKey && (e.key === 'Home' || e.key === 'End');
  if (!back && !fwd && !ends) return;
  e.preventDefault();
  const cards = [...$('railList').children], i = cards.indexOf(b);
  if (!e.altKey) { (cards[i + (fwd ? 1 : -1)] || b).focus(); return; }
  if (settings.railSort !== 'custom') { showTip(b, 'Switch to Custom order to reorder'); setTimeout(hideTip, 1500); return; }
  let j = ends ? (e.key === 'Home' ? 0 : cards.length - 1) : e.shiftKey ? (back ? 0 : cards.length - 1) : i + (back ? -1 : 1);
  j = Math.max(0, Math.min(cards.length - 1, j));
  if (j === i) return;
  const keys = cards.map(c => c.dataset.key);
  keys.splice(j, 0, keys.splice(i, 1)[0]);
  saveCustom(keys);
  applyRailOrder(keys, true);
  b.focus(); railSay(b, j, keys.length);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.railDrag) { e.stopImmediatePropagation(); railDragEnd(false); } }, true);
function selectSession(sid) {
  if (sid === S.sid) return;
  S.sid = sid; store.set('ccprobe.sid', sid); S.sel = 'lead'; S.userPanned = false; S.expandFinished = false;
  clearGraph(); render();
}

// ---- hiding agents by hand: until they write anything new, then they come back by themselves ----
const BUSY = ['running', 'thinking', 'polling'];
const canHide = n => n && n.id !== 'lead' && n.role !== 'lead' && !BUSY.includes(n.state?.key);
// done means finished (its work handed back, or an earlier agent of a reused name) or dead; idle and parked agents are not done
const isDone = a => a.finished || a.state.key === 'dead';
function isHidden(a) {
  const t = hidden[a.id];
  if (t == null) return false;
  if ((a.last_ts || 0) > t) { delete hidden[a.id]; store.set('ccprobe.hidden', hidden); return false; }   // at work again
  return true;
}
function hideAgents(ids) {
  if (!ids.length || !S.model) return;
  const now = S.model.now;
  for (const k in hidden) if (hidden[k] < now - 86400) delete hidden[k];   // long gone from the model's window
  for (const id of ids) hidden[id] = now;
  store.set('ccprobe.hidden', hidden);
  if (ids.includes(S.sel)) S.sel = 'lead';
  hideTip(); render();
}
function unhideAgents(ids) {
  let n = 0;
  for (const id of ids) if (id in hidden) { delete hidden[id]; n++; }
  if (n) store.set('ccprobe.hidden', hidden);
  return n;
}

// ---- graph: nodes ----
function buildNodes(s) {
  const now = S.model.now;
  const lead = s.lead || {};
  const nodes = [{
    id: 'lead', role: 'lead', label: s.project, sub: clip(s.title || s.name || '', 26), state: lead.state || { key: 'unknown', label: '?' },
    ctx: lead.ctx, ctx_max: lead.ctx_max, said: lead.said, recent: lead.recent || [], last_ts: lead.last_ts, model: lead.model,
  }];
  const rowOf = rowIndex(s);
  for (const a of s.agents || []) {
    if (isHidden(a) || a.finished && !settings.showFinished) continue;
    const row = a.task != null ? rowOf.get(a.task) : null;
    nodes.push(Object.assign({}, a, {
      sub: clip(a.task_title || a.desc || '', 26), rowKind: row ? row.kind : null,
      collapsed: a.finished && now - (a.state.since || now) > 240 && !S.expandFinished,
    }));
  }
  return nodes;
}
function rowIndex(s) {
  const m = new Map();
  const w = s.wts;
  if (w && w.groups) for (const g in w.groups) for (const r of w.groups[g]) m.set(r.n, Object.assign({ group: g }, r));
  return m;
}
const isParked = n => n.state.key === 'waiting_window' || (n.rowKind === 'paused' || n.rowKind === 'parked') && !['running', 'thinking', 'polling'].includes(n.state.key);
const radius = n => {
  const c = settings.compact;
  return n.role === 'lead' ? (c ? 40 : 52) : n.role === 'worker' ? (c ? 32 : 42) : (n.finished ? 22 : c ? 22 : 30);
};

// role-band layout with stable ordering (ui.md §3)
function layout(nodes, s) {
  const pos = new Map(), W = 1100;
  const vis = nodes.filter(n => !n.collapsed);
  const ids = new Set(vis.map(n => n.id));
  const lead = vis[0];
  pos.set('lead', { x: W / 2, y: 110, r: radius(lead) });
  const agents = vis.slice(1);
  const fin = agents.filter(n => n.finished);
  const live = agents.filter(n => !n.finished);
  // a helper orbits its anchor only when the anchor is itself placed in a row or the parked column
  // (not another satellite, not finished); otherwise it takes a place in the row like everyone else
  const parked = live.filter(isParked);
  const liveIds = new Set(live.map(n => n.id));
  const cand = new Set(live.filter(n => n.role === 'helper' && n.anchor && n.anchor !== 'lead' && !isParked(n)).map(n => n.id));
  const sats = live.filter(n => cand.has(n.id) && liveIds.has(n.anchor) && !cand.has(n.anchor));
  const main = live.filter(n => !sats.includes(n) && !parked.includes(n));
  const rank = { worker: 0, mp: 1, lp: 2, helper: 3 };
  main.sort((a, b) => rank[a.role] - rank[b.role] || (a.task || 0) - (b.task || 0) || a.born - b.born);
  parked.sort((a, b) => rank[a.role] - rank[b.role] || (a.task || 0) - (b.task || 0) || a.born - b.born);
  const per = 5, gap = 240;
  let maxY = 110, maxX = W / 2, minX = W / 2;
  main.forEach((n, i) => {
    const row = Math.floor(i / per), cnt = Math.min(per, main.length - row * per), col = i % per;
    const x = W / 2 + (col - (cnt - 1) / 2) * gap, y = 420 + row * 280;
    pos.set(n.id, { x, y, r: radius(n) });
    maxY = Math.max(maxY, y); maxX = Math.max(maxX, x); minX = Math.min(minX, x);
  });
  // satellites: fixed angular slots around their anchor, handed out in spawn order
  const byAnchor = new Map();
  for (const n of sats.sort((a, b) => a.born - b.born)) {
    if (!byAnchor.has(n.anchor)) byAnchor.set(n.anchor, []);
    byAnchor.get(n.anchor).push(n);
  }
  const orbit = (anc, angles) => {
    const p = pos.get(anc), list = byAnchor.get(anc);
    list.forEach((n, i) => {
      const a = angles[i % angles.length] * Math.PI / 180, R = 200 + Math.floor(i / angles.length) * 120;
      const q = { x: p.x + R * Math.cos(a), y: p.y + R * Math.sin(a), r: radius(n) };
      pos.set(n.id, q); maxY = Math.max(maxY, q.y); maxX = Math.max(maxX, q.x); minX = Math.min(minX, q.x);
    });
  };
  for (const anc of byAnchor.keys()) if (pos.has(anc)) orbit(anc, [62, 118, 28, 152, 90, 0, 180]);   // below a row agent
  // parked column on the right
  const px = Math.max(maxX + 250, W / 2 + 330);
  parked.forEach((n, i) => {
    const col = parked.length > 4 ? Math.floor(i / Math.ceil(parked.length / 2)) : 0;
    const k = parked.length > 4 ? i % Math.ceil(parked.length / 2) : i;
    const q = { x: px + col * 210, y: 110 + k * 205, r: radius(n) };
    pos.set(n.id, q); maxY = Math.max(maxY, q.y); maxX = Math.max(maxX, q.x);
  });
  for (const anc of byAnchor.keys()) if (parked.some(n => n.id === anc)) orbit(anc, [180, 145, 215, 110, 250]);   // left of a parked one
  // finished (expanded) row
  let y = maxY + 230;
  if (fin.length) {
    fin.sort((a, b) => a.born - b.born).forEach((n, i) => {
      const cnt = fin.length;
      pos.set(n.id, { x: W / 2 + (i - (cnt - 1) / 2) * 150, y, r: radius(n) });
    });
    y += 190;
  }
  const collapsed = nodes.filter(n => n.collapsed);
  const res = { y, collapsed };
  S.order = [...new Set(['lead', ...main.map(n => n.id), ...sats.map(n => n.id), ...parked.map(n => n.id), ...fin.map(n => n.id)])];
  return { pos, res, minX, maxX };
}

function clearGraph() {
  for (const g of ['gEdges', 'gNodes', 'gTethers', 'gCards', 'gPulse']) $(g).textContent = '';
  S.nodes.clear(); S.edges.clear(); S.cards.clear(); S.res.clear(); S.pulses = []; S.prevState.clear();
  S.disp.clear(); S.leaving.clear(); S.vbD = null; S.snapNext = true; S.prevCollapsed = new Set(); S.fadeUntil = 0;
  $('hiddenBtn').hidden = $('clearBtn').hidden = true;   // renderGraph shows them again when they apply
}

// ---- motion: renderGraph sets targets once per tick; one spring loop moves nodes, resources, cards and the view,
// and redraws the edges and tethers from what is on screen every frame ----
Object.assign(S, { disp: new Map(), leaving: new Set(), vbD: null, snapNext: true, prevCollapsed: new Set(), fadeUntil: 0, loopT: 0 });
const W0 = 12;   // a critically damped spring (ω, rad/s): ~90 % of a move in 0.3 s, at rest by ~0.7 s, no overshoot
const posAnim = () => settings.motion === 'full' && !document.hidden && !S.snapNext;
const fadeAnim = () => settings.motion !== 'off' && !document.hidden && !S.snapNext;
// one step in closed form (stable for any dt); a new target mid-flight keeps position and velocity: no restart
function spr(o, k, v, t, dt, eps = .3, veps = 5) {
  const d = o[k] - o[t];
  if (!d && !o[v]) return false;
  const e = Math.exp(-W0 * dt), a = o[v] + W0 * d;
  o[k] = o[t] + (d + a * dt) * e; o[v] = (o[v] - W0 * a * dt) * e;
  if (Math.abs(o[k] - o[t]) < eps && Math.abs(o[v]) < veps) { o[k] = o[t]; o[v] = 0; return false; }
  return true;
}
function fadeTo(o, to, ms, delay = 0) {
  const now = performance.now();
  o.f0 = opNow(o, now); o.f1 = to; o.ft = now + delay; o.fd = ms;
  S.fadeUntil = Math.max(S.fadeUntil, o.ft + ms);
}
function opNow(o, now) {
  if (!o) return 1;
  if (!o.fd) return o.f1 ?? 1;
  const k = Math.min(1, Math.max(0, (now - o.ft) / o.fd));
  return o.f0 + (o.f1 - o.f0) * k;
}
const opStr = v => v >= .999 ? '1' : Math.max(0, v).toFixed(3);
function put(e, a, v) { if (e['_' + a] !== v) { e['_' + a] = v; e.setAttribute(a, v); } }   // per-frame writes, cached
// a node's or resource's target; a new one grows out of `from()` (its parent, or the finished chip)
function target(id, x, y, kind, from) {
  let d = S.disp.get(id);
  if (!d) {
    d = { kind, x, y, vx: 0, vy: 0, tx: x, ty: y, s: 1, vs: 0, ts: 1, f1: 1, born: performance.now() };
    S.disp.set(id, d);
    const f = posAnim() && from && from();
    if (f) { d.x = f.x; d.y = f.y; d.s = .5; }
    if (fadeAnim()) { d.f1 = 0; fadeTo(d, 1, posAnim() ? 220 : 150); }
    return d;
  }
  if (d.leaving) { unleave(d); d.ts = 1; }
  if (Math.abs(d.tx - x) > .5 || Math.abs(d.ty - y) > .5) {
    d.tx = x; d.ty = y;
    if (S.tipAnchor && S.nodes.get(id)?.outer.contains(S.tipAnchor)) hideTip();   // its tip would point at the old spot
  }
  if (!posAnim()) { d.x = d.tx; d.y = d.ty; d.vx = d.vy = 0; d.s = d.ts; d.vs = 0; }
  return d;
}
// on the way out: fade (and move or shrink) for `ms`, then `drop` removes it; with motion off it goes at once
function leave(o, ms, drop, hold = 0) {
  o.drop = drop;
  if (!fadeAnim()) { drop(); return; }
  if (!posAnim() && 'tx' in o) { o.tx = o.x; o.ty = o.y; o.ts = o.s; ms = 150; hold = 0; }   // reduced: fade in place
  o.leaving = true; o.until = performance.now() + ms;
  fadeTo(o, 0, ms - hold, hold); S.leaving.add(o);
}
function unleave(o) {
  if (!o.leaving) return;
  o.leaving = false; S.leaving.delete(o);
  fadeTo(o, 1, fadeAnim() ? 150 : 0);
}
// where an edge or tether meets a node or resource as drawn now
function geom(id) {
  const d = S.disp.get(id); if (!d) return null;
  if (d.kind === 'res') return { x: d.x, y: d.y, r: d.rr, rect: d.w ? { w: d.w, h: d.h } : null };
  return { x: d.x, y: d.y, r: d.r * d.s, top: (d.top || 0) * d.s, bottom: (d.bottom || 0) * d.s };
}
function moving() {
  const now = performance.now();
  if (S.leaving.size || now < S.fadeUntil || S.pulses.length) return true;
  for (const d of S.disp.values()) if (d.x !== d.tx || d.y !== d.ty || d.s !== d.ts) return true;
  for (const k of S.cards.values()) if (k.swapAt || k.ox !== k.tox || k.oy !== k.toy) return true;
  const v = S.vbD;
  return !!v && (v.x !== v.tx || v.y !== v.ty || v.w !== v.tw || v.h !== v.th);
}
function kick() { if (!S.raf) { S.loopT = performance.now(); S.raf = requestAnimationFrame(tick); } }
function tick(now) {
  S.raf = 0;
  if (document.hidden) { settleAll(); return; }
  const dt = Math.min(.064, Math.max(0, (now - S.loopT) / 1000)); S.loopT = now;
  for (const d of S.disp.values()) { spr(d, 'x', 'vx', 'tx', dt); spr(d, 'y', 'vy', 'ty', dt); spr(d, 's', 'vs', 'ts', dt, .002, .03); }
  const t0 = performance.now();
  for (const k of S.cards.values()) {
    if (!k.swapAt) { spr(k, 'ox', 'vox', 'tox', dt); spr(k, 'oy', 'voy', 'toy', dt); }
    else if (t0 >= k.swapAt) { k.ox = k.tox; k.oy = k.toy; k.vox = k.voy = 0; k.swapAt = 0; fadeTo(k, 1, 150); }
  }
  const v = S.vbD;
  if (v) { spr(v, 'x', 'vx', 'tx', dt); spr(v, 'y', 'vy', 'ty', dt); spr(v, 'w', 'vw', 'tw', dt); spr(v, 'h', 'vh', 'th', dt); }
  const t = performance.now();
  for (const o of S.leaving) if (t >= o.until) { S.leaving.delete(o); o.leaving = false; o.drop(); }
  drawFrame(t);
  stepPulses(now);
  if (moving()) S.raf = requestAnimationFrame(tick);
}
// a hidden tab, or coming back to one: everything straight to where it belongs
function settleAll() {
  for (const d of S.disp.values()) { d.x = d.tx; d.y = d.ty; d.s = d.ts; d.vx = d.vy = d.vs = 0; d.fd = 0; }
  for (const k of S.cards.values()) { k.ox = k.tox; k.oy = k.toy; k.vox = k.voy = 0; k.fd = 0; k.swapAt = 0; k.f1 = k.leaving ? 0 : 1; }
  for (const e of S.edges.values()) e.fd = 0;
  for (const o of [...S.leaving]) { S.leaving.delete(o); o.leaving = false; o.drop(); }
  const v = S.vbD;
  if (v) { v.x = v.tx; v.y = v.ty; v.w = v.tw; v.h = v.th; v.vx = v.vy = v.vw = v.vh = 0; }
  for (const p of S.pulses) { p.dot.remove(); p.halo.remove(); }
  S.pulses = []; S.fadeUntil = 0;
  drawFrame(performance.now());
}
function drawFrame(now) {
  const tf = d => `translate(${d.x.toFixed(1)},${d.y.toFixed(1)})` + (Math.abs(d.s - 1) > .001 ? ` scale(${d.s.toFixed(3)})` : '');
  for (const [id, p] of S.nodes) {
    const d = S.disp.get(id); if (!d) continue;
    put(p.outer, 'transform', tf(d)); put(p.outer, 'opacity', opStr(opNow(d, now)));
  }
  for (const [id, r] of S.res) {
    const d = S.disp.get(id); if (!d) continue;
    put(r.g, 'transform', tf(d)); put(r.g, 'opacity', opStr(opNow(d, now)));
  }
  for (const [key, e] of S.edges) {
    const a = geom(e.a), b = geom(e.b);
    if (!a || !b) { e.g.remove(); S.edges.delete(key); S.leaving.delete(e); continue; }
    const { d, mid } = edgePath(a, b, e.bend);
    put(e.path, 'd', d);
    put(e.lbl, 'x', (mid.x + 8).toFixed(1)); put(e.lbl, 'y', (mid.y - 6).toFixed(1));
    put(e.g, 'opacity', opStr(Math.min(opNow(S.disp.get(e.a), now), opNow(S.disp.get(e.b), now), opNow(e, now))));
  }
  for (const [key, k] of S.cards) {
    const n = geom(k.node);
    if (!n) { k.g.remove(); k.t.remove(); S.cards.delete(key); S.leaving.delete(k); continue; }
    const sx = n.x + k.ox, sy = n.y + k.oy;
    put(k.g, 'transform', `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
    const o = Math.min(opNow(k, now), opNow(S.disp.get(k.node), now));
    put(k.g, 'opacity', opStr(o));
    // the tether: from the node's rim to the nearest point of the card
    const cx = Math.max(sx, Math.min(n.x, sx + k.w)), cy = Math.max(sy, Math.min(n.y, sy + k.h));
    const dx = cx - n.x, dy = cy - n.y, L = Math.hypot(dx, dy) || 1;
    put(k.t, 'x1', (n.x + dx / L * (n.r + 6)).toFixed(1)); put(k.t, 'y1', (n.y + dy / L * (n.r + 6)).toFixed(1));
    put(k.t, 'x2', cx.toFixed(1)); put(k.t, 'y2', cy.toFixed(1));
    const ts = opStr(o * .55); if (k.t._op !== ts) { k.t._op = ts; k.t.style.opacity = ts; }
  }
  const v = S.vbD;
  if (v) { S.vb = { x: v.x, y: v.y, w: v.w, h: v.h }; applyVb(); }
}
// a node that appears grows out of the finished chip (when it was folded there), else its parent, anchor or the lead
function enterFrom(n) {
  const at = id => { const d = S.disp.get(id); return d ? { x: d.x, y: d.y } : null; };
  if (S.prevCollapsed.has(n.id)) return at('_fin');
  return at(n.parent) || at(n.anchor) || at('lead');
}

function renderGraph(s) {
  const now = S.model.now;
  const nodes = buildNodes(s);
  const { pos, res } = layout(nodes, s);
  S.pos = pos;   // the layout's targets; what is on screen is S.disp
  const nHidden = (s.agents || []).filter(a => a.id in hidden).length;
  S.clearable = nodes.filter(n => !n.collapsed && canHide(n) && isDone(n)).map(n => n.id);   // what is drawn, not the chip's
  $('hiddenBtn').hidden = !nHidden; setT($('hiddenText'), `${nHidden} hidden · show`);
  $('clearBtn').hidden = !S.clearable.length; setT($('clearText'), `Clear ${S.clearable.length} done`);
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (!byId.has(S.sel) || byId.get(S.sel).collapsed) S.sel = 'lead';
  const alertsBy = new Map();
  for (const a of liveAlerts(S.model)) if (a.session === s.id && a.agent && a.sev !== 'info') alertsBy.set(a.agent, (alertsBy.get(a.agent) || 0) + 1);

  const boxes = [];   // obstacles for card placement and the fit box, all at the targets
  const seen = new Set();
  for (const n of nodes) {
    if (n.collapsed) continue;
    const p = pos.get(n.id); if (!p) continue;
    seen.add(n.id);
    let parts = S.nodes.get(n.id);
    if (!parts) { parts = makeNode(n.id); S.nodes.set(n.id, parts); }
    parts.outer.classList.remove('leaving'); parts.outer.removeAttribute('aria-hidden');
    const lb = updateNode(parts, n, p, now, alertsBy.get(n.id) || 0);
    p.top = p.y - lb[0].y; p.bottom = lb[1].y + lb[1].h - p.y;
    const d = target(n.id, p.x, p.y, 'node', () => enterFrom(n));
    if (d.r && Math.abs(d.r - p.r) > .5 && posAnim()) d.s *= d.r / p.r;   // a new radius: scale from the old size
    d.r = p.r; d.top = p.top; d.bottom = p.bottom;
    boxes.push(...lb);
  }

  // resources: the collapsed-finished chip, the HP queue and the window
  const resSeen = new Set();
  const w = s.wts && !s.wts.error ? s.wts : null;
  if (res.collapsed.length) {
    resSeen.add('_fin');
    boxes.push(drawChip({ x: pos.get('lead').x - 260, y: 110 }, `✓ ${res.collapsed.length} finished · show`));
  }
  const worker = nodes.find(n => n.role === 'worker' && seen.has(n.id));
  if (w) {
    const hp = (w.groups.HP || []).filter(r => ['queued', 'active', 'paused', 'parked', 'asks', 'other'].includes(r.kind));
    const next = (w.groups.HP || []).find(r => r.kind === 'queued');
    const qx = worker ? pos.get(worker.id).x - 330 : 120;
    const qy = worker ? pos.get(worker.id).y : res.y;
    resSeen.add('_queue');
    boxes.push(drawResClear('_queue', { x: qx, y: qy }, boxes, ROLECOL.worker, 'i-queue', `HP queue · ${hp.length} open`,
      next ? clip(`next ${next.n} · ${next.title}`, 36) : 'nothing queued',
      `MP ${(w.groups.MP || []).filter(r => r.kind !== 'done').length} · LP ${(w.groups.LP || []).filter(r => r.kind !== 'done').length} open`));
    const win = w.window || {};
    const holderPos = win.holder && pos.get(win.holder);
    const wx = holderPos ? holderPos.x - 230 : 550;
    const waiters = (win.waiters || []).map(id => byId.get(id)?.label).filter(Boolean);
    resSeen.add('_window');
    boxes.push(drawResClear('_window', { x: wx, y: res.y }, boxes, win.held ? 'red' : 'green', win.held ? 'i-lock' : 'i-unlock',
      `Window · ${w.lock_name || 'lock'}`, win.held ? clip(`${shortWho(win.who)} · ${dur(now - (win.since || now))}`, 38) : 'free',
      waiters.length ? clip('waiting: ' + waiters.join(', '), 38) : ''));
  }
  for (const [id, r] of S.res) if (!resSeen.has(id)) {
    const d = S.disp.get(id);
    if (!d) { r.g.remove(); S.res.delete(id); }
    else if (!d.leaving) leave(d, 150, () => { r.g.remove(); S.res.delete(id); S.disp.delete(id); });
  }

  // nodes on the way out: into the finished chip, or faded where they stand (quickly when you hid them)
  const folded = new Set(res.collapsed.map(n => n.id));
  for (const [id, parts] of S.nodes) if (!seen.has(id)) {
    const d = S.disp.get(id);
    const drop = () => { parts.outer.remove(); S.nodes.delete(id); S.disp.delete(id); };
    if (!d) { drop(); continue; }
    if (d.leaving) continue;
    S.prevState.delete(id);
    if (parts.g.contains(document.activeElement)) S.nodes.get('lead')?.g.focus({ preventScroll: true });
    if (S.tipAnchor && parts.outer.contains(S.tipAnchor)) hideTip();
    parts.outer.classList.add('leaving'); parts.outer.setAttribute('aria-hidden', 'true'); parts.g.setAttribute('tabindex', -1);
    const chip = folded.has(id) && S.disp.get('_fin');
    if (chip) { d.tx = chip.tx; d.ty = chip.ty; d.ts = .3; } else if (id in hidden) d.ts = .85;
    if (chip) leave(d, 400, drop, 150);   // seen flying in: it fades only on the last part of the way
    else leave(d, id in hidden ? 180 : 250, drop);
  }

  // edges: their ends are looked up every frame, so they follow the nodes as they move
  const eSeen = new Set();
  for (const e of s.edges || []) {
    if (!seen.has(e.from) || !seen.has(e.to)) continue;
    drawEdge(e.key, e.from, e.to, `edge ${e.kind}${e.hot ? ' hot' : ''}`, e.kind === 'task' && byId.get(e.to)?.task ? `task ${byId.get(e.to).task}` : '', eSeen);
  }
  if (w && w.window && w.window.held && seen.has(w.window.holder) && S.res.has('_window')) drawEdge('lock', w.window.holder, '_window', 'edge lock', '', eSeen);
  if (w && worker && S.res.has('_queue')) drawEdge('queue', '_queue', worker.id, 'edge', '', eSeen);
  for (const [k, e] of S.edges) if (!eSeen.has(k) && !e.leaving) leave(e, 150, () => { e.g.remove(); S.edges.delete(k); });

  placeCards(nodes, pos, boxes, now);
  fit(boxes);
  S.prevCollapsed = folded;
  drawFrame(performance.now());
  S.snapNext = false;
  if (moving()) kick();
}

function makeNode(id) {
  const outer = el('g', {}, $('gNodes'));   // moved and faded by the motion loop
  const g = el('g', { class: 'node', tabindex: 0, role: 'button' }, outer);
  const p = { g, outer };
  p.halo = el('circle', { class: 'halo' }, g);
  p.flash = el('polygon', { class: 'flash' }, g);
  p.arc = el('circle', { class: 'arc' }, g);
  p.hex = el('polygon', { class: 'hex' }, g);
  p.selring = el('polygon', { class: 'selring' }, g);
  p.mark = el('use', {}, g); p.mark.setAttribute('class', 'mark');
  p.lbl = el('text', { class: 'lbl' }, g);
  p.sub = el('text', { class: 'sub' }, g);
  p.stat = el('g', { class: 'stat' }, g); p.sico = el('use', { width: 12, height: 12 }, p.stat); p.stxt = el('text', {}, p.stat);
  p.barbg = el('rect', { class: 'barbg', height: 4, rx: 2 }, g); p.bar = el('rect', { class: 'bar', height: 4, rx: 2 }, g);
  p.meta = el('text', { class: 'meta' }, g);
  p.badge = el('g', { class: 'badge' }, g); el('circle', { r: 8 }, p.badge); p.badgeT = el('text', { y: 4 }, p.badge);
  p.hide = el('g', { class: 'hide' }, g); el('circle', { r: 8 }, p.hide); el('path', { d: 'M-3,-3L3,3M3,-3L-3,3' }, p.hide);
  el('title', {}, p.hide).textContent = 'Hide from the diagram (H)';
  p.hide.addEventListener('click', ev => { ev.stopPropagation(); hideAgents([id]); });
  g.addEventListener('click', ev => { ev.stopPropagation(); select(id); });
  g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(id); } });
  g.addEventListener('mouseenter', () => showTip(g, nodeTip(id)));
  g.addEventListener('mouseleave', hideTip);
  return p;
}

function updateNode(p, n, pos, now, nAlerts) {
  const { x, y, r } = pos;
  const st = n.state || { key: 'unknown', label: '?' };
  const [sIcon, sCol] = STATUS[st.key] || STATUS.unknown;
  const active = ['running', 'thinking', 'polling'].includes(st.key) || (n.role === 'lead' && !['waiting_user', 'idle', 'dead', 'shell'].includes(st.key));
  const col = n.role === 'lead' ? 'cyan' : ROLECOL[n.role] || 'violet';
  // blocked (paused, parked, waiting for or looping on the window): a dashed hex, at full strength
  const blocked = !n.finished && n.role !== 'lead' && (isParked(n) || st.key === 'polling');
  p.g.setAttribute('class', `node c-${col}${active ? ' active' : ''}${isParked(n) ? ' parked' : ''}${blocked ? ' blocked' : ''}${n.finished ? ' finished' : ''}${S.sel === n.id ? ' sel' : ''}`);
  setA(p.g, { tabindex: 0, 'aria-label': `${n.label}, ${st.label}${n.task ? ', task ' + n.task : ''}` });
  setA(p.halo, { r: r * 1.75 });
  setA(p.hex, { points: hexPts(r) });
  setA(p.selring, { points: hexPts(r + 9) });
  setA(p.flash, { points: hexPts(r + 3) });
  setA(p.arc, { r: r + 10, 'stroke-dasharray': `${(r * .9).toFixed(0)} ${(r * 7).toFixed(0)}` });
  p.arc.style.display = active ? '' : 'none';
  // inner mark: the lead's star, a pause glyph when parked, a status icon otherwise
  const markId = n.role === 'lead' ? 'i-lead' : isParked(n) ? 'i-park' : (st.key === 'dead' ? 'i-dead' : st.key === 'ended' ? 'i-done' : 'i-think');
  const ms = n.role === 'lead' ? r * .62 : r * .5;
  setA(p.mark, { href: '#' + markId, x: -ms / 2, y: -ms / 2, width: ms, height: ms });
  // context: the bar under the label only (no "almost full" pill or alert: the user's call)
  const pct = n.ctx_max ? n.ctx / n.ctx_max : 0;
  const lvl = pct >= .9 ? 'crit' : pct >= .8 ? 'warn' : '';
  // label stack
  let yy = r + 21;
  setA(p.lbl, { y: yy }); setT(p.lbl, clip(n.label, 20));
  const compact = settings.compact || n.finished;
  if (n.sub && !compact) { yy += 15; setA(p.sub, { y: yy }); setT(p.sub, n.sub); p.sub.style.display = ''; } else p.sub.style.display = 'none';
  yy += 17;
  const label = clip(st.label, 34);
  const tw = textW(label, 11.5) + 16;
  p.stat.setAttribute('class', `stat k-${st.key} c-${sCol}`);
  setA(p.sico, { href: '#' + sIcon, x: -tw / 2, y: yy - 10 });
  setA(p.stxt, { x: -tw / 2 + 16, y: yy }); setT(p.stxt, label);
  yy += 9;
  setA(p.barbg, { x: -40, y: yy, width: 80 });
  setA(p.bar, { x: -40, y: yy, width: (80 * Math.min(pct, 1)).toFixed(1) });
  p.bar.setAttribute('class', `bar ${lvl}`);
  yy += 17;
  if (!compact) {
    const meta = `${n.ctx ? kfmt(n.ctx) + ' / ' + kfmt(n.ctx_max) : 'no context yet'} · ${ago(n.last_ts, now)}`;
    setA(p.meta, { y: yy }); setT(p.meta, meta); p.meta.style.display = '';
  } else { p.meta.style.display = 'none'; yy -= 12; }
  p.badge.style.display = nAlerts ? '' : 'none';
  setA(p.badge, { transform: `translate(${(r * .8).toFixed(1)},${(-r * .75).toFixed(1)})` }); setT(p.badgeT, '!');
  p.hide.style.display = canHide(n) ? '' : 'none';
  setA(p.hide, { transform: `translate(${(-r * .8).toFixed(1)},${(-r * .75).toFixed(1)})` });
  // a one-shot ring when the state changes
  const prev = S.prevState.get(n.id);
  if (prev && prev !== st.key && settings.motion === 'full' && !document.hidden) {
    p.flash.classList.remove('go'); void p.flash.getBBox(); p.flash.classList.add('go');
  }
  S.prevState.set(n.id, st.key);
  const labelHalf = Math.max(textW(clip(n.label, 20), 14.5), tw, n.sub && !compact ? textW(n.sub, 11) : 0, textW(p.meta.textContent || '', 10.5)) / 2 + 6;
  return [
    { x: x - r - 12, y: y - r - (pct >= .7 ? 38 : 14), w: 2 * r + 24, h: 2 * r + (pct >= .7 ? 38 : 14) + 6, node: n.id },
    { x: x - labelHalf, y: y + r + 6, w: 2 * labelHalf, h: yy - r, node: n.id },
  ];
}

function drawRes(id, col, ico, h, s1, s2) {
  let r = S.res.get(id);
  if (!r) {
    const g = el('g', { class: 'res' }, $('gNodes'));
    r = { g, box: el('rect', { class: 'box', rx: 8 }, g), ico: el('use', { class: 'ico', width: 14, height: 14 }, g),
      h: el('text', { class: 'h' }, g), s1: el('text', { class: 's' }, g), s2: el('text', { class: 's' }, g) };
    S.res.set(id, r);
  }
  const lines = [s1, s2].filter(Boolean);
  const wdt = Math.max(textW(h, 12.5) + 30, ...lines.map(l => textW(l, 11))) + 26, hgt = 30 + lines.length * 16;
  const x = -wdt / 2, y = -hgt / 2;   // around its centre; the motion loop places it
  r.g.setAttribute('class', `res c-${col}`);
  setA(r.box, { x, y, width: wdt, height: hgt });
  setA(r.ico, { href: '#' + ico, x: x + 12, y: y + 9 });
  setA(r.h, { x: x + 32, y: y + 21 }); setT(r.h, h);
  setA(r.s1, { x: x + 12, y: y + 39 }); setT(r.s1, s1 || '');
  setA(r.s2, { x: x + 12, y: y + 55 }); setT(r.s2, s2 || '');
  return { w: wdt, h: hgt };
}

// a resource card keeps clear of whatever is already placed: its own spot first, then the nearest free one sideways
function drawResClear(id, p, boxes, ...rest) {
  const { w, h } = drawRes(id, ...rest);
  const box = x => ({ x: x - w / 2 - 8, y: p.y - h / 2 - 8, w: w + 16, h: h + 16 });
  let x = p.x;
  for (let k = 0; k <= 24; k++) {
    const xx = p.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 60;
    if (!boxes.some(o => hit(box(xx), o))) { x = xx; break; }
  }
  const d = target(id, x, p.y, 'res');
  d.w = w; d.h = h; d.rr = Math.min(w, h) / 2 + 2;
  return box(x);
}

function drawChip(p, text) {
  let r = S.res.get('_fin');
  if (!r) {
    const g = el('g', { class: 'chipnode', tabindex: 0, role: 'button' }, $('gNodes'));
    r = { g, box: el('rect', { rx: 12 }, g), t: el('text', {}, g) };
    g.addEventListener('click', () => { S.expandFinished = !S.expandFinished; render(); });
    S.res.set('_fin', r);
  }
  const w = textW(text, 11.5) + 24;
  setA(r.box, { x: -w / 2, y: -13, width: w, height: 26 });
  setA(r.t, { x: -w / 2 + 12, y: 4 }); setT(r.t, text);
  const d = target('_fin', p.x, p.y, 'res');
  d.rr = 14; d.w = 0;
  return { x: p.x - w / 2 - 6, y: p.y - 19, w: w + 12, h: 38 };
}

function edgePath(a, b, bend) {
  const rad = n => n.rect ? Math.min(n.rect.w, n.rect.h) / 2 : n.r;
  const below = (from, to) => to.y - from.y > (from.r || 0) + 40 && Math.abs(to.x - from.x) < (to.y - from.y) * 1.2;
  let p, q;
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  p = below(a, b) && a.bottom ? { x: a.x, y: a.y + a.bottom + 4 } : { x: a.x + ux * (rad(a) + 10), y: a.y + uy * (rad(a) + 10) };
  q = below(b, a) && b.bottom ? { x: b.x, y: b.y + b.bottom + 4 } : (below(a, b) && b.top ? { x: b.x - ux * 4, y: b.y - b.top - 4 } : { x: b.x - ux * (rad(b) + 10), y: b.y - uy * (rad(b) + 10) });
  const L2 = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const c = { x: (p.x + q.x) / 2 - (q.y - p.y) / L2 * L2 * bend, y: (p.y + q.y) / 2 + (q.x - p.x) / L2 * L2 * bend };
  return { d: `M${p.x.toFixed(1)},${p.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`, mid: { x: (p.x + 2 * c.x + q.x) / 4, y: (p.y + 2 * c.y + q.y) / 4 } };
}
function drawEdge(key, a, b, cls, label, seen) {
  seen.add(key);
  let e = S.edges.get(key);
  if (!e) {
    const g = el('g', {}, $('gEdges'));
    e = { g, path: el('path', {}, g), lbl: el('text', { class: 'elbl' }, g), f1: 1 };
    S.edges.set(key, e);
    if (fadeAnim()) { e.f1 = 0; fadeTo(e, 1, 200); }
  }
  unleave(e);
  e.a = a; e.b = b;
  e.bend = key === 'lock' || key === 'queue' ? 0 : ((hash(key) % 2) ? .07 : -.07);
  if (!e.path.classList.contains('flashy')) e.path.setAttribute('class', cls);
  setA(e.path, { 'marker-end': /\btask\b/.test(cls) ? 'url(#arrTask)' : 'none' });
  e.cls = cls;
  setT(e.lbl, label);
}
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

// ---- speech bubbles and tool cards, placed where they hit nothing (ui.md §3) ----
function placeCards(nodes, pos, boxes, now) {
  const want = [];
  const byRecent = nodes.filter(n => !n.collapsed && pos.has(n.id)).sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
  const sel = byRecent.find(n => n.id === S.sel);
  const order = sel ? [sel, ...byRecent.filter(n => n !== sel)] : byRecent;
  let nb = 0, nt = 0;
  for (const n of order) {
    const st = n.state || {};
    const active = ['running', 'thinking', 'polling'].includes(st.key) || n.role === 'lead';
    if (n.said && (n === sel || (active && now - (n.last_ts || 0) < 600)) && nb < 3 && !n.finished) {
      nb++;
      want.push({ key: n.id + ':b', node: n, kind: 'bubble', head: `${n.label} says`.toUpperCase(), lines: wrap(n.said, 40, 3) });
    }
    if ((st.key === 'running' || st.key === 'polling') && st.detail && nt < 3) {
      nt++;
      const tool = (st.label || '').split(' · ')[0];
      want.push({ key: n.id + ':t', node: n, kind: 'tool', head: null, lines: [clip(`${tool}: ${st.detail}`, 44)] });
    }
  }
  const placed = [];
  const seen = new Set();
  for (const c of want) {
    const p = pos.get(c.node.id);
    const w = Math.max(...c.lines.map(l => textW(l, 11.5)), c.head ? textW(c.head, 9.5) : 0) + 22;
    const h = c.lines.length * 16 + (c.head ? 30 : 12);
    const r = p.r;
    const cands = [
      [p.x + r + 40, p.y - h / 2], [p.x + r + 22, p.y + r + 8], [p.x + r + 22, p.y - r - 26 - h],
      [p.x - r - 40 - w, p.y - h / 2], [p.x - r - 22 - w, p.y + r + 8], [p.x - r - 22 - w, p.y - r - 26 - h],
      [p.x + r + 40, p.y + r + 70], [p.x - r - 40 - w, p.y + r + 70],
    ];
    let spot = null;
    for (const [x, y] of cands) {
      const rect = { x, y, w, h };
      if (boxes.some(b => hit(rect, b)) || placed.some(b => hit(rect, b))) continue;
      spot = rect; break;
    }
    if (!spot) continue;
    placed.push({ x: spot.x - 6, y: spot.y - 6, w: spot.w + 12, h: spot.h + 12 });
    seen.add(c.key);
    drawCard(c, spot, p);
  }
  for (const [k, c] of S.cards) if (!seen.has(k) && !c.leaving) {
    if (S.tipAnchor === c.g) hideTip();
    leave(c, 150, () => { c.g.remove(); c.t.remove(); S.cards.delete(k); });
  }
  boxes.push(...placed);
}
function wrap(text, n, max) {
  const words = String(text).split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  if (lines.length > max) { lines.length = max; lines[max - 1] = clip(lines[max - 1] + ' …', n); }
  return lines.map(l => l.length > n ? clip(l, n) : l);
}
function drawCard(c, spot, p) {
  const col = c.node.role === 'lead' ? 'cyan' : ROLECOL[c.node.role] || 'violet';
  const ox = spot.x - p.x, oy = spot.y - p.y;   // where it sits relative to its node
  let k = S.cards.get(c.key);
  if (!k) {
    const g = el('g', {}, $('gCards'));
    k = { g, t: el('line', {}, $('gTethers')), sig: null, f1: 1, ox, oy, tox: ox, toy: oy, vox: 0, voy: 0 };
    g.addEventListener('mouseenter', () => showTip(g, k.tip));
    g.addEventListener('mouseleave', hideTip);
    S.cards.set(c.key, k);
    const nd = S.disp.get(c.node.id);
    if (fadeAnim()) { k.f1 = 0; fadeTo(k, 1, 180, nd && performance.now() - nd.born < 50 ? 200 : 0); }   // after a new node arrives
  } else {
    unleave(k);
    if (Math.abs(k.tox - ox) > .5 || Math.abs(k.toy - oy) > .5) {
      // to the other side of its node, or far: fade out, jump, fade in (a slide would cross the node)
      const far = Math.hypot(ox - k.ox, oy - k.oy) > 120 || Math.sign(k.ox + k.w / 2) !== Math.sign(ox + spot.w / 2);
      k.tox = ox; k.toy = oy;
      if (far && posAnim()) { k.swapAt = performance.now() + 90; fadeTo(k, 0, 90); }
    }
    if (!posAnim()) { k.ox = k.tox; k.oy = k.toy; k.vox = k.voy = 0; k.swapAt = 0; }
  }
  k.node = c.node.id; k.w = spot.w; k.h = spot.h;
  k.tip = c.kind === 'bubble' ? c.node.said : c.node.state.detail;
  const sig = `${c.kind}|${col}|${c.head || ''}|${c.lines.join('\n')}|${spot.w.toFixed(0)},${spot.h.toFixed(0)}`;
  if (k.sig === sig) return;   // only its text and size; a move never rebuilds it
  k.sig = sig;
  k.g.textContent = '';
  k.g.setAttribute('class', `card ${c.kind} c-${col}`);
  k.t.setAttribute('class', `tether c-${col}`);
  el('rect', { x: 0, y: 0, width: spot.w, height: spot.h, rx: 7 }, k.g);
  let y = 18;
  if (c.head) { const t = el('text', { x: 11, y, class: 'k' }, k.g); t.textContent = c.head; y += 16; }
  for (const line of c.lines) { const t = el('text', { x: 11, y }, k.g); t.textContent = line; y += 16; }
}

// ---- viewport: fit to content, wheel zoom, drag to pan ----
function fit(boxes, force) {
  if (!boxes.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  const pad = 30;
  const vb = { x: x0 - pad, y: y0 - pad - 40, w: Math.max(600, x1 - x0 + 2 * pad), h: Math.max(400, y1 - y0 + 2 * pad + 40) };
  const key = [vb.x, vb.y, vb.w, vb.h].map(v => Math.round(v / 10)).join(',');
  const changed = S.fitKey !== key;
  S.fitKey = key; S.fitVb = vb;
  if (S.userPanned && !force) { $('fitBtn').hidden = !changed && $('fitBtn').hidden; if (changed) $('fitBtn').hidden = false; return; }
  vbTarget(vb);
  $('fitBtn').hidden = true;
}
function vbTarget(vb) {
  const v = S.vbD;
  if (!v || !posAnim()) { S.vbD = { ...vb, vx: 0, vy: 0, vw: 0, vh: 0, tx: vb.x, ty: vb.y, tw: vb.w, th: vb.h }; S.vb = { ...vb }; applyVb(); return; }
  if (v.tx === vb.x && v.ty === vb.y && v.tw === vb.w && v.th === vb.h) return;   // same fit: nothing to move
  v.tx = vb.x; v.ty = vb.y; v.tw = vb.w; v.th = vb.h;
  kick();
}
function vbRest() {   // the user took the view: stop where it is
  const v = S.vb; if (!v) return;
  S.vbD = { ...v, vx: 0, vy: 0, vw: 0, vh: 0, tx: v.x, ty: v.y, tw: v.w, th: v.h };
}
function applyVb() { const v = S.vb; put($('graph'), 'viewBox', `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`); }
function svgPoint(ev) {
  const svg = $('graph'), pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
$('graph').addEventListener('wheel', ev => {
  if (!S.vb || !S.fitVb) return;
  ev.preventDefault();
  const p = svgPoint(ev), k = Math.exp(ev.deltaY * .0015);
  const w = Math.min(S.fitVb.w / .4, Math.max(S.fitVb.w / 3, S.vb.w * k)), f = w / S.vb.w;
  S.vb = { x: p.x - (p.x - S.vb.x) * f, y: p.y - (p.y - S.vb.y) * f, w: S.vb.w * f, h: S.vb.h * f };
  vbRest(); S.userPanned = true; applyVb(); $('fitBtn').hidden = false;
}, { passive: false });
let drag = null;
$('graph').addEventListener('pointerdown', ev => {
  if (ev.target.closest('.node, .card, .chipnode') || !S.vb) return;
  drag = { x: ev.clientX, y: ev.clientY, vb: { ...S.vb }, moved: false };
  $('graph').setPointerCapture(ev.pointerId);
});
$('graph').addEventListener('pointermove', ev => {
  if (!drag) return;
  const svg = $('graph'), s = drag.vb.w / svg.clientWidth;
  if (!drag.moved) {
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) <= 3) return;
    // a drag after all: stop any fit in flight and pan from the view as it is now
    drag.moved = true; svg.classList.add('panning');
    vbRest(); drag.x = ev.clientX; drag.y = ev.clientY; drag.vb = { ...S.vb };
  }
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  S.vb = { ...drag.vb, x: drag.vb.x - dx * s, y: drag.vb.y - dy * s };
  vbRest(); S.userPanned = true; applyVb(); $('fitBtn').hidden = false;
});
$('graph').addEventListener('pointerup', ev => {
  $('graph').classList.remove('panning');
  if (drag && !drag.moved && !ev.target.closest('.node')) select('lead');
  drag = null;
});
$('graph').addEventListener('dblclick', ev => { if (!ev.target.closest('.node')) doFit(); });
$('fitBtn').addEventListener('click', doFit);
$('clearBtn').addEventListener('click', () => hideAgents(S.clearable || []));
$('hiddenBtn').addEventListener('click', () => { const s = cur(); if (s && unhideAgents((s.agents || []).map(a => a.id))) render(); });
function doFit() { S.userPanned = false; if (S.fitVb) vbTarget(S.fitVb); $('fitBtn').hidden = true; }

// ---- pulses: one shared rAF loop ----
function queuePulse(m) {
  const key = [m.from, m.to].sort().join('~');
  const e = S.edges.get(key);
  showTicker(m);
  if (!e || settings.motion === 'off') return;
  if (settings.motion === 'reduced') { e.path.classList.add('flashy'); setTimeout(() => { e.path.classList.remove('flashy'); e.path.setAttribute('class', e.cls); }, 400); return; }
  if (S.pulses.length >= 3) { S.pulses[S.pulses.length - 1].extra++; return; }
  const forward = m.from < m.to;   // the edge path runs from its first endpoint in the model; check by geometry below
  const halo = el('circle', { r: 9, class: 'pulse-halo' }, $('gPulse'));
  const dot = el('path', { d: 'M-6,-5L6,0L-6,5L-2.5,0Z', class: 'pulse' }, $('gPulse'));   // a chevron: direction reads even in a still frame
  const fromPos = S.disp.get(m.from);   // as drawn now
  const L = e.path.getTotalLength(), p0 = e.path.getPointAtLength(0);
  const rev = fromPos ? Math.hypot(p0.x - fromPos.x, p0.y - fromPos.y) > Math.hypot(e.path.getPointAtLength(L).x - fromPos.x, e.path.getPointAtLength(L).y - fromPos.y) : !forward;
  S.pulses.push({ e, dot, halo, t0: performance.now(), rev, extra: 0, ang: 0 });
  kick();
}
function stepPulses(now) {
  S.pulses = S.pulses.filter(p => {
    const k = Math.min((now - p.t0) / 1300, 1), ease = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (!p.e.path.isConnected || k >= 1) { p.dot.remove(); p.halo.remove(); return false; }
    const L = p.e.path.getTotalLength(), at = (p.rev ? 1 - ease : ease) * L, pt = p.e.path.getPointAtLength(at);
    const ahead = p.e.path.getPointAtLength(Math.max(0, Math.min(L, at + (p.rev ? -2 : 2))));
    if (Math.hypot(ahead.x - pt.x, ahead.y - pt.y) > .01) p.ang = Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180 / Math.PI;
    p.dot.setAttribute('transform', `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)}) rotate(${p.ang.toFixed(1)})`);
    p.halo.setAttribute('cx', pt.x); p.halo.setAttribute('cy', pt.y);
    return true;
  });
}
let tickerTimer = 0;
function showTicker(m) {
  const s = cur(); if (!s) return;
  const name = id => id === 'lead' ? 'lead' : ((s.agents || []).find(a => a.id === id)?.label || id.slice(0, 7));
  const verb = m.kind === 'spawn' ? 'spawned' : m.kind === 'handback' ? 'handed back to' : '→';
  const t = $('ticker');
  t.innerHTML = `<span class="who">${esc(name(m.from))} ${verb} ${esc(name(m.to))}</span><span class="what">${esc(m.summary)}</span><span class="when">${hhmm(m.t, 1)}</span>`;
  t.hidden = false; t.classList.remove('fade');
  clearTimeout(tickerTimer); tickerTimer = setTimeout(() => t.classList.add('fade'), 10000);
}
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('paused', document.hidden);
  if (!document.hidden) settleAll();
  if (!document.hidden && S.away) {
    const t = $('ticker');
    t.innerHTML = `<span class="who">+${S.away} event${S.away > 1 ? 's' : ''} while away</span><span class="what">see the timeline and the agents' messages</span>`;
    t.hidden = false; t.classList.remove('fade');
    clearTimeout(tickerTimer); tickerTimer = setTimeout(() => t.classList.add('fade'), 10000);
    S.away = 0;
  }
});

// ---- selection and the side panel ----
function select(id) { unhideAgents([id]); S.sel = id; if (S.tab !== 'agent' && S.tab !== 'wts') S.tab = 'agent'; render(); }
function nodeById(s, id) { return id === 'lead' ? Object.assign({ id: 'lead', role: 'lead', label: s.project }, s.lead) : (s.agents || []).find(a => a.id === id); }
function nodeTip(id) {
  const s = cur(); if (!s) return '';
  const n = nodeById(s, id); if (!n) return '';
  const st = n.state || {};
  return [n.label || s.project, st.label, n.task ? `task ${n.task}: ${n.task_title || ''}` : '', n.ctx ? `context ${kfmt(n.ctx)} / ${kfmt(n.ctx_max)}` : '',
    st.detail ? 'now: ' + st.detail : '', 'last active ' + ago(n.last_ts, S.model.now)].filter(Boolean).join('\n');
}

document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { S.tab = b.dataset.tab; renderPanel(); } });
$('alertBtn').addEventListener('click', () => { S.tab = 'alerts'; renderPanel(); });

function renderPanel() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const s = cur();
  let h;
  if (!S.model) h = '<div class="empty-note">Waiting for the first data…</div>';
  else if (S.tab === 'alerts') h = alertsPanel();
  else if (!s) h = '<div class="empty-note">No session selected.</div>';
  else if (S.tab === 'wts') h = wtsPanel(s);
  else h = agentPanel(s, S.sel);
  if (h === S.panelHtml) return;
  const pane = $('panel'), top = pane.scrollTop;
  pane.innerHTML = h; S.panelHtml = h; pane.scrollTop = top;
  pane.querySelectorAll('svg.pbar').forEach(svg => {
    const f = +svg.dataset.frac; const r = svg.querySelector('.fg');
    if (r) r.setAttribute('width', (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%');
  });
}
const pbar = (frac, lvl) => `<svg class="pbar" data-frac="${frac}"><rect class="bg" width="100%" height="6" rx="3"/><rect class="fg ${lvl}" width="0" height="6" rx="3"/></svg>`;

function agentPanel(s, id) {
  const now = S.model.now;
  const n = nodeById(s, id) || nodeById(s, 'lead');
  const isLead = id === 'lead' || !n.id || n.id === 'lead';
  const st = n.state || { key: 'unknown', label: '?' };
  const [si, sc] = STATUS[st.key] || STATUS.unknown;
  const col = isLead ? 'cyan' : ROLECOL[n.role] || 'violet';
  const pct = n.ctx_max ? n.ctx / n.ctx_max : 0, lvl = pct >= .9 ? 'crit' : pct >= .8 ? 'warn' : '';
  const row = !isLead && n.task != null ? rowIndex(s).get(n.task) : null;
  const label = isLead ? s.project : n.label;
  const msgs = (s.messages || []).filter(m => m.from === (isLead ? 'lead' : n.id) || m.to === (isLead ? 'lead' : n.id)).slice(-8).reverse();
  const nameOf = x => x === 'lead' ? 'lead' : ((s.agents || []).find(a => a.id === x)?.label || x.slice(0, 7));
  let h = `<div class="ptitle c-${col}"><svg class="hx" viewBox="-10 -10 20 20"><polygon points="${hexPts(8.5)}"/></svg>${esc(label)}
    <span class="s c-${sc}">${icon(si)}${esc(st.label)}</span></div>`;
  h += `<div class="pmeta">${isLead ? esc(s.title || '') + ' · ' : esc(n.desc || '') + ' · '}${esc(modelName(n.model) || 'model ?')}${isLead ? '' : ' · ' + esc(n.id.slice(0, 9)) + '…'}</div>`;
  if (!isLead && canHide(n)) h += `<div class="pacts"><button class="pbtn" data-hide="${esc(n.id)}">${icon('i-eye')}Hide from the diagram</button><span class="pmeta">it comes back if it starts working again · H</span></div>`;
  if (st.detail) h += `<div class="sec">Now</div><div class="said">${esc(st.detail)}</div>`;
  if (row) h += `<div class="sec">Task</div><div class="taskcell"><b>${row.n}</b> <span class="pmeta">${esc(row.group)}</span> ${esc(row.title)}<div class="pmeta">${esc(row.status)}</div></div>`;
  h += `<div class="sec">Context</div>${pbar(pct, lvl)}<div class="pmeta">${n.ctx ? kfmt(n.ctx) + ' / ' + kfmt(n.ctx_max) + ' tokens · ' + Math.round(pct * 100) + '%' : 'not known yet'}${(n.compactions || []).length ? ' · compacted ' + n.compactions.length + '× in view' : ''}</div>`;
  h += `<div class="kv"><span>Last active</span><span>${hhmm(n.last_ts, 1)} · ${ago(n.last_ts, now)}</span>`;
  if (isLead) {
    h += `<span>Session</span><span>${esc(s.status)} since ${hhmm(s.status_since)}</span>`;
    h += `<span>Pane</span><span>${s.tmux ? 'tmux ' + esc(s.tmux.session) + ':' + esc(s.tmux.pane) : 'not in tmux'}</span>`;
    if (s.perm_mode) h += `<span>Permissions</span><span>${esc(s.perm_mode)}</span>`;
    h += `<span>Version</span><span>${esc(s.version)} · pid ${s.pid}</span>`;
  } else {
    h += `<span>Role</span><span>${esc(n.role)}${n.name ? ' · "' + esc(n.name) + '"' : ''} · depth ${n.depth}</span>`;
    h += `<span>Parent</span><span><button class="linkbtn" data-select="${esc(n.parent)}">${esc(nameOf(n.parent))}</button></span>`;
  }
  h += '</div>';
  for (const x of (isLead ? (s.lead.notices || []) : [])) h += `<div class="alert amber"><div class="ad">${hhmm(x.t)} · ${esc(x.text)}</div></div>`;
  if (n.said) h += `<div class="sec">Last said</div><div class="said">${esc(n.said)}</div>`;
  h += `<div class="sec">Recent tools</div>`;
  h += (n.recent || []).slice().reverse().map(e => `<div class="ev"><span class="tm">${hhmm(e.t, 1)}</span><span class="tl t-${toolCls(e.tool)}">${esc(e.tool)}</span><span class="a" data-tip="${esc(e.arg)}">${e.to ? '→ ' + esc(toName(s, e.to)) + ' · ' : ''}${esc(e.arg)}</span></div>`).join('') || '<div class="empty-note">none in view</div>';
  h += `<div class="sec">Messages</div>`;
  h += msgs.map(m => { const out = m.from === (isLead ? 'lead' : n.id); const other = out ? m.to : m.from;
    const verb = m.kind === 'spawn' ? (out ? 'spawned' : 'spawned by') : m.kind === 'handback' ? (out ? 'handback →' : 'handback ←') : (out ? '→' : '←');
    return `<div class="ev"><span class="tm">${hhmm(m.t, 1)}</span><span class="tl t-SendMessage">${verb}</span><span class="a" data-tip="${esc(m.summary)}"><button class="linkbtn" data-select="${esc(other)}">${esc(nameOf(other))}</button> · ${esc(m.summary)}</span></div>`; }).join('') || '<div class="empty-note">none in view</div>';
  return h;
}

function toName(s, to) {
  if (to === 'main' || to === 'lead') return 'lead';
  const a = (s.agents || []).find(x => x.id === to || x.name === to);
  return a ? a.label : to;
}

function wtsPanel(s) {
  const w = s.wts;
  if (!w) return `<div class="empty-note">${esc(s.project)} has no worker queue (.autopilot/worker/queue.md).</div>`;
  if (w.error) return `<div class="alert amber"><div class="at">WTS could not be read</div><div class="ad">${esc(w.error)}</div></div><pre class="said">${esc(w.raw || '')}</pre>`;
  const now = S.model.now, win = w.window || {};
  const agents = new Map((s.agents || []).map(a => [a.id, a]));
  const nm = id => id === 'lead' ? 'lead' : (agents.get(id)?.label || '?');
  let h = `<div class="winrow ${win.held ? 'c-red' : 'c-green'}">${icon(win.held ? 'i-lock' : 'i-unlock')}<span class="w">${win.held
    ? `Window held by <b>${esc(shortWho(win.who))}</b> since ${hhmm(win.since, 1)} (${dur(now - (win.since || now))})${win.holder ? ' · ' + esc(nm(win.holder)) : ''}`
    : 'Window free'}${(win.waiters || []).length ? ' · waiting: ' + win.waiters.map(id => esc(nm(id))).join(', ') : ''}</span></div>`;
  const counts = ['HP', 'MP', 'LP'].map(g => `<a data-jump="${g}">${g} ${(w.groups[g] || []).length}</a>`).join('');
  h += `<div class="jump">${counts}</div>`;
  const cur = +((w.state_file || '').match(/running\s+(\d+)/) || [])[1];
  for (const g of ['HP', 'MP', 'LP']) {
    const rows = w.groups[g] || [];
    const runs = [...new Set(rows.map(r => r.runs_on))];
    const head = g === 'HP' ? (w.hp_line || '').replace(/^[^\w]+/, '') : ((w.modes || {})[g] === 'desk' ? 'desk-only' : (w.modes || {})[g] || 'running');
    h += `<div class="gh" id="g-${g}">${g}<span class="gm">${esc(head)}${runs.length === 1 ? ' · ' + esc(runs[0]) : ''}</span></div>`;
    if (!rows.length) h += '<div class="empty-note">empty</div>';
    for (const r of rows) {
      const [ri, rc] = ROWKIND[r.kind] || ROWKIND.other;
      const a = r.agent ? agents.get(r.agent) : null;
      const statusText = String(r.status).replace(/^[⏩⏳✋✅⛔❓💤■\s]+/u, '');
      h += `<div class="wrow ${r.n === cur ? 'cur' : ''}${a ? ' bound' : ''}" ${a ? `data-select="${esc(a.id)}"` : ''} data-tip="${esc(r.task)}">
        <span class="n">${r.n}</span><span class="t">${esc(r.title)}</span><span class="st2 c-${rc}">${icon(ri)}${esc(statusText)}</span>`;
      if (runs.length > 1) h += `<span class="ro">${esc(r.runs_on)}</span>`;
      if (a) {
        const [ai, ac] = STATUS[a.state.key] || STATUS.unknown;
        const mismatch = (r.kind === 'active' && ['dead', 'stuck'].includes(a.state.key)) ||
          (r.kind === 'active' && a.state.key === 'ended' && now - a.state.since > 600) ||
          (['paused', 'parked'].includes(r.kind) && a.state.key === 'running' && !/window/.test(a.state.label));
        h += `<span class="obs${mismatch ? ' mismatch' : ''}">agent ${esc(a.label)}: <span class="c-${ac}">${icon(ai)}</span>${esc(a.state.label)}${mismatch ? ' · does not match the row' : ''}</span>`;
      } else if (r.kind === 'active') {
        h += `<span class="obs">no agent seen for this row</span>`;
      }
      h += '</div>';
    }
  }
  return h;
}

function liveAlerts(m) {
  const now = Date.now() / 1000;
  return (m?.alerts || []).filter(a => !(dismissed[a.key + '|' + a.title] > now));
}
function alertsPanel() {
  const m = S.model, list = liveAlerts(m);
  const nDismissed = (m.alerts || []).length - list.length;
  if (!list.length) return `<div class="empty-note">Nothing needs a look.${nDismissed ? ` (${nDismissed} dismissed)` : ''}</div>`;
  const ss = new Map((m.sessions || []).map(s => [s.id, s]));
  return list.map(a => {
    const s = ss.get(a.session);
    const agentName = a.agent && s ? (a.agent === 'lead' ? 'lead' : (s.agents || []).find(x => x.id === a.agent)?.label) : null;
    return `<div class="alert ${a.sev}"><div class="at">${esc(a.title)}<span class="tm">since ${hhmm(a.since)}</span></div>
      <div class="ad">${esc(a.detail)}</div>
      <div class="aa"><span class="proj">${esc(a.project || '')}</span>${agentName ? `<button data-select="${esc(a.agent)}" data-sid="${esc(a.session)}">show ${esc(agentName)}</button>` : ''}
      <button data-dismiss="${esc(a.key + '|' + a.title)}">Dismiss</button><button data-snooze="${esc(a.key + '|' + a.title)}">Snooze 1h</button></div></div>`;
  }).join('') + (nDismissed ? `<div class="empty-note">${nDismissed} dismissed · reset in ⚙</div>` : '');
}

$('panel').addEventListener('click', e => {
  const t = e.target.closest('[data-select],[data-dismiss],[data-snooze],[data-jump],[data-hide]');
  if (!t) return;
  if (t.dataset.hide) return hideAgents([t.dataset.hide]);
  if (t.dataset.jump) { $('g-' + t.dataset.jump)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (t.dataset.dismiss) { dismissed[t.dataset.dismiss] = 1e12; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.snooze) { dismissed[t.dataset.snooze] = Date.now() / 1000 + 3600; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.sid && t.dataset.sid !== S.sid) selectSession(t.dataset.sid);
  unhideAgents([t.dataset.select]);   // asked to see it: put it back on the diagram
  S.sel = t.dataset.select;
  if (S.tab === 'alerts') S.tab = 'agent';
  render();
  const n = S.nodes.get(S.sel);
  if (n && settings.motion !== 'off') { n.flash.classList.remove('go'); void n.flash.getBBox(); n.flash.classList.add('go'); }
});

// ---- timeline ----
const nameIn = (s, id) => id === 'lead' ? 'lead' : ((s.agents || []).find(a => a.id === id)?.label || id.slice(0, 7));
function renderTimeline(s) {
  const svg = $('tl');
  if (!s || !S.model) { svg.textContent = ''; return; }
  const W = svg.clientWidth || 800, span = settings.span, now = S.model.now, t0 = now - span, X0 = 100;
  const agents = new Map((s.agents || []).map(a => [a.id, a]));
  const lanes = S.order.filter(id => id === 'lead' || agents.has(id));
  const fin = (s.agents || []).filter(a => a.finished && !lanes.includes(a.id) && !(a.id in hidden)).map(a => a.id);
  const LH = 15, rows = Math.min(lanes.length + (fin.length ? 1 : 0), 14), H = rows * LH + 22;
  const x = t => X0 + (t - t0) / span * (W - X0 - 14);
  const step = span <= 900 ? 180 : span <= 2700 ? 300 : span <= 7200 ? 900 : 3600;
  let h = '';
  for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) h += `<line class="gridl" x1="${x(t)}" x2="${x(t)}" y1="2" y2="${H - 16}"/><text x="${x(t)}" y="${H - 3}" text-anchor="middle">${hhmm(t)}</text>`;
  const laneY = new Map();
  const drawLane = (key, ids, label, i, cls) => {
    const y = 10 + i * LH;
    ids.forEach(id => laneY.set(id, y));
    h += `<text class="lane-l${ids.includes(S.sel) ? ' sel' : ''}" data-lane="${esc(ids[0])}" x="0" y="${y + 4}">${esc(clip(label, 13))}</text><line class="lane" x1="${X0}" x2="${W - 14}" y1="${y}" y2="${y}"/>`;
    const bins = new Map();
    for (const id of ids) for (const [t, tool] of (s.events || {})[id] || []) {
      if (t < t0) continue;
      const b = Math.floor(x(t) / 3);
      const v = bins.get(b) || { n: 0, tool, t };
      v.n++; v.tool = tool; v.t = t; bins.set(b, v);
    }
    for (const [b, v] of bins) {
      const cl = `ev-${toolCls(v.tool)}${cls ? ' ' + cls : ''}`;
      h += v.n > 1 ? `<rect class="${cl}" x="${b * 3}" y="${y - 4}" width="3" height="8" rx="1"><title>${v.n} calls · ${hhmm(v.t, 1)}</title></rect>`
        : `<circle class="${cl}" cx="${b * 3 + 1.5}" cy="${y}" r="2.8"><title>${hhmm(v.t, 1)} ${esc(v.tool)}</title></circle>`;
    }
    for (const id of ids) {
      const n = id === 'lead' ? s.lead : agents.get(id);
      for (const c of (n && n.compactions) || []) if (c >= t0) h += `<path class="cmp" d="M${x(c) - 4},${y - 7}h8l-4,6z"><title>compacted ${hhmm(c, 1)}</title></path>`;
    }
  };
  lanes.slice(0, fin.length ? 13 : 14).forEach((id, i) => drawLane(id, [id], id === 'lead' ? 'lead' : agents.get(id).label, i, agents.get(id)?.finished ? 'fin' : ''));
  if (fin.length) drawLane('fin', fin, `finished (${fin.length})`, Math.min(lanes.length, 13), 'fin');
  for (const m of s.messages || []) {
    if (m.t < t0) continue;
    const y1 = laneY.get(m.from), y2 = laneY.get(m.to);
    if (y1 == null || y2 == null || y1 === y2) continue;
    const xx = x(m.t);
    // a bow from the sender's lane that lands on the receiver's lane with an arrowhead
    h += `<path class="arc${m.from === S.sel || m.to === S.sel ? ' sel' : ''}" marker-end="url(#tlArrow)" d="M${xx},${y1} Q${xx + 14},${(y1 + y2) / 2} ${xx},${y2 - Math.sign(y2 - y1) * 1.5}"><title>${hhmm(m.t, 1)} ${esc(nameIn(s, m.from))} → ${esc(nameIn(s, m.to))}: ${esc(m.summary)}</title></path>`;
  }
  h += `<line class="now" x1="${W - 14}" x2="${W - 14}" y1="2" y2="${H - 16}"/>`;
  // drawn in CSS pixels (W is its own width); its height eases, so the graph above resizes smoothly, never in a jump
  svg.removeAttribute('viewBox'); svg.style.height = H + 'px';
  svg.innerHTML = '<defs><marker id="tlArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto"><path class="tl-ah" d="M0,0L10,5L0,10z"/></marker></defs>' + h;
  const nEv = lanes.concat(fin).reduce((k, id) => k + ((s.events || {})[id] || []).filter(e => e[0] >= t0).length, 0);
  setT($('tlTitle'), `${s.project} · last ${dur(span)} · ${nEv} tool calls · ${(s.messages || []).filter(m => m.t >= t0).length} messages`);
}
$('tl').addEventListener('click', e => { const l = e.target.closest('[data-lane]'); if (l && l.dataset.lane !== 'fin') select(l.dataset.lane); });
new ResizeObserver(() => { if (S.model) renderTimeline(cur()); }).observe($('tl'));

// ---- tooltip: one shared div ----
let tipTimer = 0;
function showTip(anchor, text) {
  if (!text) return;
  S.tipAnchor = anchor;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    const t = $('tip'), r = anchor.getBoundingClientRect();
    t.textContent = text; t.hidden = false;
    const tw = t.offsetWidth, th = t.offsetHeight;
    let x = r.right + 8, y = r.top;
    if (x + tw > innerWidth - 8) x = Math.max(8, r.left - tw - 8);
    if (y + th > innerHeight - 8) y = innerHeight - th - 8;
    t.style.left = x + 'px'; t.style.top = Math.max(8, y) + 'px';
  }, 150);
}
function hideTip() { clearTimeout(tipTimer); $('tip').hidden = true; S.tipAnchor = null; }
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (t && !t.closest('#graph')) showTip(t, t.dataset.tip);
});
document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) hideTip(); });

// ---- notifications: once per new red alert, only while the tab is hidden ----
function notify(m) {
  for (const a of m.alerts || []) {
    const red = a.sev === 'red' || a.key.startsWith('asks:');
    if (!red || S.notified.has(a.key)) continue;
    S.notified.add(a.key);
    if (S.first || !settings.notify || !document.hidden || dismissed[a.key + '|' + a.title] > Date.now() / 1000) continue;
    try { if (Notification.permission === 'granted') new Notification(`ccprobe · ${a.project || ''}`, { body: a.title, tag: a.key }); } catch (e) { /* no notifications here */ }
  }
  const live = new Set((m.alerts || []).map(a => a.key));
  for (const k of [...S.notified]) if (!live.has(k)) S.notified.delete(k);   // it may fire again if it comes back
}

// ---- settings popover ----
function syncSettingsUi() {
  document.querySelectorAll('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => {
    const on = String(settings[seg.dataset.set]) === b.dataset.v;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  }));
  document.querySelectorAll('input[data-set]').forEach(i => { i.checked = !!settings[i.dataset.set]; });
}
document.addEventListener('click', e => {
  const b = e.target.closest('.seg[data-set] button');
  if (b) {
    const k = b.closest('.seg').dataset.set;
    settings[k] = k === 'span' ? +b.dataset.v : b.dataset.v;
    saveSettings(); applyTheme(); syncSettingsUi();
    if (S.model) { if (k === 'motion') clearGraph(); render(); }
    return;
  }
  const pop = $('settings');
  if (e.target.closest('#gearBtn')) { pop.hidden = !pop.hidden; $('gearBtn').setAttribute('aria-expanded', String(!pop.hidden)); syncSettingsUi(); return; }
  if (!pop.hidden && !e.target.closest('#settings')) { pop.hidden = true; $('gearBtn').setAttribute('aria-expanded', 'false'); }
});
document.querySelectorAll('input[data-set]').forEach(i => i.addEventListener('change', async () => {
  const k = i.dataset.set;
  settings[k] = i.checked;
  if (k === 'notify' && i.checked) {
    try {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { settings.notify = false; i.checked = false; $('popFoot').textContent = 'Notifications are blocked for this page in the browser settings.'; }
    } catch (e) { settings.notify = false; i.checked = false; }
  }
  saveSettings(); applyTheme();
  if (S.model) render();
}));
$('resetBtn').addEventListener('click', () => {
  dismissed = {}; store.set('ccprobe.dismissed', dismissed);
  hidden = {}; store.set('ccprobe.hidden', hidden);
  railOrder = { v: 1, keys: [] }; store.set('ccprobe.railOrder', railOrder); S.railForce = true;
  resetSplitters();
  S.expandFinished = false; S.userPanned = false;
  if (S.model) { clearGraph(); render(); }
});

// ---- keyboard ----
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') { if (!$('settings').hidden) $('settings').hidden = true; else select('lead'); }
  else if (e.key === 'f' || e.key === 'F') doFit();
  else if (e.key === 'h' || e.key === 'H' || e.key === 'Delete' || e.key === 'Backspace') {
    const s = cur(), n = s && S.sel !== 'lead' ? nodeById(s, S.sel) : null;
    if (canHide(n)) { e.preventDefault(); hideAgents([n.id]); }
  }
  else if (e.key === '1' || e.key === '2' || e.key === '3') { S.tab = ['agent', 'wts', 'alerts'][+e.key - 1]; renderPanel(); }
  else if (e.key === '[' || e.key === ']') {
    const ss = [...$('railList').children].map(b => b.dataset.sid); const i = ss.indexOf(S.sid);   // as shown
    if (ss.length) selectSession(ss[(i + (e.key === ']' ? 1 : -1) + ss.length) % ss.length]);
  }
});

// ---- splitters: drag to resize the sessions panel (left) and the side panel (right); widths are kept in settings ----
const STAGE_MIN = 360;   // the graph keeps at least this much between the two panels
function splitter(id, { cssVar, key, min, def, frac, left }) {
  const sp = $(id);
  const width = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || def;
  const other = () => (left ? sideW : railW)();
  const set = (w, save) => {
    const max = Math.max(min, Math.round(Math.min(innerWidth * frac, innerWidth - other() - STAGE_MIN - 14)));
    w = Math.round(Math.min(max, Math.max(min, w)));
    document.documentElement.style.setProperty(cssVar, w + 'px');   // CSSOM: allowed by the CSP
    sp.setAttribute('aria-valuenow', w); sp.setAttribute('aria-valuemin', min); sp.setAttribute('aria-valuemax', max);
    if (save) { settings[key] = w; saveSettings(); }
    return w;
  };
  const at = x => left ? x : innerWidth - x;   // the panel's width if its edge sat at x
  sp.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const grab = at(ev.clientX) - width();   // keep the pointer where it took hold
    sp.setPointerCapture(ev.pointerId);
    sp.classList.add('drag'); document.body.classList.add('resizing'); hideTip();
    const move = e => set(at(e.clientX) - grab, false);
    const up = e => {
      sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
      sp.classList.remove('drag'); document.body.classList.remove('resizing');
      set(at(e.clientX) - grab, true);
      if (S.model) renderTimeline(cur());
    };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('dblclick', () => set(def, true));
  sp.addEventListener('keydown', e => {
    const step = (e.shiftKey ? 80 : 20) * (left ? 1 : -1);   // the arrow points the way the edge moves
    if (e.key === 'ArrowRight') { e.preventDefault(); set(width() + step, true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); set(width() - step, true); }
    else if (e.key === 'Home') { e.preventDefault(); set(def, true); }
  });
  return { set, width, def, key };
}
const SIDE = splitter('splitter', { cssVar: '--side-w', key: 'sideW', min: 280, def: 380, frac: .6, left: false });
const RAIL = splitter('splitterL', { cssVar: '--rail-w', key: 'railW', min: 160, def: 230, frac: .35, left: true });
function sideW() { return SIDE.width(); }
function railW() { return RAIL.width(); }
const resetSplitters = () => { RAIL.set(RAIL.def, true); SIDE.set(SIDE.def, true); };
addEventListener('resize', () => { RAIL.set(settings.railW || RAIL.def, false); SIDE.set(settings.sideW || SIDE.def, false); });   // re-clamp to the new window
RAIL.set(settings.railW || RAIL.def, false); SIDE.set(settings.sideW || SIDE.def, false);

applyTheme();
syncSettingsUi();
const hashTab = (location.hash.match(/tab=(agent|wts|alerts)/) || [])[1];
if (hashTab) S.tab = hashTab;
if (/\bpoll\b/.test(location.hash)) startPolling(); else connect();   // #poll: plain polling (headless checks, odd proxies)
