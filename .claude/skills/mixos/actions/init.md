# /mixos init

You are installing MixOS on someone's machine and booting it for the first
time. The machine is **macOS**, **Linux**, or **Windows with WSL 2**; Claude is
running in the **Claude app**'s Code tab or in **VS Code**; and the person may
not be a developer. The whole system —
app, Postgres, and the scheduler tick — runs locally in **Docker**; there is no
cloud account to create and no secret to generate.

You are the installer, not a checklist. Run the commands yourself, explain what
each one is for in plain language, and pause only where you genuinely need the
person (a password prompt, a GUI click, a confirmation). Do not dump every
command at once and do not make them choose between setups.

The one place you ask for permission is **Step 2**. Survey first, ask once,
then install everything. **Step 7** asks once more, at the end: whether to put
their copy in a private GitHub repository of their own.

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

Then which app Claude is running in:

```bash
echo "$CLAUDE_CODE_ENTRYPOINT"
```

`claude-desktop` is the **Claude app**: skip everything marked **VS Code**, and
never ask the person to install VS Code or its extensions. Anything else is VS
Code, or a terminal: follow what is marked **VS Code**.

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
In the **Claude app**, the last steps are:

> 3. Start a new session, and in the environment selector under the prompt box,
>    choose **WSL**, then **Ubuntu**. The session starts in your Linux home
>    folder.
> 4. Get MixOS again there — this time inside Linux — with the download prompt
>    from https://mixos.org/docs/install. It saves MixOS in your Linux home
>    folder (`/home/<you>/MixOS`), **not** anywhere under `/mnt/c`.
> 5. Start another WSL session, in that folder, and run `/mixos init`.

In **VS Code**:

> 3. In VS Code, install the **WSL** extension (by Microsoft). Open the Command
>    Palette (`Ctrl+Shift+P`) and run **WSL: Connect to WSL**.
> 4. In that new window, get MixOS again — this time inside Linux. Open the
>    Claude Code panel there (install the extension in WSL if VS Code asks),
>    and paste the download prompt from https://mixos.org/docs/install. It
>    saves MixOS in your Linux home folder (`/home/<you>/MixOS`), **not**
>    anywhere under `/mnt/c`.
> 5. Open that folder, open Claude Code there, and run `/mixos init`.

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

If all three are true, don't re-run setup. Go to **Step 7** first: their own
repository on GitHub is the one part of setup that may still be missing. If the
copy already has one, or they say no to it, tell them:

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
| VS Code CLI — **VS Code** | `code --version` | If missing on **macOS**: Command Palette (`Cmd+Shift+P`) → **Shell Command: Install 'code' command in PATH**, then retry. On **Linux** it comes with VS Code's package, and in **WSL** with the WSL extension. If it is still missing, skip the extensions step and name the extensions for the person to install from the Extensions view. |
| Extensions — **VS Code** | `code --list-extensions` | Looking for `Anthropic.claude-code` and `esbenp.prettier-vscode`. |
| GitHub CLI (optional) | `gh --version`, then `gh auth status` (exit 0: signed in) | Not needed to boot MixOS. Step 7 uses it to create their own private repository on GitHub, and `/mixos deploy` to open pull requests there, with a paste-ready link as its fallback. |

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

If 3000 is taken, it's usually a `next dev` the person forgot about
(`ps -o command -p <pid>` confirms) or another MixOS copy. Mention it now. The
boot doesn't fail on it with a bind error: it names the holder and gives the
command for the next free port (Step 5). The Supabase ports are different: a
conflict there stops the boot.

## Step 2 — Present the list and ask once

Show exactly what you are about to install, in order, with a one-line "what it's
for" each. On **macOS**, something like:

> Here's what's missing on your machine. I'll install all of it, in this order:
>
> 1. **Homebrew** — the macOS package manager everything else installs through.
> 2. **Node 26** — runs the build tools and the local database CLI.
> 3. **Project dependencies** (`npm ci`) — about 90 seconds.
> 4. **Docker Desktop** — runs MixOS and its database on your machine.
> 5. **VS Code extensions** — Claude Code and Prettier.

On **Linux**:

> 1. **Node 26**, through nvm — runs the build tools and the local database
>    CLI. It installs into your home folder; no password needed.
> 2. **Project dependencies** (`npm ci`) — about 90 seconds.
> 3. **Docker Engine** — runs MixOS and its database. This one needs
>    administrator rights, so I'll give you one block to paste into the
>    terminal, and it will ask for your password.
> 4. **VS Code extensions** — Prettier.

On **WSL**, Docker is installed on the Windows side, by them:

