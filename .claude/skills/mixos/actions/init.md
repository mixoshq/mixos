# /mixos init

You are installing MixOS on someone's machine and booting it for the first
time. The machine is **macOS**, **Linux**, or **Windows with WSL 2**; Claude is
running in **VSCode**; and the person may not be a developer. The whole system —
app, Postgres, and the scheduler tick — runs locally in **Docker**; there is no
cloud account to create and no secret to generate.

You are the installer, not a checklist. Run the commands yourself, explain what
each one is for in plain language, and pause only where you genuinely need the
person (a password prompt, a GUI click, a confirmation). Do not dump every
command at once and do not make them choose between setups.

The one place you ask for permission is **Step 2**. Survey first, ask once,
then install everything.

## Step 0 — Which machine is this?

```bash
uname -s; [ -r /proc/sys/kernel/osrelease ] && cat /proc/sys/kernel/osrelease
```

| `uname -s` prints | Kernel release | This is | Follow |
|---|---|---|---|
| `Darwin` | — | macOS | everything marked **macOS** |
| `Linux` | contains `microsoft` | Windows, inside WSL 2 | everything marked **WSL** |
| `Linux` | anything else | Linux | everything marked **Linux** |
| `MINGW…`, `MSYS…`, `CYGWIN…`, or `uname` is not found | — | Windows outside WSL | stop — see below |

Each step below says where the platforms differ. Where it says nothing, the
command is the same on all three.

### Windows outside WSL

Claude is running on Windows itself — Git Bash or PowerShell — and the local
stack cannot run there: it is Linux containers driven from a Linux shell, and
`npm run dev:docker` refuses to start outside one. Do not attempt it. The setup
it needs takes administrator rights and a restart, which only the person can
do, so explain and hand it over:

> MixOS runs on Windows through WSL 2, the Linux environment built into
> Windows. Setting that up takes a restart, so here are a few steps for you —
> then I take over:
>
> 1. Open **PowerShell as Administrator** and run `wsl --install`. Restart when
>    it asks, then finish the Ubuntu setup that opens: choose a Linux username
>    and password. Remember the password — you'll type it once more later.
> 2. Install **Docker Desktop for Windows** from
>    https://docs.docker.com/desktop/setup/install/windows-install/ and start
>    it. In **Settings → Resources → WSL integration**, turn on **Ubuntu**, then
>    click **Apply & restart**.
> 3. In VS Code, install the **WSL** extension (by Microsoft). Open the Command
>    Palette (`Ctrl+Shift+P`) and run **WSL: Connect to WSL**.
> 4. In that new window, clone MixOS again — this time inside Linux. Run
>    **Git: Clone**, paste the same address, and save it in your Linux home
>    folder (`/home/<you>`), **not** anywhere under `/mnt/c`.
> 5. Open the cloned folder, open Claude Code there, and run `/mixos init`.

Then stop.

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
> `/mixos help`.

Then stop. If only some are true, continue — the steps below are all safe to
re-run.

## Step 1 — Survey (detect only, change nothing)

Run these and record what you find. **Do not install anything in this step**,
even if something is obviously missing; the whole point is to present one
complete list in Step 2 instead of six separate prompts. Run only the rows for
this platform.

