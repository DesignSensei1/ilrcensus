# ILRCensus

Resident census and new-resident registration for ILRA Estate.

The census team visits every unit once and records each household. That record becomes the estate's
resident register. After the census, people moving in register on the public page, and an enumerator or
the estate admin approves them, which keeps the same register current.

## Who does what

| Role | Signs in? | Can |
|---|---|---|
| Estate admin | Yes | See progress, add blocks/streets and units, create enumerator accounts, assign units, approve or reject new residents, search and export the register, mark households as moved out |
| Enumerator | Yes (account made by the admin) | See the unit map, record households door to door (works offline), mark units vacant / nobody home / declined, approve or reject new residents |
| Resident | No | Register as a new resident, check the request with the reference and phone number |

Enumerators only see household details for units assigned to them or records they made. The full register is admin only.

## What is recorded

- Unit: code, block or street, type, census status
- Household: occupancy (owner-occupier, tenant, caretaker), year moved in, vehicles
- Household head: name, phone, optional email; landlord name and phone for rented units
- Everyone who lives there: name, relation to head, age group (not date of birth), optional phone
- Consent: who agreed and when, and who recorded it. Nothing is saved without consent.

Each household gets a resident ID such as `ILRA-A03-01` (estate, unit, household number for that unit).

## Offline use for enumerators

ILRCensus is an installable web app (PWA). After an enumerator signs in once with signal:

- the app opens without signal (service worker caches it)
- the unit list is kept on the phone
- household forms and unit status updates are saved on the phone and sent automatically when the phone is back online; the top bar shows how many are waiting
- each saved form carries an ID, so a form sent twice is only recorded once
- unfinished forms are kept as drafts if the app is closed mid-visit

Signing in, approving new residents, and viewing existing records need signal.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. On the first start the server prints an admin username and a one-time
password; you are asked to change it after signing in. To choose them yourself:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='something-long' npm start
```

To try it with a fictional estate (only on an empty database):

```bash
npm run seed:demo   # Blocks A to C, users admin / amaka / tunde, password demo1234
```

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the SQLite database file is kept. Back this folder up. |
| `ESTATE_CODE` | `ILRA` | Prefix for resident IDs |
| `SECURE_COOKIE` | off | Set to `1` when served over HTTPS (it should be in production) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | generated | First admin account, used only when the database has no users |

### Deploying

Any host that runs Node and keeps a disk works (a small VPS, Render or Railway with a persistent volume, Fly.io with a volume).
Serve it over HTTPS: phones only allow offline mode and "Add to Home screen" on HTTPS sites. Back up `DATA_DIR` daily.

## Privacy

This app holds personal data. Before going live the estate should:

- agree who the "estate office" is and who gets admin accounts
- keep the consent statement (in `public/app.js`, `CONSENT_TEXT`) in line with what the estate actually does
- decide how long moved-out households are kept, and delete them after that
- follow the Nigeria Data Protection Act 2023

## Project layout

```
server.js         API, sign-in, approvals, export
db.js             SQLite schema
public/           the web app (index.html, app.js, app.css, sw.js, manifest, icons)
scripts/seed-demo.js
```

## Not built yet

- SMS or WhatsApp confirmation to residents when they are approved
- Residents viewing or correcting their own record online (today they ask the estate office)
- Photo or ID document upload
- Automatic deletion of old moved-out records
