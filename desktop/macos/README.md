# MixOS Launcher for macOS

A Mac app for running MixOS on your own computer, without a terminal. It has a
window that lists every copy of MixOS on the Mac with its status, and a menu
bar icon, the MixOS mark, for opening, starting and stopping a copy.

- **See whether each copy is up.** You get a ✓ or ✗ for its web server, its
  database, its sign-in page and Studio, and the fix for anything that failed.
  The menu bar mark is full while a copy is up, dimmed while none is, and a
  warning sign when a running copy fails a check.
- **Start, stop and open** a copy. Starting one opens it in your browser once
  it answers, which you can turn off in Settings. If another MixOS already has
  the port, the app offers the next free one as a button.
- **Set up a new copy.** It checks that the Mac has git, Node and Docker, and
  offers each one's installer or a fix if not. Then it downloads MixOS's newest
  release into a folder you choose, installs its dependencies and starts it.
  The new copy gets a database of its own, separate from every other copy.

It finds copies by itself: every checkout that has started MixOS, and every one
another copy sees running. **Add an Existing Copy…** adds any other.

## Install

Open `MixOS-Launcher-<version>.dmg` and drag **MixOS Launcher** to
Applications. The app is signed ad hoc, not with an Apple Developer ID, so the
first time you open it, **Control-click it and choose Open**. After that it
opens like any other app.

It needs macOS 13 or later. What it sets up needs Docker Desktop and Node 22 or
newer, and it tells you if either is missing.

## Build it

From the repository root:

```bash
npm run desktop:mac                       # this Mac's architecture
bash desktop/macos/build.sh --universal   # Apple silicon and Intel in one app
```

Both write `desktop/macos/dist/MixOS Launcher.app` and
`desktop/macos/dist/MixOS-Launcher-<version>.dmg`. You need Xcode, or the
command line tools, with Swift 5.9 or later. There's no Xcode project: it's a
Swift package, and `build.sh` wraps the binary in an app bundle. The icon and
the in-app logo are drawn from `public/logo.png` at build time
(`make-icon.swift`), and the version and the Node requirement come from
`package.json`.

To work on it, open `desktop/macos/Package.swift` in Xcode, or use
`swift build` and `swift test` in `desktop/macos`. A binary run with
`swift run` has no bundle around it, so it shows a system symbol in place of
the logo.

## How it works

The app decides nothing about MixOS itself. It runs each copy's own commands,
in that copy's folder:

| To | It runs |
|---|---|
| Show a copy's status | `npm run --silent status -- --json` |
| Start a copy | `npm run dev:docker -- --detach --no-open` |
| Stop a copy | `npm run docker:down` |
| Set up a new copy | `git clone`, then the newest release tag, `npm ci`, and the start above |

What it shows is therefore what that copy's code says, and a newer MixOS
explains itself to an older app. `npm run status -- --json` only ever gains
fields. A copy from before that command shows **Status unavailable**, and it
can still be started and stopped.

Copies are found in `~/.mixos/instances.json`, the record of which folder owns
which instance (see [More than one instance](../../docs/local-docker.md#more-than-one-instance-on-one-machine)),
and in the other copies each status report lists as running.

**The PATH.** An app opened from Finder gets launchd's bare `PATH`, with no
Homebrew, no nvm and no Docker CLI. The app asks your login shell for its
`PATH` once at launch (`zsh -l -i`), with a 10-second limit, and adds the usual
install locations after it. Commands run with `NO_COLOR=1` and
`MIXOS_OPEN_BROWSER=false`, so MixOS's scripts know nobody is at a terminal.

## Tests

```bash
cd desktop/macos && swift test
```

They cover reading the status report and the claims, the login-shell `PATH`,
the command runner, the recommended-port parsing and the folder rules. One test
runs against a real checkout from a bare, Finder-like environment, and only
when asked:

```bash
env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" PATH=/usr/bin:/bin \
  MIXOS_LAUNCHER_LIVE=/path/to/your/mixos swift test --filter Live
```
