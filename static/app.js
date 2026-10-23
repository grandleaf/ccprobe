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
  waiting_user: ['i-ask', 'rose'], shell: ['i-wait', 'slate'], unknown: ['i-wait', 'slate'],
};
const ROWKIND = {
  active: ['i-run', 'green'], queued: ['i-wait', 'slate'], paused: ['i-park', 'amber'], parked: ['i-park', 'amber'],
  asks: ['i-ask', 'rose'], done: ['i-done', 'green'], closed: ['i-done', 'slate'], other: ['i-wait', 'slate'],
};
const ROLECOL = { lead: 'cyan', worker: 'amber', mp: 'green', lp: 'rose', helper: 'violet' };
const TOOLS = new Set(['Bash', 'Read', 'Edit', 'Write', 'SendMessage', 'Agent']);
const toolCls = t => TOOLS.has(t) ? t : (t === 'MultiEdit' || t === 'NotebookEdit' ? 'Edit' : 'other');
const icon = (id, cls = 'ico12') => `<svg class="${cls}"><use href="#${id}"/></svg>`;

// ---- settings (localStorage, every access guarded) ----
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window: settings last for this visit */ } },
};
const reducedOS = matchMedia('(prefers-reduced-motion: reduce)').matches;
const settings = Object.assign({ v: 1, theme: 'system', motion: reducedOS ? 'reduced' : 'full', span: 2700, showFinished: true, compact: false, notify: false },
  store.get('ccprobe.settings', {}));
const saveSettings = () => store.set('ccprobe.settings', settings);
let dismissed = store.get('ccprobe.dismissed', {});    // alert key+title -> until (epoch s; 1e12 = for good)

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

