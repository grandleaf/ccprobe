'use strict';
// ccprobe page: draws the model the server streams (DESIGN.md §9). Read-only; all state is in memory or localStorage.

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = (t, sec) => t ? new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined }) : '—';
const dur = s => { s = Math.max(0, Math.round(s)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 86400)}d`; };
const ago = (t, now) => !t ? '—' : (now - t < 45 ? 'just now' : dur(now - t) + ' ago');
const kfmt = n => n >= 1e6 ? parseFloat((n / 1e6).toFixed(2)) + 'M' : Math.round(n / 1e3) + 'k';
// token counts: never more than 5 characters (940 · 4.2k · 88k · 6.8M · 244M · 3.4B), exact values go in tooltips
const tfmt = n => {
  n = Math.round(n || 0);
  if (n < 1000) return String(n);
  for (const [d, u] of [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']]) { const x = n / d; if (x < 999.5 || u === 'B') return (x < 99.95 ? x.toFixed(1) : Math.round(x)) + u; }
};
const exact = n => Math.round(n || 0).toLocaleString('en-US').replace(/,/g, '\u2009');
const modelName = m => (m || '').replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase());
const clip = (s, n) => { s = String(s ?? ''); if (s.length <= n) return s; let c = s.slice(0, n - 1); const sp = c.lastIndexOf(' '); if (sp > n * .6) c = c.slice(0, sp); return c.trimEnd() + '…'; };

// ---- status vocabulary: one mapping, icons from the sprite (no emoji in the UI chrome) ----
const STATUS = {
  running: ['i-run', 'green'], thinking: ['i-think', 'cyan'], polling: ['i-wait', 'slate'], waiting_window: ['i-window', 'amber'],
  ended: ['i-done', 'slate'], ended_bg: ['i-wait', 'slate'], stuck: ['i-stuck', 'amber'], dead: ['i-dead', 'red'],
  waiting_user: ['i-ask', 'rose'], idle: ['i-done', 'slate'], shell: ['i-wait', 'slate'], unknown: ['i-wait', 'slate'], parked: ['i-park', 'slate'],
};
// paused by hand (slate ⏸: stays so until someone resumes it) is not waiting (amber: it goes on by itself)
const stLook = st => st.key === 'parked' && st.sub === 'hold' ? ['i-wait', 'amber'] : STATUS[st.key] || STATUS.unknown;
const ROWKIND = {
  active: ['i-run', 'green'], queued: ['i-wait', 'slate'], paused: ['i-park', 'slate'], parked: ['i-wait', 'amber'],
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
const settings = Object.assign({ v: 1, theme: 'system', motion: reducedOS ? 'reduced' : 'full', span: 2700, showFinished: true, compact: false, notify: false, railSort: 'attn', hideUnseen: false, allEdges: false },
  store.get('ccprobe.settings', {}));
const saveSettings = () => store.set('ccprobe.settings', settings);
let dismissed = store.get('ccprobe.dismissed', {});    // alert key|sig -> until (epoch s; 1e12 dismissed, 2e12 cleared)
const CLEARED = 2e12;
const akey = a => a.key + '|' + (a.sig ?? a.title);
let hidden = store.get('ccprobe.hidden', {});          // agent id -> server time the user hid it from the diagram

// ---- page state ----
const S = {
  model: null, sid: store.get('ccprobe.sid', null), sel: 'lead', tab: null, lastMsgAt: 0, conn: 'connecting',
  seen: new Set(), first: true, prevState: new Map(), userPanned: false, vb: null, fitVb: null, away: 0,
  notified: new Set(), expandFinished: false, nodes: new Map(), edges: new Map(), cards: new Map(), res: new Map(),
  pos: new Map(), order: [], pulses: [], raf: 0, panelHtml: '', authFailed: false, det: null, open: {}, foldPref: store.get('ccprobe.folds', {}), gone: new Map(), alUndo: null,
  tokKind: store.get('ccprobe.tokKind', 'out'), tokAll: false, tokHold: false, tokOrder: { agents: [], tasks: [] },
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
  pruneDismissed(m);
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
    const [hi, hc] = modeLook(hp);
    h += `<span class="chip c-${hc}">${icon(hi)}HP ${esc(hp.replace(/^[^\w]+/, ''))}</span>`;
    for (const g of ['MP', 'LP']) {
      const mode = (w.modes || {})[g] || 'running';
      const [i, c] = modeLook(mode);
      h += `<span class="chip c-${c}">${icon(i)}${g} ${mode === 'desk' ? 'desk-only' : esc(mode)}</span>`;
    }
    h += `<span class="chip c-${w.caffeinate ? 'green' : 'amber'}" data-tip="caffeinate keeps the Mac awake">${icon('i-cup')}${w.caffeinate ? 'awake' : 'may sleep'}</span>`;
  }
  const tt = m?.tokens_today;
  if (tt && tt.n) {
    const v = tt.v;
    h += `<button class="chip tok" id="tokChip" aria-haspopup="true" data-tip="${esc(`Today since 00:00 · all sessions${tt.ready ? '' : ' (still counting)'}\nOutput ${exact(v[3])} · fresh in ${tfmt(v[0] + v[1])} · cache read ${tfmt(v[2])}\n${exact(tt.n)} replies · click for each session`)}">${icon('i-tokens')}${tfmt(v[3])} out today</button>`;
  }
  if ($('chips').innerHTML !== h) $('chips').innerHTML = h;
  if (!$('tokPop').hidden) renderTokPop(m);
  const live = liveAlerts(m);
  const n = live.length;
  const mine = live.filter(a => a.session === S.sid);   // the tab counts this session's; the bell, every session's
  for (const [id, cls, list] of [['alertCount', 'count', live], ['tabCount', 'tcount', mine]]) {
    const e = $(id), k = list.length; e.hidden = !k; e.textContent = k; e.className = cls + (list.some(a => a.sev === 'red') ? ' red' : '');
  }
  document.title = (n ? `(${n}) ` : '') + 'ccprobe';
}
// today's tokens per session (the chip's popover); clicking one opens its Tokens tab
function renderTokPop(m) {
  const tt = m?.tokens_today;
  if (!tt) return;
  const ss = (m.sessions || []).filter(s => s.tokens && s.tokens.today && s.tokens.today.some(Boolean))
    .sort((a, b) => b.tokens.today[3] - a.tokens.today[3]);
  const known = [0, 0, 0, 0];
  let h = `<div class="pop-h">Tokens today <span class="pmeta">since 00:00</span></div><div class="tkpop"><span></span><span>out</span><span>in</span><span>read</span>`;
  for (const s of ss) {
    const v = s.tokens.today;
    v.forEach((x, i) => { known[i] += x; });
    h += `<button data-tksid="${esc(s.id)}">${esc(s.project)}</button><span>${tfmt(v[3])}</span><span>${tfmt(v[0] + v[1])}</span><span>${tfmt(v[2])}</span>`;
  }
  const rest = tt.v.map((x, i) => x - known[i]);
  if (rest.some(x => x > 0)) h += `<span class="pmeta" data-tip="Transcripts written today by sessions that are no longer running">other</span><span>${tfmt(rest[3])}</span><span>${tfmt(rest[0] + rest[1])}</span><span>${tfmt(rest[2])}</span>`;
  h += `<b>all</b><b>${tfmt(tt.v[3])}</b><b>${tfmt(tt.v[0] + tt.v[1])}</b><b>${tfmt(tt.v[2])}</b></div>`;
  h += `<div class="pop-foot">out: what the models wrote (thinking included) · in: input + cache writes · read: cache reads</div>`;
  if ($('tokPop').innerHTML !== h) $('tokPop').innerHTML = h;
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
    return (BUSY.includes(st.key) || s.status === 'busy' ? 2 : 3) + (unseen(s) ? .5 : 0);   // unseen after the ones on screen
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
      <div class="m">${s.tmux ? 'tmux ' + esc(s.tmux.session) + ':' + esc(s.tmux.pane) + (unseen(s) ? ' · no terminal' : '') : 'not in tmux'} · v${esc(s.version)}</div>`;
}
// a tmux session no terminal shows (its window was closed): it still runs, unseen
const unseen = s => !!s.tmux && s.tmux.attached === 0;
function renderRail(m) {
  const all = m?.sessions || [];
  // the toggle hides sessions no terminal shows, except the one you are looking at
  const ss = settings.hideUnseen ? all.filter(s => !unseen(s) || s.id === S.sid) : all;
  const ub = $('unseenBtn'), nu = all.filter(unseen).length;
  ub.classList.toggle('on', !!settings.hideUnseen); ub.setAttribute('aria-pressed', String(!!settings.hideUnseen));
  ub.dataset.tip = settings.hideUnseen ? `Show the ${nu} session${nu === 1 ? '' : 's'} with no terminal` : `Hide the ${nu} session${nu === 1 ? '' : 's'} no terminal shows (tmux window closed)`;
  const alerts = liveAlerts(m);
  const nt = all.filter(s => s.tmux).length;
  const shown = ss.length < all.length ? `${ss.length} of ${all.length}` : `${all.length}`;
  setT($('railCount'), ss.length < all.length ? shown : `${shown} session${all.length === 1 ? '' : 's'}`);   // "2 of 4": short enough for a narrow rail
  $('railCount').dataset.tip = `${shown} session${all.length === 1 ? '' : 's'} · ${nt} in tmux${all.length > ss.length ? ` · ${all.length - ss.length} with no terminal hidden` : ''}`;
  $('rail').classList.toggle('custom', settings.railSort === 'custom');
  const list = railEntries(ss);
  for (const { s, key } of list) {          // contents: every tick, each card only when its text changed
    let b = railCards.get(key);
    if (!b) { b = document.createElement('button'); b.className = 'sess'; b.setAttribute('role', 'listitem'); b.dataset.key = key; railCards.set(key, b); }
    const h = cardHtml(s, alerts, m.now);
    if (b._html !== h) { b.innerHTML = h; b._html = h; }
    b.dataset.sid = s.id; b.classList.toggle('on', s.id === S.sid); b.classList.toggle('unseen', unseen(s));
    b.setAttribute('aria-label', `${s.project}, ${s.lead?.state?.label || s.status}${unseen(s) ? ', no terminal open' : ''}`);
    if (unseen(s)) b.dataset.tip = `No terminal shows this tmux session (its window was closed). It still runs; to see it: tmux attach -t ${s.tmux.session}`;
    else delete b.dataset.tip;
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

$('unseenBtn').addEventListener('click', () => {
  settings.hideUnseen = !settings.hideUnseen; saveSettings();
  S.railForce = true; hideTip(); renderRail(S.model);
});
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
  S.sid = sid; store.set('ccprobe.sid', sid); S.sel = 'lead'; S.tab = null; S.userPanned = false; S.expandFinished = false;   // a session opens on its first tab
  clearGraph(); render();
}

// ---- hiding agents by hand: until they write anything new, then they come back by themselves ----
const BUSY = ['running', 'thinking', 'polling'];
// what "Clear N done" may hide: not the lead, nor an agent at work; a paused one (or one waiting for the window) still
// has its task in hand
const canHide = n => n && n.id !== 'lead' && n.role !== 'lead' && !BUSY.includes(n.state?.key) && !isParked(n);
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
  const win = s.wts && !s.wts.error && s.wts.window || {};
  nodes[0].holds = !!win.held && win.holder === 'lead';
  for (const a of s.agents || []) {
    if (isHidden(a) || a.finished && !settings.showFinished) continue;
    const row = a.task != null ? rowOf.get(a.task) : null;
    nodes.push(Object.assign({}, a, {
      sub: clip(a.task_title || a.desc || '', 26), rowKind: row ? row.kind : null, holds: !!win.held && win.holder === a.id,
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
const isParked = n => n.state.key === 'waiting_window' || n.state.key === 'parked' || (n.rowKind === 'paused' || n.rowKind === 'parked') && !['running', 'thinking', 'polling'].includes(n.state.key);
// why a blocked agent is not working, as [icon, colour]
const holdOf = n => n.state.key === 'waiting_window' ? STATUS.waiting_window
  : n.state.key === 'parked' ? stLook(n.state) : n.rowKind === 'paused' ? STATUS.parked : ['i-wait', 'amber'];
const radius = n => {
  const c = settings.compact;
  return n.role === 'lead' ? (c ? 40 : 52) : n.role === 'worker' ? (c ? 32 : 42) : (n.finished ? 22 : c ? 22 : 30);
};

// ---- layout: rows by role (lead · agents · helpers · finished · shelf), every agent in a sticky column ----
// Known methods, kept simple: a layered (Sugiyama-style) drawing whose order within a row is chosen to cut crossings,
// made incremental the way DynaDAG and yFiles' incremental mode are: what is on screen keeps its place, newcomers go
// into the gap that suits them best, and a freed place stays free for a while. Tidying (closing gaps, swapping
// neighbours to remove crossings) happens only at a quiet moment, or when you press Tidy.
const LEAD_X = 550, COLW = 240, MAXC = 2, Y_AGENTS = 420, ROW_GAP = 270, QUIET_MS = 120000, REORDER_MS = 300000;
// how long a place stays free after its agent went: 2 minutes, or 5 for a place with an heir (the HP worker's, a reused
// name's), so the next worker still lands where the last one was
const GHOST_MS = 120000, HEIR_MS = 300000;
const heirKey = k => k === 'worker' || k.startsWith('name:');
// rows: the lead 0; then one grid of rows 1, 1.1, 1.2 … (five slots each, columns −2…2) at fixed heights, shared by
// agents and helpers (a helper's place is under its anchor, one row down); finished 3; the shelf 4. Because every row
// has a fixed height, a new row never pushes anything.
const BAND = { lead: 0, agents: 1, finished: 3, shelf: 4 };
S.mem = new Map();   // session id -> { agents: Map(key -> {sub, col, seen}), sig, since, lastReorder }
// the place belongs to a line of succession: the HP worker's place passes to the next hp<N>, a name's to its successor
const lineage = n => n.role === 'worker' ? 'worker' : n.name ? 'name:' + n.name : n.id;
const slotKey = (sub, col) => sub + ':' + col;
function memFor(sid) {
  let m = S.mem.get(sid);
  if (!m) {
    m = { agents: new Map(), sig: '', since: performance.now(), lastReorder: 0 };
    const saved = store.get('ccprobe.layout', {})[sid];   // a reload keeps the places
    if (saved) for (const [k, sub, col] of saved.agents || []) if (Math.abs(col) <= MAXC) m.agents.set(k, { sub, col, seen: performance.now() });
    S.mem.set(sid, m);
  }
  return m;
}
function saveMem(sid, m) {
  const all = store.get('ccprobe.layout', {});
  all[sid] = { agents: [...m.agents].map(([k, e]) => [k, e.sub, e.col]), t: Date.now() };
  for (const k of Object.keys(all)) if (Date.now() - (all[k].t || 0) > 7 * 86400e3) delete all[k];
  store.set('ccprobe.layout', all);
}
// which lines count for the layout (and are drawn without a selection): see edgeShow
function layoutEdges(s, now, born) {
  return (s.edges || []).filter(e => edgeShow(e, now, born, null).show).map(e => [e.from, e.to]);
}
// lines that say something: tasks, recent messages, one agent spawning another, a newborn's spawn (2 min);
// the rest only for the selected agent
function edgeShow(e, now, born, sel, all = false) {   // all: the "Show all relationships" setting
  const age = now - (e.last || 0), talked = e.last > 0 && age < 600;
  const mine = !!sel && sel !== 'lead' && (e.from === sel || e.to === sel);
  const kind = e.kind === 'spawn' && talked ? 'msg' : e.kind;
  let show = e.kind === 'task' || talked || (e.kind === 'spawn' && e.from !== 'lead') || (e.kind === 'spawn' && now - (born.get(e.to) || 0) < 120);
  if (!show && (mine || all)) show = true;
  return { show, kind, faint: kind === 'msg' && !e.hot, dim: !!sel && sel !== 'lead' && !mine };
}
// line crossings with rows and columns: two lines between the same pair of rows cross when their ends swap order;
// two dips under one row cross when they interleave
function crossings(E, at) {
  let n = 0;
  for (let i = 0; i < E.length; i++) {
    let p = at(E[i][0]), q = at(E[i][1]); if (!p || !q) continue;
    if (p.row > q.row) [p, q] = [q, p];
    for (let j = i + 1; j < E.length; j++) {
      if (E[j][0] === E[i][0] || E[j][0] === E[i][1] || E[j][1] === E[i][0] || E[j][1] === E[i][1]) continue;
      let r = at(E[j][0]), t = at(E[j][1]); if (!r || !t) continue;
      if (r.row > t.row) [r, t] = [t, r];
      if (p.row === q.row && r.row === t.row && p.row === r.row) {
        const a = Math.min(p.col, q.col), b = Math.max(p.col, q.col), c = Math.min(r.col, t.col), d = Math.max(r.col, t.col);
        if ((a < c && c < b && b < d) || (c < a && a < d && d < b)) n++;
      } else if (p.row === r.row && q.row === t.row && p.row !== q.row && (p.col - r.col) * (q.col - t.col) < 0) n++;
    }
  }
  return n;
}
// the grid: remembered slots first; then each newcomer takes the free slot that costs least (distance from the slot it
// wants, 5 per row away from the row it wants, plus 2 per crossing it adds); the slots of agents that left stay
// reserved for GHOST_MS (HEIR_MS when a successor may come)
function placeRow(rm, members, want, E, at, now, slots, isHelper) {   // fills `slots` (id -> {sub, col}), which `at` reads
  const keyOf = new Map();
  for (const n of members.slice().sort((a, b) => (b.born || 0) - (a.born || 0))) {   // the newest of a line inherits
    const k = lineage(n);
    keyOf.set(n.id, [...keyOf.values()].includes(k) ? n.id : k);
  }
  const present = new Set(keyOf.values());
  for (const [k, e] of rm) if (!present.has(k) && now - e.seen > (heirKey(k) ? HEIR_MS : GHOST_MS)) rm.delete(k);
  const used = new Set();
  for (const n of members) {
    const e = rm.get(keyOf.get(n.id));
    if (e && !used.has(slotKey(e.sub, e.col))) { slots.set(n.id, { sub: e.sub, col: e.col }); used.add(slotKey(e.sub, e.col)); }
  }
  const ghosts = [...rm].filter(([k]) => !present.has(k)).map(([, e]) => slotKey(e.sub, e.col));
  let fresh = members.filter(n => !slots.has(n.id));
  if (!slots.size && !ghosts.length) {
    // nothing remembered (first sight): the agents in role order, rows of five centred under the lead
    const rank = { worker: 0, mp: 1, lp: 2, helper: 3 }, per = 2 * MAXC + 1;
    const first = fresh.filter(n => !isHelper(n)).sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || (a.task || 0) - (b.task || 0) || (a.born || 0) - (b.born || 0));
    first.forEach((n, i) => {
      const sub = Math.floor(i / per), inRow = Math.min(per, first.length - sub * per);
      slots.set(n.id, { sub, col: i % per - Math.floor((inRow - 1) / 2) });
    });
    fresh = fresh.filter(n => !slots.has(n.id));
  }
  for (const n of fresh.sort((a, b) => (isHelper(a) - isHelper(b)) || (a.born || 0) - (b.born || 0))) {   // helpers after their anchors
    const busy = new Set([...[...slots.values()].map(v => slotKey(v.sub, v.col)), ...ghosts]);
    const maxSub = Math.max(0, ...[...slots.values()].map(v => v.sub), ...ghosts.map(g => +g.split(':')[0]));
    const w = want(n, slots);
    let best = null;
    for (let sub = 0; sub <= Math.max(maxSub, w.sub) + 1; sub++) for (let col = -MAXC; col <= MAXC; col++) {
      if (busy.has(slotKey(sub, col))) continue;
      slots.set(n.id, { sub, col });
      const cost = Math.abs(col - w.col) + 5 * Math.abs(sub - w.sub) + 2 * crossings(E, at) + .01 * Math.abs(col);
      if (!best || cost < best.cost) best = { sub, col, cost };
    }
    slots.set(n.id, { sub: best.sub, col: best.col });
  }
  for (const n of members) { const v = slots.get(n.id); rm.set(keyOf.get(n.id), { sub: v.sub, col: v.col, seen: now }); }
  return { keyOf, ghosts: ghosts.length };
}
// close the gaps within each row, toward the one nearest the centre (nobody changes rows or sides); `fixed` slots
// (helpers under their anchors) stay where they are and are stepped over
function compactRow(rm, keys, fixed = []) {
  const rows = new Map(), held = new Set(fixed.map(e => slotKey(e.sub, e.col)));
  for (const k of keys) { const e = rm.get(k); if (!rows.has(e.sub)) rows.set(e.sub, []); rows.get(e.sub).push(e); }
  let moved = 0;
  for (const [sub, items] of rows) {
    items.sort((a, b) => a.col - b.col);
    const pivot = items.reduce((b, it, i) => Math.abs(it.col) < Math.abs(items[b].col) ? i : b, 0);
    const free = c => !held.has(slotKey(sub, c));
    let c = items[pivot].col;
    for (let i = pivot + 1; i < items.length; i++) { c++; while (!free(c)) c++; if (items[i].col !== c) { items[i].col = c; moved++; } }
    c = items[pivot].col;
    for (let i = pivot - 1; i >= 0; i--) { c--; while (!free(c)) c--; if (items[i].col !== c) { items[i].col = c; moved++; } }
  }
  return moved;
}
// swap neighbours within a row while that removes crossings; returns how many it removed
function untangleRow(rm, keyOf, members, E, at) {
  let removed = 0;
  for (let pass = 0; pass < 8; pass++) {
    const order = members.map(n => rm.get(keyOf.get(n.id))).sort((a, b) => a.sub - b.sub || a.col - b.col);
    let better = false;
    for (let i = 0; i + 1 < order.length; i++) {
      const A = order[i], B = order[i + 1];
      if (A.sub !== B.sub) continue;
      const before = crossings(E, at);
      [A.col, B.col] = [B.col, A.col];
      const after = crossings(E, at);
      if (after < before) { removed += before - after; better = true; } else [A.col, B.col] = [B.col, A.col];
    }
    if (!better) break;
  }
  return removed;
}

function layout(nodes, s) {
  const now = performance.now(), mem = memFor(s.id);
  const pos = new Map(), vis = nodes.filter(n => !n.collapsed);
  pos.set('lead', { x: LEAD_X, y: 110, r: radius(vis[0]) });
  const agents = vis.slice(1), fin = agents.filter(n => n.finished), live = agents.filter(n => !n.finished);
  const liveIds = new Set(live.map(n => n.id));
  // a helper that serves another agent on screen wants the slot under it
  const isHelper = n => n.role === 'helper' && n.anchor && n.anchor !== 'lead' && n.anchor !== n.id && liveIds.has(n.anchor);
  const born = new Map(agents.map(n => [n.id, n.born || 0]));
  const E = layoutEdges(s, S.model.now, born);
  const slot = new Map();
  const at = id => id === 'lead' ? { row: 0, col: 0 } : slot.has(id) ? { row: 1 + slot.get(id).sub / 10, col: slot.get(id).col } : null;
  const nbrs = id => E.filter(e => e[0] === id || e[1] === id).map(e => e[0] === id ? e[1] : e[0]);
  // where a newcomer wants to be: a helper under its anchor; an agent among those it talks to, else at the row's end
  const want = (n, slots) => {
    if (isHelper(n) && slots.has(n.anchor)) return { sub: slots.get(n.anchor).sub + 1, col: slots.get(n.anchor).col };
    const near = nbrs(n.id).filter(x => slots.has(x)).map(x => slots.get(x));
    if (near.length) return { sub: Math.min(...near.map(v => v.sub)), col: near.reduce((a, v) => a + v.col, 0) / near.length };
    return { sub: 0, col: n.role === 'worker' ? -MAXC : MAXC };
  };
  const g = placeRow(mem.agents, live, want, E, at, now, slot, isHelper);

  // quiet-time upkeep: once nothing has come or gone for QUIET_MS, close the gaps within rows (stepping around places
  // still held for an agent that went), put a helper left away from the agent it serves back under it, and, rarely,
  // swap neighbours that remove 2+ crossings. Tidy does it all now, held places included.
  const sig = live.map(n => n.id).sort().join();
  if (sig !== mem.sig) { mem.sig = sig; mem.since = now; }
  const quiet = now - mem.since > QUIET_MS, tidy = S.tidyNow;
  S.tidyNow = false;   // asked once, done once (never left set if anything below fails)
  const reserved = () => [...mem.agents.keys()].filter(k => ![...g.keyOf.values()].includes(k));
  const sync = () => { for (const n of live) { const e = mem.agents.get(g.keyOf.get(n.id)); if (e) slot.set(n.id, { sub: e.sub, col: e.col }); } };   // helpers being re-placed have none yet
  // a helper sits under a regular agent (helpers anchored to helpers keep their own place)
  const byId = new Map(live.map(n => [n.id, n]));
  const underAgent = n => isHelper(n) && !isHelper(byId.get(n.anchor));
  const agentKeys = live.filter(n => !isHelper(n)).map(n => g.keyOf.get(n.id));
  const helperSlots = () => live.filter(isHelper).map(n => mem.agents.get(g.keyOf.get(n.id))).filter(Boolean);
  const isAstray = n => underAgent(n) && slot.has(n.anchor) && slot.has(n.id)
    && (slot.get(n.id).sub !== slot.get(n.anchor).sub + 1 || Math.abs(slot.get(n.id).col - slot.get(n.anchor).col) > 1);
  if (tidy) {
    for (const k of reserved()) mem.agents.delete(k);
    // the agents close up first; then the helpers that serve one go back under it
    const hs = live.filter(underAgent);
    for (const n of hs) { mem.agents.delete(g.keyOf.get(n.id)); slot.delete(n.id); }
    compactRow(mem.agents, agentKeys, helperSlots()); sync();
    placeRow(mem.agents, live, want, E, at, now, slot, isHelper); sync();
  } else if (quiet) {
    compactRow(mem.agents, agentKeys, [...helperSlots(), ...reserved().map(k => mem.agents.get(k))]); sync();
    // a stray helper goes back under its agent, one at a time, and only when a place there is free (else it stays put);
    // tried at most once a minute, so a helper that cannot get there is not shuffled about
    if (mem.lastHelpers === undefined || now - mem.lastHelpers > 60000) {
      mem.lastHelpers = now;
      for (const n of live.filter(isAstray)) {
        const k = g.keyOf.get(n.id), old = mem.agents.get(k);
        mem.agents.delete(k); slot.delete(n.id);
        placeRow(mem.agents, live, want, E, at, now, slot, isHelper); sync();
        if (isAstray(n)) { mem.agents.set(k, old); slot.set(n.id, { sub: old.sub, col: old.col }); }
      }
    }
  }
  if (tidy || (quiet && now - mem.lastReorder > REORDER_MS)) {
    const saved = [...mem.agents.values()].map(e => [e, e.col]);
    const gain = untangleRow(mem.agents, g.keyOf, live, E, id => (sync(), at(id)));
    if (gain >= (tidy ? 1 : 2)) mem.lastReorder = now;
    else for (const [e, c] of saved) e.col = c;   // not worth moving anyone
    sync();
  }
  if (tidy) mem.lastReorder = now;
  // can Tidy do anything? (a gap inside a row, a reserved slot, or a helper away from its anchor)
  const rowsOf = new Map();
  for (const n of live) { if (isHelper(n)) continue; const v = slot.get(n.id); if (!rowsOf.has(v.sub)) rowsOf.set(v.sub, []); rowsOf.get(v.sub).push(v.col); }
  const gap = [...rowsOf.values()].some(c => Math.max(...c) - Math.min(...c) + 1 > c.length);
  const astray = live.some(isAstray);
  S.canTidy = gap || reserved().length > 0 || astray;
  const key = JSON.stringify([...mem.agents].map(([k, e]) => [k, e.sub, e.col]));
  if (key !== mem.savedKey) { mem.savedKey = key; saveMem(s.id, mem); }

  // rows at fixed heights from Y_AGENTS down; then finished; then the shelf
  let maxY = 110;
  for (const n of live) { const v = slot.get(n.id), y = Y_AGENTS + v.sub * ROW_GAP; pos.set(n.id, { x: LEAD_X + v.col * COLW, y, r: radius(n) }); maxY = Math.max(maxY, y); }
  let y = maxY + (maxY > 110 ? 260 : 300);
  if (fin.length) {
    fin.sort((p, q) => (p.born || 0) - (q.born || 0)).forEach((n, i) => pos.set(n.id, { x: LEAD_X + (i - (fin.length - 1) / 2) * 150, y, r: radius(n) }));
    y += 230;
  }
  // which row everything is in, for the line router
  S.band = new Map([['lead', BAND.lead]]);
  for (const n of live) S.band.set(n.id, BAND.agents + slot.get(n.id).sub / 10);
  for (const n of fin) S.band.set(n.id, BAND.finished);
  S.order = [...new Set(['lead', ...live.slice().sort((p, q) => slot.get(p.id).sub - slot.get(q.id).sub || slot.get(p.id).col - slot.get(q.id).col).map(n => n.id), ...fin.map(n => n.id)])];
  return { pos, res: { y: y - 30, collapsed: nodes.filter(n => n.collapsed) } };
}

function clearGraph() {
  for (const g of ['gEdges', 'gNodes', 'gTethers', 'gCards', 'gPulse']) $(g).textContent = '';
  S.nodes.clear(); S.edges.clear(); S.cards.clear(); S.res.clear(); S.pulses = []; S.prevState.clear();
  S.disp.clear(); S.leaving.clear(); S.vbD = null; S.fitVb = null; S.snapNext = true; S.prevCollapsed = new Set(); S.fadeUntil = 0;
  $('hiddenBtn').hidden = $('clearBtn').hidden = $('finBtn').hidden = true;   // renderGraph shows them again when they apply
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
// a node's or resource's target; a new one grows out of `from()` (its parent, or the finished button)
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
  if (d.kind === 'res') return { x: d.x, y: d.y, r: d.rr, rect: d.w ? { w: d.w, h: d.h } : null, top: (d.h || 2 * d.rr) / 2, bottom: (d.h || 2 * d.rr) / 2 };
  return { x: d.x, y: d.y, r: d.r * d.s, top: (d.top || 0) * d.s, bottom: (d.bottom || 0) * d.s, half: (d.half || d.r) * d.s };
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
    const { d, mid } = routeEdge(key, a, b, e.a, e.b, e.bend);
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
// ---- line routing: lines travel in the channels between rows and down the gaps between columns, never across an
// agent. Neighbouring rows: an S-curve from under the upper agent's labels to the top of the lower one. Same row: a dip
// into the channel below it. Rows in between: along the channel, down the nearest column gap, across, and in.
const P = p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
function curve(p0, c1, c2, p3) {
  return { d: `M${P(p0)} C${P(c1)} ${P(c2)} ${P(p3)}`, mid: { x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8 } };
}
function rounded(pts, r) {
  pts = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > .5);
  let d = `M${P(pts[0])}`, total = 0;
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], l1 = lens[i - 1], l2 = lens[i], k = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${P({ x: b.x + (a.x - b.x) / l1 * k, y: b.y + (a.y - b.y) / l1 * k })} Q${P(b)} ${P({ x: b.x + (c.x - b.x) / l2 * k, y: b.y + (c.y - b.y) / l2 * k })}`;
  }
  d += ` L${P(pts[pts.length - 1])}`;
  for (const l of lens) total += l;
  let half = total / 2, mid = pts[0];
  for (let i = 0; i < lens.length; i++) { if (half <= lens[i]) { const f = half / (lens[i] || 1); mid = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f }; break; } half -= lens[i]; }
  return { d, mid };
}
function routeEdge(key, A, B, ida, idb, bend) {
  const band = id => S.band?.get(id) ?? (S.disp.get(id)?.kind === 'res' ? BAND.shelf : null);
  const ba = band(ida), bb = band(idb);
  if (ba == null || bb == null || !S.chan) return edgePath(A, B, bend);
  const flip = ba > bb || (ba === bb && A.x > B.x);
  const [U, L, bu, bl] = flip ? [B, A, bb, ba] : [A, B, ba, bb];
  const lane = ((hash(key) % 5) - 2) * 6;   // parallel runs sit a little apart
  const up = { x: U.x, y: U.y + U.bottom + 4 };
  let out;
  if (bu === bl) {
    const lp = { x: L.x, y: L.y + L.bottom + 4 }, cy = (S.chan.get(bu) ?? up.y + 60) + lane + Math.min(30, Math.abs(L.x - U.x) / 25);
    out = curve(up, { x: up.x, y: cy }, { x: lp.x, y: cy }, lp);
  } else {
    const lo = { x: L.x, y: L.y - L.top - 4 };
    const between = (S.bands || []).filter(b => b > bu && b < bl);
    if (!between.length) {
      // an S over the whole gap: the handles reach past the middle so both turns are wide, and only the arrowhead's
      // length at the end runs straight, so the arrowhead sits on a straight piece (it stays where it is)
      const st = { x: lo.x, y: lo.y - 12 }, h = (st.y - up.y) * .62;
      out = curve(up, { x: up.x, y: up.y + h + lane }, { x: st.x, y: st.y - h + lane }, st);
      out.d += ` L${P(lo)}`;
    } else {
      const c1 = S.chan.get(bu) + lane, c2 = S.chan.get(between[between.length - 1]) + lane;
      // the column gap next to the lower end, on the side the line comes from
      const k = (lo.x - LEAD_X) / COLW, side = up.x < lo.x ? -.5 : .5;
      const gx = LEAD_X + (Math.round(k) + side) * COLW + lane;
      out = rounded([up, { x: up.x, y: c1 }, { x: gx, y: c1 }, { x: gx, y: c2 }, { x: lo.x, y: c2 }, lo], 28);
    }
  }
  if (flip) out.d = reversePath(out.d);
  return out;
}
// the same path drawn the other way (so arrowheads and pulses keep their direction)
function reversePath(d) {
  const segs = d.match(/[MLQC][^MLQC]*/g).map(s => ({ t: s[0], p: s.slice(1).trim().split(/\s+/).map(v => v.split(',').map(Number)) }));
  const out = [];
  let cur = segs[0].p[0];
  for (const s of segs.slice(1)) { out.push({ t: s.t, from: cur, ctrl: s.p.slice(0, -1), to: s.p[s.p.length - 1] }); cur = s.p[s.p.length - 1]; }
  let r = `M${cur.map(v => v.toFixed(1)).join(',')}`;
  for (const s of out.reverse()) r += ` ${s.t}${[...s.ctrl.slice().reverse(), s.from].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}`;
  return r;
}
// where the "N finished · show" button is, in graph units (null while it is hidden)
function finAt() {
  const b = $('finBtn'); if (b.hidden || !S.vb) return null;
  const r = b.getBoundingClientRect();
  return svgPoint({ clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
}
// a node that appears grows out of the finished button (when it was folded there), else its parent, anchor or the lead
function enterFrom(n) {
  const at = id => { const d = S.disp.get(id); return d ? { x: d.x, y: d.y } : null; };
  if (S.prevCollapsed.has(n.id) && S.finFrom) return { x: S.finFrom.x, y: S.finFrom.y };
  return at(n.parent) || at(n.anchor) || at('lead');
}

function renderGraph(s) {
  const now = S.model.now;
  const nodes = buildNodes(s);
  const { pos, res } = layout(nodes, s);
  S.pos = pos;   // the layout's targets; what is on screen is S.disp
  const nHidden = (s.agents || []).filter(a => a.id in hidden).length;
  S.clearable = nodes.filter(n => !n.collapsed && canHide(n) && isDone(n)).map(n => n.id);   // what is drawn, not the folded ones
  S.finFrom = finAt();   // before it hides: unfolded agents grow out of it
  $('finBtn').hidden = !res.collapsed.length; setT($('finN'), res.collapsed.length);
  $('hiddenBtn').hidden = !nHidden; setT($('hiddenN'), nHidden);
  $('clearBtn').hidden = !S.clearable.length; setT($('clearN'), S.clearable.length);
  $('tidyBtn').disabled = !S.canTidy;
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
    d.r = p.r; d.top = p.top; d.bottom = p.bottom; d.half = Math.max(p.r + 12, lb[1].w / 2);
    boxes.push(...lb);
  }
  // the channels between rows (from label bottoms to the hex tops of the next row): lines travel in them
  const ext = new Map();
  for (const n of nodes) {
    const p = pos.get(n.id), b = S.band.get(n.id); if (!p || b == null || n.collapsed) continue;
    const e = ext.get(b) || { lo: Infinity, hi: -Infinity };
    e.lo = Math.min(e.lo, p.y - p.top); e.hi = Math.max(e.hi, p.y + p.bottom); ext.set(b, e);
  }
  ext.set(BAND.shelf, { lo: res.y - 40, hi: res.y + 40 });
  const bands = [...ext.keys()].sort((x, y) => x - y);
  S.chan = new Map();
  bands.forEach((b, i) => { if (i + 1 < bands.length) S.chan.set(b, (ext.get(b).hi + ext.get(bands[i + 1]).lo) / 2); else S.chan.set(b, ext.get(b).hi + 40); });
  S.bands = bands;

  // resources: the HP queue and the window (the folded finished agents are a button in the stage bar)
  const resSeen = new Set();
  const w = s.wts && !s.wts.error ? s.wts : null;
  const worker = nodes.find(n => n.role === 'worker' && seen.has(n.id));
  if (w) {
    const hp = (w.groups.HP || []).filter(r => ['queued', 'active', 'paused', 'parked', 'asks', 'other'].includes(r.kind));
    const next = (w.groups.HP || []).find(r => r.kind === 'queued');
    resSeen.add('_queue');
    boxes.push(placeRes('_queue', { x: LEAD_X - 165, y: res.y }, ROLECOL.worker, 'i-queue', `HP queue · ${hp.length} open`,
      next ? clip(`next ${next.n} · ${next.title}`, 36) : 'nothing queued',
      `MP ${(w.groups.MP || []).filter(r => r.kind !== 'done').length} · LP ${(w.groups.LP || []).filter(r => r.kind !== 'done').length} open`));
    const win = w.window || {};
    const waiters = (win.waiters || []).map(id => byId.get(id)?.label).filter(Boolean);
    resSeen.add('_window');
    // the shelf: queue and window side by side at the bottom, always in the same place
    boxes.push(placeRes('_window', { x: LEAD_X + 165, y: res.y }, win.held ? 'red' : 'green', win.held ? 'i-lock' : 'i-unlock',
      `Window · ${w.lock_name || 'lock'}`, win.held ? clip(`${shortWho(win.who)} · ${dur(now - (win.since || now))}`, 38) : 'free',
      waiters.length ? clip('waiting: ' + waiters.join(', '), 38) : ''));
  }
  for (const [id, r] of S.res) if (!resSeen.has(id)) {
    const d = S.disp.get(id);
    if (!d) { r.g.remove(); S.res.delete(id); }
    else if (!d.leaving) leave(d, 150, () => { r.g.remove(); S.res.delete(id); S.disp.delete(id); });
  }

  // nodes on the way out: into the finished button, or faded where they stand (quickly when you hid them)
  const folded = new Set(res.collapsed.map(n => n.id)), finPt = finAt();
  for (const [id, parts] of S.nodes) if (!seen.has(id)) {
    const d = S.disp.get(id);
    const drop = () => { parts.outer.remove(); S.nodes.delete(id); S.disp.delete(id); };
    if (!d) { drop(); continue; }
    if (d.leaving) continue;
    S.prevState.delete(id);
    if (parts.g.contains(document.activeElement)) S.nodes.get('lead')?.g.focus({ preventScroll: true });
    if (S.tipAnchor && parts.outer.contains(S.tipAnchor)) hideTip();
    parts.outer.classList.add('leaving'); parts.outer.setAttribute('aria-hidden', 'true'); parts.g.setAttribute('tabindex', -1);
    const chip = folded.has(id) && finPt;
    if (chip) { d.tx = chip.x; d.ty = chip.y; d.ts = .3; } else if (id in hidden) d.ts = .85;
    if (chip) leave(d, 400, drop, 150);   // seen flying in: it fades only on the last part of the way
    else leave(d, id in hidden ? 180 : 250, drop);
  }

  // edges: their ends are looked up every frame, so they follow the nodes as they move
  const eSeen = new Set();
  const bornOf = new Map(nodes.map(n => [n.id, n.born || 0]));
  const dimAll = S.sel !== 'lead' && seen.has(S.sel);
  for (const e of s.edges || []) {
    if (!seen.has(e.from) || !seen.has(e.to)) continue;
    const v = edgeShow(e, S.model.now, bornOf, dimAll ? S.sel : null, settings.allEdges);   // the layout ignores the setting
    if (!v.show) continue;
    drawEdge(e.key, e.from, e.to, `edge ${v.kind}${e.hot ? ' hot' : ''}${v.faint ? ' faint' : ''}${v.dim ? ' dim' : ''}`,
      e.kind === 'task' && byId.get(e.to)?.task ? `task ${byId.get(e.to).task}` : '', eSeen);
    S.edges.get(e.key).flow = flowOf(e, v.kind, S.model.now);
  }
  flowKick();
  const dimRes = id => dimAll && S.sel !== id ? ' dim' : '';
  if (w && w.window && w.window.held && seen.has(w.window.holder) && S.res.has('_window')) drawEdge('lock', w.window.holder, '_window', 'edge lock' + dimRes(w.window.holder), '', eSeen);
  if (w && worker && S.res.has('_queue')) drawEdge('queue', worker.id, '_queue', 'edge queue' + dimRes(worker.id), '', eSeen);
  for (const [k, e] of S.edges) if (!eSeen.has(k) && !e.leaving) leave(e, 150, () => { e.g.remove(); S.edges.delete(k); });

  const cards = placeCards(nodes, pos, boxes, now);
  fit(boxes, cards);
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
  p.mark = el('use', {}, g); p.mark.setAttribute('class', 'mark');
  p.lbl = el('text', { class: 'lbl' }, g);
  p.sub = el('text', { class: 'sub' }, g);
  p.stat = el('g', { class: 'stat' }, g); p.sico = el('use', { width: 12, height: 12 }, p.stat); p.stxt = el('text', {}, p.stat);
  p.barbg = el('rect', { class: 'barbg', height: 4, rx: 2 }, g); p.bar = el('rect', { class: 'bar', height: 4, rx: 2 }, g);
  p.meta = el('text', { class: 'meta' }, g);
  p.badge = el('g', { class: 'badge' }, g); el('circle', { r: 8 }, p.badge); p.badgeT = el('text', { y: 4 }, p.badge);
  p.lockm = el('g', { class: 'lockm' }, g); el('circle', { r: 9 }, p.lockm); el('use', { href: '#i-lock', x: -5.5, y: -6, width: 11, height: 11 }, p.lockm);
  el('title', {}, p.lockm).textContent = 'Holds the window';
  g.addEventListener('click', ev => { ev.stopPropagation(); select(id); });
  g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(id); } });
  g.addEventListener('mouseenter', () => showTip(g, nodeTip(id)));
  g.addEventListener('mouseleave', hideTip);
  return p;
}

function updateNode(p, n, pos, now, nAlerts) {
  const { x, y, r } = pos;
  const st = n.state || { key: 'unknown', label: '?' };
  const [sIcon, sCol] = stLook(st);
  const active = ['running', 'thinking', 'polling'].includes(st.key) || (n.role === 'lead' && !['waiting_user', 'idle', 'dead', 'shell'].includes(st.key));
  const col = n.role === 'lead' ? 'cyan' : ROLECOL[n.role] || 'violet';
  // blocked (paused, parked, waiting for or looping on the window): a dashed hex, at full strength
  const blocked = !n.finished && n.role !== 'lead' && (isParked(n) || st.key === 'polling');
  p.g.setAttribute('class', `node c-${col}${active ? ' active' : ''}${isParked(n) ? ' parked' : ''}${blocked ? ' blocked' : ''}${n.finished ? ' finished' : ''}${S.sel === n.id ? ' sel' : ''}`);
  setA(p.g, { tabindex: 0, 'aria-label': `${n.label}, ${st.label}${n.task ? ', task ' + n.task : ''}` });
  setA(p.halo, { r: r * 1.75 });
  setA(p.hex, { points: hexPts(r) });
  setA(p.flash, { points: hexPts(r + 3) });
  setA(p.arc, { r: r + 10, 'stroke-dasharray': `${(r * .9).toFixed(0)} ${(r * 7).toFixed(0)}` });
  p.arc.style.display = active ? '' : 'none';
  // inner mark: the lead's star; when blocked, why (a window: waiting for it, ⏸: paused by hand, an hourglass: on hold)
  // in that state's colour; a status icon otherwise
  const hold = !n.finished && n.role !== 'lead' && isParked(n) ? holdOf(n) : null;
  const markId = n.role === 'lead' ? 'i-lead' : hold ? hold[0] : (st.key === 'dead' ? 'i-dead' : st.key === 'ended' ? 'i-done' : 'i-think');
  p.mark.setAttribute('class', hold ? `mark c-${hold[1]}` : 'mark');
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
  p.lockm.style.display = n.holds ? '' : 'none';   // holds the window (its card is on the shelf, joined by a red line)
  setA(p.lockm, { transform: `translate(${(r * .8).toFixed(1)},${(r * .72).toFixed(1)})` });
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

// a resource card at a fixed place (the shelf): it never moves, so you always know where to look
function placeRes(id, p, ...rest) {
  const { w, h } = drawRes(id, ...rest);
  const d = target(id, p.x, p.y, 'res');
  d.w = w; d.h = h; d.rr = Math.min(w, h) / 2 + 2;
  return { x: p.x - w / 2 - 8, y: p.y - h / 2 - 8, w: w + 16, h: h + 16 };
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
// ---- line flow: dashes travel along a line that is in use. The speed eases in and out (a message line slows to a stop
// over minutes, not at once), and the offset is kept here, so there is no loop seam and no restart ----
const FLOW = 23;          // px/s at full speed (the old CSS loop: 28 px per 1.2 s)
const FLOW_FULL = 60, FLOW_GONE = 300;   // a message line: full speed for a minute after a message, still by 5 minutes
function flowOf(e, kind, now) {
  if (settings.motion !== 'full') return 0;
  if (kind === 'task') return e.hot ? FLOW : 0;
  if (kind !== 'msg' || !e.last) return 0;
  const age = now - e.last;
  return age <= FLOW_FULL ? FLOW : age >= FLOW_GONE ? 0 : FLOW * (1 - (age - FLOW_FULL) / (FLOW_GONE - FLOW_FULL));
}
let flowRaf = 0, flowAt = 0;
function flowKick() { if (!flowRaf && !document.hidden) { flowAt = performance.now(); flowRaf = requestAnimationFrame(flowStep); } }
function flowStep(t) {
  const dt = Math.min(.1, (t - flowAt) / 1000), k = 1 - Math.exp(-dt / .7);   // ~2 s to reach a new speed
  flowAt = t;
  let live = false;
  for (const e of S.edges.values()) {
    const want = e.flow || 0;
    if (!want && !e.fv) continue;
    e.fv = Math.abs(want - e.fv) < .05 ? want : (e.fv || 0) + (want - (e.fv || 0)) * k;
    e.off = ((e.off || 0) - e.fv * dt) % 5040;   // a multiple of every dash period: the wrap is invisible
    e.path.setAttribute('stroke-dashoffset', e.off.toFixed(2));
    live = live || e.fv > 0 || want > 0;
  }
  flowRaf = live && !document.hidden ? requestAnimationFrame(flowStep) : 0;
}
document.addEventListener('visibilitychange', flowKick);
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
  const view = S.fitVb && visible(S.fitVb), inView = r => !view || (r.x > view.x0 + 8 && r.x + r.w < view.x1 - 8 && r.y > view.y0 + 8 && r.y + r.h < view.y1 - 8);
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
    // a free spot on screen first, so a new card does not make the view move; else any free spot
    let spot = null;
    for (const pass of [inView, () => true]) {
      for (const [x, y] of cands) {
        const rect = { x, y, w, h };
        if (!pass(rect) || boxes.some(b => hit(rect, b)) || placed.some(b => hit(rect, b))) continue;
        spot = rect; break;
      }
      if (spot) break;
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
  return placed;   // the cards' boxes: kept out of the graph's own fit (see fit)
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
function bounds(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x0, y0, x1, y1 };
}
// the view that centres these bounds; never zoomed in past 1:1 (a lone lead would fill the stage), so a small graph
// sits centred at its natural size
function fitFor(b) {
  const pad = 30, MAX_ZOOM = 1, svg = $('graph');
  const cw = b.x1 - b.x0 + 2 * pad, ch = b.y1 - b.y0 + 2 * pad + 40;
  const w = Math.max(600, cw, (svg.clientWidth || 0) / MAX_ZOOM), h = Math.max(400, ch, (svg.clientHeight || 0) / MAX_ZOOM);
  return { x: b.x0 - pad + cw / 2 - w / 2, y: b.y0 - pad - 40 + ch / 2 - h / 2, w, h };
}
// what the screen shows of a view box: the svg keeps its aspect, so one side shows more than the box
function visible(vb) {
  const svg = $('graph'), A = (svg.clientWidth || vb.w) / (svg.clientHeight || vb.h);
  const w = Math.max(vb.w, vb.h * A), h = Math.max(vb.h, vb.w / A), cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
  return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2, w, h };
}
// a view still serves when everything is on screen and the empty space is not piled up on one side
const LOPSIDED = .4;   // the margins on the two sides may differ by up to this share of the view
function serves(vb, b) {
  const v = visible(vb), m = 8;
  if (b.x0 < v.x0 + m || b.x1 > v.x1 - m || b.y0 < v.y0 + m || b.y1 > v.y1 - m) return false;
  return Math.abs((b.x0 - v.x0) - (v.x1 - b.x1)) <= LOPSIDED * v.w && Math.abs((b.y0 - v.y0) - (v.y1 - b.y1)) <= LOPSIDED * v.h;
}
// fit the graph (agents, chip, shelf) and keep its speech and tool cards on screen. The view moves only when it has
// to: a card that appears or goes, or a label that grows, moves nothing while the current view still serves (all on
// screen, not lopsided) at the right zoom. Otherwise it goes to the graph's own centred fit, or to the fit around the
// cards too when they would stick out of that one.
function fit(core, cards = []) {
  if (!core.length) return;
  const all = bounds(core.concat(cards)), own = fitFor(bounds(core));
  const ideal = serves(own, all) ? own : fitFor(all);
  const prev = S.fitVb;
  const keep = prev && Math.abs(prev.w - ideal.w) <= .06 * ideal.w && Math.abs(prev.h - ideal.h) <= .06 * ideal.h && serves(prev, all);
  const vb = keep ? prev : ideal;
  S.fitVb = vb;
  if (S.userPanned) { if (vb !== prev) $('fitBtn').disabled = false; return; }
  vbTarget(vb);
  $('fitBtn').disabled = true;
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
  vbRest(); S.userPanned = true; applyVb(); $('fitBtn').disabled = false;
}, { passive: false });
let drag = null;
$('graph').addEventListener('pointerdown', ev => {
  if (ev.target.closest('.node, .card') || !S.vb) return;
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
  vbRest(); S.userPanned = true; applyVb(); $('fitBtn').disabled = false;
});
$('graph').addEventListener('pointerup', ev => {
  $('graph').classList.remove('panning');
  if (drag && !drag.moved && !ev.target.closest('.node')) select('lead');
  drag = null;
});
$('graph').addEventListener('dblclick', ev => { if (!ev.target.closest('.node')) doFit(); });
$('fitBtn').addEventListener('click', doFit);
$('clearBtn').addEventListener('click', () => hideAgents(S.clearable || []));
$('tidyBtn').addEventListener('click', () => { S.tidyNow = true; hideTip(); render(); });
$('finBtn').addEventListener('click', () => { S.expandFinished = true; render(); });
$('hiddenBtn').addEventListener('click', () => { const s = cur(); if (s && unhideAgents((s.agents || []).map(a => a.id))) render(); });
function doFit() { S.userPanned = false; if (S.fitVb) vbTarget(S.fitVb); $('fitBtn').disabled = true; }

// ---- pulses: one shared rAF loop ----
function queuePulse(m) {
  const key = [m.from, m.to].sort().join('~');
  const e = S.edges.get(key);
  showTicker(m);
  if (!e || settings.motion === 'off') return;
  if (settings.motion === 'reduced') { e.path.classList.add('flashy'); setTimeout(() => { e.path.classList.remove('flashy'); e.path.setAttribute('class', e.cls); }, 400); return; }
  if (S.pulses.length >= 3) { S.pulses[S.pulses.length - 1].extra++; return; }
  const forward = m.from < m.to;   // the edge path runs from its first endpoint in the model; check by geometry below
  const halo = el('circle', { r: 0, class: 'pulse-halo' }, $('gPulse'));   // the glow: a radial gradient, no blur filter
  const dot = el('circle', { r: 0, class: 'pulse' }, $('gPulse'));
  const fromPos = S.disp.get(m.from);   // as drawn now
  const L = e.path.getTotalLength(), p0 = e.path.getPointAtLength(0);
  const rev = fromPos ? Math.hypot(p0.x - fromPos.x, p0.y - fromPos.y) > Math.hypot(e.path.getPointAtLength(L).x - fromPos.x, e.path.getPointAtLength(L).y - fromPos.y) : !forward;
  S.pulses.push({ e, dot, halo, t0: performance.now(), rev, extra: 0 });
  kick();
}
// a glowing spot: it swells in at the sender (8%), travels (to 82%), then flares and fades at the receiver
const PULSE_MS = 2400, PULSE_GO = .08, PULSE_AT = .82;
function stepPulses(now) {
  S.pulses = S.pulses.filter(p => {
    const k = Math.min((now - p.t0) / PULSE_MS, 1);
    if (!p.e.path.isConnected || k >= 1) { p.dot.remove(); p.halo.remove(); return false; }
    const j = Math.min(1, Math.max(0, (k - PULSE_GO) / (PULSE_AT - PULSE_GO))), ease = j < .5 ? 2 * j * j : 1 - Math.pow(-2 * j + 2, 2) / 2;
    const L = p.e.path.getTotalLength(), pt = p.e.path.getPointAtLength((p.rev ? 1 - ease : ease) * L);
    const grow = Math.min(1, k / PULSE_GO), end = Math.max(0, (k - PULSE_AT) / (1 - PULSE_AT));
    const breathe = 1 + .12 * Math.sin((now - p.t0) / 140);
    setA(p.dot, { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: (5.5 * grow * (1 - end)).toFixed(2) });
    setA(p.halo, { cx: pt.x.toFixed(1), cy: pt.y.toFixed(1), r: (20 * grow * breathe * (1 + end * .9)).toFixed(2), opacity: (1 - end).toFixed(3) });
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
function select(id) { unhideAgents([id]); S.sel = id; if (!['agent', 'wts', 'tokens'].includes(S.tab)) S.tab = 'agent'; render(); }
function nodeById(s, id) { return id === 'lead' ? Object.assign({ id: 'lead', role: 'lead', label: s.project }, s.lead) : (s.agents || []).find(a => a.id === id); }
function nodeTip(id) {
  const s = cur(); if (!s) return '';
  const n = nodeById(s, id); if (!n) return '';
  const st = n.state || {};
  return [n.label || s.project, st.label, n.task ? `task ${n.task}: ${n.task_title || ''}` : '', n.ctx ? `context ${kfmt(n.ctx)} / ${kfmt(n.ctx_max)}` : '',
    st.detail ? 'now: ' + st.detail : '', 'last active ' + ago(n.last_ts, S.model.now)].filter(Boolean).join('\n');
}

document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) { S.tab = b.dataset.tab; renderPanel(); } });
$('alertBtn').addEventListener('click', jumpWorstAlert);

function renderPanel() {
  if (S.alUndo && (S.tab !== 'alerts' || S.alUndo.sid !== S.sid)) S.alUndo = null;   // Undo lasts while you stay on the tab
  tabsFor(cur());
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const s = cur();
  let h;
  if (!S.model) h = '<div class="empty-note">Waiting for the first data…</div>';
  else if (S.tab === 'alerts') h = alertsPanel();
  else if (!s) h = '<div class="empty-note">No session selected.</div>';
  else if (S.tab === 'wts') h = wtsPanel(s);
  else if (S.tab === 'tokens') h = tokensPanel(s);
  else h = agentPanel(s, S.sel);
  if (h === S.panelHtml) return;
  // keep the reader's place: the section header at the top of the view stays where it was, and focus stays put
  const pane = $('panel'), top = pane.scrollTop, py = pane.getBoundingClientRect().top, fk = document.activeElement?.dataset?.k;
  let anchor = null;
  if (top > 0) for (const el of pane.querySelectorAll('[data-k]')) { const y = el.getBoundingClientRect().top - py; if (y <= 1) anchor = { k: el.dataset.k, y }; else break; }
  pane.innerHTML = h; S.panelHtml = h; pane.scrollTop = top;
  const a = anchor && pane.querySelector(`[data-k="${anchor.k}"]`);
  if (a) pane.scrollTop += a.getBoundingClientRect().top - py - anchor.y;
  if (fk) pane.querySelector(`[data-k="${fk}"]`)?.focus({ preventScroll: true });
  pane.querySelectorAll('svg.pbar').forEach(svg => {
    const f = +svg.dataset.frac; const r = svg.querySelector('.fg');
    if (r) r.setAttribute('width', (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%');
  });
}
const pbar = (frac, lvl) => `<svg class="pbar" data-frac="${frac}"><rect class="bg" width="100%" height="6" rx="3"/><rect class="fg ${lvl}" width="0" height="6" rx="3"/></svg>`;

// ---- the agent panel's detail (brief, report, files, trouble, the command in flight): fetched from /api/agent for the
// one agent on screen, every couple of seconds while it is shown; the panel draws from the model until it arrives ----
let detBusy = false;
function wantDetail(s, id) {
  const key = s.id + '/' + id;
  if (detBusy || (S.det?.key === key && Date.now() - S.det.at < 2000)) return;
  detBusy = true;
  fetch(`/api/agent?s=${encodeURIComponent(s.id)}&a=${encodeURIComponent(id)}`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null).catch(() => null)
    // re-render even when the reader moved on meanwhile: that render asks for the agent now on screen
    .then(d => { detBusy = false; S.det = { key, d, at: Date.now() }; if (S.tab === 'agent' && cur()) renderPanel(); });
}
setInterval(() => { if (S.tab === 'agent' && !document.hidden && cur()) renderPanel(); }, 2500);   // the detail moves on even when the model does not

// a fold remembers its state per agent; an agent you have not touched follows your last choice for that part
const isOpen = (id, part, def) => S.open[id + '.' + part] ?? S.foldPref[part] ?? def;
const foldBtn = (part, open, title, right = '') => `<button class="sec sech fold" data-fold="${part}" data-k="f-${part}" aria-expanded="${open}"><span>${icon('i-chev', 'chev')}${title}</span><span class="fm">${right}</span></button>`;
const secH = (k, title, right = '') => `<div class="sec sech" data-k="s-${k}"><span>${title}</span><span class="fm">${right}</span></div>`;
const kb = s => (new Blob([s]).size / 1024).toFixed(1) + ' KB';
const coarse = s => s < 60 ? '<1m' : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
// model text as plain text: escaped first, then headings, **bold** and `code` made quiet, blank runs folded
function prose(text, preview) {
  let t = esc(preview ? text.slice(0, 1200) : text);
  t = t.split('\n').map(l => l.replace(/^#{1,4}\s+(.*)$/, '<span class="h">$1</span>')).join('\n');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return preview ? t.replace(/\n\s*\n+/g, '\n') : t.replace(/\n\s*\n\s*\n+/g, '\n\n');
}
const dimPaths = t => t.replace(/…\/scratchpad\//g, '<span class="pv">…/scratchpad/</span>').replace(/(^|[\s'"=])~\//g, '$1<span class="pv">~/</span>');
const midPath = (p, n = 48) => { if (p.length <= n) return p; const seg = p.split('/'); return '…/' + seg.slice(-2).join('/'); };
const pathHtml = p => { const m = midPath(p), i = m.lastIndexOf('/'); return i < 0 ? `<b>${esc(m)}</b>` : `<span class="d">${esc(m.slice(0, i + 1))}</span><b>${esc(m.slice(i + 1))}</b>`; };
const shortDesc = (desc, label) => String(desc || '').replace(/^(?:HP|MP|LP|Task|Advisor)\s*#?\d+[a-z]?\s*:\s*/i, '').replace(label + ': ', '');

function nowBlock(s, n, st, d, now, sc) {
  const p = d?.now, win = s.wts?.window;
  let head, body = '';
  if (st.key === 'waiting_window') {
    const holder = win?.holder ? (win.holder === 'lead' ? 'lead' : (s.agents || []).find(a => a.id === win.holder)?.label) : null;
    head = `<div class="nowh c-amber">${icon('i-window')} Waiting for the shared window</div>`;
    body = `<div class="nowsub">${holder ? `held by <button class="linkbtn" data-select="${esc(win.holder)}">${esc(holder)}</button>` : 'held elsewhere'}${win?.since ? ' since ' + hhmm(win.since) : ''}</div>`;
  } else if (p) {
    const what = p.tool === 'Bash' ? (p.d ? p.desc : (p.cmd.split('\n')[0] || p.desc)) : `${p.tool}  ${p.file || p.desc}`;
    head = `<div class="nowh">${esc(what)}</div>`;
    if (p.tool === 'Bash' && p.cmd && (p.d || p.cmd.includes('\n') || p.cmd.length > 60)) {
      const open = isOpen(n.id, 'cmd', false), long = p.cmd.length > 150 || p.cmd.split('\n').length > 3;
      body = `<div class="cmd${open ? '' : ' clamp3'}">${dimPaths(esc(p.cmd))}</div>` + (long ? `<button class="linkbtn more" data-fold="cmd" data-k="m-cmd">${open ? 'less' : 'whole command'}</button>` : '');
    }
  } else {
    head = `<div class="nowh">${esc(st.label)}</div>`;
    if (st.detail) body = `<div class="nowsub">${esc(st.detail)}</div>`;
  }
  const jobs = (d?.bg || []).slice(0, 3).map(j => `<div class="job">${icon('i-wait')}<span>${esc(j.desc || 'background job')}</span><span class="fm">${coarse(now - j.t)}</span></div>`).join('')
    + ((d?.bg || []).length > 3 ? `<div class="job"><span></span><span>+${d.bg.length - 3} more</span><span></span></div>` : '');
  return secH('now', 'Now', p ? `<span data-tip="started ${hhmm(p.t, 1)}">${coarse(now - p.t)}</span>` : '')
    + `<div class="now c-${sc}">${head}${body}${jobs}</div>` + troubleHtml(d?.trouble);
}

function troubleHtml(tr) {
  if (!tr) return '';
  const chips = [];
  if (tr.errors) chips.push(`<span class="tchip"><b>${tr.errors}</b> failed</span>`);
  if (tr.denials) chips.push(`<span class="tchip warn"><b>${tr.denials}</b> denied</span>`);
  if (tr.repeat?.n >= 3) chips.push(`<span class="tchip${tr.repeat.n >= 5 ? ' warn' : ''}" data-tip="${esc(tr.repeat.what)}">same command <b>${tr.repeat.n}×</b></span>`);
  if (!chips.length) return '';
  const e = tr.last_error?.text ? `<div class="terr" data-tip="${esc(tr.last_error.text)}">${hhmm(tr.last_error.t)} · ${esc(tr.last_error.text)}</div>` : '';
  return `<div class="trouble">${chips.join('')}</div>${e}`;
}

function textFold(id, part, title, item, fin, boiler) {
  if (!item?.text) return '';
  const open = isOpen(id, part, false), text = item.text;
  let shown = text;
  if (!open && boiler) { const paras = text.split(/\n\s*\n/); if (paras.length > 1 && /^You are /.test(paras[0])) shown = paras.slice(1).join('\n\n'); }
  let body = prose(shown, !open);
  if (open && boiler) { const i = text.search(/\n\s*\n/); if (i > 0 && /^You are /.test(text)) body = `<span class="boiler">${prose(text.slice(0, i))}</span>` + prose(text.slice(i)); }
  return foldBtn(part, open, title, kb(text))
    + `<div class="prose${open ? '' : fin ? ' clamp8' : ' clamp3'}">${body}</div>`
    + (open || text.length > 240 || text.split('\n').length > (fin ? 8 : 3) ? `<button class="linkbtn more" data-fold="${part}" data-k="m-${part}">${open ? 'show less' : 'show all'}</button>` : '');
}

function filesHtml(id, d) {
  if (!d || (!d.files_n && !d.seen_n)) return '';
  let h = '';
  if (d.files_n) {
    const all = isOpen(id, 'files-all', false), rows = all ? d.files : d.files.slice(0, 8);
    const add = d.files.reduce((a, f) => a + f.add, 0), del = d.files.reduce((a, f) => a + f.del, 0);
    h += secH('files', `Files changed · ${d.files_n}`, `<span class="add">+${add}</span>  <span class="rm">−${del}</span>`) + '<div class="flist">';
    h += rows.map(f => `<div class="fl" data-tip="${esc(f.path)}\nedited ${f.n}× · last ${hhmm(f.t, 1)}"><span class="p">${pathHtml(f.path)}</span><span class="z">${f.n}×</span>`
      + `<span class="${f.add ? 'add' : 'z'}">${f.add ? '+' + f.add : '·'}</span><span class="${f.del ? 'rm' : 'z'}">${f.del ? '−' + f.del : '·'}</span><span class="z">${hhmm(f.t)}</span></div>`).join('');
    h += '</div>';
    const more = Math.min(d.files.length, 12) - rows.length;
    if (more > 0 || (all && d.files.length > 8)) h += `<button class="linkbtn more" data-fold="files-all" data-k="m-files">${all ? 'show less' : `+${more} more`}</button>`;
    if (d.files_n > d.files.length && all) h += `<div class="pmeta">${d.files_n - d.files.length} older not listed</div>`;
  }
  if (d.seen_n) {
    const open = isOpen(id, 'seen', false);
    h += foldBtn('seen', open, `${d.seen_n} seen in shared tree · not by this agent`);
    if (open) h += '<div class="flist">' + d.seen.map(f => `<div class="fl seen" data-tip="${esc(f.path)}"><span class="p">${pathHtml(f.path)}</span><span></span><span></span><span></span><span>${hhmm(f.t)}</span></div>`).join('') + '</div>';
  }
  return h;
}

function toolsHtml(s, n, d, fin) {
  const skip = ['SendMessage', 'SubagentHandback', 'Agent'];
  const rows = (d?.history || (n.recent || []).slice().reverse()).filter(e => !skip.includes(e.tool)).slice(0, 6);
  const row = e => {
    const tip = [e.d ? e.arg : '', e.cmd ? '$ ' + e.cmd : e.arg].filter(Boolean).join('\n') + (e.err ? '\nfailed' : '');
    return `<div class="ev${e.err ? ' fail' : ''}"><span class="tm">${hhmm(e.t, 1)}</span><span class="tl t-${toolCls(e.tool)}">${esc(e.tool)}</span><span class="a${e.d ? ' desc' : ''}" data-tip="${esc(tip)}">${e.err ? icon('i-x') : ''}${esc(e.arg)}</span></div>`;
  };
  if (fin) {
    const open = isOpen(n.id, 'tools', false);
    return foldBtn('tools', open, `Last tools · ${rows.length}`, rows.length ? hhmm(rows[0].t) : '') + (open ? rows.map(row).join('') : '');
  }
  return secH('tools', 'Recent tools') + (rows.map(row).join('') || '<div class="empty-note">none in view</div>');
}

function msgsHtml(s, n, isLead) {
  const me = isLead ? 'lead' : n.id;
  const all = (s.messages || []).filter(m => m.from === me || m.to === me).slice(-30).reverse();
  const open = isOpen(n.id || 'lead', 'msgs-all', false), msgs = open ? all : all.slice(0, 5);
  const nameOf = x => x === 'lead' ? 'lead' : ((s.agents || []).find(a => a.id === x)?.label || x.slice(0, 7));
  let h = secH('msgs', 'Messages');
  h += msgs.map(m => { const out = m.from === me; const other = out ? m.to : m.from;
    const verb = m.kind === 'spawn' ? (out ? 'spawned' : 'spawned by') : m.kind === 'handback' ? (out ? 'handback →' : 'handback ←') : (out ? '→' : '←');
    return `<div class="ev"><span class="tm">${hhmm(m.t, 1)}</span><span class="tl t-SendMessage">${verb}</span><span class="a" data-tip="${esc(m.summary)}"><button class="linkbtn" data-select="${esc(other)}">${esc(nameOf(other))}</button> · ${esc(m.summary)}</span></div>`; }).join('') || '<div class="empty-note">none in view</div>';
  if (all.length > 5) h += `<button class="linkbtn more" data-fold="msgs-all" data-k="m-msgs">${open ? 'show less' : `+${all.length - 5} more`}</button>`;
  return h;
}

function agentPanel(s, id) {
  const now = S.model.now;
  const n = nodeById(s, id) || nodeById(s, 'lead');
  const isLead = id === 'lead' || !n.id || n.id === 'lead';
  const aid = isLead ? 'lead' : n.id;
  wantDetail(s, aid);
  const d = S.det?.key === s.id + '/' + aid ? S.det.d : null;
  const st = n.state || { key: 'unknown', label: '?' };
  const [si, sc] = stLook(st);
  const col = isLead ? 'cyan' : ROLECOL[n.role] || 'violet';
  const fin = !isLead && (n.finished || st.key === 'dead');
  const pct = n.ctx_max ? n.ctx / n.ctx_max : 0, lvl = pct >= .9 ? 'crit' : pct >= .8 ? 'warn' : '';
  const row = !isLead && n.task != null ? rowIndex(s).get(n.task) : null;
  const label = isLead ? s.project : n.label;
  const nameOf = x => x === 'lead' ? 'lead' : ((s.agents || []).find(a => a.id === x)?.label || x.slice(0, 7));
  const tk = isLead ? s.lead.tokens : n.tokens;
  const tipId = isLead ? `pid ${s.pid}` : `${n.role}${n.name ? ' · "' + n.name + '"' : ''} · ${n.id}`;
  let h = `<div class="ptitle c-${col}"><svg class="hx" viewBox="-10 -10 20 20"><polygon points="${hexPts(8.5)}"/></svg><span data-tip="${esc(tipId)}">${esc(label)}</span>
    <span class="s c-${sc}">${icon(si)}${esc(fin ? 'finished ' + hhmm(n.last_ts) : st.label)}</span></div>`;
  h += `<div class="pmeta tight">${isLead ? esc(s.title || '') + ' · ' : (shortDesc(n.desc, n.label) ? esc(shortDesc(n.desc, n.label)) + ' · ' : '')}${esc(modelName(n.model) || 'model ?')}</div>`;
  const out = tk && tk.n ? `<button class="linkbtn tkline" data-tktab="1" data-tip="${esc(tokTip(isLead ? 'lead' : n.label, tk) + '\nclick: the Tokens tab')}">${tfmt(tk.v[3])} out</button>` : '';
  if (!isLead) {
    const from = `from <button class="linkbtn" data-select="${esc(n.parent)}">${esc(nameOf(n.parent))}</button>${n.depth > 1 ? ` (depth ${n.depth})` : ''}`;
    const t0 = d?.brief?.t || n.born;
    h += fin ? `<div class="pmeta">${from} · ran ${hhmm(t0)}–${hhmm(n.last_ts)} · ${dur(n.last_ts - t0)}${out ? ' · ' + out : ''}</div>`
             : `<div class="pmeta">${from}${t0 ? ' · started ' + hhmm(t0) : ''} · active ${ago(n.last_ts, now)}</div>`;
  } else {
    h += `<div class="kv"><span>Session</span><span>${esc(s.status)} since ${hhmm(s.status_since)} · active ${ago(n.last_ts, now)}</span>`;
    h += `<span>Pane</span><span>${s.tmux ? 'tmux ' + esc(s.tmux.session) + ':' + esc(s.tmux.pane) : 'not in tmux'}</span>`;
    h += `<span>Perms</span><span>${s.perm_mode ? esc(s.perm_mode) + ' · ' : ''}v${esc(s.version)} · pid ${s.pid}</span></div>`;
  }
  const context = () => secH('ctx', 'Context') + pbar(pct, lvl)
    + `<div class="ctxl"><span>${n.ctx ? kfmt(n.ctx) + ' / ' + kfmt(n.ctx_max) + ' · ' + Math.round(pct * 100) + '%' : 'not known yet'}${(n.compactions || []).length ? ' · compacted ' + n.compactions.length + '×' : ''}</span>${out}</div>`;
  const task = () => row ? secH('task', 'Task') + `<div class="taskcell${fin ? ' one' : ''}"><b>${row.n}</b> <span class="pmeta">${esc(row.group)}</span> ${esc(row.title)}${fin ? '' : `<div class="pmeta">${esc(row.status)}</div>`}</div>` : '';
  const brief = () => textFold(aid, 'brief', `Brief${d?.brief?.t ? ' · ' + hhmm(d.brief.t) : ''}`, d?.brief, false, true);
  const report = () => textFold(aid, 'rep', `Report${d?.rounds > 1 ? ' · round ' + d.rounds : ''} · ${hhmm(d?.report?.t)}${fin ? ' · final' : ''}`, d?.report, fin, false);
  const said = () => n.said ? secH('said', 'Last said') + `<div class="said">${esc(n.said)}</div>` : '';
  if (isLead) {
    h += nowBlock(s, n, st, d, now, sc);
    for (const x of (s.lead.notices || [])) h += `<div class="alert amber"><div class="ad">${hhmm(x.t)} · ${esc(x.text)}</div></div>`;
    h += said() + context() + filesHtml(aid, d) + toolsHtml(s, n, d, false) + msgsHtml(s, n, true);
  } else if (fin) {
    h += report() + filesHtml(aid, d) + troubleHtml(d?.trouble) + task() + brief() + toolsHtml(s, n, d, true) + msgsHtml(s, n, false);
  } else {
    h += nowBlock(s, n, st, d, now, sc) + (n.role === 'helper' ? said() : '') + task() + brief() + context() + report()
      + filesHtml(aid, d) + toolsHtml(s, n, d, false) + msgsHtml(s, n, false);
  }
  return h;
}

function toName(s, to) {
  if (to === 'main' || to === 'lead') return 'lead';
  const a = (s.agents || []).find(x => x.id === to || x.name === to);
  return a ? a.label : to;
}

// ---- tokens: output is the headline (what the model wrote); fresh input and cache reads each on their own scale ----
const TOKKINDS = [['out', 'Output'], ['fresh', 'Fresh in'], ['read', 'Cache read']];
const tokOf = (v, k) => k === 'out' ? v[3] : k === 'fresh' ? v[0] + v[1] : v[2];
const ROLEORDER = ['lead', 'worker', 'mp', 'lp', 'helper'];
const ROLENAME = { lead: 'lead', worker: 'HP', mp: 'MP', lp: 'LP', helper: 'helpers' };
const roleCol = r => r === 'lead' ? 'cyan' : ROLECOL[r] || 'violet';
const spanName = s => s < 3600 ? `${s / 60}m` : `${s / 3600}h`;
function tokTip(name, t) {
  const v = t.v;
  return `${name}${t.model ? ' · ' + modelName(t.model) : ''}\nOutput ${exact(v[3])} (thinking included)\nFresh in ${exact(v[0] + v[1])} (input ${exact(v[0])} + cache write ${exact(v[1])})\nCache read ${exact(v[2])}${t.n ? `\n${exact(t.n)} replies` : ''}${t.cx ? ' · ' + t.cx + ' compactions' : ''}`;
}
// a list sorted by size, except while the pointer is on it: then rows keep their places (new ones go last)
function holdOrder(key, items, id, val) {
  let out = items.slice().sort((a, b) => val(b) - val(a) || String(id(a)).localeCompare(String(id(b))));
  if (S.tokHold && S.tokOrder[key].length) {
    const prev = S.tokOrder[key], at = x => { const i = prev.indexOf(id(x)); return i < 0 ? 1e9 : i; };
    out = items.slice().sort((a, b) => at(a) - at(b));
  }
  S.tokOrder[key] = out.map(id);
  return out;
}
const tkBar = (frac, col) => `<svg class="tkbar"><rect class="bg" width="100%" height="6" rx="3"/><rect class="fg c-${col}" width="${(frac > 0 ? Math.max(1, frac * 100) : 0).toFixed(1)}%" height="6" rx="3"/></svg>`;
function tokensPanel(s) {
  const T = s.tokens, k = S.tokKind, kname = (TOKKINDS.find(x => x[0] === k) || TOKKINDS[0])[1];
  if (!T || !T.n) return '<div class="empty-note">No replies counted yet.</div>';
  const v = T.v;
  let h = '<div class="sec">Tokens · this session</div><div class="tktiles">';
  for (const [id, name] of TOKKINDS) {
    const tip = `${name}: ${exact(tokOf(v, id))}` + (id === 'fresh' ? `\ninput ${exact(v[0])} + cache write ${exact(v[1])}` : id === 'out' ? '\nthinking included' : '\nthe context, read again from the cache on every reply');
    h += `<button class="tktile${id === k ? ' on' : ''}" data-tk="${id}" aria-pressed="${id === k}" data-tip="${esc(tip)}"><span>${name}</span><b>${tfmt(tokOf(v, id))}</b></button>`;
  }
  const hit = v[2] / Math.max(1, v[0] + v[1] + v[2]);
  h += `</div><div class="pmeta">${exact(T.n)} replies · cache hit ${(hit * 100).toFixed(1)}%${T.cx ? ' · ' + T.cx + ' compactions' : ''}${T.ready ? '' : ' · counting…'}</div>`;

  // the split by role
  const byRole = {};
  for (const a of T.agents) byRole[a.role] = (byRole[a.role] || 0) + tokOf(a.v, k);
  const sum = Object.values(byRole).reduce((x, y) => x + y, 0) || 1;
  h += '<svg class="tkroles" viewBox="0 0 1000 8" preserveAspectRatio="none">';
  let x = 0;
  for (const r of ROLEORDER) if (byRole[r]) { const w = byRole[r] / sum * 1000; h += `<rect class="c-${roleCol(r)}" x="${x.toFixed(1)}" width="${Math.max(1, w - 3).toFixed(1)}" height="8"/>`; x += w; }
  h += '</svg><div class="tklegend">';
  for (const r of ROLEORDER) if (byRole[r]) h += `<span class="c-${roleCol(r)}" data-tip="${esc(ROLENAME[r] + ': ' + exact(byRole[r]) + ' · ' + (byRole[r] / sum * 100).toFixed(1) + '%')}"><i></i>${ROLENAME[r]} ${tfmt(byRole[r])}</span>`;
  h += '</div>';

  // per minute, stacked by role, over the timeline's span
  const span = settings.span, binS = span <= 7200 ? 60 : 180, bins = Math.round(span / binS), now = S.model.now;
  const end = Math.floor(now / 60) * 60 + 60, start = end - bins * binS;
  const cells = Array.from({ length: bins }, () => [0, 0, 0, 0, 0]);
  const ki = k === 'out' ? 4 : k === 'fresh' ? 2 : 3;
  for (const row of T.series.rows) {
    const b = Math.floor((T.series.t0 + row[0] * 60 - start) / binS), ri = ROLEORDER.indexOf(T.series.roles[row[1]]);
    if (b >= 0 && b < bins && ri >= 0) cells[b][ri] += row[ki];
  }
  const per = binS / 60, tot = cells.map(c => c.reduce((p, q) => p + q, 0) / per), peak = Math.max(...tot);
  h += `<div class="sec tkhead"><span>${kname} per minute · last ${spanName(span)}</span><span>${peak ? 'peak ' + tfmt(peak) + '/min' : 'none yet'}</span></div>`;
  h += `<svg class="tkchart" viewBox="0 0 ${bins * 10} 72" preserveAspectRatio="none"><line class="peak" x1="0" x2="${bins * 10}" y1="1.5" y2="1.5"/>`;
  cells.forEach((c, b) => {
    const last = b === bins - 1;
    let y = 72;
    if (peak) for (let ri = 0; ri < 5; ri++) {
      const hh = c[ri] / per / peak * 70;
      if (hh <= 0) continue;
      y -= hh;
      h += `<rect class="c-${roleCol(ROLEORDER[ri])}${last ? ' now' : ''}" x="${b * 10 + 1}" y="${y.toFixed(2)}" width="8" height="${hh.toFixed(2)}"/>`;
    }
    const parts = ROLEORDER.map((r, ri) => c[ri] ? `${ROLENAME[r]} ${tfmt(c[ri] / per)}` : '').filter(Boolean).join(' · ');
    h += `<rect class="hit" x="${b * 10}" y="0" width="10" height="72" data-tip="${esc(`${hhmm(start + b * binS)} · ${tfmt(tot[b])} ${kname.toLowerCase()}/min${last ? ' (this minute so far)' : ''}${parts ? '\n' + parts : ''}`)}"/>`;
  });
  h += `</svg><div class="tkaxis"><span>${hhmm(start)}</span><span>now</span></div>`;

  // by agent: the lead and every agent the session had, finished ones too (they really spent it)
  const agents = holdOrder('agents', T.agents, a => a.id, a => tokOf(a.v, k));
  const top = Math.max(1, ...agents.map(a => tokOf(a.v, k)));
  h += `<div class="sec">By agent · ${kname}</div><div class="tklist">`;
  for (const a of agents.slice(0, S.tokAll ? agents.length : 12)) {
    const col = roleCol(a.role), name = `${a.finished ? icon('i-done') : ''}<span>${esc(a.label)}</span>`;
    h += `<div class="tkrow${a.id === S.sel ? ' sel' : ''}${a.finished ? ' fin' : ''}" data-tip="${esc(tokTip(a.label, a) + (a.finished ? '\nfinished' : ''))}">`
      + (a.shown ? `<button class="nm c-${col}" data-select="${esc(a.id)}">${name}</button>` : `<span class="nm c-${col}">${name}</span>`)
      + `${tkBar(tokOf(a.v, k) / top, col)}<span class="val">${tfmt(tokOf(a.v, k))}</span></div>`;
  }
  h += '</div>';
  if (agents.length > 12) h += `<button class="linkbtn more" data-tkall="1">${S.tokAll ? 'show the top 12' : `+ ${agents.length - 12} more · show all`}</button>`;

  // by WTS task: its own agents and the helpers they spawned
  const rows = rowIndex(s), tasks = Object.entries(T.tasks || {}).map(([n, t]) => ({ n: +n, ...t, row: rows.get(+n) }));
  if (tasks.length) {
    const tl = holdOrder('tasks', tasks, t => t.n, t => tokOf(t.v, k)), ttop = Math.max(1, ...tl.map(t => tokOf(t.v, k)));
    h += `<div class="sec">By task · ${kname}</div><div class="tklist">`;
    for (const t of tl.slice(0, S.tokAll ? tl.length : 8)) {
      const col = GROUPCOL[t.row?.group] || 'slate', ag = t.row?.agent;
      const tip = `${t.n} · ${t.row?.title || ''}\n${t.agents} agent${t.agents === 1 ? '' : 's'}${tokTip('', { v: t.v })}`;
      const inner = `<b class="c-${col}">${t.n}</b><span>${esc(t.row?.title || '')}</span>`;
      h += `<div class="tkrow task" data-tip="${esc(tip)}">`
        + (ag ? `<button class="nm" data-select="${esc(ag)}">${inner}</button>` : `<span class="nm">${inner}</span>`)
        + `${tkBar(tokOf(t.v, k) / ttop, col)}<span class="val">${tfmt(tokOf(t.v, k))}</span></div>`;
    }
    h += '</div>';
    if (tasks.length > 8 && !S.tokAll) h += `<button class="linkbtn more" data-tkall="1">+ ${tasks.length - 8} more · show all</button>`;
  }
  return h;
}
document.addEventListener('mouseover', e => { S.tokHold = !!e.target.closest('.tklist'); });   // rows hold still under the pointer

const LIVEKIND = ['active', 'paused', 'parked', 'asks'];
const GROUPCOL = { HP: ROLECOL.worker, MP: ROLECOL.mp, LP: ROLECOL.lp };   // the same colours as the agents on the graph
// a group's mode (HP: the worker's state line; MP/LP: running, desk-only or paused) as an icon and a colour
const modeLook = t => /running/i.test(t) ? ['i-run', 'green'] : /paus/i.test(t) ? ['i-park', 'slate'] : /desk/i.test(t) ? ['i-park', 'cyan']
  : /stop/i.test(t) ? ['i-dead', 'red'] : ['i-wait', 'slate'];
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
  const counts = ['HP', 'MP', 'LP'].map(g => `<a data-jump="${g}" class="c-${GROUPCOL[g]}">${g} ${(w.groups[g] || []).length}</a>`).join('');
  h += `<div class="jump">${counts}</div>`;
  const cur = +((w.state_file || '').match(/running\s+(\d+)/) || [])[1];
  for (const g of ['HP', 'MP', 'LP']) {
    const rows = w.groups[g] || [];
    const runs = [...new Set(rows.map(r => r.runs_on))];
    const head = g === 'HP' ? (w.hp_line || '').replace(/^[^\w]+/, '') : ((w.modes || {})[g] === 'desk' ? 'desk-only' : (w.modes || {})[g] || 'running');
    const [mi, mc] = modeLook(head);
    h += `<div class="gh c-${GROUPCOL[g]}" id="g-${g}"><span class="gname">${g}</span><span class="mode c-${mc}">${icon(mi)}${esc(head || '—')}</span>${runs.length === 1 ? `<span class="gm">${esc(runs[0])}</span>` : ''}</div>`;
    if (!rows.length) h += '<div class="empty-note">empty</div>';
    for (const r of rows) {
      const [ri, rc] = r.kind === 'parked' && /waiting for the window/i.test(r.status) ? STATUS.waiting_window : ROWKIND[r.kind] || ROWKIND.other;
      const a = r.agent ? agents.get(r.agent) : null;
      const statusText = String(r.status).replace(/^[⏩⏳✋✅⛔❓💤■\s]+/u, '');
      const live = LIVEKIND.includes(r.kind);   // in progress, paused or asking: these get a filled pill and an edge bar
      h += `<div class="wrow ${r.n === cur ? 'cur' : ''}${a ? ' bound' : ''}${live ? ` live c-${rc}` : ''}" ${a ? `data-select="${esc(a.id)}"` : ''} data-tip="${esc(r.task)}">
        <span class="n">${r.n}</span><span class="t">${esc(r.title)}</span><span class="st2 c-${rc}${live ? ' pill' : ''}">${icon(ri)}${esc(statusText)}</span>`;
      if (runs.length > 1) h += `<span class="ro">${esc(r.runs_on)}</span>`;
      if (a) {
        const [ai, ac] = stLook(a.state);
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
  return (m?.alerts || []).filter(a => !(dismissed[akey(a)] > now));
}
// a hidden alert stays hidden while its condition holds; once it has been gone for 2 minutes the entry is dropped, so
// the next time (stuck again, another question) it shows. Expired snoozes go too.
function pruneDismissed(m) {
  const now = Date.now() / 1000, live = new Set((m.alerts || []).map(a => a.key));
  for (const k of live) S.gone.delete(k);
  let changed = false;
  for (const [k, until] of Object.entries(dismissed)) {
    const key = k.slice(0, k.indexOf('|'));
    if (!live.has(key) && !S.gone.has(key)) S.gone.set(key, now);
    if (until <= now || (!live.has(key) && now - S.gone.get(key) >= 120)) { delete dismissed[k]; changed = true; }
  }
  if (changed) store.set('ccprobe.dismissed', dismissed);
}
// the bell, and "N in other sessions": the session with the worst alert, on its Alerts tab
function jumpWorstAlert() {
  const live = S.model ? liveAlerts(S.model) : [];
  if (!sessAlerts(S.model, cur()).length) { const a = live.find(x => x.sev === 'red') || live[0]; if (a) selectSession(a.session); }
  S.tab = 'alerts'; renderPanel();
}
const sessAlerts = (m, s) => s ? liveAlerts(m).filter(a => a.session === s.id) : [];
// a tab with nothing for this session (no queue, no alerts) is not shown; none chosen, or one that is gone, falls back to
// the first one shown (WTS when there is a queue)
function tabsFor(s) {
  const has = { agent: true, wts: !!s?.wts, alerts: !!S.model && (sessAlerts(S.model, s).length > 0 || (S.alUndo?.sid === s?.id && S.tab === 'alerts')), tokens: !!s?.tokens?.n };
  document.querySelectorAll('.tabs button').forEach(b => { b.hidden = !has[b.dataset.tab]; });
  if (!has[S.tab]) S.tab = has.wts ? 'wts' : 'agent';
  return has;
}
function alertsPanel() {
  const m = S.model, list = sessAlerts(m, cur());
  const nHidden = (m.alerts || []).filter(a => a.session === S.sid).length - list.length;
  const elsewhere = liveAlerts(m).filter(a => a.session !== S.sid).length;
  const n = sev => list.filter(a => a.sev === sev).length, clearable = list.length - n('red');
  const undo = S.alUndo?.sid === S.sid ? S.alUndo : null;
  // the header: counts by severity, then Clear (amber and info; red ones are dismissed one at a time) or, after it, Undo
  let h = '<div class="alhead">' + [['red', 'needs you'], ['amber', 'warn'], ['info', 'info']].filter(([v]) => n(v)).map(([v, w]) => `<span class="alsev ${v}">${n(v)} ${w}</span>`).join('');
  if (undo) h += `<span class="alundo">${undo.n} cleared · <button data-alundo data-k="al-act">Undo</button></span>`;
  else if (list.length) h += clearable ? `<button class="alclear" data-alclear data-k="al-act" data-tip="Hide the amber and info alerts until they change · red ones stay">Clear ${clearable}</button>`
    : `<button class="alclear" data-alclear data-k="al-act" aria-disabled="true" data-tip="Red alerts are dismissed one at a time">Clear</button>`;
  h += '</div>';
  if (!list.length) h += '<div class="empty-note">Nothing needs a look here.</div>';
  const foot = (nHidden ? `<div class="alfoot">${nHidden} hidden here · <button data-alshow>Show</button></div>` : '')
    + (elsewhere ? `<div class="alfoot"><button data-alelse>${elsewhere} in other session${elsewhere === 1 ? '' : 's'} →</button></div>` : '');
  const ss = new Map((m.sessions || []).map(s => [s.id, s]));
  return h + list.map(a => {
    const s = ss.get(a.session);
    const agentName = a.agent && s ? (a.agent === 'lead' ? 'lead' : (s.agents || []).find(x => x.id === a.agent)?.label) : null;
    return `<div class="alert ${a.sev}"><div class="at">${esc(a.title)}<span class="tm">since ${hhmm(a.since)}</span></div>
      <div class="ad">${esc(a.detail)}</div>
      <div class="aa"><span class="proj">${esc(a.project || '')}</span>${agentName ? `<button data-select="${esc(a.agent)}" data-sid="${esc(a.session)}">show ${esc(agentName)}</button>` : ''}
      <button data-dismiss="${esc(akey(a))}">Dismiss</button><button data-snooze="${esc(akey(a))}">Snooze 1h</button></div></div>`;
  }).join('') + foot;
}

$('panel').addEventListener('click', e => {
  const al = e.target.closest('[data-alclear],[data-alundo],[data-alshow],[data-alelse]');
  if (al) {
    if (al.hasAttribute('data-alelse')) return jumpWorstAlert();
    if (al.hasAttribute('data-alclear')) {
      if (al.getAttribute('aria-disabled') === 'true') return;
      const these = sessAlerts(S.model, cur()).filter(a => a.sev !== 'red');
      S.alUndo = { sid: S.sid, n: these.length, prev: these.map(a => [akey(a), dismissed[akey(a)]]) };
      for (const a of these) dismissed[akey(a)] = CLEARED;
    } else if (al.hasAttribute('data-alundo') && S.alUndo) {
      for (const [k, v] of S.alUndo.prev) { if (v === undefined) delete dismissed[k]; else dismissed[k] = v; }
      S.alUndo = null;
    } else if (al.hasAttribute('data-alshow')) {
      for (const a of (S.model.alerts || []).filter(x => x.session === S.sid)) { delete dismissed[akey(a)]; delete dismissed[a.key + '|' + a.title]; }
    }
    store.set('ccprobe.dismissed', dismissed);
    return render();
  }
  const f = e.target.closest('[data-fold]');
  if (f) {
    const id = S.sel === 'lead' || !S.sel ? 'lead' : S.sel, part = f.dataset.fold, v = !isOpen(id, part, false);
    S.open[id + '.' + part] = v; S.foldPref[part] = v; store.set('ccprobe.folds', S.foldPref);
    return renderPanel();
  }
  const k = e.target.closest('[data-tk],[data-tkall],[data-tktab]');
  if (k) {
    if (k.dataset.tk) { S.tokKind = k.dataset.tk; store.set('ccprobe.tokKind', S.tokKind); }
    if (k.dataset.tkall) S.tokAll = !S.tokAll;
    if (k.dataset.tktab) S.tab = 'tokens';
    return renderPanel();
  }
  const t = e.target.closest('[data-select],[data-dismiss],[data-snooze],[data-jump]');
  if (!t) return;
  if (t.dataset.jump) { $('g-' + t.dataset.jump)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  if (t.dataset.dismiss) { dismissed[t.dataset.dismiss] = 1e12; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.snooze) { dismissed[t.dataset.snooze] = Date.now() / 1000 + 3600; store.set('ccprobe.dismissed', dismissed); return render(); }
  if (t.dataset.sid && t.dataset.sid !== S.sid) selectSession(t.dataset.sid);
  unhideAgents([t.dataset.select]);   // asked to see it: put it back on the diagram
  if ((cur()?.agents || []).find(a => a.id === t.dataset.select)?.finished) S.expandFinished = true;   // unfold them
  S.sel = t.dataset.select;
  if (!S.tab || S.tab === 'alerts') S.tab = 'agent';
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
  if (t && !t.closest('#graph') && !(t.id === 'tokChip' && !$('tokPop').hidden)) showTip(t, t.dataset.tip);   // no tip over its own popover
});
document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) hideTip(); });

// ---- notifications: once per new red alert, only while the tab is hidden ----
function notify(m) {
  for (const a of m.alerts || []) {
    const red = a.sev === 'red' || a.key.startsWith('asks:');
    if (!red || S.notified.has(a.key)) continue;
    S.notified.add(a.key);
    if (S.first || !settings.notify || !document.hidden || dismissed[akey(a)] > Date.now() / 1000) continue;
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
  const tp = $('tokPop');
  if (e.target.closest('#tokChip')) { tp.hidden = !tp.hidden; hideTip(); renderTokPop(S.model); return; }
  const ts = e.target.closest('[data-tksid]');
  if (ts) { tp.hidden = true; selectSession(ts.dataset.tksid); S.tab = 'tokens'; renderPanel(); return; }
  if (!tp.hidden && !e.target.closest('#tokPop')) tp.hidden = true;
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
  if (e.key === 'Escape') { if (!$('settings').hidden) $('settings').hidden = true; else if (!$('tokPop').hidden) $('tokPop').hidden = true; else select('lead'); }
  else if (e.key === 'f' || e.key === 'F') doFit();
  else if (e.key.length === 1 && '1234'.includes(e.key)) {   // the shown tabs, in order
    tabsFor(cur()); const t = [...document.querySelectorAll('.tabs button:not([hidden])')][+e.key - 1]?.dataset.tab; if (t) { S.tab = t; renderPanel(); }
  }
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
const hashTab = (location.hash.match(/tab=(agent|wts|alerts|tokens)/) || [])[1];
if (hashTab) S.tab = hashTab;
if (/\bpoll\b/.test(location.hash)) startPolling(); else connect();   // #poll: plain polling (headless checks, odd proxies)
