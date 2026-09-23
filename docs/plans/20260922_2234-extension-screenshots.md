# Screenshots for apps and themes

**Status:** done
**Scope:** platform — `src/lib/`, `scripts/`, `src/proxy.ts`, the `_template` scaffolds, docs

## Context

An app or theme is chosen from a listing before it is installed, and today that
listing has almost nothing to look at. An app declares a Lucide `icon` name and
nothing more; a theme may declare a single `assets.preview` thumbnail. The
catalogue client already models a gallery — `ScreenshotSchema` in
[`src/lib/repository/types.ts`](../../src/lib/repository/types.ts) carries
`{ url, alt, width, height, caption }` — but that is data fetched *from*
mixos.org. Nothing on this side of the wire produces it.

The README cannot fill the gap. The listing renderer resolves relative image
paths against mixos.org, so a `./screenshot.png` in a README is documented as a
dead link (see [`docs/apps/architecture.md`](../apps/architecture.md)). An
author who wants to show their app has no supported way to do it.

This adds a `screenshots/` directory and a manifest `screenshots` array to apps
and themes, validated at build time and resolved into public URLs in the
generated registries.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Which kinds | Apps and themes. **Not connectors.** | A connector has no UI to screenshot — its icon is its whole visual identity. |
| Entry shape | `{ file, alt?, caption? }` | Mirrors the catalogue's `ScreenshotSchema` so the two sides line up. `alt` optional to keep scaffolding cheap; the runtime type is `string \| null` so a renderer can tell "no alt supplied" from "deliberately empty". |
| Path form | Full relative path: `"screenshots/dashboard.png"` | Same convention as a connector's `icon: "assets/icon.svg"` — the manifest says where the file actually is instead of leaving the directory implied. |
| Location | `apps/<slug>/screenshots/`, `themes/<slug>/screenshots/` | Top-level, beside `assets/` rather than inside it. A theme's `assets/` is copied wholesale to `public/themes/<slug>/`; folding screenshots in there would give them two public URLs. |
| Serving | `public/screenshots/<kind>/<slug>/`, proxy-exempt | One copy step and one matcher exemption for both kinds. Same category as connector icons and theme assets: listing imagery, committed in the repo, never a place a secret hides. |
| `assets.preview` | Unchanged | It is the admin **picker thumbnail**; `screenshots` is the **listing gallery**. Two purposes, no migration, no breaking change. |
| UI | None in this pass | The registries carry resolved URLs so a gallery can be built later. |

## Constraints (build-enforced)

| Rule | Value | Why |
|---|---|---|
| Formats | `.png` `.jpg` `.jpeg` `.webp` | No SVG. A screenshot is not a vector, and an SVG is a script-bearing document served from an unauthenticated path. |
| Count | ≤ 8 per app/theme | A gallery nobody scrolls past item eight. |
| File size | ≤ 2 MB each | These ship in the repo and over the wire. |
| Min width | ≥ 640px | Below that it is a thumbnail, and it will ship visibly soft. |
| Height / aspect | Unconstrained | An app page and a widget are different shapes; forcing one aspect would mean letterboxing. |

Each failure aborts the build with a message naming the file and the measured
value, matching how `validateConnectorIcon` already reports a wrong-sized icon.

## File-level changes

1. **`src/lib/screenshots.ts`** (new) — the `Screenshot` runtime type plus the
   constraint constants, imported by both manifest type files, the schema, and
   the generator. One definition, so apps and themes cannot drift.

2. **`scripts/manifest-schemas.ts`** — `screenshotSchema` (`{ file, alt?, caption? }`,
   `file` constrained to start with `screenshots/`), added to
   `RawAppManifestSchema` and `RawThemeManifestSchema` as optional arrays.
   Shape only; existence and pixels are the generator's job.

