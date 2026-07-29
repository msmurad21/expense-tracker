# Security

This app reads your email and builds a record of your finances. This document
states plainly what it protects, what it does not, and why.

## Reporting a vulnerability

Please open a [security advisory](https://github.com/msmurad21/expense-tracker/security/advisories/new)
rather than a public issue.

**Never attach a real email to a report** — not even a redacted one. Redaction is
easy to get wrong, and a leaked card number cannot be withdrawn. Hand-write a
synthetic sample like the ones in `tests/fixtures/`.

---

## Threat model

The realistic attacker is **someone who can send you an email**, which is
everyone. They cannot read your inbox, but they can put anything they like into
a message that lands in it, including a perfect copy of your bank's alert
format with your bank's name in the `From` header.

That matters because this app *parses email into financial records*. Without
care, a forged email becomes a fabricated transaction, a corrupted balance, or
a hung application.

### What is done about it

**Templates are bound to DKIM-verified sender domains.**
Gmail verifies DKIM signatures on receipt and records the verdict in an
`Authentication-Results` header. A template minted from mail that genuinely
passed DKIM for `hbl.com` will only ever run against mail that also passes DKIM
for `hbl.com`. The `From` header is never consulted, because anyone can write
anything there. Messages with no valid signature are parsed by nothing at all.

Only the topmost `Authentication-Results` header is trusted — Gmail prepends its
own on delivery, and any header below it may have been written by the sender.

**Parse templates are data, never code.**
There is no `eval`, no `new Function`, and no dynamic dispatch on any
template-supplied string anywhere in the parsing path. A template declares which
field to capture and how to coerce it; a fixed evaluator over a closed set of
types does the work. The worst a hostile template can express is a bad regex.

**Regex patterns are vetted before they are stored.**
Patterns of the form `(a+)+` cause catastrophic backtracking — measured in this
repo's own test suite at over 50 ms for 23 characters, doubling per character,
so a ~35-character subject line would hang for hours. Since the hung process
also owns the database and the IPC channel, that is a full application freeze
triggered remotely by anyone who can email you. Nested quantifiers,
backreferences, oversized repetitions and overlong patterns are rejected
structurally before storage.

**Nothing parses until a human approves it.**
Templates default to `pending`. Only `approved` ones run, and approval means a
person looked at what the template extracted from a real message. This applies
to the templates that ship with the app, which are validated by exactly the same
rules — a mistake in ours hangs the app just as effectively as a hostile one.

**Raw HTML is never rendered.**
Email bodies are converted to plain text in the main process. Rendering bank
HTML would load tracking pixels — telling the sender when you read it, which
defeats the app's no-telemetry stance from the other direction — and would hand
attacker-controlled markup straight to a renderer.

---

## Credentials

Your Gmail App Password or OAuth refresh token is encrypted with Electron
`safeStorage` and stored as ciphertext. The encryption key lives in the OS
keychain: macOS Keychain, Windows DPAPI, or libsecret/kwallet on Linux.

**No secret is ever returned across the IPC boundary.** The UI can set a
credential; there is no method to read one back. It sees only
`{ hasKey: true, hint: "…4f2a" }`.

Two honest limitations:

- **On Linux, `safeStorage` can silently downgrade.** With no available secret
  store it encrypts using a hardcoded password while still reporting that
  encryption is available. The app checks the selected backend and refuses to
  store a credential when it reports `basic_text`, rather than pretending.
- **This is not protection against malware running as you.** The key can be
  fetched unattended by the app, so anything running under your user account can
  ask for it too. What it does protect against is a stolen disk image, a cloud-
  synced application-support folder, and a backup.

The command-line scripts are different, and deliberately so: they read
`.env.local`, which is gitignored but **not encrypted**. That file is a
development convenience. The desktop app never reads it.

---

## Data at rest

**The database is not encrypted.** It holds your transactions, merchant names
and email bodies in plaintext, and relies on full-disk encryption — FileVault on
macOS, BitLocker on Windows.

This is a deliberate trade-off. SQLCipher would encrypt it, but it is a native
module that compiles from source, which would require a C++ toolchain on the
user's machine and break the app's core promise that a non-technical user can
install it. Given the key would have to be stored locally anyway, the additional
protection against the realistic threats is small.

Stated here rather than left implied, because "local-first" is easy to read as
"encrypted", and it is not.

---

## Network

The app makes no outbound connections except:

1. Your mail provider (Gmail IMAP or the Gmail API).
2. The Anthropic API — **only** if you explicitly enable the LLM fallback and
   supply your own key. It is off by default, and the app is fully functional
   without it.

There is no telemetry, no analytics, no crash reporting, and no update check.

The renderer process is served under a Content-Security-Policy with
`connect-src 'none'`. It has no legitimate need to open a socket, so a
renderer-side XSS cannot exfiltrate your data — it can only call the enumerated
IPC methods.

---

## What is not covered

- A compromised machine. Malware running as you can read the database directly.
- A compromised Google account. If someone controls your inbox they can send
  themselves signed mail from domains you trust.
- Physical access to an unlocked machine.
