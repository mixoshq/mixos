# Verified publishers and an opt-in kill switch (spec, waiting on mixos.org)

**Status:** proposed, 28 November 2026. A specification for both repositories.
Nothing in MixOS is built yet, by the plan's own order: Item 10 of
[`20261127_1649-runtime-isolation-hardening.md`](20261127_1649-runtime-isolation-hardening.md)
lands "once mixos.org's half is ready". This fixes the wire formats, so the
two halves meet, and says what each side does.

**Scope:** the signed texts mixos.org produces, the install record, the update
check's answer, and what MixOS shows and does with them.

## Context

mixos.org signs each release with Ed25519 over one canonical text,
`mixos-release-v1`: a line per field in a fixed order, built identically in
`src/lib/repository/release-signature.ts` here and
`src/lib/registry/release-signature.ts` in the mixos-org repository, which test
the same vectors. Two things a malicious-publisher threat model wants are
missing:

- **Who published it.** The install record names a GitHub repository, but
  nothing says anyone checked who owns it.
- **A way to stop a known-bad release fast.** The daily update check shows a
  withdrawn release with its reason and a Deactivate button, and never acts.
  Its answer isn't signed, so it couldn't safely act.

Both need mixos.org to sign something new. MixOS must verify it before it
shows or does anything.

## 1. Verified publisher

**On mixos.org** (its own work): verify a publisher by a domain (a DNS TXT
record) or a GitHub organisation it administers, and require 2FA to publish.
Record `verified`, a display `name` and the `method` on the publisher.

**The signed text, `mixos-release-v2`.** Every line of v1, in order, then
three more:

```
mixos-release-v2
kind=<kind>
slug=<slug>
version=<version>
tag=<tag or empty>
commit=<40 hex>
hash=<content hash>
algorithm=<content hash algorithm>
requires-mixos=<floor or empty>
publisher-verified=<true|false>
publisher-name=<name, or empty when not verified>
publisher-method=<domain|github-org, or empty when not verified>
```

- No field may contain a line break, as in v1.
- `publisher-name` is at most 64 printable characters.
- A release published before verification is signed with
  `publisher-verified=false` and the two empty.

**The install manifest** gains `signatureFormat` (`"mixos-release-v1"` or
`"mixos-release-v2"`) and, for v2, `publisher: { verified, name, method }`.

**MixOS verifies** whichever format the manifest names, against the pinned keys
(`MIXOS_ORG_KEYS`), exactly as today:

- **v1** still installs, and shows no publisher.
- **v2**'s `publisher` is believed only because the signature covers it. A v2
  manifest whose publisher fields don't match the signed text fails, as a
  tampered v1 manifest does today.

**The install record, `.registry.json` v2.** This is a versioned schema change:
`schema-urls.ts` bumps `registry-install` to version 2. The record gains
`signatureFormat` and `publisher` (nullable). v1 records are still read, and
read as `publisher: null`. Install writes v2 from then on.

**What is shown.** "Verified publisher · \<name\>" only when an install
record's `publisher.verified` is true:

- on Browse, from the verified manifest;
- in the register review;
- on the tile;
- on the Reach page, as a label in `src/lib/apps/labels.ts` with its
  definition: "mixos.org checked who published this, by \<method\>. It says
  nothing about whether the code is safe."

It is never derived from a listing's unsigned text.

## 2. An opt-in kill switch

**The signed text, `mixos-withdrawal-v1`,** for a withdrawal mixos.org marks
as a security matter:

```
mixos-withdrawal-v1
kind=<kind>
slug=<slug>
version=<version>
commit=<40 hex>
severity=security
reason-sha256=<hex SHA-256 of the reason text>
issued-at=<ISO 8601, UTC>
```

**The update check's answer** gains, for such a release:
`withdrawal: { severity: "security", reason, issuedAt, keyId, signature }`.
A plain withdrawal (no security severity) stays as it is, unsigned and shown
only.

**MixOS, the setting.** `security.withdrawn-release.deactivate` in
`platform_settings`, off by default, set on Admin > Settings and audited.

**MixOS, the action.** With the setting on, the cron tick's update check
deactivates an active app when all of these hold:

- its installed release matches the withdrawal's `kind`, `slug`, `version` and
  `commit` exactly;
- the signature verifies against a pinned key;
- the reason's hash matches;
- `issued-at` isn't in the future.

It is audited as `app.deactivate` with actor `update-check`, and the details
carry the withdrawal. A notice on Admin > Apps says why, with the reason.
Activating it again is the admin's call: the release stays withdrawn, and the
notice stays.

**It fails open, deliberately.** An unreachable catalogue, an unsigned answer,
a signature that doesn't verify, or the setting off: nothing happens beyond
today's notice. It is an availability action taken on a remote party's word,
so it is opt-in and must be signed. A compromised mixos.org key could switch
apps off where it is on. That is an availability risk, not an access one: it
can only deactivate, never install or activate.

## Order

1. **mixos.org** adds publisher verification and starts signing
   `mixos-release-v2` and `mixos-withdrawal-v1`, behind a flag. It emits v1
   until MixOS can read v2.
2. **MixOS**, in one release:
   - reads and verifies both release formats, and `.registry.json` v2 (v1
     still read);
   - adds the label and the badge;
   - verifies signed withdrawals;
   - adds the setting, off.

   It adds shared test vectors to `release-signature.test.ts`, with the same
   ones in mixos-org.
3. **mixos.org** starts emitting v2 and signed withdrawals.

## Tests (MixOS side)

- A v2 manifest with a verified publisher shows the badge. One whose publisher
  fields differ from the signed text is refused. A v1 manifest installs with
  none.
- `.registry.json` v1 is read as no publisher. v2 round-trips.
- A signed security withdrawal deactivates only with the setting on, the exact
  release installed and a valid signature. A tampered reason, an unknown key,
  a future `issued-at`, or the setting off does nothing. Each is audited, and
  the notice shows.
- The escape catalogue gains a case: a forged withdrawal can't deactivate
  anything (refused at runtime).

**Effort:** MixOS's half, M, 3–5 days, once step 1 is done.
