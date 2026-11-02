// ILRCensus server: API + static app.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ESTATE_CODE = (process.env.ESTATE_CODE || 'ILRA').toUpperCase();
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_DAYS = 30; // long, so enumerators stay signed in while offline in the field
const TENURES = ['owner', 'tenant', 'caretaker'];
const UNIT_STATUSES = ['unvisited', 'enumerated', 'vacant', 'revisit', 'declined'];
const RELATIONS = ['Head', 'Spouse', 'Child', 'Parent', 'Sibling', 'Relative', 'Domestic staff', 'Other'];
const AGE_BANDS = ['0-5', '6-17', '18-35', '36-59', '60+'];

// ---------- first admin ----------
if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare(`INSERT INTO users (name, username, password_hash, role, must_change_password)
              VALUES (?, ?, ?, 'admin', 1)`).run('Estate admin', username, bcrypt.hashSync(password, 10));
  console.log('\n  First admin account created');
  console.log(`  username: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`  password: ${password}   (you will be asked to change it)`);
  console.log('');
}

// ---------- helpers ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const log = (userId, action, detail = '') =>
  db.prepare('INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)').run(userId ?? null, action, detail);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res); if (r && r.then) r.catch(next); } catch (e) { next(e); } };

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// Reject cross-site form posts: every write must be JSON from our own pages.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Requests must be JSON.' });
  }
  next();
});

// Load the signed-in user, if any.
app.use('/api', (req, res, next) => {
  const token = parseCookies(req).ilr_session;
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha(token), now());
    if (row) req.user = row;
  }
  next();
});

const requireStaff = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
const requireAdmin = (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please sign in.' })
  : req.user.role !== 'admin' ? res.status(403).json({ error: 'Only the estate admin can do this.' })
  : next();

const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, phone: u.phone || '', role: u.role,
  active: !!u.active, mustChangePassword: !!u.must_change_password, createdAt: u.created_at });

function nextResidentCode(unit) {
  const n = db.prepare('SELECT COUNT(*) n FROM households WHERE unit_id = ?').get(unit.id).n + 1;
  const safe = unit.code.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return `${ESTATE_CODE}-${safe}-${String(n).padStart(2, '0')}`;
}

function cleanOccupants(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 30).map((o) => ({
    name: str(o.name, 120),
    relation: RELATIONS.includes(o.relation) ? o.relation : 'Other',
    age_band: AGE_BANDS.includes(o.age_band) ? o.age_band : '18-35',
    phone: str(o.phone, 30),
  })).filter((o) => o.name);
}

function householdDetail(id) {
  const h = db.prepare(`SELECT h.*, u.code unit_code, u.zone, r.name recorded_by_name
                        FROM households h JOIN units u ON u.id = h.unit_id
                        LEFT JOIN users r ON r.id = h.recorded_by WHERE h.id = ?`).get(id);
  if (!h) return null;
  h.occupants = db.prepare('SELECT name, relation, age_band, phone FROM occupants WHERE household_id = ? ORDER BY id').all(id);
  return h;
}

function canSeeUnitRecord(user, unit) {
  return user.role === 'admin' || unit.assigned_to === user.id ||
    !!db.prepare('SELECT 1 FROM households WHERE unit_id = ? AND active = 1 AND recorded_by = ?').get(unit.id, user.id);
}

// ---------- auth ----------
const attempts = new Map(); // simple brute-force brake per IP
app.post('/api/login', wrap((req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username, 60));
  if (!user || !user.active || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    a.n += 1; if (a.n >= 8) { a.n = 0; a.until = Date.now() + 5 * 60 * 1000; }
    attempts.set(key, a);
    throw new HttpError(401, 'That username and password do not match an active account.');
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, expires.toISOString());
  res.setHeader('Set-Cookie', `ilr_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`);
  log(user.id, 'signed in');
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).ilr_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', 'ilr_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, estate: ESTATE_CODE }));

app.post('/api/me/password', requireStaff, wrap((req, res) => {
  const { current, next } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) bad('Your current password is not correct.');
  if (String(next || '').length < 8) bad('Choose a new password with at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(String(next), 10), req.user.id);
  log(req.user.id, 'changed password');
  res.json({ ok: true });
}));

// ---------- public (residents) ----------
app.get('/api/public/units', (req, res) => {
  res.json({ units: db.prepare('SELECT id, code, zone FROM units ORDER BY zone, code').all() });
});

app.post('/api/public/registrations', wrap((req, res) => {
  const b = req.body;
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(b.unit_id));
  if (!unit) bad('Choose the unit you are moving into.');
  const name = str(b.name, 120); if (!name) bad('Enter your full name.');
  const phone = str(b.phone, 30); if (digits(phone).length < 10) bad('Enter a phone number with at least 10 digits.');
  if (!TENURES.includes(b.tenure)) bad('Say whether you own the unit, rent it, or look after it.');
  if (b.consent !== true) bad('Tick the consent box so the estate office can keep your details.');
  const occupants = cleanOccupants(b.occupants);
  const ref = 'REG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  db.prepare(`INSERT INTO registrations (ref, unit_id, name, phone, email, tenure, landlord_name, landlord_phone, move_in, occupants_json, consent_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ref, unit.id, name, phone, str(b.email, 120), b.tenure, str(b.landlord_name, 120), str(b.landlord_phone, 30),
      str(b.move_in, 10), JSON.stringify(occupants), now());
  log(null, 'new resident request', `${name} for ${unit.code} (${ref})`);
  res.json({ ref });
}));