3. **`scripts/generate-project-registry.ts`**
   - `readImageSize` gains **JPEG** support (SOF marker scan). It parses PNG and
     WebP today, and returns `null` for anything else — which the caller treats
     as "cannot measure". Allowing `.jpg` without this would mean the width
     floor silently stops applying to the most common screenshot format.
   - `validateScreenshots(entries, kind, slug, dir)` — existence, extension,
     byte size, measurable-image, min width, count. Returns resolved
     `Screenshot[]`.
   - `copyScreenshots` — copies `<dir>/screenshots` → `public/screenshots/<kind>/<slug>/`
     for each app and theme. Deliberately not `copyDir`: only *declared* files
     are copied, so an undeclared draft in the directory never reaches a public
     URL.
   - Emit `screenshots` into `AppManifest` and `ThemeManifest`.

4. **`src/lib/apps/types.ts`, `src/lib/themes/types.ts`** — `screenshots: Screenshot[]`
   on each manifest interface, documented as generator-derived (an author writes
   `file`/`alt`/`caption`; `url`, `width` and `height` are measured).

5. **`src/proxy.ts`** — add `screenshots/` to the matcher's negative lookahead,
   with a comment extending the existing "public by nature" reasoning.

6. **`.gitignore`** — `/public/screenshots/`, alongside `/public/themes/` and
   `/public/connector-assets/`. It is generated output.

7. **Templates** — `apps/_template/screenshots/README.md` and
   `themes/_template/screenshots/README.md` explaining the convention and the
   constraints, with a commented manifest example. The manifests themselves get
   **no** `screenshots` key, so a scaffolded app builds green with an empty
   directory.

8. **Backfill** — `screenshots/` directories created for `career`,
   `inbox-actions`, `wall-e`, `mixos` and `mixos-dark`. Real images were supplied
   for all but `wall-e` and are declared; `wall-e` keeps a placeholder README so
   the empty directory survives a commit.

9. **Docs** — `docs/apps/architecture.md` (manifest field reference + a note
   beside the "images must be absolute URLs" README rule saying where screenshots
   go instead), `docs/apps/assets.md`, `docs/themes/assets.md` (how `screenshots`
   differs from `assets.preview`), and one new invariant in each of
   `apps/AGENTS.md` and `themes/AGENTS.md`.

## Verification

All run, all passing.

1. `npx tsx scripts/generate-project-registry.ts` — clean. Four declared
   screenshots resolve, measure and copy; `wall-e` carries `[]`.
2. Failure paths, each exercised against `apps/wall-e` and each aborting with a
   message naming the file and the measured value: missing file, `.svg`, a
   400x128 PNG (below the width floor), a 2.2 MB PNG, the same file declared
   twice, and a `file` escaping the directory (caught by the schema).
3. Measured dimensions cross-checked against `sips` — exact for PNG and for the
   newly-added JPEG path (3410x1090 both ways).
4. Served **signed out**: `/screenshots/apps/career/applications.png` returns
   200 `image/png`, while `/apps/career` still 307s to `/login`. The exemption
   opened the screenshot path and nothing else.
5. Undeclared files are not published — the `_template` and `wall-e`
   `README.md` files sit in source `screenshots/` directories and appear
   nowhere under `public/screenshots/`.
6. `npm run typecheck`, `npm run lint`, `npm run build` — all clean.

## Out of scope

- Connectors.
- Any UI that renders a gallery.
- Changing `assets.preview`.
- Publishing the array to mixos.org — the registry now carries it; the publish
  path is a separate change.

## Follow-up worth someone's judgement

Two of the four backfilled screenshots show a state that undersells the app:
`career` is an empty tracker ("Nothing tracked yet") and `inbox-actions` is the
unconfigured-connector guard ("Failed to load — Gmail is not configured"). Both
are honest and both are real screens, but a listing is a sales surface, and the
guidance in the template README — lead with the view that answers "what is
this?", with real-looking data in it — points the other way. Worth re-capturing
with seeded data before these listings go anywhere public.
