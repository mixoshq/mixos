# App admin dialog: reach, MCP tool switches, and a real Access tab

**Status:** built
**Scope:** platform — `src/components/admin/`, `src/components/ui/toggle.tsx`, `src/components/apps/`, `src/app/(main)/admin/`, `src/app/(main)/oauth/authorize/`, `src/app/api/mcp/`, `src/lib/apps/`, `src/lib/dashboard/`, `src/lib/mcp/`, `src/lib/repository/delete-data*`, `scripts/` (the release step's registry sync, smoke activation, the pull-request check), `supabase/migrations/`, docs

## Context

The app details dialog (`src/components/admin/app-details-dialog.tsx`) is where
an admin manages one app. It had seven tabs: Overview, Access, Settings, Hooks
& Services, Connectors, MCP and Database. Three things an admin needs were
missing from it, and two of them were missing from the whole platform.

- **What the app can reach was invisible.** `egress` (the hostnames
  `context.http` may call) appeared nowhere in the admin UI, although the
  mixos.org Permissions page tells admins to read it first. `escapes` were
  invisible too, and [`20261005_2150-app-escapes.md`](20261005_2150-app-escapes.md)
  fixed that first: it narrowed the escapable rules to `raw-response` and put
  an Escapes panel on this dialog's Overview, where it stays. This plan doesn't
  touch escapes.
- **MCP tools were all-or-nothing, and on by default.** A tool was reachable
  when a user consented to its app on the MCP consent screen and still held a
  grant. An admin could not turn off one tool, or every tool, for an app they
  otherwise wanted people to use.
- **Access was managed somewhere else.** Who holds an app was decided per user
  on `/admin/users`, through `toggleUserGrant`, a server action written inline
  in that page. The Access tab showed only the public surface
  (`app-visibility-panel.tsx`) and the unlock password
  (`app-password-panel.tsx`). There was no list of who has access, and no way
  to grant from the app's side.

Found while reading the code, and folded in below:

- **API keys could not be created.** The `key` auth tier was implemented
  (`src/lib/apps/api-keys.ts`, table `app_api_keys`), but `mintApiKey()` had
  no caller, so every `key`-tier route refused every caller.
- **The grant gate's readiness check was too loose.** Granting was refused
  while a required connector was unconfigured, via
  `getMissingTenantConfigConnectors()`, which asked `isConnectorConfigured()`:
  only whether a `connector_configs` row existed. A three-legged OAuth
  connector has a row as soon as its client ID is saved, before anyone presses
  Connect, so the gate passed for a connector that refuses every call.
  `src/lib/connectors/status.ts` exists to answer this correctly.
- **The password action read only the legacy maps.** `setAppPasswordAction`
  looked for `password` in the manifest's `pageVisibility` and `apiVisibility`
  maps alone, so an app declaring `password` in `defineRoute`, the recommended
  place, was refused the password its routes needed.

## Decisions

### Requested

| Decision | Choice |
|---|---|
| Egress and escapes | Shown in the dialog. Egress on Reach; escapes on Overview, from the escapes plan |
| MCP tools | An admin enables or disables each tool. **All tools are disabled by default.** |
| Access tab | Lists everyone with access, has a **Grant access** button that searches users by name or email, shows the password-gated and public parts of the app, and filters between them |
| Roles | Each user's role is shown and can be changed in the list, and the list filters by role |

### Locked with the user on 2026-10-05

| Question | Decision | Why |
|---|---|---|
| Existing installs on upgrade | **Every MCP tool starts disabled, including tools users already use.** Ships as a breaking change: `feat(os)!` with a `BREAKING CHANGE` footer and a `WHATS-NEW.md` entry telling admins to enable the tools they want | Matches "disabled by default" and fails closed. Seeding `enabled` for apps with live consents was considered and rejected. |
| API keys | **Mint, list and revoke on Access, in this change** | Without it the `key` tier is dead code, and Access is where an admin asks "who and what can reach this app". |
| Revoking a grant | **Does not revoke the user's MCP tokens** | Grants are re-checked on every call, so the app's tools disappear from the token without touching the user's other apps. |

### Approved with the user on 2026-10-14

| Question | Decision | Why |
|---|---|---|
| Where egress goes | The Connectors tab, renamed **Reach**, gains a Network section | Egress is the same question as connectors: what does this app call out to. Overview already carries the Escapes panel. |
| Filters on Access | **Users**, **Password-gated**, **Public**, **API keys**, each with a count | Public is wider exposure than password-gated, so leaving it out would hide the loudest case. API keys are the other way in. |
| Readiness | Fixed here, in `getMissingTenantConfigConnectors()` | Grant access is built on that gate. A three-legged tenant connector must be `ready`; a user-scoped one only needs its client credentials. |
| Grants from `/admin/users` | Kept, and moved onto the same shared server actions | Two places to grant is fine. Two implementations of the gate is not. |

### Decided with the user on 2026-10-15, after a security review

An independent review of the built change found no critical or high issues,
two medium ones and several small ones. Each is fixed here, with a test.

| Question | Decision | Why |
|---|---|---|
| A role on a global app | **A role is never access.** A `user_app_grants` row that records only a role (`role_only`, migration 0013) is ignored by `hasAppGrant` and every other access path: routes, pages, MCP, App Services, the dashboard and the menu bar. Setting a role never creates access; granting on an app that isn't global turns a role-only row into a grant. The release step records whether each app is global, and when an app stops being global it audits it (`app.global.ended`), Admin > Apps marks it **Needs grants** until someone is granted it, and the Access tab lists the people with a role and no access. Which rows are roles is decided by the rule under the re-check, below | A role row on a global app looked exactly like a grant, so an app that stopped being global stayed with everyone given a role in it, by no grant anyone made |
| Tool switches when a different extension takes the slug | **Deleted** in the release step's transaction, with its API keys, and counted in `app.identity.changed` (`mcpToolSwitchesReset`). The confirmation and the **Replaces a different extension** strip say the keys were revoked and the tools turned off | They were turned on for the tools of the extension before it. This replaces "kept" under Settled while building |
| `tools/call` | **The grant first**, then the switches, read whether or not the tool is declared. A disabled tool and an undeclared one both answer `NOT_EXPOSED`. The docs say exactly that, instead of "can't probe" | Someone without the app learns nothing about its tools, and a declared name costs the same reads as an undeclared one |
| A grant or revoke that changes nothing | Returns `{ ok: true, changed: false }` and still refreshes the pages; the Access tab and /admin/users say the person already had the app and their role wasn't changed, or didn't have it | The page that asked was out of date |
| No role on a grant, everywhere | The smoke activation stores a null role too. /admin/users' role select has **Default**. The docs say a user on Default follows `defaultRole`, and changes when it does | A stored copy of the default stops following the manifest |
| The not-ready connector warning | Worded by the app's state: an inactive app can't be activated or granted until the connector is ready; an active one can't be granted, and whatever needs the connector fails | The warning on an active app talked about activating it |
| A connector switch that can't be read | The actions still throw; the admin pages render from the credentials, and log it | The gate mustn't pass on a guess; a page that only shows its answer needn't fail with it |
| A route-scoped API key where the route can't be named | Refused: only a key for every route passes `resolveAuthTier` without a method and pattern | A scope that can't be checked mustn't pass |
| Grants and keys of an app the build doesn't carry | Listed and revoked, with the same admin check and audit (`notInBuild` in its details), from **Revoke access…** on its entry under Not in this build | They come back with the app. A leaked key or a grant that should go shouldn't have to wait for that |
| The Access tab's reads | The newest read of the list wins; a key count that failed says so instead of "…"; the MCP switches are read each time the tab is shown | An older answer landing last, a failure shown as loading, and switches kept for the life of the page each showed something untrue |
| Small ones | API key labels refuse `\p{Cc}`, `\p{Cf}`, `\p{Zl}` and `\p{Zp}`. The MCP route's `listChanged` comment says the tool set can change. The user search escapes LIKE with `!`, so it means the same whatever `standard_conforming_strings` is | |
| Kept | Connectors gate activation and granting; a repeat is a quiet no-op; a grant follows `defaultRole` | The rows above fix their side effects |

### Decided with the user on 2026-10-15, after the re-check

The reviewer re-checked the fixes. All held but the first: marking only the
rows of apps that were global at a release step missed three cases, the
deploy that first applies 0013 and also ends an app's being global, an app
missing from that deploy, and rows an older build writes after a host rolls
back to it. Four small findings came with it.

| Question | Decision | Why |
|---|---|---|
| Which rows are grants | **A row is a grant when someone is recorded granting it:** an admin in `granted_by`, or the CLI's own `user.grant.add` audit row for that person and app (no admin, `via` cli or ci; narrowed after the final review, below) from the row's `granted_at` on. Anything else is only a role. `role_only` is null until that is decided: every row from before 0013, and any an older build writes after a rollback. Every access check applies the rule to undecided rows (`src/lib/apps/grant-rule.ts`), and every release step decides them for every app its build carries, global or not, audits the roles it finds as `app.grants.marked`, and marks an app that isn't global **Needs grants** when it finds any | The database already tells the rows apart: every grant path recorded who granted, and setting a role never did. The time matters: a grant revoked long ago and a role since is only a role. Deciding in the checks too holds the rule before any release step runs |
| A grant on an app that is global | **Never demoted.** A grant made before the app went global outlasts it. A role set on a global app writes a role-only row only for someone with no grant, and Default keeps a grant a grant | While the app is global a grant changes nothing, and a build sharing the database that sees the app as global would otherwise take production's grants |
| Every grant path | **Records who granted.** The actions set `granted_by`, a grant over a role-only row too. The CLI's smoke grant and the pull-request check write `role_only = false` and a `user.grant.add` audit row as the CLI | The rule holds for every grant made from now on, and the pull-request check's grants survive the release step |
| The upgrade | A note in WHATS-NEW, as what to do: someone who only had a role, never a grant, no longer has the app through it, Admin > Apps shows **Needs grants** where that happened, and a grant written straight into the database counts as a role too | Admins can act on it |
| The menu bar's reorder | Checked against the held apps the menu bar lists; an install of an app the user doesn't hold keeps its place | Every reorder was refused for anyone with an install of an app they didn't hold |
| A grant read that fails | `filterHeldApps` logs it and counts only the global apps, so the dashboard, the menu bar and the App Manager still render; `hasAppGrant` counts it as no grant | They degraded quietly before this change |
| A role change a revoke beats | Each change is one statement that says whether it changed anything; nothing changed is `changed: false`, not audited | A revoke between the read and the update was audited as a role change |

### Settled with the user on 2026-10-15, after the final review

The reviewer found the change safe to ship and left three small items, each
fixed with a test.

| Question | Decision | Why |
|---|---|---|
| The rule's audit branch | Only the CLI's own `user.grant.add` rows count: no admin (`actor_id` null, a `cli:` name) and `via` cli or ci, which the smoke grant and the pull-request check record. The index holds exactly those rows (`where action = 'user.grant.add' and actor_id is null`) | An admin's grant always sets `granted_by`, so an admin's audit row is never needed, and a future feature writing one without a grant mustn't grant access |
| The release step's scan | One statement decides the undecided rows of every carried app, in one pass over `user_app_grants`, instead of one statement per app | No index leads with `app_slug`, so each per-app statement scanned the table inside the release step's lock |
| When **Needs grants** shows | Only when someone lost the app, and it says why: `roles-decided`, people decided to have only a role on an app that isn't global, or `global-ended`, the app stopped being global and someone who had it, by an install or a role, has no grant. An app that stops being global with everyone who had it granted is audited and not marked. `apps.needs_grants_since` and `apps.needs_grants_reason` hold it | The mark fired when nobody had lost anything, as after a preview build's release step, and spoke of an app no longer being global where it never was |

### Settled while building

Not owner decisions: what the code does where the plan was silent, or where
main had moved on since it was written.

| Question | What was built | Why |
|---|---|---|
| The readiness rule | `registryConfigState()`, which main added to `src/lib/connectors/status.ts` for the Connector Registry after this plan was written | It is exactly the approved rule: `ready` for a tenant connector, client credentials for a user-scoped one, and ready as installed for a connector that asks for no credentials. Credentials that can't be decrypted count as not configured. |
| A disabled connector | Blocks activating and granting, like an unconfigured one | The extension lifecycle plan (D7, rank 26) put this refusal in `getMissingTenantConfigConnectors()` and held it until this change rewrote that function. A disabled connector refuses every call, which is what the gate exists to catch. |
| What a blocked connector says | Its state in the Connector Registry's words (Not configured, Needs authorization, Disabled), and what to do: configure, connect or enable | "Configure" was wrong for a connector that is configured and only needs Connect, or is switched off. |
| Granting with no role | Stores no role, so the person follows `defaultRole`, shown as "(default)" | Storing the default's key would stop following the manifest if the default changed. |
| A second grant, or revoking someone without a grant | Changes nothing and records nothing, and says so (`changed: false`, 2026-10-15) | An upsert would reset a role an admin assigned, and a refusal would throw on /admin/users, whose forms have nowhere to put one, after a double click or from a stale page. |
| A role for someone without a grant | Refused on an app that isn't global; a role kept from when the app was global can be cleared there, not changed | Writing the grant row would be access by the back door, with no connector check and no `user.grant.add` row. `setUserAppRole()`, which did that, is removed. |
| Refusals | Returned as values from every changing action, `{ ok: false, message }` | A thrown error reaches the browser as an opaque digest in production, which is why main's newer actions return them too. |
| Input | Checked with zod after the admin check and before anything is read | Each action is a public POST endpoint, and its arguments come from whoever calls it. |
| Reads | `listAppAccess`, `searchUsersForGrant`, `listAppApiKeys`, `getMcpToolSettings` require an admin and aren't audited | As main's other reads (`getAppSchema`, `getAppSettings`). Every change is audited. |
| The user search | In SQL, holders left out before the limit, LIKE's wildcards escaped with `!` | Main's query builder has no `or()`, and filtering after a limit could show fewer than ten when more match. Someone with only a role is offered: they don't hold the app. |
| Tool switches when an app leaves | Kept with its row, like its grants; Delete data takes them, and counts them | The lifecycle plan's rules: Remove keeps an app's data, and Delete data takes the `apps` row and everything hanging off it. Its preview lists "MCP tool switches". |
| Tool switches when a different extension takes the slug | Deleted, with its keys (decided on 2026-10-15, above) | First built as kept, like settings. They were turned on for the tools of the extension before it. |
| Keys revoked by an identity change | Listed as revoked "when a different extension took this app's slug" | Read from the `app.identity.changed` audit row the release step writes in the same transaction as the revocation. |
| A switch the database can't read | Off for clients; the MCP tab says it couldn't read | Failing closed for clients; an admin shown "all off" for a read that failed would be told something untrue. |
| The consent screen with nothing to offer | Says a connection approved now sees nothing, and to connect again once tools are on | Consent is fixed at approval, so "until an app does" was not true. |
| The Toggle on the app import list | `src/components/ui/toggle.tsx` is a UI primitive, so apps can import it, like every other file there | The allowlist takes `@/components/ui/*` whole; the export snapshot test lists it. |

## Design

### Reach tab (was Connectors)

Two sections, rendered by `AppReachPanel`:

1. **Connectors.** Each required connector, with its state when it isn't
   ready, and a line saying a connector must be ready (configured, connected
   if it signs in with OAuth, and not disabled) before the app can be
   activated or granted.
2. **Network.** The `egress` hostnames, one per line in mono, with a line
   saying these are the only hosts the app's own code can call, each request
   and each redirect checked. A `*.example.com` entry gets a line saying it
   covers one level of subdomain and not the name itself. With no `egress`,
   an empty state: the app makes no outbound calls of its own, and reaches
   outside services only through its connectors.

### MCP tab: per-tool switches

- **Each tool card has a switch**, the same `Toggle` the App Manager uses to
  enable an app (`src/components/ui/toggle.tsx`, `role="switch"` with the
  state in words beside it). Off is the default and the state for any tool
  with no row.
- **The heading shows "n of m enabled"**, once the switches have been read.
- **One line explains the effect:** a tool that is off is not listed or
  callable for anyone, from its next call, and an app with none on is left off
  the consent screen.
- **Optimistic:** a switch moves when clicked and moves back, with the
  refusal, if the save fails.
- **Enforced on the server, not only in the UI:**

| Surface | Change |
|---|---|
| `tools/list` (`reachableApps` in `src/lib/mcp/tools.ts`, through `appsWithEnabledMcpTools`) | Omits disabled tools, and apps with none enabled. Main's app gate still applies after it |
| `tools/call` (`callTool` in `src/lib/mcp/broker.ts`) | Checks the grant before it looks the tool up. Refuses a disabled tool with `NOT_EXPOSED`, the answer a tool the app never declared gets, after the same reads |
| Consent screen (`consentableApps`) | Offers only apps with at least one enabled tool, each with only its enabled tools |
| Consent action (`approveAuthorization`) | Keeps only submitted apps with an enabled tool and a grant, whatever the form names |
| `/account/mcp` | "Apps you can share" reads `consentableApps`, so it lists what can actually be shared; consent is still per app |

A renamed tool is a new name, so it arrives disabled. That fails closed, which
is the right way to fail here. A different extension under the slug starts with
every tool disabled again: the release step deletes the switches.

### Access tab

A segmented filter heads the tab: **Users (n) · Password-gated (n) · Public (n)
· API keys (n)**. A segment the app has nothing for still shows, with its count
at 0 and an empty state that names the reason, following the dialog's
"every tab, always" rule. The API keys count is of live keys.

**Users**

- **One row per person with access:**
  - name and email;
  - **role**, when the app declares `roles` (see below);
  - granted by and when, from `user_app_grants.granted_by` / `granted_at`;
  - **Revoke**.
- **A global app lists every user,** because every user has access. A banner
  says access is implicit for everyone. Grant and Revoke are hidden, because
  `global` cannot be granted or revoked per user. Roles still apply:
  `setAppRoleAction` writes a role-only row, which carries the role and never
  access, for someone with no grant, so a global app's roles are managed here
  like any other app's.
- **An app that stopped being global** has a banner saying only the people
  granted it have it. It lists the people given a role while it was global
  apart, as "A role, and no access", each with **Grant**, which keeps their
  role while the app still declares it, and **Clear role**.
- **A grant or revoke that changes nothing** says so: the person already had
  the app and their role wasn't changed, or didn't have it.
- **Revoke confirms first.** It says the app leaves that person's dashboard and
  their MCP access to it ends on the next call, because both follow from the
  grant.
- **A search box** appears once the list is longer than ten rows.
- **After a grant or a revoke,** the list is read again, and the dialog's
  "Who can install it" row and the tile's "n granted users" pill take their
  count from it at once; the page's refresh then brings the server's.

**Roles** (only when the app declares `roles`; otherwise there is no role
column and no role filter):

- **The role column shows the effective role.** That is the stored role, or
  `defaultRole` when none is stored, shown as "Default (`<role>`)" so the
  admin can tell an inherited role from an assigned one.
- **Changing it** uses a select of the declared roles plus "Default
  (`<role>`)", which clears the stored role. It saves on change and is audited.
- **A role filter** sits beside the search box: "All roles", then each declared
  role with its count, counted by effective role. It combines with the search
  ("editors named Sam").
- **A stale role is flagged.** A stored role the manifest no longer declares
  (renamed or removed) shows as "Unknown role: `<key>`" in the warning tone,
  and gets its own filter entry. No route can name an undeclared role, so that
  user satisfies no role check until an admin picks one, and doesn't fall back
  to `defaultRole`.
- **Grant access** opens a small overlay anchored below the button:
  - a type-ahead over users by name or email, searched on the server and
    excluding people who already hold the app. It is a combobox: the arrow
    keys move through matches and Enter picks one;
  - once someone is picked, a role select when the app declares roles;
  - a Grant button.

  Escape and an outside click close the overlay only, never the dialog
  beneath it, and Escape returns focus to the button.
- **When a required connector isn't ready,** the button is replaced by a
  sentence saying what to do (configure, connect or enable it), and the server
  action refuses too.

**Password-gated**

- The pages and routes that accept the password, from the shared walk over
  the hoisted route contracts (`src/lib/apps/access-surfaces.ts`).
- The existing `AppPasswordPanel`: whether a password is set, plus set and
  rotate.
- A line saying that until a password is set nobody can unlock them: the pages
  say the app isn't available, and the routes refuse every request. That is
  the fail-closed rule.

**Public**

- Pages and routes whose auth set includes `public`, with the line "reachable
  by anyone on the internet, with no sign-in", in the warning tone.
- The data comes from the same contract walk, split by tier instead of merged.
- A route accepting both `public` and `password` appears in both lists.

**API keys**

- **Shown only when the app declares at least one `key` route.** Otherwise the
  empty state says the app accepts no API keys.
- **Each key shows:** label, `hint`, scopes, created by and when, last used,
  expiry, and status (active, expired or revoked, with when, and whether the
  release step revoked it because a different extension took the slug).
- **New key:** a label, then scopes picked from the app's `key` routes as
  `METHOD /path` (with "every key route" as an explicit choice), then an expiry
  of 30, 90 or 365 days, or never.
  - The key is shown once, with a copy button, and never again.
  - An empty scope list authorizes nothing, so the form requires at least one.
- **Revoke** sets `revoked_at`, which takes effect on the next request
  (`resolveApiKey` is live).

**An app the build doesn't carry** has **Revoke access…** on its entry under
Not in this build: the people with access and its live API keys, each with
Revoke. Granting, roles and minting need the manifest, so they aren't offered.

### Server actions

`src/lib/apps/grant-actions.ts`, `src/lib/apps/api-key-actions.ts` and
`src/lib/mcp/tool-settings-actions.ts` (new). `grant-actions.ts` replaces the
inline `toggleUserGrant` and backs both pages; `/admin/users` keeps thin
FormData adapters that check for an admin themselves and call it. Every action
calls `requireAdmin()` before it reads anything, then checks its input with
zod. Every action that changes something calls `recordAdminAction()` and
returns `{ ok: true }` or `{ ok: false, message }`; the grant actions say
whether anything changed, `{ ok: true, changed }`.

| Action | Notes |
|---|---|
| `grantAppAccess(slug, userId, role?)` | Refuses global apps, unknown slugs, a user who doesn't exist, and a required connector that isn't ready. Validates `role` against the manifest; none stores null, which follows `defaultRole`. Turns a role-only row into a grant with the role given. Leaves a grant the person already holds as it is, with `changed: false`. Clears the app's **Needs grants** mark. Audited `user.grant.add` |
| `revokeAppAccess(slug, userId)` | Refuses global apps. Deletes the install row, then the grant, then the person's widgets, as `toggleUserGrant` did; someone without a grant is left as they are, with `changed: false`. Works for an app the build doesn't carry. Audited `user.grant.revoke`, with `notInBuild` for such an app |
| `setAppRoleAction(slug, userId, role \| null)` | Validates `role` against the manifest. On a global app a role writes a role-only row for someone with no grant, and sets it on a grant; `null` deletes a role-only row and clears a grant's role. On any other it updates the existing grant, `null` clearing it back to `defaultRole`; a role-only row can be cleared with `null` and is otherwise refused, as is someone with no row. Each change is one statement that says whether it changed anything. Audited `user.role.set`, when something changed |
| `searchUsersForGrant(slug, query)` | Matches name or email with `ilike`, escaped with `!`, at most 10 results, excluding the people who hold it |
| `listAppAccess(slug)` | Grants, joined to users, each with its effective role and whether that role is inherited or stale; the people with only a role, apart; and when the app stopped being global. For a global app, every user. Works for an app the build doesn't carry |
| `getMcpToolSettings(slug)` | Each declared tool's switch. Throws when the table can't be read |
| `setMcpToolEnabledAction(slug, tool, enabled)` | Rejects a tool name the manifest does not declare. Audited `app.mcp.tool.enable` / `app.mcp.tool.disable` |
| `listAppApiKeys(slug)` | Every key, revoked ones included, never the key or its digest. Works for an app the build doesn't carry |
| `mintAppApiKey(slug, { label, scopes, expiresInDays })` / `revokeAppApiKey(slug, id)` | Scopes are validated against the app's `key` routes, or exactly `["*"]`; a label is plain text on one line, with no control, format or separator characters, up to 80 characters. Revoking is scoped to the app, and works for an app the build doesn't carry. Audited `app.apikey.create` (label, scopes, expiry, key id) / `app.apikey.revoke`, with `notInBuild` for such an app |

`getMissingTenantConfigConnectors()` (`src/lib/apps/connector-gates.ts`)
returns each blocking connector with its state (`unconfigured`,
`needs-authorization` or `disabled`), and `src/lib/apps/connector-readiness.ts`
holds the states' words, for the server and the browser alike. It throws when
the connector switch can't be read; the admin pages pass `forDisplay`, which
falls back to the credentials and logs it.

### Data model: migrations 0013 and 0014

`supabase/migrations/0013_role_only_grants.sql`, in phase 2:

```sql
alter table public.user_app_grants
  add column if not exists role_only boolean;
alter table public.apps
  add column if not exists global boolean,
  add column if not exists needs_grants_since timestamptz,
  add column if not exists needs_grants_reason text
    check (needs_grants_reason in ('global-ended', 'roles-decided'));
create index if not exists idx_admin_audit_log_cli_grant_add
  on public.admin_audit_log (target_id, (details->>'appSlug'), created_at)
  where action = 'user.grant.add' and actor_id is null;
```

- `role_only` is false for a grant, true for a role and nothing else, and null
  until decided: every row before this file, and any row a build without the
  column writes. The rule decides an undecided row
  (`src/lib/apps/grant-rule.ts`), in every check and at every release step;
  the index serves its audit question.
- `apps.global` is what the last release step that carried the app saw, so the
  next one can tell the app stopped being global. `needs_grants_since` and
  `needs_grants_reason` are the **Needs grants** mark, set only when someone
  lost the app, and cleared by a grant or by the app becoming global again.
- It bumps `platform_schema_version` to 13, last.

`supabase/migrations/0014_app_mcp_tool_settings.sql`, in phase 3:

```sql
create table if not exists public.app_mcp_tool_settings (
  app_slug    text not null references public.apps(slug) on delete cascade,
  tool_name   text not null,
  enabled     boolean not null default false,
  updated_by  uuid references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (app_slug, tool_name)
);
alter table public.app_mcp_tool_settings enable row level security;
```

- A missing row means disabled.
- RLS on and no policies, as every table here; 0001's sweep has already run, so
  the migration enables it itself.
- It bumps `platform_schema_version` to 14, last. Main's own 0008 to 0012
  took the numbers this plan first expected, and 0013 is phase 2's.
- API keys need no schema change.

## File-level changes

### Phase 1: reach (manifest data only, no schema)

- `src/components/admin/app-details-dialog.tsx`: the Connectors tab renamed
  Reach, drawn by `AppReachPanel`, with a Network section.
- `src/components/admin/app-reach-panel.test.ts` (new).

### Phase 2: Access tab

- `src/lib/apps/grant-actions.ts` (new): the grant actions above.
- `src/lib/apps/api-key-actions.ts` (new), and `src/lib/apps/api-keys.ts`:
  `listApiKeys` (with the identity-change flag) and `revokeApiKey`.
- `src/lib/apps/access-surfaces.ts` (new): the contract walk, client-safe,
  shared by the panel, by `setAppPasswordAction` and by the key actions.
  Replaces `src/components/admin/app-visibility-panel.tsx`, which is deleted.
- `src/lib/apps/connector-gates.ts` and `src/lib/apps/connector-readiness.ts`
  (new): readiness by `registryConfigState()`, the switch, and their words.
- `src/lib/apps/admin-actions.ts`: `setAppPasswordAction` reads the contract
  walk; activation says what to do about each blocking connector.
- `src/lib/apps/access.ts`: `setUserAppRole` removed, as nothing calls it.
- `src/app/(main)/admin/users/page.tsx`: drops the inline `toggleUserGrant`
  body and calls the shared actions. `src/components/admin/user-dialog.tsx`
  says what to do about a blocking connector.
- `src/components/admin/app-access-panel.tsx` (new): the filter and the four
  views. `src/components/admin/app-api-keys-panel.tsx` (new).
- `src/components/admin/app-details-dialog.tsx`: the Access tab renders the new
  panel; the not-ready connector warning and pills name each state.
  `src/components/admin/app-tile.tsx` and `app-registry-list.tsx`: the shared
  type, and the grant count from the Access tab.
- `src/components/ui/toggle.tsx` (new): the App Manager's on/off switch as a
  primitive, used by the MCP tab and by `src/components/apps/app-toggle-list.tsx`,
  which drew it inline before.
- `src/app/(main)/admin/apps/page.tsx`: where to grant.
- `scripts/smoke-activate.ts`: the same words for a blocking connector, and
  a null role. `scripts/ci-extensions.ts`: grants only what isn't global.
- `supabase/migrations/0013_role_only_grants.sql` and
  `src/lib/apps/grant-rule.ts` (new): which rows are grants.
  `scripts/sync-app-registry.ts` records each app's `global`, decides the
  undecided rows of every app it carries, and marks the end of an app's being
  global; `scripts/app-migrations.ts` prints both. `src/lib/apps/access.ts`:
  `hasAppGrant`, `getUserGrantedSlugs` and the new `filterHeldApps` read
  grants by the rule, and `getAppBuildStatus` the **Needs grants** mark;
  `src/lib/dashboard/actions.ts` and `src/lib/apps/actions.ts` show only apps
  the user holds, and the menu bar's reorder keeps the others' places.
- `src/lib/apps/auth-tier.ts`: a route-scoped key needs the method and route.
- `src/components/admin/not-in-build-access.tsx` (new), from
  `apps-not-in-build.tsx`. `src/components/admin/newest-wins.ts` (new).
  `src/components/admin/user-table.tsx`: the stored role and kept roles.
- Tests: `src/lib/apps/access-admin.integration.test.ts`,
  `src/lib/apps/grant-search.integration.test.ts`,
  `src/lib/apps/access-surfaces.test.ts`,
  `src/lib/apps/connector-readiness.test.ts`,
  `src/components/admin/missing-connector-warning.test.ts`,
  `src/components/admin/user-app-access.test.ts`,
  `src/components/admin/app-access-reads.test.ts` and
  `src/lib/apps/role-upgrade.integration.test.ts` (new);
  `src/lib/apps/import-policy.test.ts`,
  `scripts/smoke-activate.integration.test.ts` and
  `src/lib/analytics/ingest.integration.test.ts`, whose grants are written as
  a grant path writes them.

### Phase 3: MCP tool switches

- `supabase/migrations/0014_app_mcp_tool_settings.sql` (new).
- `scripts/sync-app-registry.ts`: a different extension under the slug loses
  its switches, counted in `app.identity.changed` and in the release step's
  line (`scripts/app-migrations.ts`).
- `src/lib/mcp/tool-settings.ts` (new): `enabledTools(slug)`, request-cached
  with React's `cache`, `enabledToolsBySlug` for the lists, failing closed, and
  `readToolSwitches` for the admin screen, which throws.
- `src/lib/mcp/tool-settings-actions.ts` (new).
- `src/lib/mcp/tools.ts`, `src/lib/mcp/broker.ts`: filter `tools/list` and
  `consentableApps`, and refuse disabled tools in `callTool`, after the grant.
  `src/app/api/mcp/route.ts`: the `listChanged` comment.
- `src/app/(main)/oauth/authorize/authorize-action.ts`: checks the submitted
  apps against the same rule. `page.tsx`: the empty state.
- `src/components/admin/app-details-dialog.tsx`: switches on the MCP tab, in
  `McpToolsPanel`, read each time it is shown. `app-tile.tsx`: what an
  identity change did.
- `src/lib/repository/delete-data.ts`, `delete-data-outcomes.ts`: Delete data
  counts the switches it takes, and names them in what goes.
- `src/lib/apps/types.ts` and `apps/_template/mcp/hello.ts`: their comments say
  a tool is reachable once an admin turns it on.
- Tests: `src/lib/mcp/tool-switches.integration.test.ts` and
  `src/components/admin/mcp-tools-panel.test.ts` (new);
  `scripts/app-identity.integration.test.ts` checks the switches go;
  `src/lib/apps/app-maintenance.integration.test.ts` switches its fixture
  tools on; `src/lib/repository/delete-data.integration.test.ts`,
  `delete-data-admin.test.ts` and `remove-admin.test.ts` count the switches.

### Docs

- `docs/apps/mcp.md`, `docs/apps/architecture.md` and `apps/AGENTS.md`: tools
  are admin-enabled and off by default.
- `docs/apps/api-routes.md`, `docs/apps/roles.md`: where keys are made and roles
  are set, a stale role, Default following `defaultRole`, a role on an app
  that stops being global, and revoking keys of an app out of the build.
- `docs/hosting/after-you-install/README.md`: Revoke access under Not in this
  build, and what an identity change does to the MCP tools.
- `docs/connectors/credentials.md`: a disabled connector blocks activating and
  granting.
- `docs/security-architecture.md`: §17 (MCP authorization chain, and what a
  caller can tell from an answer), §22 (app API keys: minting, labels, a key
  where the route can't be named, an app out of the build, and revocation on
  an identity change), §3.1 (who writes grants, the gate before granting, a
  role is never access, and an identity change), §9 (the new admin actions),
  §19 (the switch and activation), §28 (the new audit actions), §8 and §31
  (Delete data takes the switches).
- `WHATS-NEW.md`: entries under 2026-10-15, the day this merges, each phase
  adding its own; the MCP one marked breaking.
- mixos.org Permissions page: say egress is shown on the app's Reach tab. That
  page lives in the mixos-org repository, so it is a follow-up there.

## Verification

Each item names the test that covers it, where one does. Each was also run
against a fresh instance built from this change (the release step, a
production build and `next start`), with scripted HTTP, MCP and browser
checks.

### Phase 1

1. An app declaring `egress` lists its hosts on Reach.
   (`app-reach-panel.test.ts`)
2. An app declaring none shows the empty state. (same)

### Phase 2

1. Grant through the type-ahead. The user appears with the default role, the
   tile's grant count updates, and `admin_audit_log` has the row.
   (`access-admin.integration.test.ts`: the grant, its audit row, the list)
2. Change the role, then revoke. The app leaves that user's dashboard, and their
   MCP token stops listing its tools. (the role and revoke tests; the token half
   in `tool-switches.integration.test.ts`, which also checks the token itself
   is left alone)
3. A three-legged tenant connector with a saved client ID and no grant blocks
   Grant on both pages. Pressing Connect unblocks it. A user-scoped connector
   with client credentials does not block. (the readiness tests, through the
   shared action both pages call, and activation)
4. A global app lists every user with no Grant or Revoke, and
   `grantAppAccess` refuses it directly. Changing a role there takes effect on
   that user's next request, and they still have access. (the global-app tests)
5. On an app with roles, a user with no stored role shows `defaultRole`
   "(default)". Choosing "Default" clears an assigned role. The role filter's
   counts match the rows it shows, and it combines with the search. (the
   effective role and its source in the list test; the filter in a browser)
6. Rename a role in the manifest. Users holding the old key show "Unknown
   role", appear under that filter entry, and are refused by role-gated routes
   until reassigned. (the stale-role test)
7. Mint a key scoped to one route. It works with `curl` on that route, is
   refused on another, and is refused on its route once revoked. (the key
   tests, through `resolveAuthTier`)
8. Each action called as a non-admin, straight to the server action, throws,
   for an app out of the build too. (the first test)
9. Set roles on a global app, including a row as /admin/users wrote it before,
   then release with the app global, then not. The undecided row is decided a
   role; nobody holds the app through a role by any path (`hasAppGrant`, the
   session route, the granted and held lists); the release step audits both
   and Admin > Apps marks **Needs grants**; the Access tab lists the people
   with a role apart; a role there can be cleared, not changed; granting keeps
   the role and clears the mark. Released global again, the grant stays one,
   and outlasts the app's being global once more. (the role-only test; the
   menu bar and dashboard read `filterHeldApps`, which it checks)
