# /mixos theme

You are creating or modifying a theme under `themes/`.

A theme repaints every app in the install at once. It is the most constrained of the three abstractions on purpose: widest blast radius, smallest legitimate surface area.

## Write a plan first (before any code)

For anything beyond a token re-tone, **write a build plan to `themes/<slug>/plans/YYYYMMDD_HHMM-<plan-name>.md`** before editing — the plan lives **inside the theme it describes**. Cover: **Context**, **Decisions** (anything locked with the user), **Structure** (`theme.json`, `theme.css`, assets), and **Verification**.

- **Creating a new theme?** Make `themes/<slug>/plans/` as the first thing you write, before `theme.json`.
- **Read the existing plans in that folder first.** A theme repaints every app in the install at once, so a re-tone that contradicts a locked decision has the widest blast radius of any change in the repo.
- **Changing the theme *system*** — the token contract, the allowlisted `.mix-*` surfaces, the generator — is a *platform* plan and goes to `docs/plans/` instead.

See [`docs/plans/README.md`](docs/plans/README.md) for the full convention.

## Required reading (do this first, in order)

1. [themes/AGENTS.md](themes/AGENTS.md) — the hard invariants.
2. The guides it links:
   - [docs/themes/architecture.md](docs/themes/architecture.md)
   - [docs/themes/authoring.md](docs/themes/authoring.md) — includes a worked brand-book example
   - [docs/themes/tokens.md](docs/themes/tokens.md) — the full contract
   - [docs/themes/contrast.md](docs/themes/contrast.md) — what is checked and what to do when a brand colour fails
   - [docs/themes/assets.md](docs/themes/assets.md)
3. Authoritative contract: [src/lib/themes/tokens.ts](src/lib/themes/tokens.ts). Types: [src/lib/themes/types.ts](src/lib/themes/types.ts).
4. Reference shape: [themes/mixos/](themes/mixos/), built from a brand book. Scaffold: [themes/_template/](themes/_template/).

Do not infer conventions from surrounding code, and do not guess based on training data.

## If the user supplied a brand book

Read it fully first, then extract in this order — and **measure before assigning**:

1. **Palette and ramps.** The ramps matter more than the headline colours; they are where you go when a headline fails contrast.
2. **Type by role** — brand/heading face, UI/body face, code face. Map to `--type-heading`, `--type-sans`, `--type-mono`. Three roles regardless of how many weights the book names.
3. **Usage rules** — what may sit on what, what backdrops are disallowed.

Then compute every candidate as text on its intended ground **before** deciding which token it becomes. Expect one or two brand colours to fail AA on white; that is normal, not a blocker. Split the literal from the role (`--brand-cyan` keeps the published value; `--primary` takes the next step down the same published ramp). Never silently substitute a colour that is not in the brand's own palette, and never reach for an escape before trying the ramp.

Report the measured table to the user before writing the theme. A brand owner will want to see which colours failed and by how much.

## Non-negotiable invariants (from themes/AGENTS.md)

- **A theme change is not an OS change.** `themes/` sits on the authoring side of the boundary with `apps/` and `connectors/`, so it takes no `os-change` label and no admin review. Commit it as `theme:<slug>`, never `os`. Changing the theme *system* — the token contract, the allowlisted `.mix-*` surfaces, the compiler — **is** an OS change. See [`OS-UPDATES.md`](OS-UPDATES.md).
- Folder name is the slug (lowercase, digits, hyphens). No leading underscore on a shipped theme.
- Tokens only in one top-level `:root` — not in a `.mix-*` rule, and not in a `:root` inside `@media` or `@supports`. The token set is closed; unknown names fail the build.
- Every required token present. Dark mode is all-or-nothing.
- Colour values must be hex / `rgb()` / `hsl()` literals or a `var()` chain ending in one. No `color-mix()` or `oklch()` in token values.
- Beyond tokens, only the ten `.mix-*` surfaces. `surfaces` in `theme.json` must match `theme.css` in both directions.
- No `@import`, no `url()` to another host. Ship fonts and images under `assets/`.
- Never declare a token listed in `FORBIDDEN_TOKENS` (empty today).
- Never set `lastUpdated`; never hand-edit anything in `src/generated/`.
- Never add a `dark:` variant to a component to work around a theme problem.

## Verify before reporting done

1. `THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts` — read the ratio table, don't just check the exit code. A pair at 4.51:1 has no headroom.
2. `npm run typecheck` and `npm run lint`.
3. `npm run build`.
4. Activate at `/admin/themes`, then load: dashboard, an app page, a form, a table, a modal, **the sign-in page while signed out**, and a public `/api/p/` link. Toggle light / dark / system.
5. Hard-reload with the OS in dark mode — confirm no flash of a light page.
6. Network tab: no requests to any font or asset host.

Do not claim done on a theme you have not looked at signed out and in both modes.
