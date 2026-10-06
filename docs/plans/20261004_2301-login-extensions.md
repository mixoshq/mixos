# Login extensions: declared identity providers and sign-in hooks

**Status:** proposed
**Scope:** platform — `src/lib/auth/`, `src/lib/hooks/`, `src/app/(auth)/login/`, `src/app/api/auth/`, `src/lib/connectors/`, `src/app/(main)/account/`, `src/app/(main)/admin/`, `src/proxy.ts`, `scripts/`, `supabase/migrations/`, docs, templates

## Context

Email and password is the only way into MixOS (`src/lib/auth/config.ts`). The
goal is to let an extension author ship sign-in with Google, X, Facebook, GitHub
or any OAuth/OIDC provider as connectors plus apps, without touching `src/`. Apps
should also be able to take part in sign-in policy: deny by rule, observe events,
and shape the login page.

Sign-in is the one place where a mistake in an extension is a mistake for every
user, admins included. So the design question is not "which hooks". It is
**which decisions an extension may influence, and in which direction.**

### What exists today

- **The hook bus is dormant, and not fit to carry authentication.** No core hook
  is dispatched anywhere, not `init`, `user-login` or `user-display-name`
  (`src/lib/hooks/types.ts:292`). Four properties of the bus matter here:
  1. Listeners register as an import side effect. At `/login` no app module has
     been imported, so on a cold start nothing is listening.
  2. Active-app gating is one process-global set, overwritten on every dashboard
     render with *that user's* enabled apps (`src/app/(main)/page.tsx:19`).
     Concurrent requests race on it.
  3. Filters are last-writer-wins by priority, values are `unknown`, and a
     throwing listener throws into the dispatcher.
  4. An app can **fire** a core hook. `resolveHookName` passes core names through
     unprefixed, so `context.hooks.doAction("user-login", anyPayload)` reaches
     every listener. For an audit listener that is a forged sign-in.

  The documented usage (`docs/apps/hooks.md`) also registers on the bare `hooks`
  singleton, which carries no `appSlug`. `isActive()` treats an unattributed
  registration as always on, so no deactivation can switch it off.
- **`ensureUser` upserts on email** (`src/lib/apps/access.ts:109`). That is
  correct for a credentials sign-in, where the email is what the password was
  checked against. Reused for a provider sign-in, it is an account takeover:
  whoever's provider asserts `admin@yourco.com` becomes that row.
- **The jwt callback assumes the credentials shape.** `if (user?.id) token.sub =
  user.id` is right when `authorize()` returned the users row. For an OAuth
  sign-in without an adapter, Auth.js sets `user.id` to `crypto.randomUUID()`
  (`getUserAndAccount` in `@auth/core/lib/actions/callback/oauth/callback.js`).
  The callback would look up a random id, find nothing, and return null. It fails
  closed, but only by accident.
- **Auth.js invents a subject when a profile has none:** `providerAccountId:
  userFromProfile.id ?? crypto.randomUUID()` (same file). A profile mapper that
  omits the id does not fail. It produces a fresh identity on every sign-in.
- **Connector OAuth is reusable in part.** `src/lib/connectors/oauth.ts` does
  PKCE, a sealed state cookie bound to the user who started the flow, and redirect
  URIs from `getAppOrigin()`. Its routes are session-gated under
  `/api/connectors`, and sign-in happens before there is a session.
- **Two origins can disagree.** `trustHost: true` makes Auth.js build its own URLs
  from `X-Forwarded-Host` unless `AUTH_URL`/`NEXTAUTH_URL` is set (`createActionURL`
  in `@auth/core/lib/utils/env.js`). `getAppOrigin()` (`src/lib/env/origin.ts`)
  falls back to `VERCEL_URL` instead. Harmless with credentials only; not harmless
  once it becomes a `redirect_uri`.
- **CSP `form-action 'self'`** (`src/proxy.ts`). Browsers can apply `form-action`
  to the redirect that follows a form submission. A no-JS POST to
  `/api/auth/signin/<provider>` that 302s to the provider may then be blocked.

## Decisions

### Locked