// ---- rail ----
function renderRail(m) {
  const ss = m?.sessions || [];
  const alerts = liveAlerts(m);
  let h = `<div class="rail-h">${ss.length} session${ss.length === 1 ? '' : 's'} · ${ss.filter(s => s.tmux).length} in tmux</div>`;
  for (const s of ss) {
    const na = (s.agents || []).filter(a => !a.finished).length;
    const nal = alerts.filter(a => a.session === s.id && a.sev !== 'info').length;
    const st = s.alive ? s.status : 'dead';
    h += `<button class="sess ${s.id === S.sid ? 'on' : ''}" data-sid="${esc(s.id)}">
      <div class="n"><span class="st ${esc(st)}"></span><span class="nm">${esc(s.project)}</span>${nal ? `<span class="b alert">${nal}</span>` : na ? `<span class="b">${na} agent${na > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="m">${esc(s.lead?.state?.label || st)} · ${ago(s.lead?.state?.since || s.status_since, m.now)}</div>
      <div class="m">${s.tmux ? 'tmux ' + esc(s.tmux.session) + ':' + esc(s.tmux.pane) : 'not in tmux'} · v${esc(s.version)}</div></button>`;
  }
  if ($('rail').innerHTML !== h) $('rail').innerHTML = h;
}
$('rail').addEventListener('click', e => {
  const b = e.target.closest('.sess'); if (!b) return;
  selectSession(b.dataset.sid);
});
function selectSession(sid) {
  if (sid === S.sid) return;
  S.sid = sid; store.set('ccprobe.sid', sid); S.sel = 'lead'; S.userPanned = false; S.expandFinished = false;
  clearGraph(); render();
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
    if (a.finished && !settings.showFinished) continue;
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
}

function renderGraph(s) {
  const now = S.model.now;
  const nodes = buildNodes(s);
  const { pos, res } = layout(nodes, s);
  S.pos = pos;
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (!byId.has(S.sel) || byId.get(S.sel).collapsed) S.sel = 'lead';
  const alertsBy = new Map();
  for (const a of liveAlerts(S.model)) if (a.session === s.id && a.agent && a.sev !== 'info') alertsBy.set(a.agent, (alertsBy.get(a.agent) || 0) + 1);

  const boxes = [];   // obstacles for card placement and the fit box
  const seen = new Set();
  for (const n of nodes) {
    if (n.collapsed) continue;
    const p = pos.get(n.id); if (!p) continue;
    seen.add(n.id);
    let parts = S.nodes.get(n.id);
    if (!parts) { parts = makeNode(n.id); S.nodes.set(n.id, parts); }
    const lb = updateNode(parts, n, p, now, alertsBy.get(n.id) || 0);
    p.top = p.y - lb[0].y; p.bottom = lb[1].y + lb[1].h - p.y;
    boxes.push(...lb);
  }
  for (const [id, parts] of S.nodes) if (!seen.has(id)) { parts.g.remove(); S.nodes.delete(id); S.prevState.delete(id); }

  // resources: the collapsed-finished chip, the HP queue and the window
  const resSeen = new Set();
  const w = s.wts && !s.wts.error ? s.wts : null;
  if (res.collapsed.length) {
    const p = { x: pos.get('lead').x - 260, y: 110 };
    resSeen.add('_fin');
    boxes.push(drawChip(p, `✓ ${res.collapsed.length} finished · show`));
  }
  const worker = nodes.find(n => n.role === 'worker' && pos.has(n.id));
  if (w) {
    const hp = (w.groups.HP || []).filter(r => ['queued', 'active', 'paused', 'parked', 'asks', 'other'].includes(r.kind));
    const next = (w.groups.HP || []).find(r => r.kind === 'queued');
    const qx = worker ? pos.get(worker.id).x - 330 : 120;
    const qy = worker ? pos.get(worker.id).y : res.y;
    resSeen.add('_queue');
    boxes.push(drawRes('_queue', { x: qx, y: qy }, 'amber', 'i-queue', `HP queue · ${hp.length} open`,
      next ? clip(`next ${next.n} · ${next.title}`, 36) : 'nothing queued',
      `MP ${(w.groups.MP || []).filter(r => r.kind !== 'done').length} · LP ${(w.groups.LP || []).filter(r => r.kind !== 'done').length} open`));
    const win = w.window || {};
    const holderPos = win.holder && pos.get(win.holder);
    const wx = holderPos ? holderPos.x - 230 : 550;
    const waiters = (win.waiters || []).map(id => byId.get(id)?.label).filter(Boolean);
    resSeen.add('_window');
    boxes.push(drawRes('_window', { x: wx, y: res.y }, win.held ? 'red' : 'green', win.held ? 'i-lock' : 'i-unlock',
      `Window · ${w.lock_name || 'lock'}`, win.held ? clip(`${shortWho(win.who)} · ${dur(now - (win.since || now))}`, 38) : 'free',
      waiters.length ? clip('waiting: ' + waiters.join(', '), 38) : ''));
  }
  for (const [id, r] of S.res) if (!resSeen.has(id)) { r.g.remove(); S.res.delete(id); }

  // edges
  const eSeen = new Set();
  const nodePos = id => pos.get(id) || (S.res.has(id) ? S.res.get(id).anchor : null);
  for (const e of s.edges || []) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    drawEdge(e.key, a, b, `edge ${e.kind}${e.hot ? ' hot' : ''}`, e.kind === 'task' && byId.get(e.to)?.task ? `task ${byId.get(e.to).task}` : '', eSeen);
  }
  if (w && w.window && w.window.held && w.window.holder && pos.get(w.window.holder)) {
    drawEdge('lock', pos.get(w.window.holder), nodePos('_window'), 'edge lock', '', eSeen);
  }
  if (w && worker && S.res.has('_queue')) drawEdge('queue', nodePos('_queue'), pos.get(worker.id), 'edge', '', eSeen);
  for (const [k, e] of S.edges) if (!eSeen.has(k)) { e.g.remove(); S.edges.delete(k); }

  placeCards(nodes, pos, boxes, now);
  fit(boxes);
}

function makeNode(id) {
  const g = el('g', { class: 'node', tabindex: 0, role: 'button' }, $('gNodes'));
  const p = { g };
  p.halo = el('circle', { class: 'halo' }, g);
  p.flash = el('polygon', { class: 'flash' }, g);
  p.arc = el('circle', { class: 'arc' }, g);
  p.hex = el('polygon', { class: 'hex' }, g);
  p.selring = el('polygon', { class: 'selring' }, g);
  p.mark = el('use', {}, g); p.mark.setAttribute('class', 'mark');
  p.pill = el('g', { class: 'pill' }, g); p.pillR = el('rect', { rx: 10, height: 20 }, p.pill); p.pillT = el('text', {}, p.pill);
  p.lbl = el('text', { class: 'lbl' }, g);
  p.sub = el('text', { class: 'sub' }, g);
  p.stat = el('g', { class: 'stat' }, g); p.sico = el('use', { width: 12, height: 12 }, p.stat); p.stxt = el('text', {}, p.stat);
  p.barbg = el('rect', { class: 'barbg', height: 4, rx: 2 }, g); p.bar = el('rect', { class: 'bar', height: 4, rx: 2 }, g);
  p.meta = el('text', { class: 'meta' }, g);
  p.badge = el('g', { class: 'badge' }, g); el('circle', { r: 8 }, p.badge); p.badgeT = el('text', { y: 4 }, p.badge);
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
  const active = ['running', 'thinking', 'polling'].includes(st.key) || (n.role === 'lead' && st.key !== 'waiting_user' && st.key !== 'dead' && st.key !== 'shell');
  const col = n.role === 'lead' ? 'cyan' : ROLECOL[n.role] || 'violet';
  p.g.setAttribute('class', `node c-${col}${active ? ' active' : ''}${isParked(n) ? ' parked' : ''}${n.finished ? ' finished' : ''}${S.sel === n.id ? ' sel' : ''}`);
  setA(p.g, { transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, 'aria-label': `${n.label}, ${st.label}${n.task ? ', task ' + n.task : ''}` });
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
  // context pill: only when it matters (>= 70 %)
  const pct = n.ctx_max ? n.ctx / n.ctx_max : 0;
  const lvl = pct >= .9 ? 'crit' : pct >= .8 ? 'warn' : '';
  p.pill.style.display = pct >= .7 ? '' : 'none';
  p.pill.setAttribute('class', `pill ${lvl || 'warn'}`);
  setA(p.pillR, { x: -32, y: -r - 34, width: 64 });
  setA(p.pillT, { x: 0, y: -r - 20 }); setT(p.pillT, Math.round(pct * 100) + '% ctx');
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

function drawRes(id, p, col, ico, h, s1, s2) {
  let r = S.res.get(id);
  if (!r) {
    const g = el('g', { class: 'res' }, $('gNodes'));
    r = { g, box: el('rect', { class: 'box', rx: 8 }, g), ico: el('use', { class: 'ico', width: 14, height: 14 }, g),
      h: el('text', { class: 'h' }, g), s1: el('text', { class: 's' }, g), s2: el('text', { class: 's' }, g) };
    S.res.set(id, r);
  }
  const lines = [s1, s2].filter(Boolean);
  const wdt = Math.max(textW(h, 12.5) + 30, ...lines.map(l => textW(l, 11))) + 26, hgt = 30 + lines.length * 16;
  const x = p.x - wdt / 2, y = p.y - hgt / 2;
  r.g.setAttribute('class', `res c-${col}`);
  setA(r.box, { x, y, width: wdt, height: hgt });
  setA(r.ico, { href: '#' + ico, x: x + 12, y: y + 9 });
  setA(r.h, { x: x + 32, y: y + 21 }); setT(r.h, h);
  setA(r.s1, { x: x + 12, y: y + 39 }); setT(r.s1, s1 || '');
  setA(r.s2, { x: x + 12, y: y + 55 }); setT(r.s2, s2 || '');
  r.anchor = { x: p.x, y: p.y, r: Math.min(wdt, hgt) / 2 + 2, rect: { x, y, w: wdt, h: hgt } };
  return { x: x - 8, y: y - 8, w: wdt + 16, h: hgt + 16 };
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
  setA(r.box, { x: p.x - w / 2, y: p.y - 13, width: w, height: 26 });
  setA(r.t, { x: p.x - w / 2 + 12, y: p.y + 4 }); setT(r.t, text);
  r.anchor = { x: p.x, y: p.y, r: 14 };
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
  if (!a || !b) return;
  seen.add(key);
  let e = S.edges.get(key);
  if (!e) {
    const g = el('g', {}, $('gEdges'));
    e = { g, path: el('path', {}, g), lbl: el('text', { class: 'elbl' }, g) };
    S.edges.set(key, e);
  }
  const bend = key === 'lock' || key === 'queue' ? 0 : ((hash(key) % 2) ? .07 : -.07);
  const { d, mid } = edgePath(a, b, bend);
  setA(e.path, { d });
  if (!e.path.classList.contains('flashy')) e.path.setAttribute('class', cls);
  setA(e.path, { 'marker-end': /\btask\b/.test(cls) ? 'url(#arrTask)' : 'none' });
  e.cls = cls;
  setA(e.lbl, { x: mid.x + 8, y: mid.y - 6 }); setT(e.lbl, label);
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
  for (const [k, c] of S.cards) if (!seen.has(k)) { c.g.remove(); c.t.remove(); S.cards.delete(k); }
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
  let k = S.cards.get(c.key);
  const sig = c.lines.join('\n') + '|' + spot.x.toFixed(0) + ',' + spot.y.toFixed(0);
  if (k && k.sig === sig) return;
  if (k) { k.g.remove(); k.t.remove(); }
  const g = el('g', { class: `card ${c.kind} c-${col}` }, $('gCards'));
  el('rect', { x: spot.x, y: spot.y, width: spot.w, height: spot.h, rx: 7 }, g);
  let y = spot.y + 18;
  if (c.head) { const t = el('text', { x: spot.x + 11, y, class: 'k' }, g); t.textContent = c.head; y += 16; }
  for (const line of c.lines) { const t = el('text', { x: spot.x + 11, y }, g); t.textContent = line; y += 16; }
  // a thin tether from the node's edge to the card
  const cx = Math.max(spot.x, Math.min(p.x, spot.x + spot.w)), cy = Math.max(spot.y, Math.min(p.y, spot.y + spot.h));
  const dx = cx - p.x, dy = cy - p.y, L = Math.hypot(dx, dy) || 1;
  const t = el('line', { x1: p.x + dx / L * (p.r + 6), y1: p.y + dy / L * (p.r + 6), x2: cx, y2: cy, class: 'tether' }, $('gTethers'));
  t.setAttribute('class', `tether c-${col}`);
  g.addEventListener('mouseenter', () => showTip(g, c.kind === 'bubble' ? c.node.said : c.node.state.detail));
  g.addEventListener('mouseleave', hideTip);
  S.cards.set(c.key, { g, t, sig });
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
  S.vb = vb; applyVb();
  $('fitBtn').hidden = true;
}
function applyVb() { const v = S.vb; $('graph').setAttribute('viewBox', `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`); }
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
  S.userPanned = true; applyVb(); $('fitBtn').hidden = false;
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
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; svg.classList.add('panning'); }
  if (!drag.moved) return;
  S.vb = { ...drag.vb, x: drag.vb.x - dx * s, y: drag.vb.y - dy * s };
  S.userPanned = true; applyVb(); $('fitBtn').hidden = false;
});
$('graph').addEventListener('pointerup', ev => {
  $('graph').classList.remove('panning');
  if (drag && !drag.moved && !ev.target.closest('.node')) select('lead');
  drag = null;
});
$('graph').addEventListener('dblclick', ev => { if (!ev.target.closest('.node')) doFit(); });
$('fitBtn').addEventListener('click', doFit);
function doFit() { S.userPanned = false; if (S.fitVb) { S.vb = S.fitVb; applyVb(); } $('fitBtn').hidden = true; }

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
  const fromPos = S.pos.get(m.from);
  const L = e.path.getTotalLength(), p0 = e.path.getPointAtLength(0);
  const rev = fromPos ? Math.hypot(p0.x - fromPos.x, p0.y - fromPos.y) > Math.hypot(e.path.getPointAtLength(L).x - fromPos.x, e.path.getPointAtLength(L).y - fromPos.y) : !forward;
  S.pulses.push({ e, dot, halo, t0: performance.now(), rev, extra: 0, ang: 0 });
  if (!S.raf) S.raf = requestAnimationFrame(stepPulses);
}
function stepPulses(now) {
  S.raf = 0;
  if (document.hidden) { for (const p of S.pulses) { p.dot.remove(); p.halo.remove(); } S.pulses = []; return; }
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
  if (S.pulses.length) S.raf = requestAnimationFrame(stepPulses);
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
  if (!document.hidden && S.away) {
    const t = $('ticker');
    t.innerHTML = `<span class="who">+${S.away} event${S.away > 1 ? 's' : ''} while away</span><span class="what">see the timeline and the agents' messages</span>`;
    t.hidden = false; t.classList.remove('fade');
    clearTimeout(tickerTimer); tickerTimer = setTimeout(() => t.classList.add('fade'), 10000);
    S.away = 0;
  }
});

