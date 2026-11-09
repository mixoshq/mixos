/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense } from "react";
import Notice from "@/components/ui/notice";
import GitHubPanel from "@/components/admin/github/github-panel";
import UpdatePullRequests from "@/components/admin/github/update-pull-requests";
import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { CREATED_OUTCOMES, type CreatedOutcome, type OutcomeTone } from "@/lib/github/outcomes";
import { readPageState } from "@/lib/github/page-state";

// The link changes on GitHub's say as much as on this page's; never cached.
export const dynamic = "force-dynamic";

/** The public guide to the App: docs/hosting/after-you-install/github-app.md, as mixos.org serves it. */
const GITHUB_APP_DOCS = "https://mixos.org/docs/install/after-you-install/github-app";

/** What the "create the App" round trip ended with, as `?created=` says. */
const CREATED: Record<CreatedOutcome, { tone: OutcomeTone; text: string }> = {
  created: { tone: "success", text: "GitHub created the App, and its key is stored here, encrypted. Now install it." },
  off: { tone: "info", text: "The GitHub App is off, so nothing was recorded." },
  state: {
    tone: "warning",
    text:
      "That didn't match a request from this page, or it expired after 15 minutes, so nothing was recorded. " +
      "If GitHub created an App anyway, delete it in your GitHub settings under Developer settings, then start again.",
  },
  exists: {
    tone: "warning",
    text:
      "This instance already has an App, so the new one wasn't recorded. Delete the new one in your GitHub " +
      "settings under Developer settings.",
  },
  busy: {
    tone: "neutral",
    text:
      "Another administrator was changing the GitHub link, so nothing was recorded. Delete the App GitHub just " +
      "created in your GitHub settings under Developer settings, then start again.",
  },
  "conversion-failed": {
    tone: "warning",
    text:
      "GitHub didn't hand over the new App, so nothing was recorded. Its code lasts an hour and works once. " +
      "Delete the App in your GitHub settings under Developer settings, then start again.",
  },
  permissions: {
    tone: "danger",
    text:
      "The App GitHub created doesn't ask for exactly the permissions in the manifest, so it wasn't recorded. " +
      "Delete it in your GitHub settings under Developer settings, then start again.",
  },
  error: { tone: "danger", text: "Something unexpected stopped it. The server log says what." },
};

function one(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export default async function GitHubAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const params = await searchParams;
  const createdParam = one(params.created);
  const created = CREATED_OUTCOMES.find((c) => c === createdParam) ?? null;
  const installedParam = one(params.installed);
  const installed =
    installedParam && /^[1-9][0-9]{0,15}$/.test(installedParam) && Number.isSafeInteger(Number(installedParam))
      ? Number(installedParam)
      : null;
  const changed = one(params.changed) === "1";

  const state = await readPageState();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">GitHub App</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For developers. Link this instance to the GitHub repository it&apos;s built from, and installing, updating
          or removing an extension here opens a pull request there, with no local checkout needed. You review and
          merge it on GitHub, and merging is the deploy.{" "}
          <a
            href={GITHUB_APP_DOCS}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-primary underline underline-offset-2"
          >
            Read the GitHub App guide
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </div>
      <div className="space-y-6">
        {created && <Notice tone={CREATED[created].tone}>{CREATED[created].text}</Notice>}
        {installed && state.app && !state.link && (
          <Notice tone="info">GitHub installed the App. Finish linking to check it and link the repository.</Notice>
        )}
        {changed && state.link && (
          <Notice tone="warning">
            The installation changed on GitHub. Check again, so the instance sees what it covers now.
          </Notice>
        )}
        <GitHubPanel state={state} installedHint={installed} />
        {/* Read from GitHub: the rest of the page doesn't wait for it. */}
        <Suspense fallback={null}>
          <UpdatePullRequests />
        </Suspense>
      </div>
    </div>
  );
}
