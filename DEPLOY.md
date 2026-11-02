# Testing and going live with ILRCensus

There are three stages. Stage 1 runs on your own computer, takes about 15 minutes and costs nothing.

---

## Stage 1. Try it on your computer

1. **Install Node.js.** Download the "LTS" version from https://nodejs.org and install it like any other program.
2. **Unzip `ilrcensus.zip`** somewhere easy to find, such as your Desktop.
3. **Open a terminal in that folder.**
   - Windows: open the `ilrcensus` folder, click the address bar, type `cmd` and press Enter.
   - Mac: open Terminal, type `cd ` (with a space), drag the `ilrcensus` folder into the window, and press Enter.
4. **Install and load the demo estate.** Type these one at a time and press Enter after each:
   ```
   npm install
   npm run seed:demo
   npm start
   ```
5. **Open http://localhost:3000** in your browser. Leave the terminal window open while you test.

### Things to try

| As | Do this |
|---|---|
| Resident | Click **Register as a new resident**, fill in the form, and note the reference number. |
| Enumerator | Sign in as `amaka` with password `demo1234`. Open a grey unit, record a household, and mark another one as "Nobody home". |
| Enumerator offline | Still signed in as amaka, press F12, open the **Network** tab, and tick **Offline**. Record another household. The top bar shows "Offline · 1 waiting". Untick Offline and it sends by itself. |
| Admin | Use a private or incognito window and sign in as `admin` / `demo1234`. Approve the resident's request, create an enumerator account, add a street of units, and download the register as CSV. |
| Dark mode | Click the **Auto** button at the top right. |

To start again from scratch, stop the server (Ctrl+C), delete the `data` folder, and run `npm run seed:demo` and `npm start` again.

---

## Stage 2. Put it online (recommended host: Railway)

Railway runs the app and keeps the database on a disk that survives restarts. Expect to pay about US$5 a month for an estate this size; check railway.com for current pricing. Free hosts that wipe their disk on restart, such as Render's free plan, **will lose your data**, so don't use them for this app.

1. **Put the code on GitHub.** Create a free account at https://github.com, create an empty **private** repository named `ilrcensus`, and send Claude its name. Claude will push the code there.
2. **Create the Railway project.** Sign up at https://railway.com with your GitHub account. Click **New Project**, choose **Deploy from GitHub repo**, and pick `ilrcensus`.
3. **Add a disk for the database.** In the project, right-click the service, choose **Attach volume**, and set the mount path to `/data`.
4. **Add the settings.** Under **Variables**, add:
   | Name | Value |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `SECURE_COOKIE` | `1` |
   | `ADMIN_USERNAME` | a username for yourself |
   | `ADMIN_PASSWORD` | a long password only you know |
5. **Get the web address.** Under **Settings → Networking**, click **Generate Domain**. You'll get an address like `ilrcensus-production.up.railway.app`. Railway serves it over HTTPS, which offline mode needs.
6. **Optional: use your own address.** If the estate owns a domain, add it under the same Networking section, for example `census.ilraestate.com`.

Do **not** run `seed:demo` on the live site.

---

## Stage 3. Before the census starts

1. Sign in as admin and change your password.
2. Under **Estate setup**, add every block or street and its units.
3. Under **Enumerators**, create an account for each enumerator and give them their temporary password in person.
4. Assign each block or street to an enumerator.
5. Ask every enumerator to open the site on their phone with signal, sign in, set their password, and choose **Add to Home screen** (Android: browser menu; iPhone: Share button).
6. Do a practice run. Each enumerator records one real unit with mobile data switched off, then turns data back on and checks that it sends.
7. Share the site address with residents for new registrations, for example on the gate notice board or in the estate WhatsApp group.

### Keeping the data safe

- Download the register as CSV from **Resident register** each week and keep it somewhere private.
- Only give admin accounts to people the estate committee approves.
- When an enumerator finishes, switch their account off under **Enumerators**.
- The estate must follow the Nigeria Data Protection Act 2023 because this is personal data.