10. An app out of the build: its grants and keys are listed and revoked,
    audited with `notInBuild`; granting, roles and minting are refused. (the
    out-of-build test)
11. Granting someone who already has the app, or revoking someone who
    doesn't, returns `changed: false`, writes nothing and refreshes the pages.
    (the grant and revoke tests)
12. The search finds `!`, `%`, `_` and a backslash literally, with
    `standard_conforming_strings` on and off. (`grant-search.integration.test.ts`)
13. A route-scoped key is refused where the route can't be named; a key for
    every route isn't. A label with a control, separator or invisible
    formatting character is refused. (the key tests)
14. When the connector switch can't be read, granting fails and the pages show
    the credentials' answer. (the gate tests)
15. From a database at 0012 with rows as the code before wrote them: the deploy
    that applies 0013 and ends an app's being global leaves its roles, and a
    role after a revoked grant, without access, keeps the grants (an admin's
    from before the app went global, the CLI's), and marks the app **Needs
    grants**; an app missing from it is decided when it returns; a row an
    older build writes after a rollback is decided at once, and by the next
    release step; a build that sees an app as global demotes no grant, and
    nobody having lost it, the app isn't marked; an admin's audit row alone
    makes no role a grant, and the CLI's and the pull-request check's do.
    (`role-upgrade.integration.test.ts`)
16. The CLI's and the pull-request check's grants survive a release step, each
    audited as the CLI. (`smoke-activate.integration.test.ts`)
17. The menu bar reorders with an install of a switched-off app, which keeps
    its place; with the grants unreadable, it and the dashboard show the
    global apps. (the menu-bar and degrade tests)
18. A role change a revoke beats returns `changed: false` and records nothing.
    (the race test, with a trigger that skips the update)
19. **Needs grants** says why: `global-ended` when an app stops being global
    and people who had it have no grant, `roles-decided` when old roles are
    decided on an app that isn't global, and nothing when everyone who had it
    is granted it. (the role-only and upgrade tests)

### Phase 3

1. After migrating, `tools/list` from the MCP inspector is empty, and the
   consent screen offers no apps. (`tool-switches.integration.test.ts`, through
   the MCP route, with 0014 applied to a fresh database and, with 0013, to one
   at 0012)
2. Enable one tool. It is listed and callable; its sibling is neither, and
   calling the sibling by name returns the unknown-tool error.
3. Disable it again. A call on an already-issued token is refused on the next
   request.
4. Someone without the app gets `FORBIDDEN_USER` for a disabled, an enabled
   and an undeclared tool alike, and the switches are read for an undeclared
   name too. (the grant-first and unreadable-switch tests)
5. A different extension under the slug: the release step deletes the
   switches, counts them in `app.identity.changed` and prints the count.
   (`scripts/app-identity.integration.test.ts`)
6. An app that stops being global takes its tools from everyone not granted
   it, a kept role included; granting brings them back on the same token.

## Out of scope

- **Per-user MCP tool choices.** The admin switch is instance-wide; users still
  consent per app.
- **Bulk grant** (a group, or everyone with an email domain).
- **Pagination of the Users list.** A global app lists every user in one read,
  which suits the instances MixOS runs today.

Two items this plan once listed here are no longer out of scope, because they
exist:

- **App settings (`env`).** This plan left them out because `setAppSetting()`
  in `src/lib/apps/env.ts` had no caller, so no screen could configure an app's
  `env`. Main has since built that screen: the dialog's **Settings** tab,
  `src/components/admin/app-settings-panel.tsx`, through `getAppSettings`,
  `setAppSettingAction` and `clearAppSettingAction` in
  `src/lib/apps/settings-actions.ts`, audited as `app.setting.set` and
  `app.setting.clear`. This change leaves it as it is, between Access and Hooks
  & Services.
- **`last_used_at` on API keys.** `resolveApiKey` already writes it, best
  effort, on every keyed request, so the API keys view shows it.

## Open questions

None open. The three raised in review are answered under
[Locked with the user](#locked-with-the-user-on-2026-10-05), the four
proposed here under
[Approved with the user](#approved-with-the-user-on-2026-10-14), and the
security review's findings under
[Decided with the user](#decided-with-the-user-on-2026-10-15-after-a-security-review)
and [after the re-check](#decided-with-the-user-on-2026-10-15-after-the-re-check).