| Decision | Choice |
|---|---|
| The model | Apps observe, veto and shape sign-in; the platform keeps the identity decision. See [Rejected alternative](#rejected-alternative-open-identity-filters). |
| The invariant | **An extension can make sign-in stricter, never easier.** The only thing that opens a new way in is a declared identity provider that an admin enables. |
| Who supplies identity | Connectors, through a declared `identity` block. Not hooks. |
| What an identity is | `(provider, subject)`, in the provider's own namespace. Never an email, never a username. |
| Who maps identity to user | The platform, through `user_identities`. No extension ever returns a user. |
| Who verifies | The platform, via Auth.js: state, PKCE, nonce, ID-token signature and claims, code exchange. Authorization code + PKCE only. |
| Provider tokens from sign-in | Discarded once the profile is read. Data access stays the `userScoped` connector flow, with its own consent. |
| App participation | Declared in `app.json` under `authHooks`, enforced by both the build and the runtime, and shown to the admin at activation. |

### Proposed defaults — confirm before Phase 2

| Question | Proposed | Why |
|---|---|---|
| New accounts created at provider sign-in (JIT) | Off for each provider; v1 is link-only, JIT ships in Phase 3 | Every account today is admin-created or seeded. A social button should not quietly become open registration. |
| Linking by verified email | Never automatic in v1. Users link from `/account/identities` while signed in | Completing both sign-ins proves control of both. Email linking is where nOAuth-class takeovers live. |
| Break-glass when a gate locks everyone out | Operator safe mode (`MIXOS_AUTH_SAFE_MODE=1`), **not** an admin-password bypass | See below. |
| Password sign-in | Unchanged and always available in v1 | "Enforce SSO" is a later platform setting. A filter must not be able to remove the password method. |
| MFA / step-up challenge | Not in v1. The gate result type leaves room for it | A challenge needs a pre-session state machine of its own. |

**Break-glass, revised from the first draft.** An earlier sketch had admin
password sign-ins skip app gates. That exempts the highest-value accounts from
exactly the controls an operator installs an app to apply: an IP allowlist now,
MFA later.

Instead, recovering from a gate that fails closed requires deployment access.
`MIXOS_AUTH_SAFE_MODE=1` makes the dispatcher skip every app-contributed auth
hook. While it is set, every sign-in logs a warning and admins see a banner.
Deactivating the offending app is also a single update of `apps.is_active`. An
attacker holding a stolen admin password has neither lever.

## Design

### Three kinds of extension point

| Kind | Can | Cannot | On throw or timeout |
|---|---|---|---|
| **Gate** | Deny | Allow what another gate denied, change which user signs in, change anything else | Deny. Anything other than exactly `{ allow: true }` is a deny, `undefined` included |
| **Bounded filter** | Transform a value the platform then re-validates | Introduce values outside the set the platform offered | The unfiltered value |
| **Observer** (action) | Learn that something happened | Delay it or break it | Caught and logged, per listener |

Gates for one event run in parallel with a 2-second timeout each, so sign-in
latency is bounded by the slowest gate rather than the sum. Observers run in
`after()` (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`,
valid in route handlers and server functions, which covers both the Auth.js
handler and the login server action).

### Hook catalogue

**Gates**

| Hook | Signature | Phase |
|---|---|---|
| `user-can-login` | `(identity: VerifiedIdentity, user: { id, email, isAdmin }, ctx: LoginGateContext) => GateResult` | 1 |
| `user-can-register` | `(identity: VerifiedIdentity, ctx: LoginGateContext) => GateResult` | 3 |

`user-can-login` runs for **every** method, credentials included. It runs after
the identity is verified and mapped to a user, and before the session cookie is
minted.

**Bounded filters**

| Hook | What survives the platform's re-validation | Phase |
|---|---|---|
| `login-methods` | Only method ids the platform offered; each label as plain text up to 40 chars; order. Every href and action is rebuilt from the id afterwards. The password method cannot be removed. | 2 |
| `user-provision-profile` | `displayName` only, length-capped. Any other key (`email`, `isAdmin`, `password`) is discarded. | 3 |

**Observers**

| Hook | Payload | Fired from | Phase |
|---|---|---|---|
| `user-login` | `{ userId, method, isNewUser }` | sign-in branch of the jwt callback, via `after()` | 1 |
| `user-login-failed` | `{ method, reason }` | where the denial is decided: `authorize()`, the signIn callback, the rate limiter | 1 |
| `user-logout` | `{ userId }` | Auth.js `events.signOut` | 1 |
| `user-created` | `{ userId, via }` | `adminCreateUser`, `ensureUser`, JIT | 1 (JIT in 3) |
| `user-sessions-revoked` | `{ userId, reason }` | `revokeUserSessions` | 1 |
| `user-identity-linked` / `user-identity-unlinked` | `{ userId, provider }` | link / unlink | 2 |

`reason` on `user-login-failed` is one of `bad-credentials`, `denied`,
`no-account`, `identity-in-use`, `rate-limited`. `bad-credentials` covers an
unknown email, a wrong password and a disallowed domain alike, so that listeners
never learn whether an account exists.

**Payload rule:** no passwords, provider tokens, raw profiles or attempted emails.

`user-sync` is removed. Its trigger, SSO profile sync, is gone, and `user-created`
covers the case. Nothing ever fired it, so no listener ever ran; the only
breakage is a compile error for code registering it, which is the right outcome.

```ts
interface VerifiedIdentity {
  method: "credentials" | string; // provider (connector) name otherwise
  provider: string | null;        // null for credentials
  subject: string | null;         // null for credentials
  email: string | null;
  emailVerified: boolean;
}

type GateResult = { allow: true } | { allow: false; reason: string };

interface LoginGateContext {
  /**
   * GET-only client for the provider's API, authorized with this sign-in's
   * token and valid for this call only. The token itself is never exposed.
   * Non-null only when the gate's app declares this connector. This is how
   * "must be a member of GitHub org X" works without app code holding a token.
   */
  provider: BoundProviderClient | null;
}
```

The user sees one generic message for every denial. `reason` goes to the server
log and to `user-login-failed`.

### Never hookable

- Which user an identity maps to (there is no `authenticate` filter).
- Verifying passwords, tokens, signatures, state, PKCE or nonce.
- `is_admin`, grants and roles. Nothing on the sign-in path assigns privilege.
- Session lifetime, cookie flags, `session_version`.
- Redirect URIs, and any sign-in scope beyond what the manifest declares.

### Identity providers are connectors

```jsonc
// connectors/<name>/connector.json — OIDC
"identity": {
  "protocol": "oidc",
  "issuer": "https://accounts.google.com",
  "scopes": ["openid", "email", "profile"],
  "emailVerifiedClaim": "email_verified"
}
```

```jsonc
// a non-OIDC provider
"identity": {
  "protocol": "oauth2",
  "authorizeUrl": "https://github.com/login/oauth/authorize",
  "tokenUrl": "https://github.com/login/oauth/access_token",
  "scopes": ["read:user", "user:email"],
  "profile": { "url": "https://api.github.com/user", "subject": "id", "name": "name" }
}
```

- **Declarative first.** OIDC needs nothing beyond the block above. An `oauth2`
  provider maps its userinfo response by field name. A provider that cannot be
  mapped this way implements `identityProfile(client)` on its connector class.
  GitHub's verified-email lookup against `/user/emails` is the motivating case.
  That method receives a GET-only client bound to the token, never the token, and
  the platform validates its output.
- **Credentials need nothing new.** Client id and secret are ordinary
  admin-entered `credentialFields`, encrypted in `connector_configs`.
  `identity.credentialKeys` (default `["clientId", "clientSecret"]`) drives
  `configured` in `src/lib/connectors/status.ts`.
- **Identity-only in v1.** `identity` and a data `auth.strategy` other than `none`
  are mutually exclusive. A Google connector for sign-in and another for Drive
  means two tiles and two redirect URIs, which is clearer than one tile with two
  grants. Revisit if it chafes.
- **Scopes.** OIDC identity scopes must be a subset of `openid email profile`
  (build-enforced). `oauth2` scopes are shown on the enable dialog, and changing
  them requires a security note in the PR, as connector invariant 19 already does
  for data scopes.
- **Naming.** The connector name is the Auth.js provider id and the `provider`
  column. `credentials` is reserved.
- **Redirect URI** is `${getAppOrigin()}/api/auth/callback/<name>`. For identity
  connectors, the registry's `showRedirectUri` step shows that URI, not the
  connector OAuth callback.
- **Subject.** It must be a non-empty string of at most 255 chars. The platform's
  composed `profile()` throws otherwise, *before* Auth.js can substitute a random
  UUID. Authoring guidance, in `docs/connectors/identity.md`, is that the subject
  must be stable and immutable:
  - OIDC: `sub`.
  - X: the numeric `id`, never the handle.
  - Facebook: the app-scoped id.
  - Microsoft: never `email` or `preferred_username` (the nOAuth takeover).
- **`emailVerified`** is true only when the declared claim is literally `true`,
  or when a coded profile reports it from a provider API that states it.
  Otherwise it is false.
- **`testConnection()`.** A platform `IdentityConnector` base class supplies it.
  For OIDC it fetches discovery and checks the issuer matches. An `oauth2` client
  secret cannot be verified without a user, so the registry says so and points at
  linking an account as the real test.

**Enabling.** Identity connectors get a "Use for sign-in" switch in the Connector
Registry, separate from "configured". The action calls `requireAdmin()` and
`recordAdminAction()`. It is refused unless `NEXTAUTH_URL` or `AUTH_URL` is set,
because the origin must never come from a header.

**Composition.** `buildAuthOptions()` is already a per-request factory. It
appends one Auth.js provider per enabled identity connector, with:
- explicit `checks: ["pkce", "state"]`, plus `"nonce"` for OIDC;
- `clientId` and `clientSecret` from `getDecryptedConfig()`;
- a platform-written `profile()` that applies the mapping (or calls
  `identityProfile()`), validates the result and returns `{ id: subject, … }`.

The cost is one request-cached read of enabled providers per auth request. The
same list is what the jwt callback checks `authMethod` against (below), so
disabling a provider ends sessions minted through it without any extra read.

### Sign-in flow

Auth.js runs, in order: provider round trip → `callbacks.signIn` →
`callbacks.jwt` → cookie → `events.signIn`
(`@auth/core/lib/actions/callback/index.js`). A throw or `false` from
`callbacks.signIn` becomes `AccessDenied`. A string return redirects **without**
completing sign-in.

1. **`callbacks.signIn`.** Build a `VerifiedIdentity`. For OAuth, it comes from
   `account.provider`, `account.providerAccountId` and the validated profile; for
   credentials, from the row `authorize()` returned. Then:
   - **Link intent present** (see Linking): link the identity, then return a
     redirect to `/account/identities`. The user stays in their existing session.
   - **No identity found, JIT off:** deny with `no-account`.
   - **No identity found, JIT on:** go to Phase 3 provisioning.
   - **Identity found:** run the platform checks (user row exists, provider still
     enabled), then the app gates (`user-can-login`).
2. **`callbacks.jwt` with `account` present.** Resolve `(provider, subject)` again
   by unique index and set `token.sub` to the users id. Set `token.authMethod`
   and stamp `sessionVersion` as today. Never copy an `account` token field into
   the JWT. The credentials branch keeps today's behaviour and adds `authMethod:
   "credentials"`. Schedule the `user-login` observers with `after()`.
3. **Every later resolution.** In addition to the existing `session_version`
   check, return null when `token.authMethod` names a provider that is no longer
   enabled.

`pages.error` is `/login`. Every `?error=` maps to one generic message.

The Auth.js route (`src/app/api/auth/[...nextauth]/route.ts`) is wrapped so that
`/signin/*` and `/callback/*` consume an IP bucket from `createRateLimiter`, as
`login-credentials` already does.

### Linking and unlinking

`/account/identities` lists the user's linked identities and the enabled
providers.

**Link.**
1. A server action mints a sealed 10-minute link-intent cookie `{ userId,
   provider, exp }`, using the same AES-GCM sealing as `OAuthFlowState`. Being a
   server action, it is POST with Next's origin check.
2. The action redirects into Auth.js sign-in for that provider.
3. In `callbacks.signIn`, the intent is honoured only if all of these hold:
   - it opens and has not expired;
   - it names this provider;
   - its `userId` equals the current session's user.

   A mismatch is a deny, exactly as the connector callback refuses a `userId`
   mismatch.
4. A subject already linked to a different user is denied with
   `identity-in-use`. It is never moved.

Account-linking CSRF (making a victim link the attacker's provider account) is
covered twice: the Auth.js `state` check binds the callback to the browser that
started it, and the link intent can only be minted by the victim's own server
action.

**Unlink.**
- Refused when it would remove the user's last credential: no `password_hash`
  and no other identity.
- Otherwise it deletes the row and bumps that user's `session_version`. The UI
  says it signs them out everywhere.
- Admins see a user's identities on `/admin/users` and can unlink them, with
  `requireAdmin()` + `recordAdminAction()`.

### Login page

`page.tsx` reads the enabled providers server-side, applies `login-methods`, and
renders platform-built buttons using each connector's icon. The icons are served
from `/connector-assets/<name>/…`, which the proxy already exempts. Each button
calls a server action that runs `signIn(provider)`. Themes style the buttons.
**No app component renders on `/login`:** it is the most-phished page, and it is
the page the CSP nonce most needs to protect.

### Hook system changes

1. **A declared entrypoint.** `apps/<slug>/hooks.ts` default-exports
   `(hooks: HookRegistrar) => void`. The generator emits a static `hookLoaders`
   map beside `widgetLoaders`. `ensureHooksLoaded()` imports every active app's
   entrypoint once per process, before any core dispatch. It is idempotent, with
   registrations keyed by slug so a re-import cannot double-register.
2. **Activation checked per dispatch.** Core-hook dispatch filters registrations
   through `filterActiveApps()`, which is request-scoped via `cache`. This uses
   the instance-wide switch, not one user's installs. `setActiveApps` and its call
   in the dashboard page are deleted.
3. **Semantics per hook.** A `CORE_HOOK_SPECS` table records each core hook's
   kind, timeout, payload schema, and whether it is an auth hook. Core hooks
   dispatch only through `runGate`, `applyBoundedFilter` and `notify`, never the
   generic `doAction`/`applyFilters`. The generator imports the same name list,
   which retires the "keep in sync" comment at
   `scripts/generate-project-registry.ts:167`.
4. **Apps cannot fire core hooks.** The registrar's `doAction`/`applyFilters`
   throw on a core name.
5. **Auth hooks need an attributed, declared registration.**
   - Registering an auth hook on the bare singleton throws.
   - Registering one through a registrar whose manifest does not declare it
     throws.
   - Registering one anywhere but `hooks.ts` fails the build.
6. **Safe mode.** `MIXOS_AUTH_SAFE_MODE=1` skips every app registration of an
   auth hook, logs a warning on each sign-in, and shows admins a banner.

```jsonc
// apps/<slug>/app.json
"authHooks": [
  { "hook": "user-can-login", "reason": "Only members of the acme GitHub organisation may sign in." }
]
```

The hook names come from a closed set. `reason` is required and must be a
sentence an admin can act on, the same rule as `escapes`. The activation dialog
lists these under "Takes part in sign-in", and activating such an app records the
list in the admin audit trail. A gate applies to every user of the instance,
including users with no grant to the app, which is why it is declared.

### Data model — `0008_user_identities.sql`

```sql
create table if not exists public.user_identities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  provider        text not null,
  subject         text not null check (length(subject) between 1 and 255),
  email           text,
  email_verified  boolean not null default false,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz,
  unique (provider, subject)
);
create index if not exists idx_user_identities_user on public.user_identities(user_id);

create table if not exists public.identity_provider_settings (
  provider            text primary key,
  sign_in_enabled     boolean not null default false,
  jit_enabled         boolean not null default false,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references public.users(id) on delete set null
);
```

- RLS enabled explicitly on both tables. The 0001 sweep does not reach later
  files; 0002–0007 each enable RLS themselves.
- `provision_user_from_identity(...)` RPC, used in Phase 3: it inserts the user
  and the identity in one transaction, so a half-provisioned account cannot
  exist. It is an `insert`, never an upsert, and fails on an existing email.
  `EXECUTE` is revoked from `anon`/`authenticated` and granted to `service_role`,
  as for `bump_session_version`.
- `platform_schema_version` bumped to `8`, last.

### Phase 3: JIT provisioning

When a provider's `jit_enabled` is on and no identity matches:

1. **Platform rules.** With `ALLOWED_EMAIL_DOMAINS` set, only a *verified* email
   counts, so an absent or unverified email is denied. An email that matches an
   existing account is denied with copy telling the person to sign in and link
   instead. Never merge.
2. **App gates.** `user-can-register`.
3. **Create.** `provision_user_from_identity` creates the account with `is_admin`
   false, `password_hash` null, and `displayName` from `user-provision-profile`.
4. **Observers.** `user-created` with `{ via: provider }`, then `user-login` with
   `{ isNewUser: true }`.

## Rejected alternative: open identity filters

The alternative is a fully open model:
- any extension may register a filter that returns the signed-in user, in
  priority order, last writer wins;
- a per-request hook decides who every request is;
- core functions such as password checking and session minting can be replaced;
- extensions inject markup and scripts into the login page.

Its appeal is real: any protocol works without a platform change. Its cost is
that login is only as secure as the weakest active extension:
- **Anyone can be anyone.** A filter that returns a user lets any listener sign
  anyone in. Correctness depends on priority numbers chosen by independent
  authors.
- **Security add-ons can't compose.** An extension that mints sessions directly
  skips the hooks that MFA and audit extensions listen on.
- **The security extension becomes the bypass.** A check whose error path returns
  the user lets everyone in, unless failure means deny.
- **Registration input can set privilege.** Profile fields that reach the user row
  unfiltered can include the role.

For MixOS specifically, the open model would also:
- make the most sensitive door the one undeclared exception in a platform where
  everything else is declared and build-checked;
- require giving apps a "sign in as user X" capability, breaking the containment
  `20260923_0041-app-packages.md` closes;
- extend to the MCP authorization server, because a forged identity can approve
  the consent screen and mint tokens.

What each open-model extension point became:

| Open-model extension point | Here |
|---|---|
| A filter returning the signed-in user | **Rejected.** Declared identity providers return `(provider, subject)`; the platform maps to a user. A buggy provider can only vouch for subjects in its own namespace, so it reaches only accounts that linked it. |
| A veto after credentials are checked | **Taken, constrained:** `user-can-login`, veto-only, fail closed, so an error path can never allow. |
| Overriding password verification | **Rejected.** |
| A per-request "current user" hook | **Rejected.** API keys and MCP tokens stay platform-owned tiers. |
| Replaceable core auth functions | **Rejected.** |
| Login, failed-login and logout events | **Taken.** Fired by the platform on every path, so no extension can skip the observers. |
| Registration events and validation | **Taken, constrained:** `user-created`, `user-can-register`, and a field allowlist on `user-provision-profile`, so registration input can never set privilege. |
| Markup and scripts injected into the login page | **Rejected.** Use the structured `login-methods` filter; themes style the page. |
| Changing the post-login redirect | **Deferred.** See Out of scope. |
| Changing session lifetime | **Rejected.** |

## Constraints (build-enforced)

| Constraint | Where |
|---|---|
| `identity.protocol` is `oidc` or `oauth2`; all URLs `https:` | connector schema |
| OIDC `identity.scopes` ⊆ `openid email profile` | connector schema |
| `identity` excludes a data `auth.strategy` other than `none` | generator |
| `oauth2` declares `profile.subject` unless the class implements `identityProfile` | generator |
| Connector name `credentials` is reserved | generator |
| `authHooks[].hook` from the closed set; `reason` non-empty | app schema |
| Auth hooks registered ⇔ declared; registered only in `hooks.ts` | generator (`scanHooks`) |
| Unattributed or undeclared auth registration; app firing a core hook | runtime throw |

## File-level changes

### Phase 1: a hook system that can carry auth; gates and events for credentials

No new sign-in method yet. This phase alone makes the existing hook catalogue
real.

- `src/lib/hooks/types.ts`: gate, filter and observer maps for the catalogue
  above; `VerifiedIdentity`, `GateResult`, `LoginGateContext`; remove `user-sync`.
- `src/lib/hooks/specs.ts` (new): `CORE_HOOK_SPECS`, the single source of core
  hook names.
- `src/lib/hooks/hook-system.ts`:
  - attribution required for auth hooks;
  - `runGate`, `applyBoundedFilter`, `notify`;
  - core-hook firing refused from registrars;
  - `setActiveApps` deleted;
  - safe mode.
- `src/lib/hooks/load.ts` (new): `ensureHooksLoaded()`.
- `scripts/generate-project-registry.ts`: the `hookLoaders` map; core names from
  `specs.ts`; `authHooks` enforcement in `scanHooks`.
- `scripts/manifest-schemas.ts`, `src/lib/apps/types.ts`: `authHooks`.
- `src/lib/auth/config.ts`:
  - `callbacks.signIn` runs `user-can-login`;
  - `authMethod` added to the token;
  - `events.signOut` dispatches `user-logout`;
  - `user-login` scheduled from the jwt callback.
- `src/lib/auth/types.d.ts`: `authMethod` on `JWT`.
- `src/app/(auth)/login/actions.ts`: `user-login-failed` for `bad-credentials` /
  `denied` / `rate-limited`.
- `src/lib/auth/revocation.ts`: `user-sessions-revoked`.
- `src/lib/apps/access.ts` (`ensureUser`), `src/lib/admin/user-actions.ts`
  (`adminCreateUser`): `user-created`.
- `src/app/(main)/page.tsx`: drop `hooks.setActiveApps`.
- `src/app/(main)/admin/apps/`: the "Takes part in sign-in" list on activation;
  audit the list.
- `docs/apps/hooks.md` and `src/components/apps/guide-tabs.tsx` (kept in sync):
  `hooks.ts`, the three kinds, the catalogue, `authHooks`, safe mode. Correct the
  current example that registers on the bare singleton.
- `apps/AGENTS.md`: a new invariant for `authHooks` and `hooks.ts`.

### Phase 2: identity providers, link-only

- `supabase/migrations/0008_user_identities.sql`.
- `src/lib/connectors/types.ts`, `scripts/manifest-schemas.ts`: `identity`.
- `src/lib/connectors/identity-connector.ts` (new): the `IdentityConnector` base
  class and `testConnection()`.
- `src/lib/connectors/status.ts`: `configured` for identity connectors.
- `src/lib/auth/providers.ts` (new): compose Auth.js providers; the
  platform-written `profile()`.
- `src/lib/auth/identities.ts` (new): lookup, link, unlink, the last-credential
  check, link-intent seal/open.
- `src/lib/auth/config.ts`: OAuth branches of `signIn` and `jwt`;
  enabled-provider check on resolution; `pages.error`.
- `src/app/api/auth/[...nextauth]/route.ts`: the rate-limit wrapper.
- `src/app/(auth)/login/page.tsx`, `login-card.tsx`, `provider-buttons.tsx` (new):
  methods and `login-methods`.
- `src/app/(main)/account/identities/` (new): the page and its server actions.
- `src/app/(main)/admin/users/`: identities per user; unlink.
- `src/app/(main)/admin/connectors/`, `src/components/admin/connector-configure-dialog.tsx`:
  the "Use for sign-in" switch; `showRedirectUri` for identity connectors.
- `src/proxy.ts`: `form-action` origins, if the spike below calls for them.
- `connectors/_template-identity/` (new): an OIDC template.
- `docs/connectors/identity.md` (new), registered in
  `src/components/connectors/connector-guide-tabs.tsx` `TABS`;
  `docs/connectors/registry-ux.md`; `connectors/AGENTS.md` invariants.
- `docs/security-architecture.md`: a new section, "Sign-in providers and auth
  hooks"; update §10 (provisioning), §12 (revocation), §18 (unauthenticated
  surface).
- `WHATS-NEW.md`.

**Phase 2 spikes, resolved before the UI is built:**
- **CSP.** Confirm whether a no-JS form POST that redirects to the provider is
  blocked by `form-action 'self'`, and whether the server-action path performs a
  client-side navigation instead. If it is blocked, the proxy adds each installed
  identity connector's authorization origin to `form-action`. The list comes from
  the static connector registry, so the proxy still needs no database.
- **Carrying `isNewUser`.** Without an adapter, Auth.js gives `signIn` and `jwt`
  no shared channel. Choose between a request-scoped holder and re-deriving it
  from `user_identities.created_at`.

### Phase 3: JIT provisioning

- `src/lib/auth/provision.ts` (new), calling `provision_user_from_identity`.
- `user-can-register` and `user-provision-profile` wired in.
- `src/app/(main)/admin/connectors/`: a JIT switch per provider, audited.
- `docs/security-architecture.md` §10: provisioning now has a third path.

## Verification

### Phase 1

1. `npx tsx scripts/generate-project-registry.ts` against fixture apps. Each of
   these fails the build, naming the app and the hook:
   - registering `user-can-login` without declaring it;
   - declaring it without registering it;
   - registering it outside `hooks.ts`.
2. `npm run typecheck`.
3. `runGate` unit cases: `{ allow: true }` allows. Each of these denies:
   - `{ allow: false }`;
   - `undefined`;
   - `{ allow: "yes" }`;
   - a throw;
   - a 3-second sleep.
4. **Cold start.** Restart the dev server and sign in as the first request. A
   fixture gate fires, which proves the loader runs.
5. **No cross-talk.** Two browsers, signed in as users with different enabled
   apps; gate behaviour is identical for both. Deactivating the fixture app stops
   the gate on the next sign-in.
6. **Safe mode.** With an always-deny gate, everyone is locked out. Set
   `MIXOS_AUTH_SAFE_MODE=1`: admins can sign in, the warning is logged, and the
   banner shows. Unset it: locked out again.
7. An app calling `context.hooks.doAction("user-login", …)` throws.
8. An observer that throws, and one that sleeps 10 seconds: sign-in still
   completes promptly.

### Phase 2

1. **Golden path.** Copy `_template-identity` into a dev instance and configure
   Google. Link from `/account/identities`, sign out, then sign in with Google:
   it lands as the same user.
2. **Unlinked account.** An unlinked Google account gets the generic error, and
   `select count(*) from users` is unchanged.
3. **Session swap.** Start a link as A, switch the session to B in another tab,
   then complete the link: denied, nothing linked.
4. **Subject in use.** A subject already linked to A, linked by B: denied with
   `identity-in-use`.
5. **Missing subject.** A profile with no subject: sign-in fails, and no
   random-UUID identity row exists.
6. **Disabling.** Disable the provider. A session minted through it ends on its
   next request; the same user's password session survives.
7. **Unlink.** Unlinking the last credential is refused. Unlinking any other
   credential signs that user out everywhere.
8. **Origin.** Enabling a provider with `NEXTAUTH_URL` unset is refused. With it
   set, a spoofed `X-Forwarded-Host` on `/api/auth/signin/<provider>` still
   yields the configured `redirect_uri`.
9. **Verification failures.** Extend `npm run verify:connectors` with an OIDC
   stub (discovery, JWKS, `id_token`). Each of these is denied:
   - a bad signature;
   - a wrong `aud`;
   - a wrong `nonce`;
   - an expired token;
   - a wrong `iss`.
10. **Rate limiting.** `/api/auth/callback/*` is rate-limited.
11. **CSP.** Provider buttons work under the CSP, with and without JS, or
    JS-required is documented.

### Phase 3

1. **JIT off and on.** With JIT off, no account is created. With it on, an
   account is created with `is_admin` false and `password_hash` null, and its
   identity row is written in the same transaction.
2. **Email collision.** A provider email matching an existing account is denied,
   and the existing account is untouched.
3. **Domain allowlist.** With `ALLOWED_EMAIL_DOMAINS` set, an unverified email is
   denied.
4. **Register gate.** A `user-can-register` deny leaves no row.
5. **Profile allowlist.** `user-provision-profile` returning `{ displayName,
   isAdmin: true, email: "x" }` applies only `displayName`.

## Out of scope

- **SAML, LDAP, passkeys, magic links.** `VerifiedIdentity` is protocol-neutral,
  so a later "declared authenticator" type can produce one. v1 ships `oidc` and
  `oauth2` only.
- **MFA and step-up** (a `challenge` gate result).
- **Enforce SSO**, i.e. turning password sign-in off.
- **Using sign-in tokens for data access** (one consent for both).
- **A `login-redirect` filter.** Auth.js's `redirect` callback has no user, and a
  string from `signIn` aborts the sign-in, so there is no clean seam yet.
- **Dispatching `init` and `user-display-name`.**
- **Automatic linking by email.**

## Adjacent gaps found, not closed here

- **`updatePassword` without re-authentication.** It sets a password without
  asking for the current one when the row has no `password_hash`. Once
  social-only accounts exist (Phase 3), a hijacked session can add a password and
  persist past unlinking. It should require a recent sign-in.
- **`trustHost: true` with `NEXTAUTH_URL` unset.** This affects every Auth.js URL,
  not only provider redirects. Phase 2 refuses to enable providers without it;
  requiring it in production generally is worth considering.
- **Auth hooks only.** The declared-entrypoint requirement applies only to auth
  hooks here. Non-auth hooks still register as an import side effect.

## Open questions

1. Confirm the proposed defaults table, especially link-only v1 and operator
   safe mode over an admin bypass.
2. Where do user-initiated security events (link, unlink) get recorded? The admin
   audit trail (§28) with the user as actor, or a user-facing security log on
   `/account`?
3. Google Workspace domain restriction: a declarative `identity.domainClaim`
   (`hd`) in the platform, or left to an app gate?
4. Identity-only connectors in v1: acceptable, or is one tile per provider for
   both sign-in and data a requirement?
