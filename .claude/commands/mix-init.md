---
description: Guided first-time local setup of MixOS on your machine
argument-hint: [notes]
---

You are installing MixOS on someone's machine and booting it for the first
time. Assume **macOS**, **Claude running in VSCode**, and that the person may not
be a developer. The whole system — app, Postgres, PostgREST, and the scheduler
tick — runs locally in **Docker**; there is no cloud account to create and no
secret to generate.

You are the installer, not a checklist. Run the commands yourself, explain what
each one is for in plain language, and pause only where you genuinely need the
person (a password prompt, a GUI click, a confirmation). Do not dump every
command at once and do not make them choose between setups.

The one place you ask for permission is **Step 2**. Survey first, ask once,
then install everything.

## Step 0 — Platform gate

Run `uname -s`. If it is not `Darwin`, stop and say so plainly:

> This guided installer only covers macOS. MixOS runs fine on Linux and on Windows
> via WSL2, but the install steps differ enough that guessing them would waste
> your time. The manual path is in [README.md](../../README.md) and
> [docs/local-docker.md](../../docs/local-docker.md) — everything after
> "install Docker Desktop and Node 22" is identical on every platform.

Then stop. Do not attempt a Linux or Windows install.

## Step 0b — Is MixOS already set up?

Check for the three Docker-path signals:

- `.env.docker.local` exists at the repo root (it is generated on first boot).
- `node_modules/` exists.
- The local database container is running:
  `docker ps --format '{{.Names}}' | grep -q supabase_db_mixos`.

**Do not use `supabase status` for this check.** With the stack down it exits
**1** and writes `failed to inspect container health: Error response from
daemon: No such container: supabase_db_mixos` to stderr — a noisy,
version-sensitive way to ask a yes/no question, and one that only answers at all
after `npm ci` has put the Supabase CLI into `node_modules`, which on a fresh
machine is the very thing you are still establishing. Its 0 is also narrower
than it sounds: what it inspects is the health of the `supabase_db_mixos`
container, and because this repo deliberately runs only a subset of the Supabase
services it prints `Stopped services: [...]` for the rest and still exits 0.
`docker ps` names the one container that matters and needs nothing installed.

If all three are true, don't re-run setup. Tell them:

> MixOS is already set up. Run `npm run dev:docker` and open
> http://localhost:3000. If you'd rather figure out what to build, run
> `/mix-help`.

Then stop. If only some are true, continue — the steps below are all safe to
re-run.

## Step 1 — Survey (detect only, change nothing)

Run these and record what you find. **Do not install anything in this step**,
even if something is obviously missing; the whole point is to present one
complete list in Step 2 instead of six separate prompts.

| What | How to check | Notes |
|---|---|---|
| Homebrew | `command -v brew` | Needed for everything else. |
| Node | `node -v` | Needs **22 or newer** — compare the major version, do not require exactly 22. `.nvmrc` says 22, but `engines` says `>=22`, and a machine on Node 24 or 26 is fine. |
| Dependencies | `[ -d node_modules ]` | |
| Docker Desktop | `[ -d /Applications/Docker.app ]` | Filesystem check. **Never** use `brew ls --cask docker-desktop` — it exits 1 for Docker Desktop installed outside Homebrew, which is common. |
| Docker daemon | `docker info` | Bare, and read the **exit code**. `docker info --format '{{.ServerVersion}}'` exits 0 with empty output when the daemon is down, so it reports dead as healthy. |
| VSCode CLI | `code --version` | If missing: VSCode → Command Palette (`Cmd+Shift+P`) → **Shell Command: Install 'code' command in PATH**, then retry. |
| Extensions | `code --list-extensions` | Looking for `Anthropic.claude-code` and `esbenp.prettier-vscode`. |
| GitHub CLI (optional) | `gh --version` | Not needed to boot MixOS. `/mix-deploy` uses it to open pull requests, and falls back to a paste-ready link without it. |

Also check that ports **3000, 54321, 54322, and 54323** are free:

```bash
for p in 3000 54321 54322 54323; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN; then echo "  ^^ port $p is IN USE"; else echo "port $p free"; fi
done
```

The `if` is not padding. `lsof` prints nothing and exits **1** when a port is
free, so the bare one-liner ends non-zero precisely when every port is
available — a result that reads like a failed check and is easy to act on
backwards.