app.post('/api/public/registrations/status', wrap((req, res) => {
  const r = db.prepare(`SELECT r.*, u.code unit_code, h.resident_code FROM registrations r JOIN units u ON u.id = r.unit_id
                        LEFT JOIN households h ON h.id = r.household_id WHERE r.ref = ?`).get(str(req.body.ref, 20).toUpperCase());
  // Ask for the phone too, so a reference alone does not reveal anything.
  if (!r || digits(r.phone).slice(-10) !== digits(req.body.phone).slice(-10)) {
    throw new HttpError(404, 'No request matches that reference and phone number.');
  }
  res.json({ status: r.status, unit: r.unit_code, name: r.name, residentCode: r.resident_code || null, note: r.decision_note });
}));

// ---------- staff: units ----------
app.get('/api/units', requireStaff, (req, res) => {
  const units = db.prepare(`SELECT u.id, u.code, u.zone, u.type, u.status, u.note, u.assigned_to, a.name assigned_name, u.updated_at,
      (SELECT COUNT(*) FROM households h WHERE h.unit_id = u.id AND h.active = 1) has_household
    FROM units u LEFT JOIN users a ON a.id = u.assigned_to ORDER BY u.zone, u.code`).all();
  res.json({ units });
});

app.get('/api/units/:id', requireStaff, wrap((req, res) => {
  const unit = db.prepare('SELECT u.*, a.name assigned_name FROM units u LEFT JOIN users a ON a.id = u.assigned_to WHERE u.id = ?').get(Number(req.params.id));
  if (!unit) throw new HttpError(404, 'Unit not found.');
  const h = db.prepare('SELECT id FROM households WHERE unit_id = ? AND active = 1').get(unit.id);
  const visible = canSeeUnitRecord(req.user, unit);
  res.json({ unit, household: h && visible ? householdDetail(h.id) : null, hidden: !!h && !visible });
}));

app.post('/api/units/:id/status', requireStaff, wrap((req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(req.params.id));
  if (!unit) throw new HttpError(404, 'Unit not found.');
  const status = req.body.status;
  if (!['vacant', 'revisit', 'declined', 'unvisited'].includes(status)) bad('Choose vacant, nobody home or declined.');
  if (db.prepare('SELECT 1 FROM households WHERE unit_id = ? AND active = 1').get(unit.id)) {
    bad(`${unit.code} already has a household on record. Ask the admin to mark it as moved out first.`);
  }
  db.prepare('UPDATE units SET status = ?, note = ?, updated_at = ? WHERE id = ?').run(status, str(req.body.note, 300), now(), unit.id);
  log(req.user.id, 'marked unit', `${unit.code} as ${status}`);
  res.json({ ok: true });
}));

