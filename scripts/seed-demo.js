// Fills an empty database with a fictional demo estate so you can try ILRCensus.
// Usage: npm run seed:demo   (do not run on the real database)
const bcrypt = require('bcryptjs');
const db = require('../db');

if (db.prepare('SELECT COUNT(*) n FROM units').get().n > 0) {
  console.log('Units already exist. The demo seed only runs on an empty estate.');
  process.exit(1);
}
const addUser = db.prepare('INSERT OR IGNORE INTO users (name, username, password_hash, role, must_change_password) VALUES (?,?,?,?,0)');
const hash = bcrypt.hashSync('demo1234', 10);
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) addUser.run('Estate admin', 'admin', hash, 'admin');
addUser.run('Amaka Obi', 'amaka', hash, 'enumerator');
addUser.run('Tunde Bello', 'tunde', hash, 'enumerator');
const amaka = db.prepare("SELECT id FROM users WHERE username='amaka'").get().id;
const tunde = db.prepare("SELECT id FROM users WHERE username='tunde'").get().id;

const addUnit = db.prepare('INSERT INTO units (code, zone, type, assigned_to) VALUES (?,?,?,?)');
['A', 'B', 'C'].forEach((b, i) => { for (let n = 1; n <= 10; n++) addUnit.run(`${b}${String(n).padStart(2, '0')}`, `Block ${b}`, 'Flat', i === 0 ? amaka : i === 1 ? tunde : null); });
console.log('Demo estate added: Blocks A to C, 30 flats.');
console.log('Sign in as admin, amaka or tunde with password demo1234.');