| What | How to check | Notes |
|---|---|---|
| Homebrew — **macOS** | `command -v brew` | Needed for everything else on a Mac. |
| Node | `node -v` | Needs **22 or newer** — compare the major version, do not require an exact one. `.nvmrc` pins **24**, which is what to install when Node is missing or too old; `engines` says `>=22`, so a machine already on 22, 24 or 26 is fine. **If it is below 22, also run `node scripts/check-node.mjs`** — it needs no dependencies, runs on any old Node, and says whether a newer Node is already installed but hidden from this shell (see Step 3.2). |
| nvm — **Linux, WSL** | `[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]` | How Node gets installed there: into the home folder, with no root. |
| Dependencies | `[ -d node_modules ]` | |
| Docker — **macOS** | `[ -d /Applications/Docker.app ]` | Filesystem check. **Never** use `brew ls --cask docker-desktop` — it exits 1 for Docker Desktop installed outside Homebrew, which is common. |
| Docker — **Linux** | `docker --version` and `docker compose version` | Docker **Engine** with the Compose v2 plugin. Docker Desktop for Linux works too; if either is already there, use it. |
| Docker — **WSL** | `docker --version`, and `[ -f "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" ]` | Docker Desktop **for Windows** supplies Docker here. Its `docker` command only exists inside WSL while Desktop is running with WSL integration on for this distribution — so `docker` missing with the `.exe` present means "not started", not "not installed". |
| Docker daemon | `docker info` | Bare, and read the **exit code**. `docker info --format '{{.ServerVersion}}'` exits 0 with empty output when the daemon is down, so it reports dead as healthy. On **Linux**, also read stderr: `permission denied` means the daemon is up but this user may not use it (the `docker` group, below); `Cannot connect` means it is not running. |
| `docker` group — **Linux** | `id -nG \| tr ' ' '\n' \| grep -qx docker` | Whether this user may use Docker without sudo. |
| sudo — **Linux, WSL** | `sudo -n true 2>/dev/null` | Exit 0 means you may run sudo commands yourself. Anything else means sudo wants a password your shell cannot type — hand those commands to the person (see Step 3). |
| Checkout location — **WSL** | `pwd` | Under `/mnt/` means the repository is on the Windows drive. It boots, but every file read is slow and edits do not hot-reload. Recommend cloning again under `~` before going further. |
| VSCode CLI | `code --version` | If missing on **macOS**: Command Palette (`Cmd+Shift+P`) → **Shell Command: Install 'code' command in PATH**, then retry. On **Linux** it comes with VS Code's package, and in **WSL** with the WSL extension. If it is still missing, skip the extensions step and name the extensions for the person to install from the Extensions view. |
| Extensions | `code --list-extensions` | Looking for `Anthropic.claude-code` and `esbenp.prettier-vscode`. |
| GitHub CLI (optional) | `gh --version` | Not needed to boot MixOS. `/mixos deploy` uses it to open pull requests, and falls back to a paste-ready link without it. |

Also check that ports **3000, 54321, 54322, and 54323** are free. On **macOS**:

```bash
for p in 3000 54321 54322 54323; do
  if lsof -nP -iTCP:$p -sTCP:LISTEN; then echo "  ^^ port $p is IN USE"; else echo "port $p free"; fi
done
```

The `if` is not padding. `lsof` prints nothing and exits **1** when a port is
free, so the bare one-liner ends non-zero precisely when every port is
available — a result that reads like a failed check and is easy to act on
backwards.

On **Linux** and **WSL**, `lsof` is often not installed; `ss` always is:

```bash
for p in 3000 54321 54322 54323; do
  if [ -n "$(ss -Hltn "sport = :$p")" ]; then echo "  ^^ port $p is IN USE"; else echo "port $p free"; fi
done
```

`ss -Hltnp "sport = :3000"` names the process holding it, when it is theirs.

If 3000 is taken it is almost always a `next dev` the person forgot about
(`ps -o command -p <pid>` confirms). Mention it now rather than letting the boot
fail later with a bind error.

## Step 2 — Present the list and ask once

Show exactly what you are about to install, in order, with a one-line "what it's
for" each. On **macOS**, something like:

> Here's what's missing on your machine. I'll install all of it, in this order:
>
> 1. **Homebrew** — the macOS package manager everything else installs through.
> 2. **Node 24** — runs the build tools and the local database CLI.
> 3. **Project dependencies** (`npm ci`) — about 90 seconds.
> 4. **Docker Desktop** — runs MixOS and its database on your machine.
> 5. **VSCode extensions** — Claude Code and Prettier.

On **Linux**:

> 1. **Node 24**, through nvm — runs the build tools and the local database
>    CLI. It installs into your home folder; no password needed.
> 2. **Project dependencies** (`npm ci`) — about 90 seconds.
> 3. **Docker Engine** — runs MixOS and its database. This one needs
>    administrator rights, so I'll give you one block to paste into the
>    terminal, and it will ask for your password.
> 4. **VSCode extensions** — Prettier.

On **WSL**, Docker is installed on the Windows side, by them:

