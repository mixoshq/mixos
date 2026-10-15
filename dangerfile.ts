/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import { danger, fail, warn, message, schedule } from "danger";
import {
  duplicatesAdded,
  nextMigrationNumber,
  platformMigrations,
} from "./scripts/platform-migration-files";
import {
  isCoreRepository,
  isReleasePR,
  versionChanges,
  type VersionChange,
} from "./scripts/release-prep";
import { strayExtensions } from "./scripts/core-extensions";

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

/* -------------------------------------------------------------------------- */
/*  A new migration must not reuse a number                                    */
/* -------------------------------------------------------------------------- */

/**
 * `fail`. The ledger records a platform migration by its number, so of two
 * files with one number a database applies the first and skips the other as
 * already applied, without a word. Two branches that each took the next number
 * merge without a conflict, because the files have different names, so the PR
 * is the place to catch it. The runner and the registry generator refuse it
 * too (scripts/platform-migration-files.ts).
 *
 * The checkout is this PR merged into its base, so for a PR into main it holds
 * main's migrations beside this PR's. A stacked PR's base is another branch,
 * so main's are listed through the API as well. Only numbers this PR's new
 * files use are held to it: a repeat its base already has is not its doing.
 */
const MIGRATIONS_DIR = "supabase/migrations";
const MAIN_BRANCH = "main";

const addedMigrations = platformMigrations(
  danger.git.created_files.filter((f) => path.posix.dirname(f) === MIGRATIONS_DIR)
).map((m) => m.file);

/** Main's migrations, when the checkout does not already hold them. */
async function migrationsOnMain(): Promise<string[]> {
  if (danger.github.pr.base.ref === MAIN_BRANCH) return [];
  try {
    const { data } = await danger.github.api.repos.getContent({
      owner: danger.github.thisPR.owner,
      repo: danger.github.thisPR.repo,
      path: MIGRATIONS_DIR,
      ref: MAIN_BRANCH,
    });
    return Array.isArray(data) ? data.map((entry) => entry.path) : [];
  } catch (err) {
    warn(
      `Could not list \`${MIGRATIONS_DIR}\` on \`${MAIN_BRANCH}\` ` +
        `(${err instanceof Error ? err.message : String(err)}), so this PR's new ` +
        `migrations were checked against \`${danger.github.pr.base.ref}\` only.`
    );
    return [];
  }
}

if (addedMigrations.length > 0) {
  schedule(async () => {
    const onBase = fs.existsSync(MIGRATIONS_DIR)
      ? fs.readdirSync(MIGRATIONS_DIR).map((f) => `${MIGRATIONS_DIR}/${f}`)
      : [];
    const existing = [...onBase, ...(await migrationsOnMain())].filter(
      (f) => !danger.git.deleted_files.includes(f)
    );
    const duplicates = duplicatesAdded(addedMigrations, existing);
    if (duplicates.length === 0) return;

    const next = nextMigrationNumber([...existing, ...addedMigrations]);
    const isOurs = (f: string) => addedMigrations.includes(f);
    // Of a number only this PR's files share, one can keep it.
    const toMove = duplicates.reduce((n, d) => {
      const ours = d.files.filter(isOurs).length;
      return n + (ours === d.files.length ? ours - 1 : ours);
    }, 0);
    const list = duplicates
      .map(
        (d) =>
          `- \`${d.version}\`: ` +
          d.files.map((f) => `\`${f}\`${isOurs(f) ? " (this PR)" : ""}`).join(", ")
      )
      .join("\n");

    fail(
      `## A new migration reuses a number\n\n` +
        `${list}\n\n` +
        `The ledger records a platform migration by its number, so a database would apply ` +
        `one file per number and skip the rest as already applied, without a word. Git sees ` +
        `no conflict between two new files; the build and the release step refuse them too.\n\n` +
        (toMove === 1
          ? `Renumber this PR's file to \`${next}\`, the next free number, and set ` +
            `\`platform_schema_version\` to \`'${Number(next)}'\` in it.`
          : `Renumber this PR's files from \`${next}\`, the next free number, and set ` +
            `\`platform_schema_version\` in each to its new number.`) +
        ` See OS-UPDATES.md.`
    );
  });
}

/* -------------------------------------------------------------------------- */
/*  The core carries only its own extensions                                   */
/* -------------------------------------------------------------------------- */

/**
 * `fail`. The core repository carries each kind's template, Wall-E and the
 * built-in themes (scripts/core-extensions.ts); an app, connector or theme of
 * someone's own belongs in their fork. Only in the core repository: a fork
 * commits its extensions, which is how it ships them.
 */
