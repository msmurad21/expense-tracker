# Notes for Claude

Guidance for AI coding agents working in this repository.

## What this project is

A local-first desktop app (Electron, macOS + Windows) that reads a user's Gmail,
parses bank transaction alerts and subscription receipts, correlates them, and
detects recurring subscriptions. It handles someone's real financial data and
real email credentials.

## Helping a non-technical user set up

This is a first-class use case: someone clones the repo, opens it in Claude Code,
and says *"set this up for me"*. Follow `.claude/skills/setup/SKILL.md`.

**The one rule that matters most: never ask the user to paste a password,
App Password, OAuth code or API key into the chat.** Those would land in a
transcript that may be logged or synced. The app collects credentials itself —
your job is to run `npm run setup` and interpret what it says. If a user pastes
a credential anyway, tell them to revoke it at
<https://myaccount.google.com/apppasswords> and generate a new one.

Diagnose with `npm run doctor -- --json`, which returns structured state and
emits nothing secret.

## Commands

```bash
npm test                      # unit tests — run before claiming anything works
npm run typecheck
npm run doctor                # environment check; -- --json for machine-readable
npm run sync -- --discover    # list senders, writes nothing to the database
npm run sync                  # pull mail into the local database
npm run analyze               # subscriptions and spending summary
```

There is no way to run Electron or reach a real inbox in CI or a sandbox. The
core is testable without either; the UI is not.

## Non-negotiables

These are load-bearing. Changing one needs a deliberate decision, not a drive-by
refactor.

**Money is integer minor units plus an explicit currency.** Never a float. Never
summed across currencies without conversion. `parseMoneyMinor` refuses ambiguous
input rather than guessing — `1.005` in USD is either `1005` or `1.01`, and
picking one is a 1000× error on someone's money. If you are tempted to make it
"just handle" such a case, don't.

**Timestamps are ISO-8601 UTC, with `tz_source` recording how they were derived.**
Never pass a bank's date string to `new Date()` — the result varies by host
locale and engine, so the same email lands on different days for different users.

**Parse templates are data, not code.** No `eval`, no `new Function`, no dynamic
dispatch on template strings. Anywhere. Email is attacker-controlled input, and
the LLM fallback derives templates from it, so a template is downstream of a
hostile source by construction.

**Templates bind to DKIM-verified sender domains, never the `From` header.**
Anyone can spoof `From`. Unsigned mail must remain unparseable.

**Templates default to `pending` and only `approved` ones run.** Built-in
templates get no exemption — a mistake in ours hangs the app just as well as a
hostile one.

**Regex patterns are vetted before storage.** See `src/main/parsing/safeRegex.ts`.
Do not loosen it without reading the test that measures why it exists.

**`node:sqlite` is loaded via `createRequire`, deliberately.** It is absent from
`builtinModules`, so a static import makes bundlers try to resolve a package
named "sqlite" and fail with `Failed to load url sqlite`. This looks like a
mistake and is not.

**Nothing privileged in the renderer.** IMAP, OAuth, SQLite and LLM calls live
in the main process. No credential ever crosses IPC in the returning direction —
`setLlmApiKey` exists, `getLlmApiKey` does not.

**Never commit a real email.** Not redacted either. Fixtures are hand-written
synthetic samples in `tests/fixtures/`.

## Layout

```
src/main/db/            Db port over node:sqlite, schema, migrations
src/main/mail/          MailSource interface, ImapSource, (planned) GmailApiSource
src/main/parsing/       safeRegex, templateSchema, evaluator, money, dates
src/main/subscriptions/ cadence detection
src/main/ingest/        sync orchestration, storage
src/main/analytics/     aggregation for the dashboard
src/renderer/           React UI
src/shared/             cross-process types
scripts/                doctor, setup, sync, analyze
```

## Things that will bite you

- **Bank alerts arrive twice** — an authorisation and then a settlement, often
  for different amounts. Deduplicate before any recurrence analysis, or every
  subscription looks like it bills twice a month.
- **Cadence must be calendar-aware.** A subscription anchored on the 31st bills
  31 Jan → 28 Feb → 31 Mar. Averaging gaps calls that irregular. And after
  clamping to Feb 28 it returns to the 31st, so the anchor is carried separately
  rather than derived from the previous date.
- **Cross-currency subscriptions drift 1–3% monthly on FX alone.** With a PKR
  card and USD subscriptions that is most of them, so amount-equality matching
  fails and naive price-change detection fires every single month. Correlate on
  merchant and date; treat amount as corroboration.
- **Aggregator receipts fan out.** One Apple or Google Play charge can settle
  several subscriptions, so `subscription_charges` is many-to-many. Don't
  "simplify" it to 1:1.
- **`emails` is separate from `transactions` on purpose**, so the whole inbox
  can be reprocessed when a parser improves, with no re-download. User
  corrections live in `user_overrides` and must be re-applied after a reprocess,
  never clobbered by it.

## Claims to avoid making

The README is deliberately honest about three limits. Don't build features that
contradict them:

- The app **cannot** tell you who started a subscription. Recurring charges are
  merchant-initiated and carry no device information.
- The app **cannot** detect unused subscriptions. It observes *charged*, never
  *used*. "Unused" is a user-applied tag.
- Annual subscriptions need ~3 years of mail to confirm, so they are surfaced as
  low-confidence guesses and labelled as such.