If 3000 is taken it is almost always a `next dev` the person forgot about
(`ps -o command -p <pid>` confirms). Mention it now rather than letting the boot
fail later with a bind error.

## Step 2 — Present the list and ask once

Show exactly what you are about to install, in order, with a one-line "what it's
for" each. Something like:

> Here's what's missing on your machine. I'll install all of it, in this order:
>
> 1. **Homebrew** — the macOS package manager everything else installs through.
> 2. **Node 22** — runs the build tools and the local database CLI.
> 3. **Project dependencies** (`npm ci`) — about 90 seconds.
> 4. **Docker Desktop** — runs MixOS and its database on your machine.
> 5. **VSCode extensions** — Claude Code and Prettier.
>
> Total download is roughly 1 GB now, plus several more GB of database images
> the first time MixOS boots. Want me to go ahead?

Wait for a yes. Skip anything already present and say so ("Homebrew is already
installed, skipping"). After this point don't ask again unless something fails
or a tool prompts for a password.

## Step 3 — Install, in dependency order

Order matters: the Supabase CLI that manages the local database is a
**devDependency of this repo**, so Node and `npm ci` must come before anything
database-related.

1. **Homebrew** (if missing):

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   This one is interactive — it asks for their macOS password and pauses for a
   RETURN. Tell them that before you run it. On Apple Silicon, brew lands in
   `/opt/homebrew` and may not be on PATH in the current shell; if `brew` still
   isn't found afterward, run `eval "$(/opt/homebrew/bin/brew shellenv)"` and
   tell them to add that line to `~/.zprofile`.

2. **Node 22+** (only if `node -v` is below 22, or Node is missing):

   - **If nvm is installed** — detect it by the *file*, not the command:
     `[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]`. `command -v nvm` will always come
     back empty here: nvm is a shell function that `~/.zshrc` defines by sourcing
     that script, and every command you run gets a fresh non-interactive shell
     that never reads it. So source it yourself, in the same invocation as the
     commands that need it, from the repo root (`nvm install` reads `.nvmrc`
     from the working directory):

     ```bash
     export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
     \. "$NVM_DIR/nvm.sh"
     nvm install                          # reads .nvmrc — currently 22
     nvm use
     nvm alias default "$(cat .nvmrc)"    # so later steps, in their own shells, get it too
     ```

     The `alias default` line is load-bearing rather than tidy-up: `nvm use`
     only changes the shell it ran in, and that shell exits the moment the
     command finishes, so without a new default the very next step (`npm ci`)
     runs under whatever Node the machine had before. Re-check `node -v` in a
     **separate** command afterwards. If it still reports the old version, that
     shell isn't loading nvm at all — either prefix each remaining Node command
     with the same `NVM_DIR`/`\.` pair, or install Node through brew below and
     stop fighting it.

   - **Otherwise:** `brew install node@22`, then follow brew's own `brew link`
     caveat if it prints one. If a different `node` keg is already installed,
     brew will refuse to link; that's fine as long as `node -v` reports 22+.

3. **Project dependencies:**

   ```bash
   npm ci
   ```

   Run it from the repo root; it takes about 90 seconds. `npm ci` rather than
   `npm install` because `package-lock.json` is committed and `ci` installs
   exactly what it pins — the same command `Dockerfile`, `Dockerfile.dev` and CI
   run, so the machine you are setting up matches the images it will build. It
   also *fails* on a lockfile that has drifted from `package.json` instead of
   silently rewriting it, which is the behaviour you want on someone else's
   laptop. If it does fail that way (`npm error code EUSAGE`, "Missing: … from
   lock file"), that is a bug in the repo, not on this machine: report it rather
   than reaching for `npm install`, which would paper over the drift and leave
   this laptop running dependencies nobody else has.

4. **Docker Desktop** (if `/Applications/Docker.app` is missing):

   ```bash
   brew install --cask docker-desktop
   ```

   **`--cask` is load-bearing, and so is the name.** A bare `brew install docker`
   installs the *formula*, which is the Docker CLI client built from
   `docker/cli` with **no daemon and no compose plugin** — you get a `docker`
   binary that fails every command with "Cannot connect to the Docker daemon"
   and has no `docker compose` subcommand at all, which is what every script in
   this repo is built on. Only the cask ships `/Applications/Docker.app` and the
   daemon inside it. The cask was renamed from `docker` to `docker-desktop`; the
   old name still resolves as an alias, but use the new one.

   Finding the formula already installed is not a blocker — Homebrew declares no
   conflict between the two, so install the cask on top of it. Just confirm
   afterwards that both `docker info` and `docker compose version` succeed; if a
   leftover formula `docker` is shadowing Docker Desktop's client on PATH,
   `brew uninstall docker` clears it.

   Also tell them about licensing once, honestly: Docker Desktop is free for
   personal use, education, and small companies, but organizations above 250
   employees or $10M annual revenue need a paid subscription.
   [OrbStack](https://orbstack.dev) is a drop-in alternative if that's a problem.

5. **VSCode extensions:**

   ```bash
   code --install-extension Anthropic.claude-code
   code --install-extension esbenp.prettier-vscode
   ```

   `--install-extension` is a no-op when the extension is already present, so
   running both is safe.

6. **GitHub CLI** — only if they said they want it: `brew install gh`, then
   `gh auth login` (GitHub.com → HTTPS → authenticate via browser). This is
   interactive; hand the terminal back to them for it.

## Step 4 — First launch of Docker Desktop

Docker Desktop's first run **cannot be fully scripted**: it shows a license
agreement and asks for the macOS password to install a privileged helper. Launch
it, then tell them what to click while you wait.

```bash
open -ga Docker
```

`-g` keeps it in the background so it doesn't steal focus, and it's a no-op if
Docker is already running. If this exits non-zero with "Unable to find
application named", the install didn't land — go back to Step 3.

Then say, before you start polling:

> Docker Desktop is starting. The first launch shows a couple of screens — accept
> the service agreement, choose the recommended settings, and enter your Mac
> password when it asks to install a helper. You can skip the sign-in / "create
> an account" screen entirely; MixOS doesn't need a Docker account. I'll wait.

Poll until the daemon actually answers, with a timeout:

```bash
deadline=$(( $(date +%s) + 180 ))
until docker info >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Docker daemon did not come up within 180s" >&2; exit 1
  fi
  sleep 2
done
```

180 seconds, not 60 — a warm restart is quick, but a first launch sitting on the
license screen is not. If it times out, don't retry blindly: ask whether a
Docker window is waiting for input.

Once the daemon answers, check the VM has enough memory:

```bash
docker info --format '{{.MemTotal}}'   # bytes
```

Guard the result (this templated form prints nothing when the daemon is down, so
only trust it after the poll succeeded). Below `4294967296` (4 GB), tell them to
raise it in Docker Desktop → Settings → Resources; the Postgres, Kong,
PostgREST, and Studio containers plus a Next.js build are tight under 4 GB.

## Step 5 — Boot MixOS

```bash
npm run dev:docker -- --detach
```

Set expectations *before* you run it, because this is the step that looks broken:

> This starts the database and the app together. The first run downloads several
> GB of database images and will sit there printing nothing for a while —
> 5 to 15 minutes is normal on a fresh machine. It is not stuck.

**`--detach` is the part you must not drop.** Plain `npm run dev:docker` is the
right command for a person at a keyboard — it runs `docker compose up` in the
foreground, streams every container's logs, and **never returns**; the session
ends when they press Ctrl-C, which stops the app container while leaving the
Supabase CLI stack (Postgres, Kong, PostgREST, Studio) running. Run it that way
from here and you never reach Step 6: the command blocks until your tool times
out, and the kill that ends it lands on the compose foreground group and tears
the app back down, so the person is left with a half-stopped stack and no
credentials. `--detach` brings the same stack up with `docker compose up -d`,
polls `http://localhost:3000/api/health/ready` until it answers 200 (with its
own timeout and a specific failure message), prints the banner, and exits 0. It
composes with `--prod` — `npm run dev:docker -- --detach --prod` — though there
is no reason to want the prod profile during setup.

Either way the script starts the Supabase local stack, writes the generated
connection settings to `.env.docker.local`, applies the platform migrations and
every app's migrations, seeds the admin account, and starts the app container
with hot reload.

Detached still means *slow*, not *instant*: the command holds your shell for the
whole first-run image pull, which can outlast the default command timeout you
run under. Give it the longest timeout your tooling allows (10 minutes for the
Bash tool).

**If it times out, find out how far it got before deciding anything.** Only the
image pulls live inside the Docker daemon and survive your command being killed.
Everything else — reading `supabase status`, writing `.env.docker.local`,
applying migrations, seeding the admin, and `docker compose up -d` itself — runs
in the killed Node process. So a timeout landing mid-boot can leave you with no
app container at all, and polling for readiness would then wait forever on
something that was never started. Check first:

```bash
docker compose -p mixos ps
```

If no app container is listed, re-run `npm run dev:docker -- --detach`: it is
idempotent, and it skips the images already pulled and the Supabase stack
already running, so the second attempt is fast. If the app container *is* there,
don't start a second boot on top of it — poll instead, then carry on to Step 6:

```bash
deadline=$(( $(date +%s) + 1200 ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/health/ready)" = "200" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "MixOS did not become ready within 20 minutes" >&2; exit 1
  fi
  sleep 5
done
echo "MixOS is ready"
```

The comparison is on the printed status code rather than curl's exit status on
purpose: while nothing is listening yet curl prints `000` and exits 7, and
testing the exit code would abort the loop on the normal not-yet-up state.

Because `--detach` already waited for readiness, a non-zero exit means the boot
really did fail — read the error it printed instead of re-running blindly.
Confirm the app for yourself anyway:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health/ready || true
```

A **200** means the app reached Postgres. A **503** means it started but can't
query — point at
[docs/local-docker.md](../../docs/local-docker.md#troubleshooting) rather than
guessing. **000** means nothing is listening on 3000 at all: curl also exits 7
there, which is what the `|| true` absorbs so the case reports itself as a
number instead of looking like a broken command — check
`docker compose -p mixos ps` and `docker compose -p mixos logs app-dev`. If the
boot failed on a port conflict, that's Step 1's port check coming true; stop
whatever holds the port and re-run.

Nothing is streaming logs now, and that is the point: the stack keeps running
after the command returns, so Step 6 can actually happen. To watch it anyway,
`docker compose -p mixos logs -f app-dev` in a terminal of their own.

## Step 6 — Hand off

1. Read `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` out of
   [`.env.docker`](../../.env.docker) and print them. Those are the credentials
   the seeded admin was created with — do not invent values, and do not ask the
   person to choose any.
2. Tell them to open **http://localhost:3000** and log in.
   Use `localhost`, **not** `127.0.0.1` — Next's dev server rejects its own
   `/_next/*` assets and hot-reload socket from the `127.0.0.1` origin, and the
   page renders unstyled and broken.
3. Print this verbatim:

   > **MixOS is successfully installed!**
   >
   > "Welcome to the real world. It sucks! You're gonna love it!"

4. Then orient them, briefly:
   - **Not sure what to build?** Run **`/mix-help`** — it explains how apps and
     connectors relate and recommends what to build.
   - **`/mix-app`** builds something under `apps/`; **`/mix-connector`** builds
     an integration under `connectors/`; **`/mix-deploy`** makes the branch and
     opens the pull request when you're ready. Never commit straight to `main`.
   - **Everyday commands:** `npm run dev:docker` to start — it stays in the
     foreground streaming logs, and Ctrl-C ends the session by stopping the app
     container while the database keeps running. `npm run docker:down` stops
     everything, including the database; that is also how the detached stack you
     started in Step 5 comes down. `npm run docker:reset` wipes the local
     database and starts over.
   - **Connector API keys are not environment variables.** An admin enters them
     in the UI at http://localhost:3000/admin/connectors and MixOS encrypts them
     in the database. The real keys live in the team's **MixOS 1Password vault** —
     request access from Anthony (amix@gmail.com), and never share them.
     This isn't needed to boot MixOS; it can wait.

## Notes

- **Every command you run gets a fresh, non-interactive shell.** Nothing you
  `export`, `source`, or `cd` survives into the next one. That is why the nvm
  branch in Step 3.2 sources `nvm.sh` inline, and why the `brew shellenv` line
  in Step 3.1 has to be repeated in each later command until it is written to
  `~/.zprofile`.
- **Everything above is idempotent.** If a step fails, fix the cause and re-run
  from that step. Nothing here destroys data except `npm run docker:reset`,
  which you should not run during setup — and which refuses to run at all
  without a terminal to confirm on, precisely so that an agent cannot wipe a
  database by accident. `npm run docker:reset -- --yes` is the deliberate
  override; needing it should feel like a decision.
- **If they ask about running without Docker:** MixOS also runs with Node on the
  host against a hosted Supabase project — see the "Alternative: hosted
  Supabase" section of [README.md](../../README.md). Don't offer this
  unprompted; it is more setup, not less.

$ARGUMENTS
