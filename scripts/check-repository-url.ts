/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refuse to ship a repository URL that is not mixos.org.
 *
 * ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
 *
 * `MIXOS_REPOSITORY_URL` decides where an instance gets the CHECKSUMS it
 * verifies every download against. Whoever chooses the catalogue chooses what
 * "verified" means on that deployment, which makes a value that reaches a
 * release the single highest-leverage line in any env file here.
 *
 * The override exists so the platform and the catalogue can be developed
 * against each other locally — `http://localhost:4321` for a host checkout,
 * `http://host.docker.internal:4321` from inside the Docker stack. Both are
 * correct on a laptop and catastrophic in a tag: every install of that release
 * would search a machine that is not on the internet, and if it ever were, its
 * checksums would be authoritative.
 *
 * ── WHY A COMMITTED FILE IS THE ONLY THING WORTH SCANNING ───────────────────
 *
 * `.env.local` is git-ignored and `.env.docker.local` is regenerated per boot,
 * so neither can travel. `.env.docker` is COMMITTED and read by compose on
 * every Docker install, and docker-compose.yml can hardcode `environment:`
 * entries. Those are the files where a developer's convenience becomes
 * everyone's default, so those are the ones checked.
 *
 * This is one of four layers, and the cheapest. The others are the Danger rule
 * on PRs, this same script in CI, and the runtime lock in
 * `src/lib/repository/client.ts` — which is the only one that still holds when
 * a deployment is misconfigured after the release is cut. See
 * docs/security-architecture.md §31.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

/** The only value allowed to travel in a committed file. */
const ALLOWED = "https://mixos.org";

/**
 * Committed files that can set the variable for someone else's install.
 *
 * Listed explicitly rather than globbed: a glob over the repo would also match
 * this file, the docs that quote a localhost example on purpose, and every
 * future test fixture — and a check that cries wolf is a check that gets a
 * `--force` added to it.
 */
const SCANNED = [".env.docker", "docker-compose.yml", "Dockerfile", "Dockerfile.dev"];

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * Lines that ASSIGN the variable, ignoring comments.
 *
 * A commented example is the documentation this check wants to exist — both
 * `.env.docker` and `.env.local.example` carry one, deliberately showing the
 * localhost form. Flagging those would mean the fix is to delete the
 * explanation.
 */
function findAssignments(file: string): Finding[] {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return [];

  const out: Finding[] = [];
  fs.readFileSync(full, "utf-8")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("#")) return;
      // `KEY=value` in an env file, `- KEY=value` or `KEY: value` in compose,
      // `ENV KEY=value` in a Dockerfile.
      const m = line.match(/MIXOS_REPOSITORY_URL\s*[=:]\s*(.*)$/);
      if (!m) return;

      const value = m[1].trim().replace(/^["']|["']$/g, "");
      // A compose passthrough (`${MIXOS_REPOSITORY_URL:-}`) is the sanctioned
      // way to point a LOCAL stack somewhere else: it carries no value of its
      // own and substitutes empty when the shell is silent.
      if (value === "" || /^\$\{MIXOS_REPOSITORY_URL(:-)?\}$/.test(value)) return;
      if (value === ALLOWED) return;

      out.push({ file, line: i + 1, text: line });
    });
  return out;
}

function main(): void {
  const findings = SCANNED.flatMap(findAssignments);

  if (findings.length === 0) {
    console.log(`✓ No committed file pins MIXOS_REPOSITORY_URL away from ${ALLOWED}.`);
    return;
  }

  console.error("\nMIXOS_REPOSITORY_URL is set in a committed file:\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  console.error(
    `\nA committed value becomes the default for every install of this release, and it\n` +
      `decides which catalogue's checksums those installs trust. Remove it, and point a\n` +
      `local stack somewhere else through the shell instead:\n\n` +
      `  MIXOS_REPOSITORY_URL=http://host.docker.internal:4321 npm run dev:docker\n`,
  );
  process.exit(1);
}

main();
