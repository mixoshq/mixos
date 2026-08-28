/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { danger, warn, message } from "danger";

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
