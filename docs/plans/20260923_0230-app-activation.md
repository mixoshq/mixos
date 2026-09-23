# App activation, and the Install / Enable vocabulary

## Context

Three words were doing one job. The catalogue said **Register**, the App
Manager said **Installed / Not installed**, and `apps.is_active` — a column
that has existed since `0001_initial.sql` — was read by nothing at all. An
admin had no way to take an app out of service short of deleting its
directory, and a user toggling "install" was not installing anything: the code
was already on the instance.

## Decisions

- **Three verbs, three stages.** *Install* brings an extension's code onto the
  instance (catalogue → this deployment). *Activate* makes an app serve
  anything (admin → instance). *Enable* is a user putting it on their own
  dashboard (user → themselves). Each is a different party's decision, so each
  keeps its own word.
- **Install everywhere in the catalogue.** Apps, connectors and themes all say
  **Install**, and the browse prose follows. "Register" described the
  implementation (writing a registry row), not the act.
- **Enabled / Disabled in the App Manager.** The toggle already meant "do I
  want this", not "is it on disk".
- **A newly installed app arrives inactive.** `is_active` is absent from the
  registry sync's conflict clause, so a redeploy never re-decides a switch an
  admin has thrown — and a newly seen slug is inserted `false`. Apps already in
  the instance keep the value they have, so nothing in a running deployment
  changes state on upgrade.
- **"Install & Activate" is one click when that is what you meant.** The
  catalogue's button is a split button for apps: Install on the face,
  Install & Activate under the chevron. Connectors and themes get no such
  option — a connector does nothing until it is configured and a theme does
  nothing until it is applied, so both already have this gate.
- **Deactivation is complete, not cosmetic.** An inactive app is refused, not
  merely hidden: it disappears from every list AND every gate turns it away.
  An app that still answered requests after being switched off would make the
  switch a lie, and the surface that would still be answering — public and
  password-tier routes, which never consult a grant — is the one where that
  matters most.
- **Nothing is deleted.** Installs, grants, dashboards and app data are
  untouched, so reactivating restores every user's setup exactly.

## File-level changes

- `src/lib/apps/access.ts` — `isAppActive` (React `cache`, so one render asks
  once), `filterActiveApps`, `setAppActive` (an upsert: an app installed from
  the catalogue is activated before the registry sync writes its row),
  `getAppActiveMap`. `hasAppGrant`, `hasAppAccess`, `getUserApps`,
  `getUserGrantedSlugs` and the global-app install all consult it.
- `src/lib/apps/auth-tier.ts` — `resolveAuthTier` returns `not-served` for an
  inactive app, above the tier loop. This is the gate every API route and
  public page passes through, on both the wire (`dispatch.ts`) and the
  server-side path (`call.ts`).
- `src/lib/apps/scheduler.ts` — the tick joins `apps` and the atomic claim has
  an `exists` check, so neither the scheduler nor "Run now" can start a job for
  an inactive app. Inside the claim rather than before it, so nothing races
  past and advances `next_run_at`.
- `src/lib/dashboard/actions.ts` — `getDashboard` filters widgets belonging to
  inactive apps out of the read. The rows and the layout stay.
- `src/lib/apps/admin-actions.ts` — `setAppActiveAction`, admin-gated and
  audited (`app.activate` / `app.deactivate`).
- `scripts/sync-app-registry.ts` — new apps insert `is_active = false`.
- `src/components/admin/app-tile.tsx` + `app-registry-list.tsx` +
  `(main)/admin/apps/page.tsx` — an **Inactive** pill and an
  Activate / Deactivate button, primary while the app is off.
- `src/components/admin/browse/*` — Register → Install throughout; the split
  button; a failed activation reported without claiming the install failed.
- `src/components/apps/app-toggle-list.tsx` + `(main)/apps/page.tsx` —
  Enabled / Disabled.

## Verification

Driven in a browser against the local stack, with `wall-e` as the subject:

- App Manager reads **Enabled**; admin tiles offer **Deactivate**.
- Deactivating shows the **Inactive** pill, removes the app from the App
  Manager, removes its widget from the dashboard, and makes its API route
  return **404** rather than data.
- Reactivating brings the widget back, unchanged.
- `npm run lint`, `npm run typecheck`, `npm run build`.

Still worth doing by hand: a `password`-tier public page on a deactivated app
(should 404, not prompt), and a scheduled job that is due at the moment an
admin deactivates its app.
