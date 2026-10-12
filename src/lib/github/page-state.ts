/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Admin > GitHub shows, read from this instance alone: the stored link,
 * and whether the stored key decrypts. Nothing here asks GitHub; the page's
 * Check again does. The caller has already required an admin.
 */

import { getAppOrigin } from "@/lib/env/origin";
import { parsePrivateKey } from "./jwt";
import {
  appSettingsUrl,
  defaultAppName,
  installAppUrl,
  installationSettingsUrl,
  repositoryUrl,
  rulesetsUrl,
} from "./manifest";
import type { GitHubPageState } from "./outcomes";
import { CorruptRecordError, encryptionKeyState, readGitHubState, readPrivateKeyPem, type GitHubState } from "./store";

/** Whether the stored key decrypts and parses. The key itself is dropped straight away. */
async function keyReadable(): Promise<boolean> {
  try {
    parsePrivateKey(await readPrivateKeyPem());
    return true;
  } catch {
    return false;
  }
}

export async function readPageState(): Promise<GitHubPageState> {
  const encryption = encryptionKeyState();
  const feature = encryption.ok ? "on" : encryption.problem;

  let origin: string | null = null;
  try {
    origin = getAppOrigin();
  } catch {
    // The page says to set NEXTAUTH_URL before creating an App.
  }

  let state: GitHubState;
  try {
    state = await readGitHubState();
  } catch (err) {
    if (!(err instanceof CorruptRecordError)) throw err;
    return {
      feature,
      corrupt: true,
      origin,
      defaultName: defaultAppName(origin ?? ""),
      app: null,
      link: null,
      branchRule: null,
      override: null,
      previewChecklist: null,
    };
  }

  const { app, link } = state;
  return {
    feature,
    corrupt: false,
    origin,
    defaultName: defaultAppName(origin ?? ""),
    app: app
      ? {
          id: app.id,
          slug: app.slug,
          name: app.name,
          owner: app.owner.login,
          ownerType: app.owner.type,
          keyFingerprint: app.keyFingerprint,
          keyReadable: feature === "on" && state.hasKey ? await keyReadable() : false,
          settingsUrl: appSettingsUrl(app.owner, app.slug),
          installUrl: installAppUrl(app.slug),
        }
      : null,
    link:
      app && link
        ? {
            installationId: link.installationId,
            installationUrl: installationSettingsUrl(app.owner, link.installationId),
            repository: {
              id: link.repository.id,
              fullName: `${link.repository.owner}/${link.repository.name}`,
              url: repositoryUrl(link.repository.owner, link.repository.name),
              defaultBranch: link.repository.defaultBranch,
              private: link.repository.private,
              fork: link.repository.fork,
              parent: link.repository.parent?.fullName ?? null,
            },
            linkedAt: link.linkedAt,
            checkedAt: link.checkedAt,
            disabled: link.disabled,
            rulesetsUrl: rulesetsUrl(link.repository.owner, link.repository.name),
          }
        : null,
    branchRule: state.branchRule
      ? {
          branch: state.branchRule.branch,
          checkedAt: state.branchRule.checkedAt,
          pullRequest: state.branchRule.pullRequest,
          rules: state.branchRule.rules,
          unreadStatus: state.branchRule.unreadStatus ?? null,
        }
      : null,
    override: state.override ? { reason: state.override.reason, at: state.override.at, by: state.override.by } : null,
    previewChecklist: state.previewChecklist ? { at: state.previewChecklist.at, by: state.previewChecklist.by } : null,
  };
}