const strayFolders = isCoreRepository(danger.github.thisPR.owner, danger.github.thisPR.repo)
  ? strayExtensions([...danger.git.created_files, ...danger.git.modified_files])
  : [];

if (strayFolders.length > 0) {
  const one = strayFolders.length === 1;
  fail(
    `## This PR adds ${one ? "an extension" : "extensions"} to the core\n\n` +
      `${strayFolders.map((f) => `- \`${f}/\``).join("\n")}\n\n` +
      `The core repository carries only each kind's template, Wall-E and the built-in themes ` +
      `(\`scripts/core-extensions.ts\`). An app, connector or theme of your own belongs in your ` +
      `fork, where you commit and deploy it. Take ${one ? "it" : "them"} out of this PR: ` +
      `\`git rm -r --cached <folder>\` keeps the files on disk.`
  );
}

/* -------------------------------------------------------------------------- */
/*  Only a release PR changes the version                                      */
/* -------------------------------------------------------------------------- */

/**
 * `fail`. Between releases package.json holds the last release's version, and
 * scripts/release-prep.ts refuses the next release while it holds another. A
 * developer may bump it locally to try an extension that needs a newer MixOS;
 * `/mixos deploy` leaves that bump out of its commits, and this catches one
 * committed another way. A release PR is told apart by its branch, which
 * `/mixos deploy release` names after the version it sets: release/vX.Y.Z.
 *
 * Only in the core repository, where releases are cut. A fork changes its
 * version by merging a release tag, which is how it upgrades
 * (docs/hosting/after-you-install/upgrading.md).
 *
 * The change is measured from where the branch left its base, as GitHub's
 * Files changed tab measures it. Danger's own diff starts from the base's
 * current tip, where a branch cut before a release would look as if it set
 * the version back.
 */
const VERSION_FILES = ["package.json", "package-lock.json"];

const versionFiles = isCoreRepository(danger.github.thisPR.owner, danger.github.thisPR.repo)
  ? VERSION_FILES.filter((f) => danger.git.modified_files.includes(f))
  : [];

/** The commit this PR's branch left its base at; null, with a warning, when GitHub can't say. */
async function branchPoint(): Promise<string | null> {
  const { base, head } = danger.github.pr;
  try {
    const { data } = await danger.github.api.repos.compareCommitsWithBasehead({
      owner: danger.github.thisPR.owner,
      repo: danger.github.thisPR.repo,
      basehead: `${base.sha}...${head.sha}`,
      per_page: 1,
    });
    return data.merge_base_commit.sha;
  } catch (err) {
    warn(
      `Could not find where this branch left \`${base.ref}\` ` +
        `(${err instanceof Error ? err.message : String(err)}), so the version in ` +
        `\`package.json\` and \`package-lock.json\` was not checked.`
    );
    return null;
  }
}

if (versionFiles.length > 0) {
  schedule(async () => {
    const from = await branchPoint();
    if (from === null) return;
    const repoSlug = `${danger.github.thisPR.owner}/${danger.github.thisPR.repo}`;
    const changes: VersionChange[] = [];
    for (const file of versionFiles) {
      const diff = await danger.git.diffForFile(file);
      if (!diff) continue;
      const before = await danger.github.utils.fileContents(file, repoSlug, from);
      changes.push(...versionChanges(file, before, diff.after));
    }
    if (changes.length === 0 || isReleasePR(danger.github.pr.head.ref, changes)) return;

    const list = changes
      .map((c) => `- \`${c.file}\`: \`${c.field}\` ${c.from ?? "(none)"} → ${c.to ?? "(none)"}`)
      .join("\n");
    const was = changes.find((c) => c.from !== null)?.from;

    fail(
      `## This PR changes the version\n\n` +
        `${list}\n\n` +
        `Only a release PR changes the version, from the \`release/vX.Y.Z\` branch ` +
        `\`/mixos deploy release\` makes. Between releases \`package.json\` holds the last ` +
        `release's version, and \`scripts/release-prep.ts\` refuses the next release while ` +
        `it holds another.\n\n` +
        `Drop the bump from the commit` +
        (was
          ? `: \`npm version ${was} --no-git-tag-version --allow-same-version\` puts the ` +
            `version back, then commit that.`
          : `.`) +
        ` To try an extension that needs a newer MixOS, keep the bump in your checkout: ` +
        `\`/mixos deploy\` leaves it out of its commits.`
    );
  });
}
