# Contributing

The most useful thing you can add is **a parse template for a bank or service
the app doesn't recognise yet**. It needs no knowledge of the rest of the
codebase, takes a few minutes, and immediately helps everyone with the same bank.

## Ground rule: never commit a real email

Not even a redacted one. Redaction is easy to get wrong, and a leaked card
number cannot be withdrawn. Every fixture in `tests/fixtures/` is hand-written
to imitate the *structure* of a real alert while containing no real data. Do the
same.

The same applies to issues and pull request descriptions.

---

## Adding a parse template

A template says which fields to pull out of an email and how to interpret them.
It is **data, not code** — there is no way to express behaviour, only extraction.

```ts
{
  name: 'HBL debit card alert',
  senderDomain: 'hbl.com',        // must be the DKIM-verified domain
  subjectPattern: 'Transaction Alert',
  kind: 'bank_alert',             // or 'receipt'
  origin: 'builtin',
  status: 'pending',              // built-ins are approved by the user, like any other
  rules: [
    { field: 'currency',    pattern: 'Amount:\\s*([A-Z]{3})',                  type: 'currency',    required: true },
    { field: 'amount',      pattern: 'Amount:\\s*[A-Z]{3}\\s*([\\d,]+\\.\\d{2})', type: 'money_minor', required: true },
    { field: 'merchant',    pattern: 'Merchant:\\s*(.+)',                      type: 'string',      required: true },
    { field: 'card_last4',  pattern: 'ending\\s+(\\d{4})',                     type: 'last4',       required: true },
    { field: 'occurred_at', pattern: 'Date & Time:\\s*([\\d/]+\\s+[\\d:]+)',   type: 'date',        required: true },
  ],
}
```

### Field types

| Type | Produces | Notes |
|---|---|---|
| `money_minor` | integer minor units | Needs a `currency` field, or a `fallback` currency on the rule |
| `currency` | ISO-4217 code | Understands `Rs`, `₨`, `US$`, `€` and similar |
| `date` | ISO-8601 UTC | Also records how the timezone was resolved |
| `last4` | four digits | For card identification |
| `string` | trimmed text | Whitespace collapsed |

### Rules your pattern must satisfy

Validation will reject it otherwise:

- **Exactly one capture group.** Use `(?:…)` for grouping you don't want captured.
- **No nested quantifiers.** `(\d+)+` and `([a-z]+)*` are rejected — they cause
  catastrophic backtracking and can hang the app on a crafted email.
- **No backreferences.** No legitimate use here.
- **Under 300 characters**, with no repetition count above 100.
- `senderDomain` must be a **bare domain** — `hbl.com`, not `https://hbl.com`
  or `alerts@hbl.com`. Subdomains of it match automatically.

A `bank_alert` template must extract `amount` and `occurred_at`. A `receipt`
template must extract `amount`. Anything extracting `amount` needs a way to know
the currency.

### Getting the pattern right

Sync your own mail, then let the tooling find the sample:

```bash
npm run sync -- --discover     # confirm the DKIM domain
npm run sync
```

Then open the project in Claude Code and say *"add a parse template for
`<domain>`"*. It reads a real email from your own database, writes the template,
and shows you what it extracted — nothing is committed automatically.

### Testing it

Add a synthetic fixture to `tests/fixtures/synthetic.ts` and a case to
`tests/parsing.test.ts`:

```bash
npm test
```

---

## Development

```bash
npm install
npm test           # unit tests
npm run typecheck
npm run doctor     # environment check
```

### Layout

```
src/
  main/            Electron main process — ALL privileged code lives here
    db/            schema, migrations, the Db port over node:sqlite
    mail/          MailSource interface + IMAP and Gmail API implementations
    parsing/       template validation, the evaluator, money and date parsing
    subscriptions/ recurrence detection
    ingest/        sync orchestration and storage
  preload/         the only main↔renderer bridge
  renderer/        React UI — no Node access, no credentials, no database
  shared/          types used across processes
```

### Conventions worth knowing before you start

- **Money is always integer minor units plus an explicit currency.** Never a
  float, never summed across currencies without conversion. `parseMoneyMinor`
  refuses ambiguous input rather than guessing — `1.005` in USD could be `1005`
  or `1.01`, and guessing is a 1000× error on someone's money.
- **Timestamps are ISO-8601 UTC**, with `tz_source` recording how a local time
  was resolved. Never pass a bank's date string to `new Date()`; its behaviour
  varies by host locale and engine.
- **`node:sqlite` is loaded via `createRequire`.** It is deliberately absent
  from `builtinModules`, so a static import makes bundlers try to resolve a
  package called "sqlite" and fail confusingly. Don't "fix" it back.
- **Nothing privileged in the renderer.** IMAP, OAuth, SQLite and any LLM calls
  live in the main process. The renderer receives data through a closed set of
  named IPC methods and never sees a credential.
- **New parsing behaviour needs a test.** The parser is the part most likely to
  break silently, and it is the part with no safety net other than tests.

---

## Pull requests

Keep them focused. A template addition should be one template. Explain what you
changed and why, and mention anything you couldn't verify.

By contributing you agree your work is licensed under the [MIT Licence](LICENSE).