// ---- selection and the side panel ----
function select(id) { S.sel = id; if (S.tab !== 'agent' && S.tab !== 'wts') S.tab = 'agent'; render(); }
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
  const t = e.target.closest('[data-select],[data-dismiss],[data-snooze],[data-jump]');
  if (!t) return;
  if (t.dataset.jump) { $('g-' + t.dataset.jump)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (t.dataset.dismiss) { dismissed[t.dataset.dismiss] = 1e12; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.snooze) { dismissed[t.dataset.snooze] = Date.now() / 1000 + 3600; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.sid && t.dataset.sid !== S.sid) selectSession(t.dataset.sid);
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
  const fin = (s.agents || []).filter(a => a.finished && !lanes.includes(a.id)).map(a => a.id);
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
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
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
function hideTip() { clearTimeout(tipTimer); $('tip').hidden = true; }
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
  document.querySelectorAll('.seg[data-set]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(settings[seg.dataset.set]) === b.dataset.v)));
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
  if (S.model) { clearGraph(); render(); }
}));
$('resetBtn').addEventListener('click', () => {
  dismissed = {}; store.set('ccprobe.dismissed', dismissed);
  setSideW(SIDE_DEFAULT, true);
  S.expandFinished = false; S.userPanned = false;
  if (S.model) { clearGraph(); render(); }
});

