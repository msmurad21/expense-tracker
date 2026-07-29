# Setup

How to point this at your real Gmail inbox and see your actual subscriptions.

Takes about ten minutes. Nothing you do here sends data anywhere except to
Google, from your own machine.

---

## Before you start

You need:

- **Node.js 22.13 or newer.** Check with `node -v`. If it's older or missing,
  get the LTS build from [nodejs.org](https://nodejs.org).
- **A personal `@gmail.com` account.** If your email is a custom domain on
  Google Workspace, skip to [Workspace accounts](#workspace-accounts) — the App
  Password route was disabled by Google in 2025 and will not work for you.

```bash
git clone https://github.com/msmurad21/expense-tracker.git
cd expense-tracker
npm install
npm run doctor
```

`npm run doctor` tells you in plain language whether anything is missing. Come
back here once it says *Everything looks good*.

---

## Step 1 — Turn on 2-Step Verification

App Passwords do not exist without it. If you already have it on, skip ahead.

1. Go to <https://myaccount.google.com/signinoptions/two-step-verification>
2. Follow the prompts.

---

## Step 2 — Create an App Password

An App Password is a 16-character credential that lets one specific program read
your mailbox, without giving it your real password and without it being able to
touch anything else in your Google account. You can revoke it at any time, and
doing so affects nothing else.

1. Go to <https://myaccount.google.com/apppasswords>
2. Give it a name — `Expense Tracker` works.
3. Google shows you 16 characters in four groups, like `abcd efgh ijkl mnop`.
4. Copy them **with the spaces removed**: `abcdefghijklmnop`

> **If that page says the option isn't available**, 2-Step Verification isn't
> fully enabled yet, or you are on a Workspace account. See
> [Workspace accounts](#workspace-accounts).

---

## Step 3 — Put the credentials in `.env.local`

```bash
cp .env.example .env.local
```

Open `.env.local` and fill it in:

```
GMAIL_USER=you@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
```

`.env.local` is gitignored and will never be committed. If you ever paste your
App Password somewhere by accident, revoke it at
<https://myaccount.google.com/apppasswords> — it takes one click, and nothing
else in your account is affected.

> **A note on where credentials live.** This file is only used by the
> command-line scripts. The desktop app stores your App Password in the OS
> keychain (macOS Keychain, Windows DPAPI) via Electron `safeStorage`, and never
> reads `.env.local`.

---

## Step 4 — See who sends you money mail

Start here. This connects to Gmail, reads nothing into the database, and just
tells you which senders it can see:

```bash
npm run sync -- --discover --limit 500
```

You'll get something like:

```
Senders seen (by DKIM-verified domain):

     84  hbl.com
     12  netflix.com
      9  apple.com
      6  spotify.com
      3  openai.com
      2  (unverified) some-newsletter.example
```

**What "(unverified)" means:** that mail either had no DKIM signature or failed
verification. No parse template will ever run against those messages — that's
the app's main defence against someone emailing you a fake bank alert. It is
normal for newsletters and small senders to appear here.

If your bank isn't in the list, widen the window:

```bash
npm run sync -- --discover --since-days 730
```

---

## Step 5 — Pull the mail in

```bash
npm run sync
```

This stores the messages locally and reports what it could and couldn't parse:

```
Scanned 412 message(s).
Stored 412 new, skipped 0 already present.

Senders with no approved template yet:

     84  hbl.com        e.g. "Transaction Alert - HBL Debit Card"
     12  netflix.com    e.g. "Your Netflix receipt"
```

Run it again any time. It resumes where it left off, and re-running can never
double-count — every message is keyed by its `Message-ID`, so even a wrong or
reset resume point costs re-downloading, never duplicate transactions.

---

## Step 6 — Teach it your bank's format

The app ships with templates for common international services, but it cannot
ship one for every bank in the world, and a template guessed without seeing a
real email would produce wrong numbers.

**The easy way.** Open the project in [Claude Code](https://claude.com/claude-code)
and say:

> add a parse template for hbl.com

It will read one of the already-synced emails from that sender, work out where
the amount, date, merchant and card digits are, and write a template. You'll be
shown exactly what it extracted before anything is approved.

**The manual way.** See [CONTRIBUTING.md](../CONTRIBUTING.md) — a template is a
small declarative object, and writing one takes a few minutes.

Either way, **nothing parses until you approve it.** That applies to built-in
templates too.

---

## Step 7 — See your subscriptions

```bash
npm run analyze
```

---

## Workspace accounts

If your email is on a custom domain through Google Workspace, App Passwords are
not available — Google removed Basic Auth for Workspace in 2025. You need the
Gmail API route, which uses OAuth with your own Google Cloud project.

That path is **planned but not yet implemented** (tracked as M5). Two things
worth knowing about it in advance:

- `gmail.readonly` is a *restricted* scope. Publishing a shared app that uses it
  would require an annual third-party security assessment costing thousands, so
  every user brings their own Google Cloud credentials instead. That is the
  reason for the extra setup, not an oversight.
- A Google Cloud OAuth app left in *Testing* status expires its refresh tokens
  **every 7 days**, which would mean re-authenticating weekly. The setup will
  walk you through publishing your own project to *Production* status to avoid
  that.

---

## Troubleshooting

Run `npm run doctor` first — it checks most of this and explains what to do.
For an agent-readable version, `npm run doctor -- --json`.

**"Gmail rejected the username or App Password"**
1. Is 2-Step Verification actually on?
2. Did you remove the spaces from the 16 characters?
3. Is this a Workspace account? See above.

**"Could not reach Gmail"**
Port 993 is likely blocked — common on corporate, university and some public
Wi-Fi networks. Try another connection.

**Sync finds nothing**
Widen the window with `--since-days 730`. Also check whether your bank's alerts
are being filtered out of the inbox into another label — the app currently reads
`INBOX` only.

**Everything shows as "(unverified)"**
Unusual. Real banks and subscription services sign their mail. Double-check you
are looking at the right account.

---

## Your data, and how to remove it

Everything lives in one SQLite file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/ExpenseTracker/expense-tracker.db` |
| Windows | `%APPDATA%\ExpenseTracker\expense-tracker.db` |
| Linux | `~/.config/ExpenseTracker/expense-tracker.db` |

`npm run doctor` prints the exact path. To erase everything the app knows,
delete that file and `.env.local`, then revoke the App Password at
<https://myaccount.google.com/apppasswords>.

Note that this file is **not encrypted** — it relies on your disk encryption
(FileVault, BitLocker). Your credentials are handled separately and are
encrypted. See [SECURITY.md](../SECURITY.md).
