/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ESLint rule: app-imports
 *
 * The editor's copy of the app import policy. App code imports its own files,
 * a published list of platform modules and a few packages, and nothing else;
 * it loads no module any other way; it calls callAppRoute only with its own
 * slug; and it writes to nothing it imported. The rule and its messages live
 * in src/lib/apps/import-policy.mjs.
 *
 * A THIN ADAPTER, ON PURPOSE. It runs the very function the registry
 * generator's containment scan runs (scripts/app-containment.ts) on the file's
 * text, so the editor and the build cannot disagree. The scan is the copy that
 * holds: lint runs on pull requests to this repository, while the generator
 * runs on every build and every Registry install, and a disable comment here
 * silences nothing there.
 *
 * Each file is compiled on its own, which costs a parse per app file. That is
 * the price of reading names the way the build reads them, through the
 * TypeScript checker, rather than through a second implementation.
 */

import { checkAppText } from "../src/lib/apps/import-policy.mjs";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "App code imports its own files, the published platform modules and the listed packages, and nothing else.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const file = context.physicalFilename ?? context.filename;
        for (const finding of checkAppText(file, context.sourceCode.text)) {
          context.report({
            loc: { line: finding.line, column: finding.column },
            message: `${finding.what} ${finding.why}`,
          });
        }
      },
    };
  },
};

export default rule;
