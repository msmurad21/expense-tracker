---
name: setup
description: Walk a user through connecting Expense Tracker to their Gmail inbox, from a fresh clone to seeing their first parsed subscriptions. Use when the user asks to set up, install, configure or connect this project, or says something like "set this up for me", "help me get started", or "connect my email".
---

# Setting up Expense Tracker for a user

Assume the person you are helping is **not a developer**. They may not know what
a terminal, an environment variable, or IMAP is. Explain in plain language, one
step at a time, and wait for them to confirm before moving on.

## The rule that overrides everything else

**Never ask the user to paste a password, App Password, OAuth code or API key
into this conversation.** Chat transcripts can be logged and synced. Credentials
go into a file that the user edits themselves, or into the app's own input.

If they paste one anyway:
1. Tell them immediately, without drama, that it needs replacing.
2. Send them to <https://myaccount.google.com/apppasswords> to revoke it — one
   click, and it affects nothing else in their Google account.
3. Have them generate a fresh one and put it straight into `.env.local`.

Do not continue using a credential that appeared in chat.

---

## Step 1 — Check the environment

```bash
npm run doctor -- --json
```

This returns structured state and contains nothing secret. Read `problems[]`;
each entry has a plain-language `message` and a `fix`.

If `node.ok` is false, point them at <https://nodejs.org> for the LTS build and
stop until it is resolved. Everything downstream depends on it.

If `DEPS_MISSING`, run `npm install`.

## Step 2 — Work out which route they need

Ask: **"Is your email a regular @gmail.com address, or a custom domain set up
through Google Workspace?"**

This is not a preference — it decides what is possible:

- **Personal `@gmail.com`** → App Password route. Continue to Step 3.
- **Google Workspace (custom domain)** → App Passwords were disabled by Google
  for Workspace in 2025. They need the Gmail API route, which is **not yet
  implemented** (M5). Tell them plainly, point at the "Workspace accounts"
  section of `docs/SETUP.md`, and stop. Do not have them try the App Password
  route — it will fail with a confusing authentication error.

## Step 3 — App Password

Walk them through it, one step at a time:

1. **2-Step Verification must be on first** — App Passwords do not exist
   without it: <https://myaccount.google.com/signinoptions/two-step-verification>
2. Then create the password: <https://myaccount.google.com/apppasswords>
3. Name it something like `Expense Tracker`.
4. Google shows 16 characters in four groups. **The spaces must be removed.**

Explain what it is, because handing an app a mailbox credential deserves
context: it lets this one program read their mail, it is not their real
password, it cannot be used to log in as them, and revoking it later takes one
click and breaks nothing else.

## Step 4 — Store it

Have **them** do this — you should never see the value:

```bash
cp .env.example .env.local
```

Then ask them to open `.env.local` in a text editor and fill in the two lines.
Confirm `.env.local` is gitignored (it is) so it cannot be committed.

## Step 5 — Discover, before importing anything

```bash
npm run sync -- --discover --limit 500
```

This writes nothing. It lists which senders the app can see, by DKIM-verified
domain.

Read the output back to them in plain terms: which bank was found, which
subscription services. If their bank is missing, retry with `--since-days 730`.

Explain the `(unverified)` entries if any appear: those messages had no valid
DKIM signature, so no parser will ever run against them. This is the app's main
defence against a forged bank alert, and it is normal for newsletters.

## Step 6 — First real sync

```bash
npm run sync
```

Report what was stored and which senders have no template yet.

## Step 7 — Write a template for their bank

The app cannot ship a template for every bank, and guessing one without seeing a
real email produces wrong numbers.

1. Read one already-synced email from the unmatched sender out of the local
   database — do **not** ask them to forward or paste one.
2. Work out where the amount, currency, date, merchant and card last-4 appear.
3. Write a template following `CONTRIBUTING.md`. It must pass
   `validateTemplate` — one capture group per pattern, no nested quantifiers,
   bound to the **DKIM-verified** domain.
4. Show them exactly what it extracted from a real message, in plain language:
   *"From this email I read: PKR 4,320.50 at NETFLIX.COM on 29 July, card ending
   4821. Does that look right?"*
5. Only after they confirm, mark it approved.

Never approve a template on their behalf. The approval gate is a security
boundary, not a formality.

## Step 8 — Show them something useful

```bash
npm run analyze
```

Walk them through what was found. Be careful not to overstate: a subscription
seen twice is provisional, and annual ones are low-confidence guesses.

---

## When something fails

`npm run doctor -- --json` first. Beyond that:

| Symptom | Cause |
|---|---|
| `AUTHENTICATIONFAILED` | 2-Step Verification off, spaces left in the password, or a Workspace account |
| `Could not reach Gmail` | Port 993 blocked — common on corporate, university and public Wi-Fi |
| Sync finds nothing | Window too narrow (`--since-days 730`), or alerts are filtered out of INBOX |
| Everything `(unverified)` | Unusual — real banks sign their mail; check the account |

## Tone

They are trusting this with their bank emails. Be concrete about what the app
does and does not do, and do not oversell. The honest framing — it finds
recurring charges on a card, it cannot tell you who signed up for them — is in
`README.md` and is worth repeating rather than glossing over.
