# App Tailwind sources: every registered app's classes, whatever git ignores

**Status:** built on 22 November 2026, on branch `fix/tailwind-extension-sources`.
`npm run typecheck` and `npm run lint` pass (0 errors), as does `npm test`: 1775 pass, and the
14 database suites skip, since nothing here touches the database. The live check under
Verification passed too.

**Scope:** platform. The registry generator (`scripts/generate-project-registry.ts`, plus a new
`scripts/app-sources.ts`), a new generated file `src/generated/app-sources.css`, one import in
`src/app/globals.css`, and a sentence in `docs/apps/assets.md`.

## Context

Tailwind v4 finds the classes to generate by scanning the project's files, and it skips the files
git ignores. In a clone of the core repository, `scripts/core-excludes.ts` puts `/apps/*` (and the
same for `connectors/` and `themes/`) in `.git/info/exclude`, so that the extensions the core
doesn't carry stay out of `git status`. Only the core's own extensions are un-ignored
(`scripts/core-extensions.ts`).

So in such a clone, a class that only a non-core app uses is never generated, and the app renders
without it. Found while making README screenshots (#122): a demo calendar widget's
`grid-cols-5` was missing, and its five day columns stacked into one. Someone's own copy of MixOS
isn't affected, because `core-excludes` removes the block there. Maintainers developing or
reviewing an app in the core clone are.

What Tailwind 4.2.2 (`@tailwindcss/postcss`) does with an ignored `apps/<slug>/`, each case run in
a fresh process because the plugin caches its result per input file:

| `globals.css` has | Class from the ignored app generated |
|---|---|
| nothing extra (automatic detection) | no |
| `@source "../../apps";` | no |
| `@source "../../apps/**/*.tsx";` | no |
| `@source "../../apps/<slug>";` | **yes** |
| `@source "../../apps/<slug>/<file>.tsx";` | **yes** |

Registering `apps/` doesn't help, because the ignore rule `/apps/*` matches each app's folder as
the scanner walks `apps/`. Registering an app's folder by name does, because nothing inside it is
ignored in its own right. The same holds with the rule in `.gitignore` instead.

## Decisions

1. **The generator names every registered app's folder as a Tailwind source.** It writes
   `src/generated/app-sources.css`: one `@source "../../apps/<slug>";` per app in the registry,
   in registry order. `globals.css` imports it after the themes, as it imports
   `src/generated/themes.css`.
2. **Every registered app, not only the ignored ones.** For an app git doesn't ignore, the line
   repeats what automatic detection already finds, which costs nothing. Listing every app keeps
   the file free of git, so it's the same in a core clone, a fork, CI and a Docker build.
3. **Registered apps only.** An app the generator skips, or one waiting in `.mixos/pending/`,
   isn't served, so its classes aren't needed. Connectors and themes have no Tailwind markup:
   a connector is server code, and a theme is CSS.
4. **Nothing changes in `core-excludes`.** Hiding the folders from `git status` is still right.
   Tailwind just stops depending on them not being hidden.

## Structure

- `scripts/app-sources.ts` (new, pure): `appSourcesCss(slugs)` returns the generated file's text.
- `scripts/generate-project-registry.ts`: writes `APP_SOURCES_CSS_FILE` after the app registry.
- `src/app/globals.css`: `@import "../generated/app-sources.css";` after the themes import, with
  a comment saying why.
- `docs/apps/assets.md`: the line that says every Tailwind class is available to an app says how.

## Tests

`scripts/app-sources.test.ts`:

- The text has one `@source` per slug, in order, relative to `src/generated/`, quoted. No slugs is
  a file with only its header. The header says it is generated and why.
- End to end, through real Tailwind in a child process (to avoid the plugin's cache): a throwaway
  git repository ignores `/apps/*` in `.git/info/exclude`, as a core clone does, and holds an app
  using a class nothing else uses. Without the generated file the class isn't generated. With it,
  imported as `globals.css` imports it, the class is.

## Verification

- `npm test`, `npm run typecheck`, `npm run lint`.
- In the Docker dev server on the core clone: a scratch app under `apps/`, ignored by
  `.git/info/exclude`, whose widget uses classes nothing else uses. After `npm run registry`,
  those classes are in the served CSS. Then an edit to the widget that adds another such class
  reaches the CSS without a restart. Remove the scratch app afterwards.

What the live check found, on the core clone's Docker dev server:

- A scratch app made with `npm run new` was git-ignored by `.git/info/exclude`. Its widget used
  `grid-cols-9`, which was in neither the source nor the served CSS before.
- `npm run registry` added `@source "../../apps/tw-probe-…";` to the generated file, and
  `.grid-cols-9` was in the served CSS with no restart.
- An edit to the widget adding `lg:grid-cols-[13rem_1fr]` reached the served CSS within four
  seconds, again with no restart: the named folder is watched like any other source.
- The scratch app was then removed, and the generated file went back to Wall·E alone.