// Census form. Idempotent on client_id so offline retries never create duplicates.
app.post('/api/households', requireStaff, wrap((req, res) => {
  const b = req.body;
  const clientId = str(b.client_id, 64) || null;
  if (clientId) {
    const dup = db.prepare('SELECT id, resident_code FROM households WHERE client_id = ?').get(clientId);
    if (dup) return res.json({ id: dup.id, residentCode: dup.resident_code, duplicate: true });
  }
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(b.unit_id));
  if (!unit) bad('That unit no longer exists. Refresh the unit list.');
  if (b.consent !== true) bad('The household must agree before anything is saved.');
  const head = str(b.head_name, 120); if (!head) bad('Enter the household head’s full name.');
  const phone = str(b.phone, 30); if (digits(phone).length < 10) bad('Enter a phone number with at least 10 digits.');
  if (!TENURES.includes(b.tenure)) bad('Choose owner-occupier, tenant or caretaker.');
  const occupants = cleanOccupants(b.occupants);
  if (!occupants.length) bad('List at least one person who lives here.');
  const owner = b.tenure === 'owner';
  const fields = {
    tenure: b.tenure, head_name: head, phone, email: str(b.email, 120),
    landlord_name: owner ? '' : str(b.landlord_name, 120), landlord_phone: owner ? '' : str(b.landlord_phone, 30),
    since_year: str(b.since_year, 4), vehicles: Math.max(0, Math.min(20, Number(b.vehicles) || 0)),
    consent_by: head, consent_at: str(b.consent_at, 40) || now(),
  };

  const result = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM households WHERE unit_id = ? AND active = 1').get(unit.id);
    let id, code, action;
    if (existing) {
      if (!canSeeUnitRecord(req.user, unit)) throw new HttpError(403, `${unit.code} already has a record. Ask the admin to update it.`);
      db.prepare(`UPDATE households SET tenure=@tenure, head_name=@head_name, phone=@phone, email=@email, landlord_name=@landlord_name,
                  landlord_phone=@landlord_phone, since_year=@since_year, vehicles=@vehicles, consent_by=@consent_by, consent_at=@consent_at,
                  updated_at=@u WHERE id=@id`).run({ ...fields, u: now(), id: existing.id });
      db.prepare('DELETE FROM occupants WHERE household_id = ?').run(existing.id);
      id = existing.id; code = existing.resident_code; action = 'updated household';
    } else {
      code = nextResidentCode(unit);
      id = db.prepare(`INSERT INTO households (resident_code, unit_id, tenure, head_name, phone, email, landlord_name, landlord_phone,
                       since_year, vehicles, consent_by, consent_at, recorded_by, source, client_id)
                       VALUES (@code,@unit,@tenure,@head_name,@phone,@email,@landlord_name,@landlord_phone,@since_year,@vehicles,
                       @consent_by,@consent_at,@by,'census',@client)`)
        .run({ ...fields, code, unit: unit.id, by: req.user.id, client: clientId }).lastInsertRowid;
      action = 'enumerated';
    }
    const ins = db.prepare('INSERT INTO occupants (household_id, name, relation, age_band, phone) VALUES (?,?,?,?,?)');
    occupants.forEach((o) => ins.run(id, o.name, o.relation, o.age_band, o.phone));
    db.prepare("UPDATE units SET status='enumerated', note='', updated_at=? WHERE id=?").run(now(), unit.id);
    log(req.user.id, action, `${unit.code} (${occupants.length} people)`);
    return { id, residentCode: code };
  })();
  res.json(result);
}));