> 1. **Node 24**, through nvm — no password needed.
> 2. **Project dependencies** (`npm ci`) — about 90 seconds.
> 3. **Docker Desktop for Windows** — runs MixOS and its database. You install
>    this one in Windows; I'll tell you exactly what to click.
> 4. **VSCode extensions** — Prettier.

Then, on every platform:

> Total download is roughly 1 GB now, plus several more GB of database images
> the first time MixOS boots. Want me to go ahead?

Wait for a yes. Skip anything already present and say so ("Node 24 is already
installed, skipping"). After this point don't ask again unless something fails
or a tool prompts for a password.

If Step 1 found a newer Node that is installed but hidden, the Node line is not
an install. Say what it is instead: "**Node 26 is already installed, but your
shells find an old Node 16 first** — I'll add one line to `~/.zshenv` so every
shell finds the new one. Nothing to download."

## Step 3 — Install, in dependency order

Order matters: the Supabase CLI that manages the local database is a
**devDependency of this repo**, so Node and `npm ci` must come before anything
database-related.

**Commands that need sudo — Linux and WSL.** Every command you run gets a
fresh, non-interactive shell, so sudo cannot ask for a password there and fails.
If Step 1's `sudo -n true` succeeded, run them yourself. Otherwise hand them
over: tell the person to open a terminal (**Terminal → New Terminal**), paste
the exact block you give them, type their password when asked, and tell you
when it finishes. Then verify the result yourself — don't take "done" on faith.

1. **Homebrew** — **macOS**, if missing:

   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

   This one is interactive — it asks for their macOS password and pauses for a
   RETURN. Tell them that before you run it. On Apple Silicon, brew lands in
   `/opt/homebrew` and may not be on PATH in the current shell; if `brew` still
   isn't found afterward, run `eval "$(/opt/homebrew/bin/brew shellenv)"` and
   tell them to add that line to `~/.zprofile`.

2. **Node 24** (only if `node -v` is below 22, or Node is missing):

   - **If a newer Node is already installed, but hidden** — Step 1's
     `node scripts/check-node.mjs` named it. **Do not install another one.** The
     shell cannot see the Node it already has, and it will not see a third
     either. The common case is a Mac with an old nodejs.org installer in
     `/usr/local/bin` and Homebrew's Node set up for login shells only
     (`brew shellenv` in `~/.zprofile`). Your shells, git hooks and editors are
     not login shells, so they find the old one. The fix is PATH:

     - **Homebrew:** add the line the check printed —
       `eval "$(/opt/homebrew/bin/brew shellenv)"`, with their Homebrew
       prefix — to `~/.zshenv` (zsh) or `~/.bashrc` (bash), which every shell
       reads. Append it; never rewrite the file.
     - **nvm:** the `nvm alias default` line in the next bullet.

     Your own shells may not pick that up during this session, so prefix every
     remaining Node command with the same `eval` line, as for Homebrew in step 1,
     and re-run `node scripts/check-node.mjs` to confirm it now exits silently.

     Offer to remove the old install, but don't require it: once the newer Node
     comes first, the old one is inert. A nodejs.org install is root-owned —
     `pkgutil --pkgs | grep org.nodejs` identifies it, and
     `pkgutil --files org.nodejs.node.pkg` lists exactly what it installed — so
     removing it takes sudo, and is the person's to run: hand it over the way
     the sudo note above describes. Any global
     tools it carries (`ls /usr/local/lib/node_modules`) go with it, so name
     them first; they reinstall under the new Node with `npm install -g`.

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
     nvm install                          # reads .nvmrc — currently 24
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

   - **Linux and WSL, with no nvm:** install nvm first — into their home
     folder, no sudo:

     ```bash
     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
     ```

     It adds itself to `~/.bashrc` (or `~/.zshrc`) for their own terminals,
     which your shells never read. Carry on with the nvm commands above, which
     source it explicitly.

   - **macOS, with no nvm:** `brew install node@24`, then follow brew's own `brew link`
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

4. **Docker**

   **macOS** (if `/Applications/Docker.app` is missing):

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

   **Linux** (if `docker` or `docker compose` is missing). Docker's install
   script sets up the Engine, the Compose plugin and the system service in one
   go on Ubuntu, Debian, Fedora, CentOS and RHEL. It needs sudo — see above:

   ```bash
   curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
   sudo sh /tmp/get-docker.sh
   sudo usermod -aG docker "$USER"
   ```

   On any other distribution, point them at
   https://docs.docker.com/engine/install/ rather than guessing. Docker Engine
   is free for everyone, so there is no licensing question on Linux.

   **The `usermod` line only takes effect in new login sessions** — not in the
   VSCode that is already open, and not in your shells, which that VSCode
   started. Until the person signs out and back in, run every command that
   touches Docker through the group explicitly:

   ```bash
   sg docker -c 'docker info'
   ```

   `sg` asks no password, because the person is now listed in the group. Tell
   them that signing out and back in (or restarting) makes plain `docker` work
   everywhere, and that until then you'll keep using `sg`.

   If `docker` exists but `docker info` says **permission denied**, only the
   `usermod` line is missing. If it says **Cannot connect**, the service is
   stopped: `sudo systemctl enable --now docker`.

   **WSL** (if `docker` is missing):

   - **`Docker Desktop.exe` is present:** it is installed, just not running or
     not connected to this distribution. Go on to Step 4.
   - **It is not:** Docker Desktop for Windows is theirs to install. Tell them,
     with their distribution's name from `$WSL_DISTRO_NAME`:

     > Install Docker Desktop for Windows: download it from
     > https://docs.docker.com/desktop/setup/install/windows-install/, or run
     > `winget install -e --id Docker.DockerDesktop` in Windows PowerShell. Keep
     > **Use WSL 2 instead of Hyper-V** ticked. When it opens, go to
     > **Settings → Resources → WSL integration**, turn on **Ubuntu**, and click
     > **Apply & restart**.

     Give them the same licensing note as on macOS: free for personal use,
     education, and small companies; organizations above 250 employees or $10M
     annual revenue need a paid subscription.

5. **VSCode extensions:**

   ```bash
   code --install-extension Anthropic.claude-code
   code --install-extension esbenp.prettier-vscode
   ```

   `--install-extension` is a no-op when the extension is already present, so
   running both is safe.

   In **WSL**, `code` installs into the WSL side, which is where the
   extensions need to be.

6. **GitHub CLI** — only if they said they want it. On **macOS**,
   `brew install gh`; on **Linux** and **WSL**, follow
   https://github.com/cli/cli/blob/trunk/docs/install_linux.md, which needs
   sudo — hand it over. Then `gh auth login` (GitHub.com → HTTPS → authenticate
   via browser). This is interactive; hand the terminal back to them for it.

## Step 4 — Get Docker running

**macOS.** Docker Desktop's first run **cannot be fully scripted**: it shows a license
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

**WSL.** Start Docker Desktop on the Windows side — WSL can run it directly:

```bash
"/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" >/dev/null 2>&1 &
```

Then say:

> Docker Desktop is starting in Windows. The first time, accept the service
> agreement; you can skip signing in. Also check **Settings → Resources → WSL
> integration** has your Linux distribution turned on. I'll wait.

A `docker` command that never appears in WSL is almost always that switch.

**Linux.** The Engine is a system service, and the install script already
started it:

```bash
systemctl is-active docker
```

If that prints anything but `active`, the person starts it (sudo — hand it
over): `sudo systemctl enable --now docker`. Poll as below, through
`sg docker -c '…'` if they have not signed in again since the `usermod`.

On every platform, poll until the daemon actually answers, with a timeout:

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
only trust it after the poll succeeded). Below `4294967296` (4 GB) the Postgres,
Kong, PostgREST, and Studio containers plus a Next.js build are tight. Where to
raise it depends on the platform: on **macOS**, Docker Desktop → Settings →
Resources; in **WSL**, `memory=` under `[wsl2]` in `%UserProfile%\.wslconfig`,
then `wsl --shutdown` in PowerShell; on **Linux**, it is the machine's own
memory, so there is nothing to raise — just say so.

