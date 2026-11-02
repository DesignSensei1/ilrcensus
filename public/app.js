/* ILRCensus front end. Plain JavaScript, no build step. */
(() => {
'use strict';

// ---------- small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const toDate = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');
const when = (s) => { if (!s) return ''; const d = toDate(s); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
const day = (s) => (s ? toDate(s.length === 10 ? s + 'T00:00:00Z' : s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const TENURE = { owner: 'Owner-occupier', tenant: 'Tenant', caretaker: 'Caretaker (owner lives elsewhere)' };
const RELATIONS = ['Head', 'Spouse', 'Child', 'Parent', 'Sibling', 'Relative', 'Domestic staff', 'Other'];
const AGES = ['0-5', '6-17', '18-35', '36-59', '60+'];
const STATUS_LABEL = { unvisited: 'Not visited', enumerated: 'Enumerated', vacant: 'Vacant', revisit: 'Nobody home', declined: 'Declined' };
const CONSENT_TEXT = 'ILRA Estate is recording who lives in each unit so the residents’ association can plan security, services and emergency contact. Your details are kept by the estate office, used only for estate matters, and never sold or shared outside the estate. You can ask to see, correct or remove them at any time. Do you agree to take part?';

function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 3000);
}

// ---------- theme ----------
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#theme').textContent = t === 'system' ? '◐ Auto' : t === 'light' ? '☀ Light' : '☾ Dark';
  $('#theme').setAttribute('aria-label', `Theme: ${t}. Click to change.`);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-color').setAttribute('content', dark ? '#182225' : '#ffffff');
}
let theme = store.get('ilr.theme', 'system');
applyTheme(theme);
$('#theme').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set('ilr.theme', theme); applyTheme(theme); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(theme));

// ---------- network and API ----------
let online = navigator.onLine;
let me = store.get('ilr.me', null);

function setOnline(v) { if (online !== v) { online = v; renderNet(); if (v) flush(); } }
window.addEventListener('online', () => { setOnline(true); flush(); });
window.addEventListener('offline', () => setOnline(false));

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    setOnline(false);
    const err = new Error('No connection. Your work is saved on this phone and will be sent when you are back online.'); err.offline = true; throw err;
  }
  setOnline(true);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(data.error || `The server answered ${res.status}.`); err.status = res.status;
    if (res.status === 401 && me) { setMe(null); }
    throw err;
  }
  return data;
}

function setMe(u) {
  me = u; if (u) store.set('ilr.me', u); else store.del('ilr.me');
  renderChrome();
}

// ---------- offline outbox (enumerators) ----------
const OUTBOX = 'ilr.outbox';
const outbox = () => store.get(OUTBOX, []);
const saveOutbox = (l) => { store.set(OUTBOX, l); renderNet(); };
let flushing = false;

function enqueue(op) { const l = outbox(); l.push({ ...op, id: uuid(), queuedAt: new Date().toISOString() }); saveOutbox(l); }

async function flush() {
  if (flushing || !me || !outbox().length) return;
  flushing = true; let sent = 0;
  try {
    for (const op of outbox()) {
      try {
        if (op.kind === 'household') await api('/api/households', { method: 'POST', body: op.body });
        else if (op.kind === 'status') await api(`/api/units/${op.unitId}/status`, { method: 'POST', body: op.body });
        saveOutbox(outbox().filter((x) => x.id !== op.id)); sent++;
      } catch (e) {
        if (e.offline || e.status === 401 || e.status >= 500) break;
        saveOutbox(outbox().map((x) => (x.id === op.id ? { ...x, error: e.message } : x)));
      }
    }
  } finally { flushing = false; }
  if (sent) {
    toast(`${sent} saved ${sent === 1 ? 'record' : 'records'} sent to the estate office`);
    try { await loadUnits(true); } catch (e) {}
    if (['units', 'unit'].includes(route().name)) render();
  }
}
setInterval(flush, 30000);

function renderNet() {
  const el = $('#net');
  if (!me) { el.hidden = true; return; }
  const n = outbox().length;
  el.hidden = false;
  el.className = 'net ' + (online ? 'on' : 'off');
  el.textContent = online ? (n ? `Sending ${n}…` : 'Online') : `Offline${n ? ` · ${n} waiting` : ''}`;
  el.title = n ? `${n} saved ${n === 1 ? 'record is' : 'records are'} waiting to be sent` : '';
}

// ---------- unit cache ----------
let units = store.get('ilr.units', []);
async function loadUnits(force) {
  if (!force && units.length && !online) return units;
  try { units = (await api('/api/units')).units; store.set('ilr.units', units); }
  catch (e) { if (!e.offline) throw e; }
  return units;
}
function unitsWithQueue() {
  const q = outbox();
  return units.map((u) => {
    const op = [...q].reverse().find((o) => o.unitId === u.id);
    if (!op) return u;
    return { ...u, status: op.kind === 'household' ? 'enumerated' : op.body.status, queued: true };
  });
}

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || '', arg: parts[1] ? decodeURIComponent(parts[1]) : '' };
}
const go = (h) => { if (location.hash === h) render(); else location.hash = h; };
window.addEventListener('hashchange', render);

const NAV = {
  public: [['', 'Home'], ['register', 'Register as a resident'], ['status', 'Check my request'], ['login', 'Staff sign in']],
  enumerator: [['units', 'My units'], ['approvals', 'New residents'], ['account', 'Account']],
  admin: [['overview', 'Overview'], ['units', 'Unit map'], ['approvals', 'New residents'], ['residents', 'Resident register'], ['team', 'Enumerators'], ['setup', 'Estate setup'], ['account', 'Account']],
};
const PUBLIC = ['', 'register', 'status', 'login', 'privacy'];
let pendingCount = 0;

function renderChrome() {
  const r = route().name;
  const list = NAV[me ? me.role : 'public'];
  const active = r === 'unit' || r === 'enumerate' ? 'units' : r === 'household' ? 'residents' : r;
  $('#nav').innerHTML = list.map(([k, l]) => `<a href="#/${k}" ${k === active ? 'aria-current="page"' : ''}>${esc(l)}${k === 'approvals' && pendingCount ? `<span class="count">${pendingCount}</span>` : ''}</a>`).join('');
  $('#who').innerHTML = me ? `${esc(me.name)} <button class="iconbtn" id="signout" type="button">Sign out</button>` : '';
  const so = $('#signout'); if (so) so.onclick = signOut;
  renderNet();
}

async function signOut() {
  const n = outbox().length;
  if (n && !confirmBox.armed) {
    confirmBox.armed = true;
    toast(`${n} saved ${n === 1 ? 'record has' : 'records have'} not been sent yet. Get online first, or press Sign out again to discard ${n === 1 ? 'it' : 'them'}.`, true);
    setTimeout(() => { confirmBox.armed = false; }, 6000);
    return;
  }
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) {}
  store.del(OUTBOX); store.del('ilr.units'); units = [];
  setMe(null); go('#/');
}
const confirmBox = { armed: false };