// ---------- staff: new resident approvals ----------
app.get('/api/registrations', requireStaff, (req, res) => {
  const rows = db.prepare(`SELECT r.*, u.code unit_code, u.zone, d.name decided_by_name, h.resident_code
    FROM registrations r JOIN units u ON u.id = r.unit_id LEFT JOIN users d ON d.id = r.decided_by
    LEFT JOIN households h ON h.id = r.household_id
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 300`).all();
  rows.forEach((r) => {
    r.occupants = JSON.parse(r.occupants_json || '[]'); delete r.occupants_json;
    const cur = db.prepare('SELECT head_name, tenure, resident_code, (SELECT COUNT(*) FROM occupants o WHERE o.household_id = h.id) people FROM households h WHERE unit_id = ? AND active = 1').get(r.unit_id);
    r.current = cur || null;
  });
  res.json({ registrations: rows });
});

app.post('/api/registrations/:id/approve', requireStaff, wrap((req, res) => {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(req.params.id));
  if (!r) throw new HttpError(404, 'Request not found.');
  if (r.status !== 'pending') bad('This request has already been decided.');
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(r.unit_id);
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM households WHERE unit_id = ? AND active = 1').get(unit.id);
    if (cur) db.prepare('UPDATE households SET active = 0, moved_out_on = ?, updated_at = ? WHERE id = ?').run(r.move_in || now().slice(0, 10), now(), cur.id);
    const code = nextResidentCode(unit);
    const id = db.prepare(`INSERT INTO households (resident_code, unit_id, tenure, head_name, phone, email, landlord_name, landlord_phone,
        since_year, consent_by, consent_at, recorded_by, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'registration')`)
      .run(code, unit.id, r.tenure, r.name, r.phone, r.email, r.landlord_name, r.landlord_phone, (r.move_in || now()).slice(0, 4),
        r.name, r.consent_at, req.user.id).lastInsertRowid;
    const occ = JSON.parse(r.occupants_json || '[]');
    const ins = db.prepare('INSERT INTO occupants (household_id, name, relation, age_band, phone) VALUES (?,?,?,?,?)');
    ins.run(id, r.name, 'Head', occ.find((o) => o.relation === 'Head')?.age_band || '18-35', r.phone);
    occ.filter((o) => o.relation !== 'Head').forEach((o) => ins.run(id, o.name, o.relation, o.age_band, o.phone || ''));
    db.prepare("UPDATE units SET status='enumerated', note='', updated_at=? WHERE id=?").run(now(), unit.id);
    db.prepare("UPDATE registrations SET status='approved', decided_by=?, decided_at=?, household_id=?, decision_note=? WHERE id=?")
      .run(req.user.id, now(), id, str(req.body.note, 300), r.id);
    log(req.user.id, 'approved new resident', `${r.name} for ${unit.code} (${code})${cur ? `; ${cur.head_name} moved out` : ''}`);
    return { residentCode: code, movedOut: cur ? cur.head_name : null };
  })();
  res.json(result);
}));

app.post('/api/registrations/:id/reject', requireStaff, wrap((req, res) => {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(req.params.id));
  if (!r) throw new HttpError(404, 'Request not found.');
  if (r.status !== 'pending') bad('This request has already been decided.');
  const note = str(req.body.note, 300);
  if (!note) bad('Add a short reason. The applicant sees it when they check their request.');
  db.prepare("UPDATE registrations SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(req.user.id, now(), note, r.id);
  log(req.user.id, 'rejected new resident', `${r.name} (${r.ref})`);
  res.json({ ok: true });
}));

