# User-scoped connectors

## Context

Every connector is tenant-scoped: one credential set, configured by an admin,
shared by everyone. `docs/connectors/architecture.md` does not merely describe
that — it says the user-scoped model "is gone and stays gone, along with the
`scope` manifest field, the `OAuthCapableConnector` interface, the
`/account/connections` page, and the `user_connector_oauth` table."

This plan brings it back, deliberately, for connectors where one shared account
is the wrong answer: a person's own Slack messages and DMs cannot be a
single account the whole deployment reads.

**What that removal bought, and what we now owe.** The doc names the property:
*because there is exactly one credential set, any response a connector returns
is the same response any user would have received.* That is what made caching,
logging and sharing safe to reason about without thinking about identity. Once a
connector answers differently per user, every one of those becomes a place a
response can reach the wrong person. The work below is mostly about paying that
back, not about OAuth.

## Decisions

| Decision | Choice |
| --- | --- |
| Scope of this change | the full model, end to end |
| Per-user credentials | new `user_connector_oauth` table, encrypted, keyed `(user_id, connector_name)` |
| Caching | cache keys must include the user; enforced where the platform owns the key, documented where an app does |
| Slack | not built here — the concept only |
| Declaring it | `userScoped: true` in `connector.json` |

**Only three-legged OAuth may be user-scoped.** An API-key connector has one key
an admin pastes; there is no per-user equivalent, and a "user-scoped" API key
would just be the tenant key wearing a different label. Build-enforced.

**A user-scoped connector cannot be used by a scheduled job.** A sync or cron
handler runs with no user, so there is no grant to resolve — the connector would
be silently absent at 3am and present in a page request. Build-enforced, because
discovering it from a job that quietly does nothing is expensive.

## Structure

### Manifest and registry
- `userScoped?: boolean` on `RawConnectorManifestSchema` and `ConnectorManifest`.
- Generator rejects `userScoped` on any strategy other than
  `oauth2_authorization_code`, and rejects an app declaring a user-scoped
  connector alongside `sync`/scheduled jobs.

### Storage — `user_connector_oauth`
`(user_id, connector_name)` primary key, `encrypted_credentials` holding only the
`oauth_*` token keys, `created_at` / `updated_at`. The client id and secret stay
in `connector_configs`: the *application* is registered once by an admin, and
only the *grant* is per person. Rows cascade on user delete — a departing user's
tokens are not something to keep.

### `src/lib/connectors/user-config.ts`
`getUserTokens` / `saveUserTokens` / `deleteUserTokens` / `refreshUserTokens` /
`listUserConnections`, mirroring `config.ts` including its advisory lock: two
concurrent requests refreshing one person's token would otherwise race, and with
a provider that rotates refresh tokens on use that permanently invalidates the
grant.

### OAuth routes
Both routes branch on `userScoped`:
- **Tenant** — admin only, as today.
- **User-scoped** — any signed-in user; the grant is written to their row.

`OAuthFlowState` gains `userId`, and the callback refuses a flow whose `userId`
is not the session's. Without it, a session that changes mid-round-trip writes
one person's grant onto another's row — the single worst failure available here.

### Context
`buildConnectors` resolves a user-scoped connector from the caller's tokens and
**omits it entirely when they have none**. Omission rather than a throwing stub:
an app checks `context.connectors.x` for presence today, and a connector that is
present but explodes on use is a worse contract than one that is absent.

### `/account/connections`
Lists every connector declaring `userScoped`, with Connect / Disconnect and this
user's grant status. Empty state when none exist — the expected state today.
Restored to the settings nav as **My Connections**.

### Docs
`architecture.md`'s "One credential set per connector" is rewritten: tenant is
still the default and still the answer for most connectors, but "stays gone" is
no longer true and a doc that says so while the code does otherwise is worse
than no doc. `AGENTS.md`, `registry-ux.md` and `credentials.md` follow.

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — and prove each new guard
   fires: `userScoped` on an API-key connector, and a scheduled job declaring a
   user-scoped connector.
2. `npm run typecheck`, `npm run lint`, `npm run verify:connectors`.
3. Round trip as a non-admin: connect, confirm the row lands under that user,
   disconnect, confirm it is gone and the connector leaves `context.connectors`.
4. Confirm a second user sees their own state, not the first user's.