async function render() {
  const r = route();
  if (me && PUBLIC.includes(r.name) && r.name !== 'privacy') return go(me.role === 'admin' ? '#/overview' : '#/units');
  if (!me && !PUBLIC.includes(r.name)) return go('#/login');
  if (me && me.mustChangePassword && r.name !== 'account') return go('#/account');
  if (me && me.role !== 'admin' && ['overview', 'residents', 'household', 'team', 'setup'].includes(r.name)) return go('#/units');
  renderChrome();
  const fn = PAGES[r.name] || notFound;
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await fn(r.arg); }
  catch (e) {
    view.innerHTML = `<div class="panel"><h1>${e.offline ? 'You are offline' : 'That did not load'}</h1><p class="muted">${esc(e.message)}</p><div class="btns"><button class="btn" id="retry">Try again</button></div></div>`;
    $('#retry').onclick = render;
  }
  view.focus({ preventScroll: true });
  refreshPending();
}

async function refreshPending() {
  if (!me || !online) return;
  try {
    const n = (await api('/api/registrations')).registrations.filter((x) => x.status === 'pending').length;
    if (n !== pendingCount) { pendingCount = n; renderChrome(); }
  } catch (e) {}
}

function notFound() { view.innerHTML = '<div class="panel"><h1>Page not found</h1><p><a href="#/">Go to the start page</a></p></div>'; }

// ---------- shared bits ----------
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
const unitStatusPill = (s, queued) => queued ? pill('queued', 'Waiting to send') : pill(s, STATUS_LABEL[s] || s);
function zoneGroups(list) { const m = new Map(); list.forEach((u) => { if (!m.has(u.zone)) m.set(u.zone, []); m.get(u.zone).push(u); }); return m; }
function counts(list) { const c = { enumerated: 0, revisit: 0, declined: 0, vacant: 0, unvisited: 0 }; list.forEach((u) => { c[u.status] = (c[u.status] || 0) + 1; }); return c; }
const legend = (c) => `<div class="legend">${['enumerated', 'revisit', 'declined', 'vacant', 'unvisited'].map((k) => `<span><span class="dot c-${k}"></span>${STATUS_LABEL[k]}${c ? ' ' + (c[k] || 0) : ''}</span>`).join('')}</div>`;
const bar = (c, n) => `<div class="bar">${['enumerated', 'revisit', 'declined', 'vacant'].map((k) => `<span class="c-${k}" style="width:${n ? (c[k] / n) * 100 : 0}%"></span>`).join('')}</div>`;