> 1. **Node 26**, through nvm — no password needed.
> 2. **Project dependencies** (`npm ci`) — about 90 seconds.
> 3. **Docker Desktop for Windows** — runs MixOS and its database. You install
>    this one in Windows; I'll tell you exactly what to click.
> 4. **VS Code extensions** — Prettier.

Leave the **VS Code extensions** line out in the Claude app. On every
platform, if `gh` is missing, add it as the last line, as optional:

> **GitHub CLI** (optional) — at the end, it puts your copy in a private
> repository of your own on GitHub, which is what you deploy.

On **Linux** and **WSL** it needs administrator rights, as Docker does.

Then, on every platform:

> Total download is roughly 1 GB now, plus several more GB of database images
> the first time MixOS boots. Want me to go ahead?

Wait for a yes. Skip anything already present and say so ("Node 26 is already
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

2. **Node 26** (only if `node -v` is below 22, or Node is missing):

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
   Claude app or VS Code that is already open, and not in your shells, which
   that app started. Until the person signs out and back in, run every command that
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

5. **VS Code extensions** — **VS Code** only; skip this in the Claude app:

   ```bash
   code --install-extension Anthropic.claude-code
   code --install-extension esbenp.prettier-vscode
   ```

   `--install-extension` is a no-op when the extension is already present, so
   running both is safe.

   In **WSL**, `code` installs into the WSL side, which is where the
   extensions need to be.

6. **GitHub CLI** — if it was on the list and they didn't turn it down. On
   **macOS**, `brew install gh`; on **Linux** and **WSL**, follow
   https://github.com/cli/cli/blob/trunk/docs/install_linux.md, which needs
   sudo — hand it over. Signing in waits for Step 7, which is where it's
   needed.

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
polls the app's `/api/health/ready` until it answers 200 (with its own timeout
and a specific failure message), prints the summary — a ✓ or ✗ for the web
server, the database, the sign-in page and Studio, with the URL and the login —
and exits 0 only if every check passed. It
composes with `--prod` — `npm run dev:docker -- --detach --prod` — though there
is no reason to want the prod profile during setup.

Either way the script starts the Supabase local stack, writes the generated
connection settings to `.env.docker.local`, applies the platform migrations and
every app's migrations, seeds the admin account, and starts the app container
with hot reload.

**The instance may not be called `mixos`.** Each checkout has its own database.
If the person already has another MixOS checkout on this machine, the boot's
first step, `[1] Instance`, gives this one its own name (from its folder, e.g.
`mixos-feature`) and writes it to `.env.instance`. That's expected, not an
error: tell them this copy has a database of its own, separate from the other
one. Wherever this file says `-p mixos` below, use the name that step printed
(`grep MIXOS_INSTANCE .env.instance` reads it back).

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
`docker compose -p mixos ps` and `docker compose -p mixos logs app-dev`.

**If the boot stopped on a port conflict,** its message names what holds the
port, often another MixOS, and gives the command for the next free one, such as
`MIXOS_PORT=3001 npm run dev:docker -- --detach`. Tell the person what holds
3000, then run the command it gave you. Nothing asks you to choose: with no one
at a keyboard the boot never waits on a question. From then on use that port
wherever this file says 3000. If the holder is this checkout's own
`npm run dev`, stop it rather than moving: the message says so.

`npm run status` asks all of these questions in one command, any time: it
prints the same summary and exits 0 only when everything answers.

Nothing is streaming logs now, and that is the point: the stack keeps running
after the command returns, so Step 6 can actually happen. To watch it anyway,
`docker compose -p mixos logs -f app-dev` in a terminal of their own.

## Step 6 — Hand off

1. Read `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` out of
   [`.env.docker`](../../../../.env.docker) and print them. Those are the credentials
   the seeded admin was created with — do not invent values, and do not ask the
   person to choose any.
2. Tell them to open the URL the summary printed, **http://localhost:3000**
   unless the boot moved to the next free port, and log in.
   Use `localhost`, **not** `127.0.0.1` — Next's dev server rejects its own
   `/_next/*` assets and hot-reload socket from the `127.0.0.1` origin, and the
   page renders unstyled and broken.
3. Print this verbatim:

   > **MixOS is successfully installed!**
   >
   > "Welcome to the real world. It sucks! You're gonna love it!"

