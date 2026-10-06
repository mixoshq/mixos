/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which kind of machine the local Docker stack is being booted on.
 *
 * The stack itself is the same everywhere — Linux containers, driven by the
 * Supabase CLI and Docker Compose. What differs is everything AROUND it: where
 * Docker comes from, how it is started, who owns the files a container writes
 * into the checkout, and what to tell someone whose Docker is missing. Those
 * answers live here so docker-up.ts and docker-down.ts give the same ones.
 *
 *   macos   Docker Desktop, started with `open -ga Docker`.
 *   linux   Docker Engine, a system service this script cannot start — that
 *           needs root, so it says what to run instead.
 *   wsl     Windows, with this checkout inside WSL 2 and Docker Desktop for
 *           Windows providing the daemon through its WSL integration.
 *   windows Windows itself (Git Bash, PowerShell). Not supported: the stack
 *           needs WSL 2, and saying so beats a failure three steps later.
 */
import fs from "node:fs";

export type HostPlatform = "macos" | "linux" | "wsl" | "windows" | "other";

export function hostPlatform(): HostPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform !== "linux") return "other";
  // WSL 2 names itself in the kernel release: "…-microsoft-standard-WSL2".
  // WSL_DISTRO_NAME would also do, but an environment variable can be lost
  // across sudo or a stripped env; the kernel cannot.
  try {
    const release = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
    if (/microsoft/i.test(release)) return "wsl";
  } catch {
    // No procfs is not WSL.
  }
  return "linux";
}

export const PLATFORM_LABEL: Record<HostPlatform, string> = {
  macos: "macOS",
  linux: "Linux",
  wsl: "Windows (WSL 2)",
  windows: "Windows",
  other: process.platform,
};

/**
 * Docker Desktop for Windows, as seen from inside WSL.
 *
 * WSL mounts the Windows drives under /mnt, so the installed application is a
 * file this side can check for and launch. Null when it is not installed in
 * the default location — the caller then asks the person to start it, rather
 * than guessing at another path.
 */
export function windowsDockerDesktop(): string | null {
  const exe = "/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe";
  return fs.existsSync(exe) ? exe : null;
}

/** How to get Docker, said the way this machine needs it said. */
export function dockerInstallHint(platform: HostPlatform): string {
  switch (platform) {
    case "macos":
      return (
        "Install Docker Desktop: brew install --cask docker-desktop  (the --cask flag matters — " +
        "`brew install docker` is the CLI-only formula with no daemon)."
      );
    case "linux":
      return (
        "Install Docker Engine with the Compose plugin — https://docs.docker.com/engine/install/ " +
        "(on Ubuntu and Debian: curl -fsSL https://get.docker.com | sudo sh). Then let your user " +
        'reach it: sudo usermod -aG docker "$USER", and sign out and back in.'
      );
    case "wsl":
      return (
        "Install Docker Desktop for Windows (https://docs.docker.com/desktop/setup/install/windows-install/), " +
        "then turn on Settings -> Resources -> WSL integration for this distribution" +
        (process.env.WSL_DISTRO_NAME ? ` (${process.env.WSL_DISTRO_NAME})` : "") +
        ". In WSL the `docker` command only exists while Docker Desktop is running with that switch on."
      );
    default:
      return "Install Docker and the Compose plugin, then re-run.";
  }
}

/** Why `docker compose` might be missing, by platform. */
export function composeInstallHint(platform: HostPlatform): string {
  if (platform === "linux") {
    return (
      "Install the Compose v2 plugin: sudo apt-get install docker-compose-plugin (or your distribution's " +
      "equivalent — https://docs.docker.com/compose/install/linux/). The standalone `docker-compose` v1 binary is not used here."
    );
  }
  return "Update Docker Desktop — Compose v2 ships with it. The standalone `docker-compose` v1 binary is not used here.";
}

/**
 * The user id the dev container should write the checkout as, or null to
 * leave it as root.
 *
 * The dev container bind-mounts the checkout and writes into it — the
 * generated registry, `next-env.d.ts`. It runs as root. On macOS that does not
 * matter: Docker Desktop's file sharing maps every write back to the person
 * who owns the folder. On Linux, and in WSL, ownership crosses the mount as it
 * is, so each of those files would land owned by root, and the next
 * `npm run registry` on the host would fail with EACCES on a file in their own
 * repository. Passing their uid in lets the container's entrypoint
 * (scripts/container-dev.sh) write as them instead.
 *
 * Root itself gets null: there is nothing to map, and dropping to uid 0 is a
 * no-op that only adds a step.
 */
export function checkoutOwner(platform: HostPlatform): { uid: number; gid: number } | null {
  if (platform !== "linux" && platform !== "wsl") return null;
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  const uid = process.getuid();
  if (uid === 0) return null;
  return { uid, gid: process.getgid() };
}