// ---------- admin: overview ----------
app.get('/api/stats', requireAdmin, (req, res) => {
  const byZone = db.prepare('SELECT zone, status, COUNT(*) n FROM units GROUP BY zone, status').all();
  const hh = db.prepare(`SELECT COUNT(*) households, SUM(tenure='owner') owners,
      (SELECT COUNT(*) FROM occupants o JOIN households h2 ON h2.id = o.household_id WHERE h2.active = 1) people
      FROM households WHERE active = 1`).get();
  const pending = db.prepare("SELECT COUNT(*) n FROM registrations WHERE status='pending'").get().n;
  const activity = db.prepare(`SELECT a.at, a.action, a.detail, u.name user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
                               WHERE a.action NOT IN ('signed in') ORDER BY a.id DESC LIMIT 15`).all();
  const enumerators = db.prepare(`SELECT u.id, u.name, (SELECT COUNT(*) FROM units x WHERE x.assigned_to = u.id) assigned,
      (SELECT COUNT(*) FROM units x WHERE x.assigned_to = u.id AND x.status IN ('enumerated','vacant')) done,
      (SELECT COUNT(*) FROM households h WHERE h.recorded_by = u.id AND h.source='census') recorded
      FROM users u WHERE u.role='enumerator' AND u.active=1 ORDER BY u.name`).all();
  res.json({ byZone, households: hh.households || 0, owners: hh.owners || 0, people: hh.people || 0, pending, activity, enumerators });
});

// ---------- admin: people with accounts ----------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY role, name').all().map(publicUser) });
});

function tempPassword() { return crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x'); }

app.post('/api/users', requireAdmin, wrap((req, res) => {
  const name = str(req.body.name, 120); if (!name) bad('Enter the enumerator’s name.');
  const username = str(req.body.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) bad('Usernames use 3 to 40 lowercase letters, numbers, dots or dashes.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) bad(`The username ${username} is taken.`);
  const role = req.body.role === 'admin' ? 'admin' : 'enumerator';
  const password = tempPassword();
  const id = db.prepare('INSERT INTO users (name, username, phone, password_hash, role) VALUES (?,?,?,?,?)')
    .run(name, username, str(req.body.phone, 30), bcrypt.hashSync(password, 10), role).lastInsertRowid;
  log(req.user.id, 'created account', `${name} (${role})`);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), tempPassword: password });
}));

app.patch('/api/users/:id', requireAdmin, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Account not found.');
  if (u.id === req.user.id && req.body.active === false) bad('You cannot switch off your own account.');
  if (typeof req.body.active === 'boolean') {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, u.id);
    if (!req.body.active) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('UPDATE units SET assigned_to = NULL WHERE assigned_to = ?').run(u.id);
    }
    log(req.user.id, req.body.active ? 'reactivated account' : 'deactivated account', u.name);
  }
  if (req.body.name || req.body.phone !== undefined) {
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(str(req.body.name, 120) || u.name, str(req.body.phone ?? u.phone, 30), u.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
}));

app.post('/api/users/:id/reset-password', requireAdmin, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Account not found.');
  const password = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  log(req.user.id, 'reset password', u.name);
  res.json({ tempPassword: password });
}));

// ---------- admin: units ----------
app.post('/api/units/bulk', requireAdmin, wrap((req, res) => {
  const zone = str(req.body.zone, 60); if (!zone) bad('Enter the block or street name.');
  const type = str(req.body.type, 40);
  let codes = [];
  if (req.body.list) {
    codes = String(req.body.list).split(/[\n,]+/).map((c) => str(c, 30)).filter(Boolean);
  } else {
    const from = Number(req.body.from), to = Number(req.body.to);
    if (!(from >= 1 && to >= from && to - from < 500)) bad('Enter a number range like 1 to 24.');
    const prefix = str(req.body.prefix, 20);
    const pad = String(to).length;
    for (let n = from; n <= to; n++) codes.push(`${prefix}${String(n).padStart(pad, '0')}`);
  }
  if (!codes.length) bad('Add at least one unit.');
  const ins = db.prepare('INSERT OR IGNORE INTO units (code, zone, type) VALUES (?,?,?)');
  let added = 0;
  db.transaction(() => codes.forEach((c) => { added += ins.run(c, zone, type).changes; }))();
  log(req.user.id, 'added units', `${added} in ${zone}`);
  res.json({ added, skipped: codes.length - added });
}));

