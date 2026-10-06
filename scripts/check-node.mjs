/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refuse to run on a Node older than package.json `engines.node`, and say why.
 *
 * Runs first, ahead of everything that needs a modern Node: the registry
 * generator (and so `dev`, `build` and `typecheck`), the Docker boot, and the
 * pre-commit hook. Without it an old Node fails somewhere deep and misleading.
 * Node 16 running the registry generator reports `Request is not defined` from
 * inside an app route, which says nothing about Node at all.
 *
 * The usual cause is not a missing Node but a hidden one. A login shell reads
 * ~/.zprofile, where `brew shellenv` puts Homebrew first. The shells an editor,
 * a git hook or Claude Code start often do not, and find whatever is first in
 * the bare PATH instead: typically /usr/local/bin/node, left by an old
 * nodejs.org installer. So when the running Node is too old, this looks for a
 * newer one already installed and names it, because installing a third Node
 * does not help when the shell cannot see the second.
 *
 * Plain JavaScript, no dependencies, and no syntax newer than Node 12, on
 * purpose: it has to run on exactly the Node it is about to reject.
 *
 * Silent and exit 0 when the Node is new enough. It never nags about running
 * something newer than `.nvmrc`: that pin is what to install, not a ceiling.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function majorOf(version) {
  const m = /(\d+)/.exec(String(version));
  return m ? Number(m[1]) : NaN;
}

/** The floor, from `engines.node`. Only the `>=N` form is used in this repo. */
function minimumMajor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const range = String((pkg.engines && pkg.engines.node) || "");
  const m = /^>=\s*(\d+)/.exec(range);
  if (!m) {
    // A range this check cannot read must not quietly turn it off.
    fail(
      'package.json engines.node is "' + range + '", and scripts/check-node.mjs only ' +
        'understands ">=N". Update the check alongside the range.',
    );
  }
  return Number(m[1]);
}

/** What to install: the pin in `.nvmrc`. */
function pinnedVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Node installs this machine has besides the one running, newest first.
 * Homebrew (both prefixes, plus Linuxbrew, linked and versioned kegs) and nvm
 * cover nearly every case worth naming. Anything else is reported as "none
 * found", which leads to the install advice, and that is still correct.
 */
function otherInstalls(minimum) {
  const paths = [];
  const brewPrefixes = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"];
  for (const prefix of brewPrefixes) {
    paths.push({ file: prefix + "/bin/node", kind: "brew", prefix: prefix });
    for (const keg of listDir(prefix + "/opt")) {
      if (/^node(@\d+)?$/.test(keg)) {
        paths.push({ file: prefix + "/opt/" + keg + "/bin/node", kind: "brew", prefix: prefix });
      }
    }
  }
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  for (const v of listDir(path.join(nvmDir, "versions", "node"))) {
    paths.push({ file: path.join(nvmDir, "versions", "node", v, "bin", "node"), kind: "nvm" });
  }

  const running = realpath(process.execPath);
  const seen = {};
  const found = [];
  for (const c of paths) {
    const real = realpath(c.file);
    if (!real || real === running || seen[real]) continue;
    seen[real] = true;
    let version;
    try {
      // stderr ignored: a stale keg whose libraries Homebrew has since
      // upgraded away (icu4c, typically) dies in dyld, loudly, on any call.
      version = execFileSync(c.file, ["-v"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      continue;
    }
    if (majorOf(version) >= minimum) {
      found.push({ file: c.file, kind: c.kind, prefix: c.prefix, version: version.replace(/^v/, "") });
    }
  }
  found.sort(function (a, b) {
    return majorOf(b.version) - majorOf(a.version);
  });
  return found;
}

function fail(message) {
  process.stderr.write("\n" + message + "\n\n");
  process.exit(1);
}

const minimum = minimumMajor();
const current = process.versions.node;
if (majorOf(current) >= minimum) process.exit(0);

const pinned = pinnedVersion();
const lines = [];
lines.push(
  "MixOS needs Node " + minimum + " or newer. This shell is running Node " + current +
    ", from " + process.execPath + ".",
);

const others = otherInstalls(minimum);
if (others.length > 0) {
  const best = others[0];
  lines.push("");
  lines.push("A newer Node is already installed, but this shell finds the old one first:");
  for (const o of others) lines.push("  " + o.version + "  " + o.file);
  lines.push("");
  if (best.kind === "brew") {
    lines.push(
      "Put Homebrew first on PATH for every shell, not only login shells. Add this line to",
    );
    lines.push("~/.zshenv (zsh) or ~/.bashrc (bash), then open a new terminal:");
    lines.push('  eval "$(' + best.prefix + '/bin/brew shellenv)"');
  } else {
    lines.push("Make it nvm's default, so shells that load nvm start on it:");
    lines.push("  nvm alias default " + (pinned || majorOf(best.version)));
    lines.push(
      "A shell that does not load nvm at all (an editor's, a git hook's) still will not see it.",
    );
  }
  lines.push("");
  lines.push(
    "Or remove the old Node at " + process.execPath + ", if nothing else on this machine needs it.",
  );
} else {
  lines.push("");
  lines.push("Install Node " + (pinned || minimum) + (pinned ? ", the version pinned in .nvmrc:" : ":"));
  lines.push("  " + "nvm install".padEnd(24) + "(reads .nvmrc)");
  lines.push("  " + ("brew install node@" + (pinned || minimum)).padEnd(24) + "(macOS, with Homebrew)");
  lines.push("/mixos init in Claude Code does this for you.");
}

fail(lines.join("\n"));
