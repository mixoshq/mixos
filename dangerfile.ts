/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import { danger, fail, warn, message } from "danger";

const ALLOWED_DIRS = ["apps/", "connectors/", "themes/"];
const OS_CHANGE_LABEL = "os-change";

const allFiles = [
  ...danger.git.modified_files,
  ...danger.git.created_files,
  ...danger.git.deleted_files,
];

// Build-plan docs describe work; they never perform it, so they shouldn't trigger
// the os-change admin-review label. They live in two places: co-located beside
// their subject (apps|connectors|themes/<slug>/plans/) for entity-scoped work, and
// docs/plans/ for platform work. See docs/plans/README.md.
const isPlanDoc = (f: string) =>
  /^docs\/plans\/.+\.md$/i.test(f) ||
  /^(?:apps|connectors|themes)\/[^/]+\/plans\/.+\.md$/i.test(f);

const osFiles = allFiles.filter(
  (f) =>
    !ALLOWED_DIRS.some((dir) => f.startsWith(dir)) && !isPlanDoc(f)
);

// Per-app, per-connector and per-theme scope labels. Match `apps/<slug>/...`,
// `connectors/<slug>/...` or `themes/<slug>/...` so top-level docs like
// `apps/AGENTS.md` don't produce a bogus `app:AGENTS.md` label. A co-located
// plan edit (`apps/<slug>/plans/*.md`) is in scope for its subject and does
// label — that is the point of co-locating it.
const scopeLabels = new Set<string>();
for (const f of allFiles) {
  const appMatch = f.match(/^apps\/([^/]+)\//);
  if (appMatch) scopeLabels.add(`app:${appMatch[1]}`);
  const connectorMatch = f.match(/^connectors\/([^/]+)\//);
  if (connectorMatch) scopeLabels.add(`connector:${connectorMatch[1]}`);
  const themeMatch = f.match(/^themes\/([^/]+)\//);
  if (themeMatch) scopeLabels.add(`theme:${themeMatch[1]}`);
}

const existingLabels = danger.github.issue.labels.map((l) => l.name);

if (osFiles.length > 0) {
  const fileList = osFiles.map((f) => `- \`${f}\``).join("\n");

  warn(
    `## OS Platform Changes Detected\n\n` +
      `This PR modifies **${osFiles.length}** file(s) outside of \`apps/\`, \`connectors/\` and \`themes/\`. ` +
      `These changes affect the MixOS platform and require admin review before merging.\n\n` +
      `${fileList}`
  );

  // Add the os-change label to flag for admin review
  if (!existingLabels.includes(OS_CHANGE_LABEL)) {
    danger.github.api.issues.addLabels({
      owner: danger.github.thisPR.owner,
      repo: danger.github.thisPR.repo,
      issue_number: danger.github.thisPR.number,
      labels: [OS_CHANGE_LABEL],
    });
  }
} else if (scopeLabels.size === 0) {
  message(
    "This PR only modifies files in `apps/`, `connectors/` and/or `themes/` — no OS platform changes."
  );
}

const newScopeLabels = [...scopeLabels]
  .filter((l) => !existingLabels.includes(l))
  .sort();

if (newScopeLabels.length > 0) {
  danger.github.api.issues.addLabels({
    owner: danger.github.thisPR.owner,
    repo: danger.github.thisPR.repo,
    issue_number: danger.github.thisPR.number,
    labels: newScopeLabels,
  });
  message(
    `Tagged scope: ${newScopeLabels.map((l) => `\`${l}\``).join(", ")}.`
  );
}

/* -------------------------------------------------------------------------- */
/*  MIXOS_REPOSITORY_URL must not travel in a committed file                   */
/* -------------------------------------------------------------------------- */

/**
 * `fail`, not `warn`.
 *
 * This variable decides which catalogue an instance gets its CHECKSUMS from,
 * and the checksum is the only thing standing between a download and the
 * source tree. Whoever chooses the catalogue chooses what "verified" means on
 * every deployment of the release the value lands in.
 *
 * It legitimately points at `localhost:4321` or `host.docker.internal:4321`
 * while the platform and the catalogue are developed against each other, which
 * is exactly why it needs a gate on the way out: the value is correct on the
 * laptop it was typed on and wrong everywhere else.
 *
 * `npm run verify:repository-url` is the same check in CI, and
 * `src/lib/repository/client.ts` ignores the variable on a built deployment
 * unless it names that machine. This one exists because a review comment on the
 * diff is the cheapest place to catch it — before it is a commit anyone has to
 * revert.
 */
const REPOSITORY_URL_FILES = [
  ".env.docker",
  "docker-compose.yml",
  "Dockerfile",
  "Dockerfile.dev",
];

const pinnedRepositoryUrl = allFiles
  .filter((f) => REPOSITORY_URL_FILES.includes(f))
  .flatMap((f) => {
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf-8")
      .split("\n")
      .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
      // A commented example is the documentation this rule wants to exist —
      // both env files carry one showing the localhost form on purpose.
      .filter(({ raw }) => !raw.startsWith("#"))
      .map(({ raw, line }) => ({
        line,
        match: raw.match(/MIXOS_REPOSITORY_URL\s*[=:]\s*(.*)$/),
      }))
      .filter(({ match }) => {
        if (!match) return false;
        const value = match[1].trim().replace(/^["']|["']$/g, "");
        // The compose passthrough carries no value of its own.
        if (value === "" || /^\$\{MIXOS_REPOSITORY_URL(:-)?\}$/.test(value)) return false;
        return value !== "https://mixos.org";
      })
      .map(({ line }) => `- \`${f}:${line}\``);
  });

