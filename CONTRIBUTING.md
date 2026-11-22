# Contributing to MixOS

Thanks for helping. This page covers the terms a contribution is made under and
the few things a pull request needs to get merged. For setting up a working
copy, see [Running a development copy](docs/hosting/development.md); for apps,
connectors and themes, read the guide for that kind of extension
([`apps/AGENTS.md`](apps/AGENTS.md), [`connectors/AGENTS.md`](connectors/AGENTS.md),
[`themes/AGENTS.md`](themes/AGENTS.md)) before writing code.

Everyone taking part in MixOS, in issues, pull requests and discussions,
follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security vulnerability? Don't open an issue or a pull request for it:
report it privately, as [`SECURITY.md`](SECURITY.md) describes.

## Sign off every commit (DCO)

MixOS uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a Contributor Licence Agreement. By signing off a commit you certify
that you wrote it, or otherwise have the right to submit it under the project's
licence.

Sign off with `-s`:

```sh
git commit -s -m "fix(os): the thing that was broken"
```

which adds a trailer using your git identity:

```
Signed-off-by: Your Name <you@example.com>
```

Use a real name and an email you can be reached at. Pull requests with
unsigned commits won't be merged. If you forgot, sign off the commits already on
your branch with:

```sh
git rebase --signoff main
git push --force-with-lease
```

### Why a DCO and not a CLA

There is no CLA, by design. Under MPL-2.0 §2 each contributor licenses their
contribution to everyone directly, and keeps their copyright. Nobody, the
maintainers included, collects the rights that would be needed to relicense
MixOS under closed terms later. The DCO only records that each contribution was
yours to give.

## What licence your contribution is under

It depends on where the change lands. [`LICENSING.md`](LICENSING.md) has the
full boundary; in short:

| Where | Your contribution is licensed under |
|---|---|
| The platform: everything not listed below, including `src/**` (except `src/generated/**`), `scripts/**`, `eslint-rules/**`, `supabase/**`, `public/**`, `deploy/**` and the root build files | MPL-2.0 |
| An app, connector or theme in this repository | The licence in that extension's manifest (`"license"` in `app.json`, `connector.json` or `theme.json`) |
| The scaffolding templates (`*/_template*/`) | CC0 1.0 (public domain) |
| The documentation: `docs/**` | CC BY 4.0, with its code samples also under CC0 1.0 |

Don't submit code you copied from elsewhere unless its licence is compatible
with the destination, and say where it came from in the pull request.

## New platform files need the licence notice

Every Covered file that can hold a comment starts with the MPL-2.0 notice (MPL
Exhibit A), which marks it as Covered Software. A new platform file — under
`src/`, `scripts/`, `eslint-rules/`, `supabase/`, `deploy/` or `public/`, a new
hook or workflow, or a new build file at the root — must begin with it, above
imports and above any `"use client"` or `"use server"` directive:

```ts
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

The same three lines take `--` in a SQL migration and `#` in a shell script,
YAML, TOML or Dockerfile. JSON can't hold a comment; `LICENSING.md` covers it
instead.

Leave the notice off files under `apps/`, `connectors/` and `themes/` unless
that extension is itself MPL-licensed, and never add it to the templates, to
`docs/` or to `src/generated/**`.

A file that starts with a shebang (`#!/usr/bin/env …`) keeps the shebang on
line 1 and the notice directly below it.

## Writing the docs

The docs in `docs/` are also the docs on [mixos.org](https://mixos.org/docs),
which copies them as they are. Two things in them are for the site, and read as
plain Markdown on GitHub:

- **A prompt for Claude** is a ` ```prompt ` fence. mixos.org draws it as
  Claude's message box, with a button that copies it. Put one prompt in each
  fence, exactly what the reader gives Claude, and say what it does in the text
  around it: a `# comment` after it would be copied too, so the site's build
  refuses one.
- **Layout markers** are HTML comments, each on a line of its own, outside
  lists. `<!-- tabs <group> -->` makes tabs of the sections up to
  `<!-- /tabs -->`, one for each heading at the first one's level.
  `<!-- details -->` closes the section up to `<!-- /details -->` behind its
  first heading. `<!-- icons <list> -->` boxes the one list up to
  `<!-- /icons -->`, with an icon beside each item, chosen by the item's bold
  start, and any paragraphs after the list as its footnote.
  `<!-- callout <name> -->` sets the section up to `<!-- /callout -->` apart in a
  box with its icon. `<!-- terms -->` makes the paragraphs up to
  `<!-- /terms -->`, each starting with a bold term, a list of terms, each on a
  line of its own. The site knows each group, list, callout and icon by name,
  and its build refuses one it doesn't, so reuse those the docs already have, or
  ask for a new one in an issue. Every other comment is dropped.

## Pull requests

- **Commit messages** follow `type(scope): summary` — for example
  `feat(os): …`, `fix(deps): …`, `docs(os): …`, `feat(wall-e-345e113c): …`. Scope is
  `os` for the platform, or the slug of the app, connector or theme.
  Breaking changes add `!`: `feat(os)!: …`. A release takes its version
  number and its notes from these (see [Releases](README.md#releases)), so
  label them accurately.
- **Before pushing,** run `npm run lint` and `npm run typecheck`. CI runs both.
- **Manifests** under `apps/`, `connectors/` and `themes/` are validated by the
  pre-commit hook (`.githooks/pre-commit`, enabled by `npm install`). If it
  blocks your commit, the error names the field to fix. The hook also stamps
  `lastUpdated` on each app, connector or theme your commit changes. Merging
  `main` into your branch doesn't re-stamp the ones only `main` changed.
- **Extensions:** the core carries only each kind's template, Wall-E and the
  built-in themes (`scripts/core-extensions.ts`), and Danger fails a pull
  request that adds another. Keep your own in your own repository. In a clone
  whose `origin` is `mixoshq/mixos`, `npm ci` keeps every other extension
  folder out of `git status`: `scripts/core-excludes.ts` writes a marked block
  into `.git/info/exclude`, which is the clone's own and never committed. Where
  `origin` is anything else, such as your fork, it removes the block, so those
  folders show: keep them out of your pull request. `npm run prepare` runs it
  again after you change `origin`.

- **Larger changes:** open an issue first, or add a plan under
  [`docs/plans/`](docs/plans/README.md), so the approach can be agreed before
  the code is written.

## Using the MixOS name

Contributing code doesn't grant rights to the MixOS name or logo. If you're
publishing a fork, an extension or a hosted service, see
[`TRADEMARK.md`](TRADEMARK.md) for what you can call it.
