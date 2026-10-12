/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Requests to the linked repository, with paths built only from its stored
 * record: `/repos/<owner>/<name>` from `github_link`, then a suffix the caller
 * spells out of percent-encoded segments. Never a name from a request, and
 * never one from a response: a repository GitHub has moved answers with a
 * redirect, which ./api.ts refuses, and the admin's Check again records the new
 * name after confirming its id.
 *
 * Rank 30 (proposing pull requests) builds on `LinkedRepository`. What it adds
 * belongs here, beside the paths: refs only under `refs/heads/mixos/`, tree
 * paths only under the extension's folder, and no merge endpoint, no write to
 * the default branch and no auto-merge, whatever a caller asks for.
 */

import { GitHubError, githubRequest, segment } from "./api";
import type { TokenShape } from "./manifest";
import { BranchRulesSchema, RepositorySchema, parseAnswer, type GitHubRepository } from "./schemas";
import type { RepositoryRecord } from "./store";

/** A path suffix of percent-encoded segments: `/rules/branches/main`. */
const SUFFIX = /^(?:\/[A-Za-z0-9._~%!'()*-]+)*$/;

/** `/repos/<owner>/<name><suffix>`, from the stored record. */
export function repositoryPath(record: Pick<RepositoryRecord, "owner" | "name">, suffix = ""): string {
  if (!SUFFIX.test(suffix) || suffix.split("/").some((s) => s === "." || s === "..")) {
    throw new GitHubError("Refusing to send a request to an unexpected repository path.", "path");
  }
  return `/repos/${segment(record.owner)}/${segment(record.name)}${suffix}`;
}

/** The linked repository, as one operation's token reaches it. */
export interface LinkedRepository {
  readonly record: RepositoryRecord;
  /** Which token this holds: read or write (./manifest.ts TOKEN_SHAPES). */
  readonly shape: TokenShape;
  /** GET a path under the repository. */
  get(suffix: string, params?: URLSearchParams): Promise<unknown>;
  /** POST under the repository: with the write shape only. */
  post(suffix: string, body: unknown): Promise<unknown>;
}

/**
 * The repository behind one token. The token stays in this closure: it isn't a
 * property, so nothing that logs or returns the object carries it.
 */
export function linkedRepository(record: RepositoryRecord, shape: TokenShape, token: string): LinkedRepository {
  const auth = { kind: "installation", token } as const;
  return {
    record,
    shape,
    async get(suffix, params) {
      return (await githubRequest(repositoryPath(record, suffix), { auth, params })).data;
    },
    async post(suffix, body) {
      if (shape !== "write") {
        throw new GitHubError("A read token can't write. This is a bug in the caller.", "path");
      }
      return (await githubRequest(repositoryPath(record, suffix), { method: "POST", auth, body })).data;
    },
  };
}

/** GET /repos/<owner>/<name>, checked to be the linked repository by id. */
export async function readRepository(repo: LinkedRepository): Promise<GitHubRepository> {
  const answer = parseAnswer(RepositorySchema, await repo.get(""), "GET /repos/{owner}/{repo}");
  if (answer.id !== repo.record.id) {
    throw new GitHubError(
      `GitHub answered for a different repository than the linked one (id ${answer.id}, not ${repo.record.id}).`,
      "malformed",
    );
  }
  return answer;
}

/** What applies to the default branch, from its ruleset rules. */
export interface BranchRules {
  branch: string;
  /** Whether a `pull_request` rule applies: changes reach the branch only through a pull request. */
  pullRequest: boolean;
  /** Every rule type that applies, sorted, without repeats. */
  rules: string[];
  /** GitHub's status when it wouldn't let the App read them: nothing applies that the App can see. */
  unreadStatus?: number;
}

/**
 * The rules, or, when GitHub refuses to show them (403 or 404), none, with its
 * status: a private repository under GitHub Free has no rulesets, and linking
 * doesn't need the rule. Any other failure is thrown.
 */
export async function readBranchRulesOrNone(repo: LinkedRepository): Promise<BranchRules> {
  try {
    return await readBranchRules(repo);
  } catch (err) {
    if (err instanceof GitHubError && (err.failure === "forbidden" || err.failure === "not-found")) {
      return { branch: repo.record.defaultBranch, pullRequest: false, rules: [], unreadStatus: err.status };
    }
    throw err;
  }
}

/**
 * The rules on the default branch, from `GET /repos/{owner}/{repo}/rules/branches/{branch}`,
 * which needs only metadata read and lists the ruleset rules that apply.
 * Classic branch protection isn't listed there, which is why an admin can
 * confirm another protection instead (./link.ts).
 */
export async function readBranchRules(repo: LinkedRepository): Promise<BranchRules> {
  const branch = repo.record.defaultBranch;
  const answer = parseAnswer(
    BranchRulesSchema,
    await repo.get(`/rules/branches/${segment(branch)}`, new URLSearchParams({ per_page: "100" })),
    "GET /repos/{owner}/{repo}/rules/branches/{branch}",
  );
  // Shown on the page, so only what reads as a rule type.
  const rules = [...new Set(answer.map((r) => r.type).filter((t) => /^[a-z_]{1,64}$/.test(t)))].sort();
  return { branch, pullRequest: rules.includes("pull_request"), rules };
}