if (pinnedRepositoryUrl.length > 0) {
  fail(
    `## MIXOS_REPOSITORY_URL is pinned in a committed file\n\n` +
      `${pinnedRepositoryUrl.join("\n")}\n\n` +
      `A committed value becomes the default for every install of this release, and it ` +
      `decides which catalogue's checksums those installs verify downloads against. ` +
      `Remove it and point a local stack somewhere else through the shell instead:\n\n` +
      "```\nMIXOS_REPOSITORY_URL=http://host.docker.internal:4321 npm run dev:docker\n```"
  );
}

/* -------------------------------------------------------------------------- */
/*  A new migration must bump platform_schema_version                          */
/* -------------------------------------------------------------------------- */

/**
 * `fail`, and this is the rule that makes the schema gate mean anything.
 *
 * The readiness probe compares `platform_settings.platform_schema_version`
 * against `EXPECTED_SCHEMA_VERSION`, which the build derives from the highest
 * numbered file in `supabase/migrations/`. Add a migration without bumping the
 * row and the two disagree in the one direction the gate cannot see: the image
 * expects N, the database reports N-1 and is *correct* about the row while being
 * wrong about the schema. The probe then reports a mismatch on every healthy
 * deployment, which is how a gate gets switched off.
 *
 * Checked on created files only. Editing an already-applied migration is a
 * different problem, and one this rule would give bad advice about.
 *
 * Comments are stripped before matching because the migration that introduced
 * the row talks about it at length in its own header.
 */
const migrationsMissingBump = danger.git.created_files
  .map((f) => ({ f, m: /^supabase\/migrations\/(\d+)_.*\.sql$/.exec(f) }))
  .filter(({ m }) => m !== null)
  .filter(({ f, m }) => {
    if (!fs.existsSync(f)) return false;
    const sqlOnly = fs
      .readFileSync(f, "utf-8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const bump = /platform_schema_version[\s\S]{0,200}?'(\d+)'/.exec(sqlOnly);
    return !bump || Number(bump[1]) !== Number(m![1]);
  })
  .map(({ f, m }) => `- \`${f}\` must set it to \`'${Number(m![1])}'\``);

if (migrationsMissingBump.length > 0) {
  fail(
    `## New migration does not bump \`platform_schema_version\`\n\n` +
      `${migrationsMissingBump.join("\n")}\n\n` +
      `The readiness probe refuses to serve a revision whose database is behind ` +
      `the schema the image was built against, and it reads that row to decide. ` +
      `A migration that does not bump it is invisible to the check. Add this as ` +
      `the last statement:\n\n` +
      "```sql\n" +
      `insert into public.platform_settings (key, value)\n` +
      `values ('platform_schema_version', '<this migration's number>')\n` +
      `on conflict (key) do update set value = excluded.value, updated_at = now();\n` +
      "```\n\n" +
      `See \`supabase/migrations/0007_platform_schema_version.sql\` and OS-UPDATES.md.`
  );
}