app.post('/api/units/assign', requireAdmin, wrap((req, res) => {
  const ids = (req.body.unit_ids || []).map(Number).filter(Boolean);
  const userId = req.body.user_id ? Number(req.body.user_id) : null;
  if (userId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1").get(userId)) bad('Choose an active enumerator.');
  const up = db.prepare('UPDATE units SET assigned_to = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id) => up.run(userId, id)))();
  log(req.user.id, 'assigned units', `${ids.length} units`);
  res.json({ ok: true });
}));

app.delete('/api/units/:id', requireAdmin, wrap((req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(req.params.id));
  if (!unit) throw new HttpError(404, 'Unit not found.');
  if (db.prepare('SELECT 1 FROM households WHERE unit_id = ?').get(unit.id) || db.prepare('SELECT 1 FROM registrations WHERE unit_id = ?').get(unit.id)) {
    bad(`${unit.code} has records attached, so it cannot be removed.`);
  }
  db.prepare('DELETE FROM units WHERE id = ?').run(unit.id);
  log(req.user.id, 'removed unit', unit.code);
  res.json({ ok: true });
}));

// ---------- admin: register ----------
function registerRows(q) {
  const where = []; const p = {};
  if (q.include_moved !== '1') where.push('h.active = 1');
  if (q.zone) { where.push('u.zone = @zone'); p.zone = q.zone; }
  if (q.tenure) { where.push('h.tenure = @tenure'); p.tenure = q.tenure; }
  if (q.q) {
    where.push(`(h.head_name LIKE @q OR h.phone LIKE @q OR h.resident_code LIKE @q OR u.code LIKE @q
               OR EXISTS (SELECT 1 FROM occupants o WHERE o.household_id = h.id AND o.name LIKE @q))`);
    p.q = `%${str(q.q, 80)}%`;
  }
  return db.prepare(`SELECT h.*, u.code unit_code, u.zone, (SELECT COUNT(*) FROM occupants o WHERE o.household_id = h.id) people,
      r.name recorded_by_name FROM households h JOIN units u ON u.id = h.unit_id LEFT JOIN users r ON r.id = h.recorded_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.zone, u.code, h.active DESC LIMIT 2000`).all(p);
}

app.get('/api/households', requireAdmin, (req, res) => res.json({ households: registerRows(req.query) }));
app.get('/api/households/:id', requireAdmin, wrap((req, res) => {
  const h = householdDetail(Number(req.params.id));
  if (!h) throw new HttpError(404, 'Household not found.');
  res.json({ household: h });
}));

app.post('/api/households/:id/move-out', requireAdmin, wrap((req, res) => {
  const h = db.prepare('SELECT h.*, u.code FROM households h JOIN units u ON u.id = h.unit_id WHERE h.id = ? AND h.active = 1').get(Number(req.params.id));
  if (!h) throw new HttpError(404, 'No current household with that ID.');
  db.prepare('UPDATE households SET active = 0, moved_out_on = ?, updated_at = ? WHERE id = ?').run(str(req.body.date, 10) || now().slice(0, 10), now(), h.id);
  db.prepare("UPDATE units SET status = 'vacant', updated_at = ? WHERE id = ?").run(now(), h.unit_id);
  log(req.user.id, 'marked moved out', `${h.head_name} from ${h.code}`);
  res.json({ ok: true });
}));

app.get('/api/export.csv', requireAdmin, (req, res) => {
  const rows = registerRows({ ...req.query, include_moved: '1' });
  const cols = ['resident_code', 'unit_code', 'zone', 'tenure', 'head_name', 'phone', 'email', 'landlord_name', 'landlord_phone',
    'since_year', 'people', 'vehicles', 'consent_at', 'source', 'active', 'moved_out_on', 'created_at'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\r\n');
  log(req.user.id, 'exported register', `${rows.length} rows`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ilrcensus-register-${now().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
});

// ---------- static app ----------
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again, and tell the admin if it keeps happening.' });
});

// Clear expired sessions now and then.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 6 * 3600e3).unref();

app.listen(PORT, () => console.log(`ILRCensus running on http://localhost:${PORT}`));