// ---- keyboard ----
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') { if (!$('settings').hidden) $('settings').hidden = true; else select('lead'); }
  else if (e.key === 'f' || e.key === 'F') doFit();
  else if (e.key === '1' || e.key === '2' || e.key === '3') { S.tab = ['agent', 'wts', 'alerts'][+e.key - 1]; renderPanel(); }
  else if (e.key === '[' || e.key === ']') {
    const ss = S.model?.sessions || []; const i = ss.findIndex(s => s.id === S.sid);
    if (ss.length) selectSession(ss[(i + (e.key === ']' ? 1 : -1) + ss.length) % ss.length].id);
  }
});

// ---- splitter: drag to resize the side panel (its width is remembered in settings) ----
const SIDE_MIN = 280, SIDE_DEFAULT = 380;
function setSideW(w, save) {
  const max = Math.max(SIDE_MIN, Math.round(innerWidth * 0.6));
  w = Math.round(Math.min(max, Math.max(SIDE_MIN, w)));
  document.documentElement.style.setProperty('--side-w', w + 'px');   // CSSOM: allowed by the CSP
  $('splitter').setAttribute('aria-valuenow', w);
  $('splitter').setAttribute('aria-valuemax', max);
  if (save) { settings.sideW = w; saveSettings(); }
  return w;
}
const sideW = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10) || SIDE_DEFAULT;
$('splitter').addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const sp = $('splitter'), grab = innerWidth - ev.clientX - sideW();   // keep the pointer where it took hold
  sp.setPointerCapture(ev.pointerId);
  sp.classList.add('drag'); document.body.classList.add('resizing'); hideTip();
  const move = e => setSideW(innerWidth - e.clientX - grab, false);
  const up = e => {
    sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
    sp.classList.remove('drag'); document.body.classList.remove('resizing');
    setSideW(innerWidth - e.clientX - grab, true);
    if (S.model) renderTimeline(cur());
  };
  sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
});
$('splitter').addEventListener('dblclick', () => setSideW(SIDE_DEFAULT, true));
$('splitter').addEventListener('keydown', e => {
  const step = e.shiftKey ? 80 : 20;
  if (e.key === 'ArrowLeft') { e.preventDefault(); setSideW(sideW() + step, true); }        // the panel grows to the left
  else if (e.key === 'ArrowRight') { e.preventDefault(); setSideW(sideW() - step, true); }
  else if (e.key === 'Home') { e.preventDefault(); setSideW(SIDE_DEFAULT, true); }
});
addEventListener('resize', () => setSideW(settings.sideW || SIDE_DEFAULT, false));   // re-clamp to the new window
setSideW(settings.sideW || SIDE_DEFAULT, false);

applyTheme();
syncSettingsUi();
const hashTab = (location.hash.match(/tab=(agent|wts|alerts)/) || [])[1];
if (hashTab) S.tab = hashTab;
if (/\bpoll\b/.test(location.hash)) startPolling(); else connect();   // #poll: plain polling (headless checks, odd proxies)
