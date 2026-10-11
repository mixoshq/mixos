# /mixos theme

You are creating or modifying a theme under `themes/`.

A theme repaints every app in the install at once. It is the most constrained of the three abstractions on purpose: widest blast radius, smallest legitimate surface area.

**If the first argument is `review`, skip to [Review mode](#review-mode-audit-against-the-contract) below** — it audits a theme and reports; it changes nothing.

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
- **One palette per theme.** Tokens only in one top-level `:root` — not in a `.mix-*` rule, and not in a `:root` inside `@media` or `@supports`. A `:root[data-mode="dark"]` block fails the build, and there is no light/dark/system setting: a dark look is a sibling theme, `themes/<slug>-dark/` (as `mixos-dark` is to `mixos`), a full copy with its own `assets/` that an admin selects at `/admin/themes`. The token set is closed; unknown names fail the build.
- Every required token present.
- Colour values must be opaque hex / `rgb()` / `hsl()` literals or a `var()` chain ending in one, for every colour token, gated or not. No `color-mix()` or `oklch()` in token values, and no alpha except on `--border`, which the build composites over `--background`.
- Beyond tokens, only the ten `.mix-*` surfaces. `surfaces` in `theme.json` must match `theme.css` in both directions.
- No `@import`, no `url()` to another host. Ship fonts and images under `assets/`.
- Never declare a token listed in `FORBIDDEN_TOKENS` (empty today).
- Never set `lastUpdated`; never hand-edit anything in `src/generated/`.
- Never add a `dark:` variant to a component to work around a theme problem.

## Verify before reporting done

1. `THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts` — read the ratio table, don't just check the exit code. A pair at 4.51:1 has no headroom.
2. `npm run typecheck` and `npm run lint`. The lint rule `mixos-design/no-low-contrast-token-pairs` measures the elements in `src/` and `apps/` under every installed theme, this one included.
3. `npm run build`.
4. Activate at `/admin/themes`, then load: dashboard, an app page, a form, a table, a modal, **the sign-in page while signed out**, and an app's public `/p/<app-slug>` page. There is no light/dark toggle to try: the theme is the whole palette. If you changed a sibling (`<slug>-dark`) too, activate and check each one.
5. Hard-reload. The active theme is resolved on the server, so the first paint should already be in its colours.
6. Network tab: no requests to any font or asset host.

Do not claim done on a theme you have not looked at signed out.

## Review mode (audit against the contract)

Triggered by `/mixos theme review <slug> [notes]`. The goal is to find where an existing theme falls short of the token contract and the contrast gate, and say so precisely — **not** to re-tone it. Report first, and change nothing until the user picks what to fix.

### 1. Read the standard before reading the theme

[themes/AGENTS.md](themes/AGENTS.md), [docs/themes/tokens.md](docs/themes/tokens.md) and [docs/themes/contrast.md](docs/themes/contrast.md), in full. Then the theme's `theme.json`, `theme.css` and `plans/`: a decision a plan records as locked with the user is context for a finding, not a finding.

### 2. Run the gate

`THEME_REPORT=1 npx tsx scripts/generate-project-registry.ts`. It writes only generated, gitignored output. If it aborts, the message names the token, selector or pair, and that is the first finding. Otherwise read this theme's ratio table: every gated pair with its ratio, and `ESC` beside an escaped one.

Then `npm run lint`. Its token-pair rule measures elements in `src/` and `apps/` under every installed theme, so an error under this theme is one the build can't see.

### 3. Audit what the gate can't decide

For each finding, record `file:line`, what's wrong, and the concrete fix.

- **Headroom.** A pair a few hundredths above its floor (4.5:1 for text, 3:1 for large text and UI) passes today and fails at the next small re-tone. Give the ratio.
- **Escapes.** Each names a pair that really fails, with a reason a reviewer can act on. Check whether a step down the brand's own ramp would pass instead ([contrast.md](docs/themes/contrast.md)).
- **The categorical ramp.** `--cat-1`…`--cat-6` don't reuse the `--destructive`, `--warning` or `--success` values.
- **The surface ladder.** `--background`, `--muted`, `--card` and `--accent` are distinct steps, so a card separates from the page and a control from its card.
- **`.mix-*` rules.** Nothing measures their ordinary properties. Compute the ratio for any colour pairing one sets, a literal or two tokens the gate never pairs, and flag a focus style removed with nothing in its place.
- **Self-contained.** Fonts and images under `assets/`; `branding` claims only what this theme owns.
- **Brand fidelity**, when the user supplied a brand book: no colour that isn't in the brand's own palette.

### 4. Report, then ask

Output a table — `file:line` · severity · finding · fix — ordered worst-first. Severity:

- **High** — fails the build, or fails WCAG AA where only lint or your eye can see it.
- **Medium** — an escape a ramp step would remove, a status colour reused as a category, a collapsed surface ladder.
- **Low** — thin headroom, polish.

Then **stop and ask which to fix.** Fixing is an update: follow the rest of this file, from the plan to [Verify before reporting done](#verify-before-reporting-done).

---

## User request

The arguments the dispatcher passed — everything after `theme` in the invocation.
