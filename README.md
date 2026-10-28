# ShareCost

**English** | [简体中文](README.zh-CN.md)

Track together. Split fairly.

**Free online hosting:** [Deploy with GitHub Pages + Supabase](DEPLOY.md) ([中文步骤](DEPLOY.zh-CN.md)). The frontend and SQL migration are prepared; database initialization and Pages enablement are required before the live shared ledger works.

ShareCost is a lightweight shared expense web app for friends, roommates, families, and travel groups. Each person signs in with their own account and joins the same ledger using an invite code. Inspired by iCost’s simple bookkeeping experience, with an original interface and brand. It does not connect to iCost accounts or data.

## Local quick start

Local Python mode requires **Python 3.10+**, with no dependency installation or frontend build step.

```sh
git clone git@github.com:JialongWang1201/ShareCost.git
cd ShareCost
./start.sh
```

Open **http://127.0.0.1:8765** in your browser. Press **Ctrl+C** in the terminal to stop the server. Alternatively, run `python3 server.py`.

The Linux desktop launcher `启动记账.desktop` uses the original installation path, `/home/wjl/Desktop/ShareCost`. Update its `Exec` and `Path` fields if you install elsewhere, or use the terminal commands above.

## English and Chinese

Use the **English / 中文** button in the top bar to switch languages. It is also available on the first-login screen before you create a ledger.

- The initial language follows your browser’s language; your choice is remembered on that browser.
- Navigation, forms, categories, dates, charts, messages, and CSV column names follow the selected language.
- Switching languages keeps your current ledger, month, and filters. It does not change stored transactions or amounts.
- Your ledger names, member names, and notes remain exactly as entered. Only sample content and interface labels are translated.

## Share a ledger

1. Select **Log in / Sign up** and create an account with your name, email, and a password of 8–128 characters. The local version uses email as a login identifier without verification. The hosted Supabase version follows your project’s email confirmation settings.
2. Create a ledger, choose its currency, and optionally set a monthly budget.
3. Copy the invite code from **Members** or **Invite** in the top bar.
4. Other members create their own accounts, select **Join a ledger**, and enter the code.
5. All members can view and add transactions. An entry’s creator or the ledger owner can edit or delete it. The owner manages the budget and invite code.

For multiple devices on the **same local network**, run:

```sh
./start.sh --host 0.0.0.0
```

Other devices can then visit `http://YOUR-COMPUTER-LAN-IP:8765`. Keep the computer and server running, and allow the port through your local firewall. The default host, `127.0.0.1`, permits access only from this computer. Access across different networks requires deployment to a server with HTTPS; use the free GitHub Pages + Supabase setup in [DEPLOY.md](DEPLOY.md), or a server with persistent storage.

Each browser profile has one login session. Use different browsers or a private window to try multiple accounts on one computer.

## Features

- Separate accounts, PBKDF2 password hashing, and HttpOnly sessions.
- Multiple shared ledgers with invite codes and code rotation.
- Automatic sync every 15 seconds while the page is visible and no dialog is open.
- Income and expense entries with dates, categories, notes, and payer or recipient selection.
- Equal or custom splits among all or selected members.
- Integer-cent arithmetic with exact allocation of rounding remainders.
- All-time member balances, suggested transfers, and settlement history, with protection against duplicate overpayment records.
- Monthly totals, category breakdowns, daily spending charts, and budgets.
- Search, income/expense filters, and CSV exports with each member’s share.
- Responsive desktop and mobile layouts, English/Chinese switching, and a clearly marked read-only demo.

## How splitting works

For an **expense**, the payer advances the money and selected members bear their shares. For **income**, the recipient receives the money and selected members are entitled to their shares. Select only yourself for personal income, such as your salary.

For example, if Alex pays 100.00 for Alex, Jamie, and Sam, an equal split allocates 33.34, 33.33, and 33.33. Jamie and Sam each owe Alex 33.33. Remainders are assigned one cent at a time in the order of selected members.

Settlement suggestions use **all historical transactions**, regardless of the selected month or search filters. A settlement records a transfer already made outside the app; it does not execute a payment. Only the payer, recipient, or ledger owner can confirm it. Editing a historical transaction recalculates balances and may create new suggested transfers, even if an earlier balance was settled.

Each ledger uses a single currency, fixed at creation. There is no currency conversion; create separate ledgers for different currencies. The monthly budget is the same total expense target for every month.

## Storage and backups

In local mode, accounts and transactions are stored in **`data/sharecost.sqlite3`** and survive server restarts. Cloud mode uses Supabase Auth and PostgreSQL instead. In local mode, browser storage remembers your language and last selected ledger. In cloud mode, the Supabase SDK also stores and refreshes the login session; account and transaction data live in Supabase. Demo content and test data are not written to the real database.

To back up your data, stop the server and copy the entire `data/` directory. To move to another computer, copy the project together with that directory. The database, QA screenshots, and Python caches are excluded from Git.

## Validation

```sh
python3 -m unittest discover -s tests -v
node --check web/app.js
node --check web/i18n.js
node --test tests/i18n.test.mjs
# Optional cloud build and PostgreSQL permission tests:
npm ci
npm run build
npm test
```

The integration test runs real HTTP requests against an isolated temporary database. It covers accounts, access control, invitations, cent rounding, amount validation, shared income, editing, deletion, concurrent settlements, and persistence across a server restart.

The optional browser test uses an installed Chromium instance with a local debugging endpoint at port `9224`:

```sh
chromium --headless --disable-gpu --remote-debugging-port=9224 \
  --user-data-dir=/tmp/sharecost-browser-qa about:blank
node tests/browser-qa.mjs
# After npm run build, also check the static cloud build:
node tests/pages-browser-qa.mjs
```

It uses a separate temporary database and checks real forms, language switching and persistence, translated search and exports, preservation of user content, and desktop/mobile layouts. Screenshots are written to the ignored `qa/` directory. Stop the debugging browser when finished.

## Project structure

```text
server.py          Python HTTP API and SQLite storage
web/index.html     App shell
web/app.js         UI and interactions
web/i18n.js        English translations and language preference
web/backend.js     Local / Supabase transport
web/config.js      Public project configuration
supabase/          Cloud SQL schema and authorized RPC
DEPLOY.md          Free hosting instructions
web/style.css      Responsive styles
start.sh           Launcher; accepts --host and --port
tests/             HTTP, translation, and browser checks
README.zh-CN.md    Chinese documentation
```

Design reference: [iCost](https://www.icostapp.com/). ShareCost uses original branding and UI assets.