4. Then orient them, briefly:
   - **Not sure what to build?** Run **`/mixos help`** — it explains how apps,
     connectors and themes fit together and recommends what to build.
   - **`/mixos app`** builds something under `apps/`; **`/mixos connector`** builds
     an integration under `connectors/`; **`/mixos theme`** changes how the whole
     install looks, under `themes/`; **`/mixos deploy`** makes the branch and
     opens the pull request when you're ready, on the repository Step 7 sets
     up. Never commit straight to `main`.
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
     database and starts over. `npm run status` says whether it's all up, at
     which address, and what to run if it isn't.
   - **Connector API keys are not environment variables.** An admin enters them
     in the UI at http://localhost:3000/admin/connectors and MixOS encrypts them
     in the database. This isn't needed to boot MixOS; it can wait.
   - **Platform encryption keys are already set for local dev.** The Docker path
     reads them from the committed `.env.docker`, which is fine because that file
     is dev-only and the values are fixed on purpose — they decrypt data already
     sitting in the local database, so regenerating them on each boot would break
     every saved credential. Nothing to do here.
5. Then offer Step 7.

## Step 7 — Their own repository on GitHub

Their copy becomes a private repository of their own on GitHub: hosts deploy
from it, new releases of MixOS merge into it from `upstream`, `/mixos deploy`
opens pull requests on it, and the GitHub App links to it. It's a repository of
their own rather than a fork, because a fork of a public repository can't be
private.

**Change nothing until they say yes.** Detecting comes first, and the question
second; on a no, nothing has changed.

### 7.1 What the copy is

From the repo root, the folder with `package.json`:

```bash
if [ -e .git ]; then git remote -v; else echo "no .git"; fi
```

Ask git nothing in a folder without `.git`: it would answer for whatever
repository encloses the folder, such as a home folder kept in git.

| It shows | The copy is | Then |
|---|---|---|
| `origin` is `github.com/mixoshq/mixos`, over https or ssh, with or without `.git` | a clone of MixOS | 7.2 |
| `no .git` | a `.zip` download | 7.2 |
| `origin` is anything else | their own repository already | Say so ("This copy already pushes to `<origin>`, so there's nothing to set up") and stop |
| no `origin`, and `upstream` is `github.com/mixoshq/mixos` | an earlier run of this step that stopped partway | 7.2, then pick up where it stopped: 7.4 from `git fetch` on if `git rev-parse -q --verify HEAD` prints nothing, 7.5 otherwise |
| no remotes at all | a repository they made themselves | Ask what it is, and change nothing without their say |

### 7.2 Ask once

> MixOS is set up on your computer. Want me to put your copy in a private
> repository of your own on GitHub? It's what you'll deploy, where new releases
> of MixOS merge in, and where `/mixos deploy` opens pull requests. I'd call it
> `mixos`, under your GitHub account, unless you'd like another name or an
> organization. Or say no, and MixOS stays on this computer only.

On a no, say that MixOS stays on this computer, that `/mixos deploy` needs the
repository, and that `/mixos init` offers it again any time. Then stop.

### 7.3 The GitHub CLI, signed in

```bash
gh --version
gh auth status
```