## Step 5 — Boot MixOS

```bash
npm run dev:docker -- --detach
```

On **Linux**, if the person has not signed in again since being added to the
`docker` group, run it through the group — and, if Node came from nvm in this
session, with nvm sourced first. `sg` starts a new shell, so pass PATH through:

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
sg docker -c "PATH='$PATH' npm run dev:docker -- --detach"
```

On Linux and in WSL the script also tells the app container who owns the
checkout, and it writes files as them rather than as root — nothing to do, but
it is why the preflight prints `files written as uid …`.

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
[docs/local-docker.md](../../../../docs/local-docker.md#troubleshooting) rather than
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
   [`.env.docker`](../../../../.env.docker) and print them. Those are the credentials
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
   - **Not sure what to build?** Run **`/mixos help`** — it explains how apps and
     connectors relate and recommends what to build.
   - **`/mixos app`** builds something under `apps/`; **`/mixos connector`** builds
     an integration under `connectors/`; **`/mixos theme`** changes how the whole
     install looks, under `themes/`; **`/mixos deploy`** makes the branch and
     opens the pull request when you're ready. Never commit straight to `main`.
   - **Your edits appear on save; brand-new apps, connectors and themes do not.** The
     container runs `next dev` over your working tree, so editing a page, a
     component, or an API route is live in about two seconds — no restart, no
     rebuild. The one exception is the generated registry: `apps/`,
     `connectors/` and `themes/` are scanned once at container start by the
     `predev` hook, so a **newly created** app, connector, or theme stays
     invisible until you run `npm run registry`. That writes `src/generated/`,
     which then hot-reloads like any other file. `/mixos app`, `/mixos connector`
     and `/mixos theme` already run the generator as their first verification
     step, so this mostly bites when you add a directory by hand.
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
   - **Platform encryption keys are already set for local dev.** The Docker path
     reads them from the committed `.env.docker`, which is fine because that file
     is dev-only and the values are fixed on purpose — they decrypt data already
     sitting in the local database, so regenerating them on each boot would break
     every saved credential. Nothing to do here.

## Deploying somewhere real — generate the platform keys

Only when setting up a deployment that is not the local Docker stack. MixOS has
**six** independent cryptographic keys, each protecting exactly one thing so that
rotating one has a bounded blast radius rather than breaking everything at once.
A deployment also needs `AUTH_SECRET` and `CRON_SECRET`.

Generate all eight, paste into the deployment's environment:

```bash
npm run keys:generate
```

Or fill only what is missing from an existing environment:

```bash
npx tsx scripts/generate-keys.ts --missing
```

Then confirm nothing is missing or malformed — this exits non-zero and names each
offender, so it belongs in a deploy check:

```bash
npm run keys:check
```

The generator enumerates the inventory in
[`src/lib/env/keys.ts`](../../../../src/lib/env/keys.ts), so it cannot fall behind when
a key is added. Each printed key carries a comment saying what rotating it costs.

**Do not point two of them at the same value**, and do not derive one from
another. That is what the previous arrangement did, and it made the base key
impossible to rotate: changing it broke every connector credential, every MCP
token, every app API key and every unlock cookie simultaneously.

## Notes

- **Every command you run gets a fresh, non-interactive shell.** Nothing you
  `export`, `source`, or `cd` survives into the next one. That is why the nvm
  branch in Step 3.2 sources `nvm.sh` inline, why the `brew shellenv` line
  in Step 3.1 has to be repeated in each later command until it is written to
  `~/.zprofile`, and why on Linux every Docker command goes through
  `sg docker -c` until the person signs in again. It is also why sudo cannot
  prompt you for a password — those commands are the person's to run.
- **Everything above is idempotent.** If a step fails, fix the cause and re-run
  from that step. Nothing here destroys data except `npm run docker:reset`,
  which you should not run during setup — and which refuses to run at all
  without a terminal to confirm on, precisely so that an agent cannot wipe a
  database by accident. `npm run docker:reset -- --yes` is the deliberate
  override; needing it should feel like a decision.
- **If they ask about running without Docker:** MixOS also runs with Node on the
  host against a Postgres of their choosing — see the "Alternative: your own
  Postgres" section of [README.md](../../../../README.md). Don't offer this
  unprompted; it is more setup, not less.
- **If they ask about putting it on the internet:** that is hosting, not
  installing — point them at [docs/hosting](../../../../docs/hosting/README.md),
  which covers their own server, Render, Railway and Vercel.

## Notes

The arguments the dispatcher passed — everything after `init` in the invocation. Usually empty.