function occRow(o = {}, i = 1) {
  return `<div class="occ" data-occ>
    <label class="full">Full name<input name="oname" value="${esc(o.name)}" autocomplete="off"></label>
    <label>Relation to head<select name="orel">${RELATIONS.map((r) => `<option${o.relation === r ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
    <label>Age group<select name="oage">${AGES.map((a) => `<option${o.age_band === a ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    <label>Phone <span class="hint">optional</span><input name="ophone" value="${esc(o.phone)}" inputmode="tel" autocomplete="off"></label>
    ${i === 0 ? '<span></span>' : '<button type="button" class="btn quiet sm" data-rm>Remove</button>'}
  </div>`;
}
function wireOccupants(root, defaults) {
  const list = $('[data-occ-list]', root);
  const wire = () => $$('[data-rm]', list).forEach((b) => { b.onclick = () => b.closest('[data-occ]').remove(); });
  wire();
  $('[data-add-occ]', root).onclick = () => { list.insertAdjacentHTML('beforeend', occRow(defaults)); wire(); $$('[name=oname]', list).pop().focus(); };
}
const readOccupants = (root) => $$('[data-occ]', root).map((r) => ({
  name: $('[name=oname]', r).value.trim(), relation: $('[name=orel]', r).value, age_band: $('[name=oage]', r).value, phone: $('[name=ophone]', r).value.trim(),
})).filter((o) => o.name);
const digits = (s) => String(s || '').replace(/\D/g, '');

function formError(form, msg) { const e = $('.error', form); e.textContent = msg; e.hidden = false; e.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
async function busy(btn, fn) { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } }

// ---------- public pages ----------
function home() {
  view.innerHTML = `
  <section class="hero">
    <div>
      <p class="eyebrow">ILRA Estate · Resident census</p>
      <h1>Every household in ILRA, counted once and kept up to date.</h1>
      <p class="lede">The estate is recording who lives in each unit. Census teams visit every home. If you are moving in, register here and the estate office will confirm you.</p>
    </div>
    <div class="choices">
      <a class="choice primary" href="#/register"><b>Register as a new resident</b><span>Moving into a unit in ILRA? Tell the estate office who will live there.</span></a>
      <a class="choice" href="#/status"><b>Check my request</b><span>Use the reference you got when you registered.</span></a>
      <a class="choice" href="#/login"><b>Staff sign in</b><span>For the estate admin and census enumerators.</span></a>
    </div>
  </section>
  <p class="small muted" style="margin-top:28px">How your details are used: <a href="#/privacy">read the privacy notice</a>.</p>`;
}

function privacy() {
  view.innerHTML = `<article class="panel" style="max-width:760px">
    <h1>Privacy notice</h1>
    <p class="lede">What the ILRA Estate census keeps about you, and what you can ask for.</p>
    <h2>What we record</h2>
    <p>The unit you live in, whether you own it, rent it or look after it, the household head’s name and phone number, an optional email, the landlord’s name and phone for rented units, and each person who lives there with their relation to the head and an age group. We do not ask for ID numbers, religion or ethnicity.</p>
    <h2>Why</h2>
    <p>To know who lives in the estate for security, gate access, estate services and contacting households in an emergency.</p>
    <h2>Who can see it</h2>
    <p>The estate admin sees the full register. Enumerators see only the units they are assigned and the records they made. Nothing is sold or shared outside the estate.</p>
    <h2>Your rights</h2>
    <p>You can ask the estate office to show you your record, correct it, or delete it. When a household moves out, the record is kept as history and then removed.</p>
    <p class="small muted">The estate should follow the Nigeria Data Protection Act 2023 when handling these records.</p>
  </article>`;
}

async function registerPage() {
  let list = [];
  try { list = (await api('/api/public/units')).units; } catch (e) { if (!e.offline) throw e; }
  if (!list.length) {
    view.innerHTML = `<div class="panel"><h1>Registration is not open yet</h1><p class="muted">${online ? 'The estate office has not added the units yet. Check back soon.' : 'You need a connection to register.'}</p></div>`;
    return;
  }
  const groups = zoneGroups(list);
  view.innerHTML = `
  <h1>Register as a new resident</h1>
  <p class="lede">Moving into ILRA Estate? Fill this in once. The estate office checks it against the census record for your unit and confirms you.</p>
  <form id="rf" novalidate>
    <fieldset><legend>Where you are moving</legend><div class="row">
      <label>Unit<select id="r-unit" name="unit"><option value="">Choose your unit</option>${[...groups].map(([z, us]) => `<optgroup label="${esc(z)}">${us.map((u) => `<option value="${u.id}">${esc(u.code)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>You are the<select id="r-tenure" name="tenure">${Object.entries(TENURE).map(([k, v]) => `<option value="${k}"${k === 'tenant' ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Move-in date<input id="r-date" name="move_in" type="date"></label>
    </div></fieldset>
    <fieldset><legend>About you</legend><div class="row">
      <label>Full name<input id="r-name" name="name" autocomplete="name"></label>
      <label>Phone<input id="r-phone" name="phone" inputmode="tel" autocomplete="tel"></label>
      <label>Email <span class="hint">optional</span><input id="r-email" name="email" type="email" autocomplete="email"></label>
      <label>Your age group<select id="r-age" name="age">${AGES.slice(2).map((a) => `<option${a === '36-59' ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    </div>
    <div class="row" data-landlord>
      <label>Landlord’s name<input id="r-ll" name="landlord_name"></label>
      <label>Landlord’s phone<input id="r-llp" name="landlord_phone" inputmode="tel"></label>
    </div></fieldset>
    <fieldset><legend>Others who will live with you</legend>
      <p class="small muted" style="margin:0">Add everyone who will sleep there most nights. Leave this empty if you live alone.</p>
      <div data-occ-list style="display:grid;gap:12px"></div>
      <div><button type="button" class="btn ghost sm" data-add-occ>Add a person</button></div>
    </fieldset>
    <label class="check"><input type="checkbox" id="r-consent" name="consent"><span>I agree that the estate office may keep these details to manage security, access and estate services. I can ask to see, correct or remove them at any time. <a href="#/privacy" target="_blank">Privacy notice</a></span></label>
    <p class="error" hidden></p>
    <div class="btns"><button class="btn" type="submit">Send to the estate office</button></div>
  </form>`;
  const f = $('#rf');
  wireOccupants(f, { relation: 'Spouse', age_band: '18-35' });
  const ll = () => { $('[data-landlord]', f).hidden = f.tenure.value === 'owner'; };
  f.tenure.onchange = ll; ll();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!f.unit.value) return formError(f, 'Choose the unit you are moving into.');
    if (!f.name.value.trim()) return formError(f, 'Enter your full name.');
    if (digits(f.phone.value).length < 10) return formError(f, 'Enter a phone number with at least 10 digits.');
    if (!f.consent.checked) return formError(f, 'Tick the consent box so the estate office can keep your details.');
    const body = { unit_id: Number(f.unit.value), tenure: f.tenure.value, move_in: f.move_in.value, name: f.name.value, phone: f.phone.value, email: f.email.value,
      landlord_name: f.landlord_name.value, landlord_phone: f.landlord_phone.value, consent: true,
      occupants: [{ name: f.name.value, relation: 'Head', age_band: f.age.value }, ...readOccupants(f)] };
    await busy($('button[type=submit]', f), async () => {
      try {
        const { ref } = await api('/api/public/registrations', { method: 'POST', body });
        view.innerHTML = `<div class="panel" style="max-width:600px"><p class="eyebrow">Request sent</p><h1>Your reference is <span class="mono">${esc(ref)}</span></h1>
          <p>Write it down. The estate office will check your details and call you on <b>${esc(body.phone)}</b>. You can check progress any time with this reference and your phone number.</p>
          <div class="btns"><a class="btn" href="#/status/${esc(ref)}">Check my request</a><a class="btn quiet" href="#/">Done</a></div></div>`;
      } catch (e) { formError(f, e.message); }
    });
  };
}

function statusPage(ref) {
  view.innerHTML = `<h1>Check my request</h1><p class="lede">Enter the reference you got when you registered and the phone number you used.</p>
  <form id="sf" class="panel" style="max-width:520px" novalidate>
    <label>Reference<input id="s-ref" name="ref" class="mono" value="${esc(ref)}" placeholder="REG-1A2B3C" autocomplete="off"></label>
    <label>Phone<input id="s-phone" name="phone" inputmode="tel"></label>
    <p class="error" hidden></p>
    <div class="btns"><button class="btn" type="submit">Check</button></div>
    <div id="s-out"></div>
  </form>`;
  const f = $('#sf');
  f.onsubmit = async (ev) => {
    ev.preventDefault(); $('.error', f).hidden = true; $('#s-out').innerHTML = '';
    try {
      const r = await api('/api/public/registrations/status', { method: 'POST', body: { ref: f.ref.value, phone: f.phone.value } });
      $('#s-out').innerHTML = `<div class="notice ${r.status === 'approved' ? 'info' : ''}">${pill(r.status, r.status[0].toUpperCase() + r.status.slice(1))}
        <p style="margin:8px 0 0">${esc(r.name)}, unit ${esc(r.unit)}. ${r.status === 'approved' ? `You are on the resident register. Your resident ID is <b class="mono">${esc(r.residentCode)}</b>.` : r.status === 'pending' ? 'The estate office has not decided yet.' : 'The estate office could not approve this request.'}${r.note ? `<br><span class="muted">Note from the estate office: ${esc(r.note)}</span>` : ''}</p></div>`;
    } catch (e) { formError(f, e.message); }
  };
}

function loginPage() {
  view.innerHTML = `<form id="lf" class="panel" style="max-width:420px;margin:24px auto 0" novalidate>
    <div><h1>Staff sign in</h1><p class="muted small" style="margin:0">For the estate admin and census enumerators. Your account comes from the estate admin.</p></div>
    <label>Username<input id="l-user" name="username" autocomplete="username" autocapitalize="none"></label>
    <label>Password<input id="l-pass" name="password" type="password" autocomplete="current-password"></label>
    <p class="error" hidden></p>
    <button class="btn" type="submit">Sign in</button>
  </form>`;
  const f = $('#lf');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    await busy($('button', f), async () => {
      try {
        const { user } = await api('/api/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
        setMe(user); await loadUnits(true).catch(() => {});
        go(user.mustChangePassword ? '#/account' : user.role === 'admin' ? '#/overview' : '#/units');
      } catch (e) { formError(f, e.offline ? 'You need a connection to sign in the first time.' : e.message); }
    });
  };
}

// ---------- admin overview ----------
async function overview() {
  const s = await api('/api/stats');
  const zones = new Map();
  s.byZone.forEach((r) => { if (!zones.has(r.zone)) zones.set(r.zone, { enumerated: 0, revisit: 0, declined: 0, vacant: 0, unvisited: 0 }); zones.get(r.zone)[r.status] = r.n; });
  const all = { enumerated: 0, revisit: 0, declined: 0, vacant: 0, unvisited: 0 };
  zones.forEach((c) => Object.keys(all).forEach((k) => { all[k] += c[k]; }));
  const total = Object.values(all).reduce((a, b) => a + b, 0);
  const done = all.enumerated + all.vacant;
  if (!total) {
    view.innerHTML = `<h1>Welcome to ILRCensus</h1><p class="lede">Start by adding the estate’s blocks or streets and their units. Then create accounts for your enumerators and assign them units.</p>
      <div class="btns"><a class="btn" href="#/setup">Add units</a><a class="btn quiet" href="#/team">Add enumerators</a></div>`;
    return;
  }
  const sum = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  view.innerHTML = `
  <h1>Census progress</h1>
  <p class="lede">Enumerated and vacant units count as done. Nobody-home and declined units stay open until someone follows up.</p>
  <div class="stack">
  <div class="stats">
    <div class="stat"><div class="eyebrow">Units done</div><div class="v">${done}<span class="muted" style="font-size:1rem;font-weight:400"> / ${total}</span></div><div class="s">${Math.round((done / total) * 100)}% of the estate</div></div>
    <div class="stat"><div class="eyebrow">Households</div><div class="v">${s.households}</div><div class="s">${s.owners} owner-occupied, ${s.households - s.owners} other</div></div>
    <div class="stat"><div class="eyebrow">Residents</div><div class="v">${s.people}</div><div class="s">${s.households ? (s.people / s.households).toFixed(1) : 0} per household</div></div>
    <div class="stat"><div class="eyebrow">New resident requests</div><div class="v">${s.pending}</div><div class="s">${s.pending ? '<a href="#/approvals">Review them</a>' : 'none waiting'}</div></div>
  </div>
  <div class="cols">
    <section class="panel"><h2>By block or street</h2>
      ${[...zones].map(([z, c]) => `<div class="zrow"><span title="${esc(z)}">${esc(z)}</span>${bar(c, sum(c))}<span class="mono">${c.enumerated + c.vacant}/${sum(c)}</span></div>`).join('')}
      ${legend(all)}
    </section>
    <section class="panel"><h2>Enumerators</h2>
      ${s.enumerators.length ? `<div class="tablewrap" style="border:0"><table><thead><tr><th>Name</th><th class="num">Assigned</th><th class="num">Done</th><th class="num">Households</th></tr></thead><tbody>
      ${s.enumerators.map((e) => `<tr><td>${esc(e.name)}</td><td class="num">${e.assigned}</td><td class="num">${e.done}</td><td class="num">${e.recorded}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No enumerators yet. <a href="#/team">Create their accounts</a>.</p>'}
    </section>
  </div>
  <section class="panel"><h2>Recent activity</h2>
    <ul class="feed">${s.activity.map((a) => `<li><time>${when(a.at)}</time><span>${esc(a.user_name || 'Resident')} ${esc(a.action)}${a.detail ? ': ' + esc(a.detail) : ''}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>
  </section>
  </div>`;
}

// ---------- unit map ----------
let mapFilter = store.get('ilr.mapFilter', { scope: 'mine', q: '', status: '' });
async function unitsPage() {
  await loadUnits(true);
  const all = unitsWithQueue();
  const isAdmin = me.role === 'admin';
  const mineCount = all.filter((u) => u.assigned_to === me.id).length;
  const scope = isAdmin ? 'all' : mineCount ? mapFilter.scope : 'all';
  const q = outbox();
  const draw = () => {
    const term = mapFilter.q.trim().toLowerCase();
    const shown = all.filter((u) => (scope === 'all' || u.assigned_to === me.id) && (!mapFilter.status || u.status === mapFilter.status) && (!term || u.code.toLowerCase().includes(term) || u.zone.toLowerCase().includes(term)));
    $('#zones').innerHTML = shown.length ? [...zoneGroups(shown)].map(([z, us]) => {
      const c = counts(us);
      return `<section class="panel zone"><h2>${esc(z)}<small>${c.enumerated + c.vacant} of ${us.length} done</small></h2>
      <div class="units">${us.map((u) => `<a class="unit ${u.status}${u.assigned_to === me.id && isAdmin === false ? ' mine' : ''}${u.queued ? ' queued' : ''}" href="#/unit/${u.id}" title="${esc(u.code)}: ${esc(STATUS_LABEL[u.status])}${u.assigned_name ? ', ' + esc(u.assigned_name) : ''}">${esc(u.code)}</a>`).join('')}</div></section>`;
    }).join('') : `<div class="empty">${all.length ? 'No units match.' : isAdmin ? 'No units yet. <a href="#/setup">Add the estate’s units</a>.' : 'The admin has not added any units yet.'}</div>`;
  };
  view.innerHTML = `
  <h1>${isAdmin ? 'Unit map' : 'My units'}</h1>
  <p class="lede">${isAdmin ? 'Every unit in the estate, coloured by census status.' : 'Tap a unit to record the household. You can keep working without signal: forms are saved on this phone and sent when you are back online.'}</p>
  ${q.length ? `<section class="panel" style="margin-bottom:16px"><h2>Waiting to send (${q.length})</h2><ul class="queue">${q.map((o) => `<li>${esc(o.unitCode)}: ${o.kind === 'household' ? 'household record' : esc(STATUS_LABEL[o.body.status])} · <span class="muted">${when(o.queuedAt)}</span>${o.error ? `<br><span class="error">${esc(o.error)}</span> <button class="btn quiet sm" data-drop="${o.id}">Discard</button>` : ''}</li>`).join('')}</ul>
    <div class="btns" style="margin-top:10px"><button class="btn sm" id="sendnow" ${online ? '' : 'disabled'}>Send now</button>${online ? '' : '<span class="small muted">Will send automatically when you are online.</span>'}</div></section>` : ''}
  <div class="toolbar">
    <input type="search" id="m-q" placeholder="Find a unit or street" value="${esc(mapFilter.q)}">
    ${!isAdmin && mineCount ? `<select id="m-scope"><option value="mine"${scope === 'mine' ? ' selected' : ''}>Assigned to me (${mineCount})</option><option value="all"${scope === 'all' ? ' selected' : ''}>All units</option></select>` : ''}
    <select id="m-status"><option value="">Any status</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}"${mapFilter.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
  </div>
  <div id="zones" class="zones"></div>
  <div style="margin-top:14px">${legend()}</div>`;
  draw();
  const saveF = () => store.set('ilr.mapFilter', mapFilter);
  $('#m-q').oninput = (e) => { mapFilter.q = e.target.value; saveF(); draw(); };
  $('#m-status').onchange = (e) => { mapFilter.status = e.target.value; saveF(); draw(); };
  if ($('#m-scope')) $('#m-scope').onchange = (e) => { mapFilter.scope = e.target.value; saveF(); unitsPage(); };
  if ($('#sendnow')) $('#sendnow').onclick = () => flush().then(render);
  $$('[data-drop]').forEach((b) => { b.onclick = () => { saveOutbox(outbox().filter((o) => o.id !== b.dataset.drop)); render(); }; });
}

async function unitPage(id) {
  id = Number(id);
  let data = null;
  try { data = await api(`/api/units/${id}`); } catch (e) { if (!e.offline) throw e; }
  await loadUnits(false);
  const cached = unitsWithQueue().find((u) => u.id === id);
  const u = data ? { ...data.unit, ...(cached && cached.queued ? { status: cached.status, queued: true } : {}) } : cached;
  if (!u) throw new Error('That unit is not in the list. Go back to the unit map.');
  const h = data && data.household;
  let body;
  if (h) {
    body = `<dl class="kv">
      <dt>Resident ID</dt><dd class="mono">${esc(h.resident_code)}</dd>
      <dt>Occupancy</dt><dd>${esc(TENURE[h.tenure])}${h.since_year ? `, since ${esc(h.since_year)}` : ''}</dd>
      <dt>Household head</dt><dd>${esc(h.head_name)} · <span class="mono">${esc(h.phone)}</span>${h.email ? ` · ${esc(h.email)}` : ''}</dd>
      ${h.landlord_name ? `<dt>Landlord</dt><dd>${esc(h.landlord_name)} · <span class="mono">${esc(h.landlord_phone)}</span></dd>` : ''}
      <dt>People (${h.occupants.length})</dt><dd>${h.occupants.map((o) => `${esc(o.name)} <span class="muted">(${esc(o.relation)}, ${esc(o.age_band)})</span>`).join('<br>')}</dd>
      <dt>Vehicles</dt><dd>${h.vehicles}</dd>
      <dt>Consent</dt><dd>Given by ${esc(h.consent_by)}, ${when(h.consent_at)}</dd>
      <dt>Recorded</dt><dd>${h.source === 'census' ? `Census, by ${esc(h.recorded_by_name || 'staff')}` : 'New resident registration'} · ${when(h.updated_at)}</dd>
    </dl>`;
  } else if (data && data.hidden) {
    body = '<p class="muted">This unit has a household on record. Only the estate admin and the enumerator who recorded it can see the details.</p>';
  } else if (!data && u.status === 'enumerated' && !u.queued) {
    body = '<p class="muted">You are offline. The household details for this unit will show when you have signal.</p>';
  } else {
    body = `<p style="margin:0">${u.queued ? 'Your entry for this unit is saved on this phone and will be sent when you are online.' : { unvisited: 'Nobody has visited this unit yet.', vacant: 'Recorded as vacant.', declined: 'The household declined to take part.', revisit: 'Nobody was home. Visit again.' }[u.status] || ''}${u.note ? ` <span class="muted">Note: ${esc(u.note)}</span>` : ''}</p>`;
  }
  const canRecord = !h && !(data && data.hidden) && !(u.status === 'enumerated' && !u.queued && !data);
  view.innerHTML = `
  <p class="small"><a href="#/units">← ${me.role === 'admin' ? 'Unit map' : 'My units'}</a></p>
  <section class="panel stack">
    <header><p class="eyebrow">${esc(u.zone)}${u.type ? ' · ' + esc(u.type) : ''}${u.assigned_name ? ' · assigned to ' + esc(u.assigned_name) : ''}</p>
      <h1>Unit ${esc(u.code)} ${unitStatusPill(u.status, u.queued)}</h1></header>
    ${body}
    <div class="btns">
      ${h ? `<a class="btn ghost" href="#/enumerate/${u.id}">Update this record</a>${me.role === 'admin' ? `<a class="btn quiet" href="#/household/${h.id}">Open in register</a>` : ''}` : ''}
      ${canRecord ? `<a class="btn" href="#/enumerate/${u.id}">Record household</a>
        <button class="btn quiet" data-mark="revisit">Nobody home</button>
        <button class="btn quiet" data-mark="vacant">Vacant</button>
        <button class="btn quiet" data-mark="declined">Declined</button>` : ''}
    </div>
    <div id="markbox" hidden><label>Note <span class="hint">optional, e.g. “come back on Saturday”</span><input id="u-note" maxlength="300"></label>
      <div class="btns" style="margin-top:8px"><button class="btn sm" id="u-save">Save</button><button class="btn quiet sm" id="u-cancel">Cancel</button></div></div>
  </section>`;
  let chosen = null;
  $$('[data-mark]').forEach((b) => { b.onclick = () => { chosen = b.dataset.mark; $('#markbox').hidden = false; $('#u-save').textContent = `Mark as ${STATUS_LABEL[chosen].toLowerCase()}`; $('#u-note').focus(); }; });
  if ($('#u-cancel')) $('#u-cancel').onclick = () => { $('#markbox').hidden = true; };
  if ($('#u-save')) $('#u-save').onclick = async () => {
    enqueue({ kind: 'status', unitId: u.id, unitCode: u.code, body: { status: chosen, note: $('#u-note').value } });
    if (online) await flush();
    toast(online && !outbox().length ? `${u.code} marked ${STATUS_LABEL[chosen].toLowerCase()}` : `${u.code} saved on this phone. It will be sent when you are online.`);
    go('#/units');
  };
}

async function enumeratePage(id) {
  id = Number(id);
  let data = null;
  try { data = await api(`/api/units/${id}`); } catch (e) { if (!e.offline) throw e; }
  await loadUnits(false);
  const u = data ? data.unit : units.find((x) => x.id === id);
  if (!u) throw new Error('That unit is not in the list. Go back to the unit map.');
  if (data && data.hidden) { view.innerHTML = `<div class="panel"><h1>${esc(u.code)} already has a record</h1><p class="muted">Ask the estate admin to update it.</p><a href="#/units">Back</a></div>`; return; }
  const draftKey = `ilr.draft.${id}`;
  const h = (data && data.household) || store.get(draftKey, null);
  const occ = h && h.occupants && h.occupants.length ? h.occupants : [{ relation: 'Head', age_band: '36-59' }];
  view.innerHTML = `
  <p class="small"><a href="#/unit/${u.id}">← Unit ${esc(u.code)}</a></p>
  <h1>${data && data.household ? 'Update' : 'Record'} household · ${esc(u.code)}</h1>
  <p class="lede">One form per household. Read the consent statement out loud before asking for names. If they say no, go back and mark the unit as declined.</p>
  ${online ? '' : '<p class="notice">You are offline. This form will be saved on this phone and sent when you have signal.</p>'}
  <form id="ef" novalidate>
    <fieldset><legend>Consent</legend>
      <div class="consent">“${esc(CONSENT_TEXT)}”</div>
      <label class="check"><input type="checkbox" id="e-consent" name="consent" ${data && data.household ? 'checked' : ''}><span>The household head agreed after hearing this statement.</span></label>
    </fieldset>
    <fieldset><legend>Household</legend>
      <div class="row">
        <label>Occupancy<select id="e-tenure" name="tenure">${Object.entries(TENURE).map(([k, v]) => `<option value="${k}"${h && h.tenure === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Living here since <span class="hint">year</span><input id="e-since" name="since_year" inputmode="numeric" maxlength="4" value="${esc(h ? h.since_year : '')}"></label>
        <label>Vehicles kept here<input id="e-veh" name="vehicles" type="number" min="0" max="20" value="${h ? Number(h.vehicles) || 0 : 0}"></label>
      </div>
      <div class="row">
        <label>Household head’s full name<input id="e-head" name="head_name" value="${esc(h ? h.head_name : '')}" autocomplete="off"></label>
        <label>Phone<input id="e-phone" name="phone" inputmode="tel" value="${esc(h ? h.phone : '')}" autocomplete="off"></label>
        <label>Email <span class="hint">optional</span><input id="e-email" name="email" type="email" value="${esc(h ? h.email : '')}" autocomplete="off"></label>
      </div>
      <div class="row" data-landlord>
        <label>Landlord’s name<input id="e-ll" name="landlord_name" value="${esc(h ? h.landlord_name : '')}" autocomplete="off"></label>
        <label>Landlord’s phone<input id="e-llp" name="landlord_phone" inputmode="tel" value="${esc(h ? h.landlord_phone : '')}" autocomplete="off"></label>
      </div>
    </fieldset>
    <fieldset><legend>Everyone who sleeps here most nights</legend>
      <p class="small muted" style="margin:0">Start with the household head. Include children and domestic staff who live in.</p>
      <div data-occ-list style="display:grid;gap:12px">${occ.map((o, i) => occRow(o, i)).join('')}</div>
      <div><button type="button" class="btn ghost sm" data-add-occ>Add a person</button></div>
    </fieldset>
    <p class="error" hidden></p>
    <div class="btns"><button class="btn" type="submit">Save household</button><a class="btn quiet" href="#/unit/${u.id}">Cancel</a></div>
  </form>`;
  const f = $('#ef');
  wireOccupants(f, { relation: 'Child', age_band: '6-17' });
  const ll = () => { $('[data-landlord]', f).hidden = f.tenure.value === 'owner'; };
  f.tenure.onchange = ll; ll();
  const firstName = $('[name=oname]', f);
  f.head_name.addEventListener('input', () => { if (!firstName.value || firstName.dataset.auto) { firstName.value = f.head_name.value; firstName.dataset.auto = '1'; } });
  // Keep an unsent draft on the phone, in case the app is closed mid-visit.
  const collect = () => ({ unit_id: u.id, tenure: f.tenure.value, since_year: f.since_year.value, vehicles: Number(f.vehicles.value) || 0, head_name: f.head_name.value.trim(),
    phone: f.phone.value.trim(), email: f.email.value.trim(), landlord_name: f.landlord_name.value.trim(), landlord_phone: f.landlord_phone.value.trim(), occupants: readOccupants(f) });
  if (!(data && data.household)) f.addEventListener('input', () => store.set(draftKey, collect()));
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!f.consent.checked) return formError(f, 'Tick the consent box first. If the household said no, go back and mark the unit as declined.');
    const body = { ...collect(), consent: true, consent_at: new Date().toISOString(), client_id: uuid() };
    if (!body.head_name) return formError(f, 'Enter the household head’s full name.');
    if (digits(body.phone).length < 10) return formError(f, 'Enter a phone number with at least 10 digits so the estate can reach this household.');
    if (!body.occupants.length) return formError(f, 'List at least one person who lives here.');
    enqueue({ kind: 'household', unitId: u.id, unitCode: u.code, body });
    store.del(draftKey);
    if (online) await flush();
    const stillQueued = outbox().find((o) => o.body.client_id === body.client_id);
    if (stillQueued && stillQueued.error) return formError(f, stillQueued.error);
    toast(stillQueued ? `${u.code} saved on this phone. It will be sent when you are online.` : `${u.code} saved`);
    go('#/units');
  };
}

// ---------- approvals ----------
async function approvalsPage() {
  const list = (await api('/api/registrations')).registrations;
  pendingCount = list.filter((r) => r.status === 'pending').length; renderChrome();
  view.innerHTML = `
  <h1>New resident requests</h1>
  <p class="lede">People moving in register on the public page. Check each request against what the census recorded for the unit, call the applicant if anything looks wrong, then approve or reject. Approving adds them to the resident register. If someone else is on record for that unit, they are marked as moved out.</p>
  <div class="cards">${list.map((r) => `
    <article class="card" data-id="${r.id}">
      <header><h2>${esc(r.name)} → ${esc(r.unit_code)}</h2><span><span class="mono small">${esc(r.ref)}</span> ${pill(r.status, r.status[0].toUpperCase() + r.status.slice(1))}</span></header>
      <div class="compare">
        <div><p class="eyebrow" style="margin:0 0 4px">Applicant</p>${esc(TENURE[r.tenure])} · moving in ${esc(day(r.move_in) || 'date not given')}<br><span class="mono">${esc(r.phone)}</span>${r.email ? ' · ' + esc(r.email) : ''}${r.landlord_name ? `<br>Landlord: ${esc(r.landlord_name)} ${esc(r.landlord_phone)}` : ''}
          <br>${r.occupants.length || 1} ${r.occupants.length === 1 ? 'person' : 'people'}: ${r.occupants.map((o) => `${esc(o.name)} <span class="muted">(${esc(o.relation)})</span>`).join(', ') || esc(r.name)}</div>
        <div><p class="eyebrow" style="margin:0 0 4px">On record for ${esc(r.unit_code)}</p>${r.current ? `${esc(r.current.head_name)} · ${esc(TENURE[r.current.tenure])} · ${r.current.people} people<br><span class="mono">${esc(r.current.resident_code)}</span>` : '<span class="muted">No current household</span>'}</div>
      </div>
      ${r.status === 'pending' ? `
        ${r.current ? `<p class="notice" style="margin:0">Approving marks ${esc(r.current.head_name)}’s household as moved out of ${esc(r.unit_code)}.</p>` : ''}
        <label>Note <span class="hint">required to reject; the applicant sees it</span><input data-note maxlength="300"></label>
        <div class="btns"><button class="btn sm" data-approve>Approve and add to register</button><button class="btn danger sm" data-reject>Reject</button></div>`
      : `<p class="small muted" style="margin:0">${r.status === 'approved' ? `Added as <span class="mono">${esc(r.resident_code)}</span>` : 'Rejected'} by ${esc(r.decided_by_name || 'staff')}, ${when(r.decided_at)}${r.decision_note ? `. Note: ${esc(r.decision_note)}` : ''}</p>`}
      <p class="small muted" style="margin:0">Sent ${when(r.created_at)}</p>
    </article>`).join('') || '<div class="empty">No requests yet. They appear here when someone registers on the public page.</div>'}</div>`;
  $$('.card[data-id]').forEach((c) => {
    const id = c.dataset.id; const note = () => $('[data-note]', c).value;
    const a = $('[data-approve]', c), r = $('[data-reject]', c);
    if (a) a.onclick = () => busy(a, async () => {
      try { const res = await api(`/api/registrations/${id}/approve`, { method: 'POST', body: { note: note() } }); toast(`Approved. Resident ID ${res.residentCode}`); approvalsPage(); }
      catch (e) { toast(e.message, true); }
    });
    if (r) r.onclick = () => busy(r, async () => {
      if (!note().trim()) { $('[data-note]', c).focus(); return toast('Add a short reason before rejecting.', true); }
      try { await api(`/api/registrations/${id}/reject`, { method: 'POST', body: { note: note() } }); toast('Request rejected'); approvalsPage(); }
      catch (e) { toast(e.message, true); }
    });
  });
}

// ---------- admin: resident register ----------
let regFilter = { q: '', zone: '', tenure: '', include_moved: '' };
async function residentsPage() {
  const zones = [...new Set((await loadUnits(true)).map((u) => u.zone))];
  view.innerHTML = `
  <h1>Resident register</h1>
  <p class="lede">The baseline built by the census, kept current by approved new residents. Only the estate admin can see this page.</p>
  <div class="toolbar">
    <input type="search" id="g-q" placeholder="Search name, phone, unit or resident ID" value="${esc(regFilter.q)}">
    <select id="g-zone"><option value="">All blocks and streets</option>${zones.map((z) => `<option${regFilter.zone === z ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>
    <select id="g-ten"><option value="">Any occupancy</option>${Object.entries(TENURE).map(([k, v]) => `<option value="${k}"${regFilter.tenure === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <label class="check" style="align-items:center"><input type="checkbox" id="g-old" ${regFilter.include_moved ? 'checked' : ''}><span>Include moved out</span></label>
    <a class="btn quiet sm" id="g-csv" href="/api/export.csv">Download CSV</a>
  </div>
  <div id="g-table"></div>`;
  let timer;
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(regFilter).filter(([, v]) => v)).toString();
    $('#g-csv').href = '/api/export.csv' + (qs ? '?' + qs : '');
    const rows = (await api('/api/households' + (qs ? '?' + qs : ''))).households;
    $('#g-table').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Resident ID</th><th>Unit</th><th>Household head</th><th>Occupancy</th><th>Phone</th><th class="num">People</th><th>Source</th><th>Status</th></tr></thead><tbody>
      ${rows.map((h) => `<tr class="link" data-h="${h.id}" tabindex="0"><td class="mono">${esc(h.resident_code)}</td><td class="mono">${esc(h.unit_code)}</td><td>${esc(h.head_name)}</td><td>${esc(TENURE[h.tenure])}</td><td class="mono">${esc(h.phone)}</td><td class="num">${h.people}</td><td>${h.source === 'census' ? 'Census' : 'Registration'}</td><td>${h.active ? pill('current', 'Current') : pill('moved', 'Moved out ' + day(h.moved_out_on))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted" style="text-align:center">No households match.</td></tr>'}
      </tbody></table></div><p class="small muted">${rows.length} ${rows.length === 1 ? 'household' : 'households'}.</p>`;
    $$('tr[data-h]').forEach((tr) => { const open = () => go(`#/household/${tr.dataset.h}`); tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
  };
  $('#g-q').oninput = (e) => { regFilter.q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 250); };
  $('#g-zone').onchange = (e) => { regFilter.zone = e.target.value; load(); };
  $('#g-ten').onchange = (e) => { regFilter.tenure = e.target.value; load(); };
  $('#g-old').onchange = (e) => { regFilter.include_moved = e.target.checked ? '1' : ''; load(); };
  await load();
}

async function householdPage(id) {
  const { household: h } = await api(`/api/households/${id}`);
  view.innerHTML = `
  <p class="small"><a href="#/residents">← Resident register</a></p>
  <section class="panel stack">
    <header><p class="eyebrow">${esc(h.zone)} · unit ${esc(h.unit_code)}</p><h1>${esc(h.head_name)} ${h.active ? pill('current', 'Current') : pill('moved', 'Moved out')}</h1></header>
    <dl class="kv">
      <dt>Resident ID</dt><dd class="mono">${esc(h.resident_code)}</dd>
      <dt>Occupancy</dt><dd>${esc(TENURE[h.tenure])}${h.since_year ? `, since ${esc(h.since_year)}` : ''}</dd>
      <dt>Phone</dt><dd class="mono">${esc(h.phone)}</dd>
      ${h.email ? `<dt>Email</dt><dd>${esc(h.email)}</dd>` : ''}
      ${h.landlord_name ? `<dt>Landlord</dt><dd>${esc(h.landlord_name)} · <span class="mono">${esc(h.landlord_phone)}</span></dd>` : ''}
      <dt>People (${h.occupants.length})</dt><dd>${h.occupants.map((o) => `${esc(o.name)} <span class="muted">(${esc(o.relation)}, ${esc(o.age_band)}${o.phone ? ', ' + esc(o.phone) : ''})</span>`).join('<br>')}</dd>
      <dt>Vehicles</dt><dd>${h.vehicles}</dd>
      <dt>Consent</dt><dd>Given by ${esc(h.consent_by)}, ${when(h.consent_at)}</dd>
      <dt>Source</dt><dd>${h.source === 'census' ? `Census, by ${esc(h.recorded_by_name || 'staff')}` : `New resident registration, approved by ${esc(h.recorded_by_name || 'staff')}`}</dd>
      <dt>Last updated</dt><dd>${when(h.updated_at)}</dd>
      ${h.active ? '' : `<dt>Moved out</dt><dd>${esc(day(h.moved_out_on))}</dd>`}
    </dl>
    ${h.active ? `<div class="btns"><a class="btn ghost" href="#/enumerate/${h.unit_id}">Edit record</a><button class="btn danger" id="mo">Mark as moved out</button></div>
      <div id="mobox" hidden class="notice"><label>Moved out on<input type="date" id="mo-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <div class="btns" style="margin-top:8px"><button class="btn danger sm" id="mo-yes">Mark moved out and set unit to vacant</button><button class="btn quiet sm" id="mo-no">Cancel</button></div></div>` : ''}
  </section>`;
  if ($('#mo')) {
    $('#mo').onclick = () => { $('#mobox').hidden = false; };
    $('#mo-no').onclick = () => { $('#mobox').hidden = true; };
    $('#mo-yes').onclick = async () => { try { await api(`/api/households/${h.id}/move-out`, { method: 'POST', body: { date: $('#mo-date').value } }); toast('Marked as moved out'); householdPage(id); } catch (e) { toast(e.message, true); } };
  }
}

// ---------- admin: enumerator accounts ----------
async function teamPage() {
  const { users } = await api('/api/users');
  view.innerHTML = `
  <h1>Enumerators and admins</h1>
  <p class="lede">Create an account for each enumerator. They get a temporary password and choose their own when they first sign in. Switch an account off when someone leaves the census team.</p>
  <div class="cols">
    <section class="stack">
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)}${u.phone ? `<br><span class="small muted mono">${esc(u.phone)}</span>` : ''}</td><td class="mono">${esc(u.username)}</td><td>${u.role === 'admin' ? pill('admin', 'Admin') : 'Enumerator'}</td>
        <td>${u.active ? (u.mustChangePassword ? pill('pending', 'Not signed in yet') : pill('current', 'Active')) : pill('off', 'Switched off')}</td>
        <td>${u.id === me.id ? '<span class="small muted">You</span>' : `<div class="btns"><button class="btn quiet sm" data-reset="${u.id}">Reset password</button><button class="btn ${u.active ? 'danger' : 'ghost'} sm" data-toggle="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button></div>`}</td></tr>`).join('')}
      </tbody></table></div>
      <div id="secret"></div>
    </section>
    <form id="nf" class="panel" novalidate>
      <h2 style="margin:0">Add an account</h2>
      <label>Full name<input id="n-name" name="name" autocomplete="off"></label>
      <label>Username <span class="hint">what they type to sign in, e.g. amaka.o</span><input id="n-user" name="username" autocapitalize="none" autocomplete="off"></label>
      <label>Phone <span class="hint">optional</span><input id="n-phone" name="phone" inputmode="tel" autocomplete="off"></label>
      <label>Role<select id="n-role" name="role"><option value="enumerator">Enumerator</option><option value="admin">Admin</option></select></label>
      <p class="error" hidden></p>
      <button class="btn" type="submit">Create account</button>
    </form>
  </div>`;
  const showSecret = (who, pw) => {
    $('#secret').innerHTML = `<div class="notice info"><p style="margin:0 0 6px">Give <b>${esc(who)}</b> this temporary password. It is shown only once.</p><span class="secret">${esc(pw)}</span>
      <p class="small muted" style="margin:6px 0 0">They sign in at this site’s address and pick a new password.</p></div>`;
  };
  const f = $('#nf');
  f.name.addEventListener('input', () => { if (!f.username.dataset.touched) f.username.value = f.name.value.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, ''); });
  f.username.addEventListener('input', () => { f.username.dataset.touched = '1'; });
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    await busy($('button', f), async () => {
      try {
        const r = await api('/api/users', { method: 'POST', body: { name: f.name.value, username: f.username.value, phone: f.phone.value, role: f.role.value } });
        await teamPage(); showSecret(`${r.user.name} (${r.user.username})`, r.tempPassword);
      } catch (e) { formError(f, e.message); }
    });
  };
  $$('[data-reset]').forEach((b) => { b.onclick = async () => { try { const r = await api(`/api/users/${b.dataset.reset}/reset-password`, { method: 'POST', body: {} }); const u = users.find((x) => x.id === Number(b.dataset.reset)); showSecret(u.name, r.tempPassword); } catch (e) { toast(e.message, true); } }; });
  $$('[data-toggle]').forEach((b) => { b.onclick = async () => { try { await api(`/api/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.on === '1' } }); toast(b.dataset.on === '1' ? 'Account switched on' : 'Account switched off. Their units are unassigned.'); teamPage(); } catch (e) { toast(e.message, true); } }; });
}

// ---------- admin: estate setup ----------
async function setupPage() {
  await loadUnits(true);
  const { users } = await api('/api/users');
  const enums = users.filter((u) => u.active);
  const groups = zoneGroups(units);
  const assignSelect = (attrs, current) => `<select ${attrs}><option value="">Nobody</option>${enums.map((u) => `<option value="${u.id}"${current === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  view.innerHTML = `
  <h1>Estate setup</h1>
  <p class="lede">Add each block or street and its units, then assign them to enumerators. Unit codes become part of each household’s resident ID, so keep them short, such as A01 or 12B.</p>
  <div class="cols">
    <section class="stack">
      ${groups.size ? [...groups].map(([z, us]) => {
        const owners = new Set(us.map((u) => u.assigned_to || 0));
        const same = owners.size === 1 ? [...owners][0] || null : undefined;
        return `<div class="panel stack" data-zone="${esc(z)}">
          <header style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;align-items:center"><h2 style="margin:0">${esc(z)} <span class="muted small" style="font-weight:400">${us.length} units</span></h2>
            <label style="display:flex;align-items:center;gap:8px;font-weight:400;white-space:nowrap">Assign all to ${assignSelect('data-zone-assign', same)}</label></header>
          ${same === undefined ? '<p class="small muted" style="margin:0">Units in this block are split between enumerators.</p>' : ''}
          <details><summary class="small">Edit units one by one</summary>
            <div class="tablewrap" style="margin-top:8px"><table><thead><tr><th>Unit</th><th>Type</th><th>Status</th><th>Enumerator</th><th></th></tr></thead><tbody>
            ${us.map((u) => `<tr><td class="mono">${esc(u.code)}</td><td>${esc(u.type)}</td><td>${unitStatusPill(u.status)}</td><td>${assignSelect(`data-unit-assign="${u.id}"`, u.assigned_to)}</td><td>${u.status === 'unvisited' && !u.has_household ? `<button class="btn quiet sm" data-del="${u.id}">Remove</button>` : ''}</td></tr>`).join('')}
            </tbody></table></div></details>
        </div>`;
      }).join('') : '<div class="empty">No units yet. Add the first block or street with the form.</div>'}
    </section>
    <form id="uf" class="panel" novalidate>
      <h2 style="margin:0">Add units</h2>
      <label>Block or street<input id="u-zone" name="zone" placeholder="Block A, or Adeola Close" list="zonelist" autocomplete="off"><datalist id="zonelist">${[...groups.keys()].map((z) => `<option value="${esc(z)}">`).join('')}</datalist></label>
      <label>Unit type <span class="hint">optional</span><input id="u-type" name="type" placeholder="Flat, duplex, terrace…"></label>
      <fieldset style="padding:12px"><legend class="small">Numbered units</legend>
        <div class="row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <label>Prefix<input id="u-prefix" name="prefix" placeholder="A"></label>
          <label>From<input id="u-from" name="from" type="number" min="1" value="1"></label>
          <label>To<input id="u-to" name="to" type="number" min="1" value="12"></label>
        </div>
        <p class="small muted" style="margin:0" id="u-preview"></p>
      </fieldset>
      <label>Or type the unit codes <span class="hint">one per line or comma separated; this replaces the numbered range</span><textarea id="u-list" name="list" rows="3" placeholder="12A, 12B, 14, 16"></textarea></label>
      <p class="error" hidden></p>
      <button class="btn" type="submit">Add units</button>
    </form>
  </div>`;
  const f = $('#uf');
  const prev = () => {
    const from = Number(f.from.value), to = Number(f.to.value), pad = String(to).length, p = f.prefix.value.trim();
    $('#u-preview').textContent = f.list.value.trim() ? 'Using the codes you typed.' : from >= 1 && to >= from ? `Adds ${to - from + 1} units: ${p}${String(from).padStart(pad, '0')} to ${p}${String(to).padStart(pad, '0')}` : 'Enter a range like 1 to 12.';
  };
  ['prefix', 'from', 'to', 'list'].forEach((n) => f[n].addEventListener('input', prev)); prev();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    await busy($('button', f), async () => {
      try {
        const body = { zone: f.zone.value, type: f.type.value };
        if (f.list.value.trim()) body.list = f.list.value; else Object.assign(body, { prefix: f.prefix.value, from: f.from.value, to: f.to.value });
        const r = await api('/api/units/bulk', { method: 'POST', body });
        toast(`${r.added} units added${r.skipped ? `, ${r.skipped} already existed` : ''}`); setupPage();
      } catch (e) { formError(f, e.message); }
    });
  };
  const assign = async (ids, userId) => { try { await api('/api/units/assign', { method: 'POST', body: { unit_ids: ids, user_id: userId || null } }); toast('Assignment saved'); } catch (e) { toast(e.message, true); } };
  $$('[data-zone-assign]').forEach((s) => { s.onchange = async () => { const z = s.closest('[data-zone]').dataset.zone; await assign(groups.get(z).map((u) => u.id), Number(s.value)); setupPage(); }; });
  $$('[data-unit-assign]').forEach((s) => { s.onchange = () => assign([Number(s.dataset.unitAssign)], Number(s.value)); });
  $$('[data-del]').forEach((b) => { b.onclick = async () => { try { await api(`/api/units/${b.dataset.del}`, { method: 'DELETE' }); toast('Unit removed'); setupPage(); } catch (e) { toast(e.message, true); } }; });
}

// ---------- account ----------
function accountPage() {
  view.innerHTML = `
  <h1>Your account</h1>
  ${me.mustChangePassword ? '<p class="notice">Choose your own password before you start. The one you were given was temporary.</p>' : `<p class="lede">Signed in as ${esc(me.name)} (${esc(me.username)}), ${me.role === 'admin' ? 'estate admin' : 'enumerator'}.</p>`}
  <form id="pf" class="panel" style="max-width:440px;margin-top:16px" novalidate>
    <h2 style="margin:0">Change password</h2>
    <label>Current password<input id="p-cur" name="current" type="password" autocomplete="current-password"></label>
    <label>New password <span class="hint">at least 8 characters</span><input id="p-new" name="next" type="password" autocomplete="new-password"></label>
    <p class="error" hidden></p>
    <button class="btn" type="submit">Save new password</button>
  </form>
  <section class="panel" style="max-width:440px;margin-top:16px"><h2>Using ILRCensus in the field</h2>
    <p class="small" style="margin:0">Add this site to your phone’s home screen (browser menu, then “Add to Home screen” or “Install app”). Open it once with signal after signing in. After that the unit list and forms work without signal, and anything you save is sent automatically when you are back online. Do not sign out while records are waiting to be sent.</p></section>`;
  const f = $('#pf');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    await busy($('button', f), async () => {
      try {
        await api('/api/me/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
        setMe({ ...me, mustChangePassword: false }); toast('Password changed'); go(me.role === 'admin' ? '#/overview' : '#/units');
      } catch (e) { formError(f, e.message); }
    });
  };
}

const PAGES = {
  '': home, privacy, register: registerPage, status: statusPage, login: loginPage,
  overview, units: unitsPage, unit: unitPage, enumerate: enumeratePage, approvals: approvalsPage,
  residents: residentsPage, household: householdPage, team: teamPage, setup: setupPage, account: accountPage,
};

// ---------- start ----------
async function start() {
  try { const r = await api('/api/me'); setMe(r.user); } catch (e) { /* offline: keep the cached sign-in */ }
  renderChrome();
  await render();
  flush();
}
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
start();
})();