- **No `gh`.** Install it: on **macOS**, `brew install gh`; on **Linux** and
  **WSL**, https://github.com/cli/cli/blob/trunk/docs/install_linux.md, which
  needs sudo, so hand it over as in Step 3. If they'd rather not have it, the
  same steps on github.com are under "Create your own repository" in
  [docs/hosting/install.md](../../../../docs/hosting/install.md#create-your-own-repository):
  point them there, and stop.
- **Not signed in** (`gh auth status` exits non-zero). Signing in is
  interactive, so hand it over:

  > In a terminal (**Terminal → New Terminal**), run `gh auth login`. Choose
  > **GitHub.com**, then **HTTPS**, say yes to authenticating Git with your
  > GitHub credentials, and log in with a web browser. Tell me when it's done.

  Then run `gh auth status` yourself.

Then the name. The owner is their own account unless they named an
organization, and the name must be free:

```bash
gh api user --jq .login
gh repo view <owner>/<name> --json name   # fails with "Could not resolve to a Repository": the name is free
```

If it exists, ask for another name. Never push into a repository that already
exists.

### 7.4 Connect the copy to MixOS's history

**A clone of MixOS.** MixOS's repository becomes `upstream`, which frees
`origin` for theirs:

```bash
git remote rename origin upstream
```

If `git rev-parse --is-shallow-repository` prints `true`, run
`git remote set-branches upstream '*'` and `git fetch --unshallow upstream`
too: a shallow clone can't be pushed to a new repository, and one made of a
single tag has no `upstream/main` for upgrades to read.

**A `.zip` download.** Make it a repository, fetch MixOS's history, and find
the release whose files these are:

```bash
git init -b main
git remote add upstream https://github.com/mixoshq/mixos.git
git fetch upstream --tags
for tag in $(git tag -l 'v*' --sort=-v:refname); do
  git reset -q "$tag" && [ -z "$(git status --porcelain)" ] && { echo "matched $tag"; break; }
done
```

`git reset` without `--hard` moves `main` and the index to a tag and leaves
every file alone, so the search touches no file. It stops at the release whose
files match these exactly: `git status` then shows nothing, since everything
else here (`node_modules/`, `.env.docker.local`, `src/generated/` and the like)
is ignored.

- **It printed `matched <tag>`.** Turn on the hooks, as `npm ci` does in a
  clone:

  ```bash
  git config core.hooksPath .githooks
  ```

- **It printed nothing.** These files aren't exactly any release, so going on
  could lose a change. Run `git reset -q "v$(node -p "require('./package.json').version")"`
  and `git status --short` to see what differs from the release they claim to
  be. If every difference is a mode change (`git diff --summary`), the unzip
  dropped the executable bit: `chmod +x` those files and search again.
  Otherwise remove the `.git` this step made (`rm -rf .git`), so the copy is as
  it was, and explain: files changed after the download, or the `.zip` came
  from the green **Code** button, which is unreleased work on `main`, rather
  than a release. Two ways on: **Source code (zip)** from
  https://github.com/mixoshq/mixos/releases/latest, or the clone prompt in
  [docs/hosting/install.md](../../../../docs/hosting/install.md), then copy
  their changes across. Stop there.

### 7.5 Nothing secret goes up

First let git show everything a commit could take:

```bash
npx tsx scripts/core-excludes.ts
```

In a clone, `npm ci` wrote a block into `.git/info/exclude` that ignores every
extension the core doesn't carry, as a checkout of MixOS itself should. With
`origin` no longer MixOS's, this removes it, so their own folders under
`apps/`, `connectors/` and `themes/` show in `git status` and can be
committed. Nothing else in the file changes, and it prints nothing when there's
no block, as in a `.zip` download.

The push sends commits, not the folder, and the commits are MixOS's own
unless they made some. Check both before the first push, and the branch:

```bash
git status --porcelain --untracked-files=all
git log --name-only --format='%h %s' HEAD --not --remotes=upstream --tags
git branch --show-current
```

- **`git status`** should print nothing. Git ignores every `.env*` file but
  the committed `.env.docker`, whose values are public and for development
  copies only, and the `*.example` templates, and every `*.pem`;
  `git check-ignore -v <file>` names the rule. If it lists a `.env*` or key
  file (`*.pem`, `*.key`), stop and show it. If it lists anything else, show it
  and ask before going on: it isn't pushed, but the next commit could take it.
- **`git log`** lists commits of theirs on top of the release, with their
  files. None is fine. If one carries a `.env*` or key file, stop and show it:
  it would be pushed.
- **The branch** must be `main`: the first branch pushed becomes the new
  repository's default, which is what hosts deploy. On another branch, ask
  before switching.

### 7.6 Create it, and push

```bash
gh repo create <owner>/<name> --private --source . --remote origin --push
gh repo set-default <owner>/<name>
```

`gh repo create` makes the repository, adds it as `origin`, and runs
`git push --set-upstream origin HEAD`: `main` goes up and tracks `origin/main`,
and MixOS's tags stay on this computer. With two remotes, gh opens pull
requests on the one named `upstream` unless a default is set, so
`gh repo set-default` points it at theirs, where `/mixos deploy` needs it.

If `gh repo create` fails, show the error. A name that turned out to be taken
means asking for another; the copy is ready for another try, and running
`/mixos init` again picks up here.

### 7.7 Check it, and tell them

```bash
git remote -v
git status -sb | head -1
gh repo view <owner>/<name> --json url,visibility --jq '.url + " " + .visibility'
```

`origin` is theirs and `upstream` is MixOS's, `main` is level with
`origin/main` (`## main...origin/main`), and the repository is `PRIVATE`.
`npx tsx scripts/core-excludes.ts` prints nothing again: no block is left to
remove. Then:

> Your copy of MixOS is on GitHub now, private, at <url>. To put it online for
> your team, a host deploys it: see docs/hosting/install.md. `/mixos deploy`
> opens your pull requests there, and new releases of MixOS merge in from
> `upstream` (docs/hosting/after-you-install/upgrading.md).

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
  host against a Postgres of their choosing — see "With a database of your own"
  in [docs/hosting/development.md](../../../../docs/hosting/development.md#with-a-database-of-your-own).
  Don't offer this unprompted; it is more setup, not less.
- **If they ask about putting it on the internet:** that is a deployment, not
  this setup — point them at [How to install](../../../../docs/hosting/install.md),
  which covers their own server, Render, Railway and Vercel. A host deploys the
  repository Step 7 makes.

## Notes

The arguments the dispatcher passed — everything after `init` in the invocation. Usually empty.
