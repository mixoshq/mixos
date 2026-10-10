---
name: mixos
description: Build on MixOS — set up a machine, decide what to build, create or update an app, connector or theme, convert an existing application, and ship it. Run `/mixos` for the list of actions, or `/mixos <action>`.
argument-hint: "[action] [arguments] [-q]"
---

# /mixos

Builder commands for this repository. The argument is the action name;
everything after it is passed to the action.

Arguments given: `$ARGUMENTS`

## Dispatch

1. Take the first word of the arguments as the action. Ignore case.
2. If there is no action, print the banner and the help list, then stop.
3. If the action is in the list, read `actions/<action>.md` (relative to
   this file) and follow it exactly — no banner, no help list. Do not act
   until you have read it.
4. If the action is not in the list, say so in one line, print the help
   list (no banner), and stop.

**The action's arguments** are everything after the action word, with `-q`
removed. Where an action file says *the arguments* or *the user request*, it
means these.

## The `-q` flag (any action)

If the arguments contain `-q` anywhere, then after reading the action file
and before doing anything it says: ask 3–5 clarifying questions and stop. Do
not read ahead, plan, run commands, or write code until they are answered.
Once answered, follow the action with `-q` stripped.

## Banner

Only when no action was given. Print as markdown (not in a code block),
with one substitution: replace `YYYY` with the current four-digit year.
Keep the blank lines and the horizontal rule.

````
# 🔷 MixOS

*Let computers do computer things, so humans can do human things.*

---

`MPL-2.0 · YYYY` — Let's get started...
````

## Help list

Print this as markdown, and nothing else after the banner. It starts with
a spacer line — a single non-breaking space (U+00A0), which is what makes
the extra gap survive markdown's blank-line collapsing — then the line
inviting an action, a blank line, and the table. One row per action: the
name in bold code, the "when" sentence, what it does in one or two short
sentences, and an example invocation with any flags in square brackets after
it. Flags are not separate rows: the "What it does" cell says in a few words
what each does. The `-q` line closes the table.

 

Call one of these actions:

| Action | When | What it does | Example |
| --- | --- | --- | --- |
| **`init`** | MixOS isn't set up on this computer yet. | Guided first-time setup: installs the tools, boots the system locally in Docker, opens it in your browser. | `/mixos init` `[notes]` |
| **`help`** | You're not sure what to build. | Plain-language guide for non-technical builders. Recommends what to build and which action to run next; builds nothing itself. | `/mixos help` `[what you want to build]` |
| **`app`** | You want to create, change, or design-review an app under `apps/`. | Writes a build plan into `apps/<slug>/plans/`, builds against the platform's invariants, verifies in a real browser. `review` audits design and UX before writing anything. | `/mixos app <create\|update\|review> <app-slug>` `[notes]` |
| **`convert`** | You already have an application and want it as a MixOS app. | Inventories the source, writes a conversion plan, and stops for approval; then builds the first slice. Pass a plan path to resume at the build. | `/mixos convert <source-path\|git-url\|plan-path>` `[app-slug] [notes]` |
| **`connector`** | An app needs an outside service no connector covers yet. | Creates or updates a connector under `connectors/`: client, credentials and OAuth, scopes, admin setup wizard. A developer's job. | `/mixos connector <create\|update> <connector-name>` `[notes]` |
| **`theme`** | You want to change how the whole install looks. | Creates, updates, or reviews a theme under `themes/`, optionally from a brand book. Checks contrast and verifies light, dark and signed-out. | `/mixos theme <create\|update\|review> <theme-name>` `[brand book path or notes]` |
| **`deploy`** | You're ready to ship, a PR has merged, or it's time to release a version. | Commits the working tree in logical commits, pushes, and opens a PR against `main` (branching first if you are on `main`; updating the PR if one is open). Never merges. With `--reset`, instead returns to `main`, pulls, and deletes local branches whose PR has merged. With `release`, instead opens a version's release PR, then gives you the commands that tag it and publish its GitHub Release (`--pre` for a prerelease). | `/mixos deploy` `[--reset \| release [--pre]]` |

Add `-q` to any action to have Claude ask 3–5 clarifying questions first and wait for your answers.

## Adding an action

Add a row to the table above and a file at `actions/<name>.md`. The row
gives *when* to call it, then what it does in one or two sentences, then an
example invocation with any flags in brackets after it. A flag is documented
inside its action's row, never as a row of its own; escape `|` inside a cell
as `\|`. The file is the full procedure, written for someone who has never
seen this repository: state what to check before doing anything, what to do,
what to print, and what to do when something fails. Refer to other actions as
`/mixos <name>` and link them as `.claude/skills/mixos/actions/<name>.md`.
Keep this file to dispatch only.
