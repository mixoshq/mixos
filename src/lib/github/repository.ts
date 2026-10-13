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
 * ── WHAT A WRITE TOKEN MAY WRITE ────────────────────────────────────────────
 *
 * The App's `contents: write` can push to any branch and create or move tags,
 * and the default branch is what every host deploys. So every write goes
 * through `post()` here, and `post()` sends only what guardWrite() lets
 * through, whatever its caller asks for:
 *
 *   - five endpoints: `git/blobs`, `git/trees`, `git/commits`, `git/refs` and
 *     `pulls`, with exactly the fields a proposal sends. Nothing else is POSTed,
 *     and the client has no PUT or PATCH (./api.ts), so no merge endpoint
 *     (`PUT pulls/{n}/merge`, `POST merges`, `POST merge-upstream`), no update
 *     to a ref, and no auto-merge, which only GraphQL can turn on;
 *   - refs only under `refs/heads/mixos/`, never the default branch, never a
 *     tag;
 *   - tree paths only under the one folder the operation's WriteScope names,
 *     each a file, mode 100644, with no `..`, `.git` or control character; a
 *     deletion (`sha: null`) only in an update's or a removal's scope, under
 *     that same folder, so an install can delete nothing and nothing can
 *     delete outside the folder;
 *   - a commit with one parent, no author or committer of its own (the App's
 *     bot commits it), and no message that would skip the repository's checks;
 *   - a pull request from a branch under `mixos/` in this repository, into the
 *     default branch, with a one-line title that skips no checks and starts no
 *     Render preview.
 *
 * A refusal is a GitHubError with failure "path", before anything is sent.
 */

import { z } from "zod";
import { ciSkipMarker } from "@/lib/repository/hand-back";
import { SlugSchema } from "@/lib/repository/types";
import { GitHubError, githubRequest, segment } from "./api";
import { isBranchName } from "./identifiers";
import type { TokenShape } from "./manifest";
import { APP_BRANCH_PREFIX, isExtensionAction, renderPreviewMarker, type ExtensionAction } from "./names";
import { BranchRulesSchema, RepositorySchema, Sha, parseAnswer, type GitHubRepository } from "./schemas";
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

/**
 * What one write operation may change, fixed before the operation starts.
 *
 * A proposal's scope names the folder its tree writes under, `apps/files`,
 * and what it does to it. An install adds files; an update replaces them,
 * deleting the ones the new release lacks; a removal deletes every one. Only
 * the last two may send a deletion, and only under the folder.
 *
 * Rank 32's MixOS update creates a branch at a commit and writes no tree, so
 * it gets a scope with no folder at all, beside this one.
 */
export type WriteScope = { folder: string; action: ExtensionAction };

/** The linked repository, as one operation's token reaches it. */
export interface LinkedRepository {
  readonly record: RepositoryRecord;
  /** Which token this holds: read or write (./manifest.ts TOKEN_SHAPES). */
  readonly shape: TokenShape;
  /** GET a path under the repository. */
  get(suffix: string, params?: URLSearchParams): Promise<unknown>;
  /** POST under the repository: with the write shape and a scope only, and what guardWrite() allows. */
  post(suffix: string, body: unknown): Promise<unknown>;
}

/**
 * The repository behind one token. The token stays in this closure: it isn't a
 * property, so nothing that logs or returns the object carries it.
 */
export function linkedRepository(
  record: RepositoryRecord,
  shape: TokenShape,
  token: string,
  scope?: WriteScope,
): LinkedRepository {
  const auth = { kind: "installation", token } as const;
  return {
    record,
    shape,
    async get(suffix, params) {
      return (await githubRequest(repositoryPath(record, suffix), { auth, params })).data;
    },
    async post(suffix, body) {
      if (shape !== "write" || !scope) {
        throw new GitHubError("Only a write token with a write scope writes. This is a bug in the caller.", "path");
      }
      const allowed = guardWrite(record, scope, suffix, body);
      return (await githubRequest(repositoryPath(record, suffix), { method: "POST", auth, body: allowed })).data;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  What a write may be                                                         */
/* -------------------------------------------------------------------------- */

/** The tar reader's limit on a package's files, and the install record. */
const MAX_TREE_ENTRIES = 5_001;

const BlobBody = z.strictObject({
  content: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  encoding: z.literal("base64"),
});

const TreeEntry = z.strictObject({
  path: z.string().min(1).max(4096),
  mode: z.literal("100644"),
  type: z.literal("blob"),
  content: z.string().optional(),
  /** A blob's id, or null to delete the file at `path`. */
  sha: z.union([Sha, z.null()]).optional(),
});

const TreeBody = z.strictObject({
  base_tree: Sha,
  tree: z.array(TreeEntry).min(1).max(MAX_TREE_ENTRIES),
});

const CommitBody = z.strictObject({
  message: z.string().min(1).max(10_000),
  tree: Sha,
  parents: z.tuple([Sha]),
});

const RefBody = z.strictObject({ ref: z.string().max(300), sha: Sha });

const PullBody = z.strictObject({
  title: z.string().min(1).max(256),
  head: z.string().max(255),
  base: z.string().max(255),
  body: z.string().max(65_536),
});

function refuse(why: string): never {
  throw new GitHubError(`Refusing to write to GitHub: ${why}`, "path");
}

function parsed<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (!result.success) refuse(`that isn't ${what} as the App writes one.`);
  return result.data;
}

/** `apps/<slug>`, `connectors/<slug>` or `themes/<slug>`. */
export function isExtensionFolder(folder: string): boolean {
  const m = /^(?:apps|connectors|themes)\/([^/]+)$/.exec(folder);
  return m !== null && SlugSchema.safeParse(m[1]).success;
}

/** No control, format or separator character in a path GitHub is given. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Throws unless `path` is a file under `folder`, with nothing in it git or a disk would read otherwise. */
function assertInside(path: string, folder: string): void {
  if (!path.startsWith(`${folder}/`)) refuse(`${JSON.stringify(path)} isn't in ${folder}/.`);
  const inside = path.slice(folder.length + 1).split("/");
  for (const name of inside) {
    if (name === "" || name === "." || name === "..") refuse(`${JSON.stringify(path)} has an empty, . or .. segment.`);
    if (name.normalize("NFC").toLowerCase() === ".git") refuse(`${JSON.stringify(path)} has a .git in it.`);
    if (UNPRINTABLE.test(name) || name.includes("\\")) refuse(`${JSON.stringify(path)} has a character the App doesn't write.`);
  }
}

/**
 * The body to send for a POST to `suffix`, or a GitHubError when the App never
 * sends that: see the module comment. Exported for its tests.
 */
export function guardWrite(record: RepositoryRecord, scope: WriteScope, suffix: string, body: unknown): unknown {
  if (!isExtensionFolder(scope.folder)) refuse("the write scope isn't an extension's folder.");
  if (!isExtensionAction(scope.action)) refuse("the write scope doesn't say what the operation does.");
  switch (suffix) {
    case "/git/blobs":
      return parsed(BlobBody, body, "a blob");

    case "/git/trees": {
      const tree = parsed(TreeBody, body, "a tree");
      const seen = new Set<string>();
      for (const entry of tree.tree) {
        if (entry.sha === null) {
          // A deletion: only what replaces or deletes the folder sends one, and
          // only for a path in it, which assertInside() holds it to below.
          if (scope.action === "install") refuse(`an install deletes nothing, and the tree would delete ${JSON.stringify(entry.path)}.`);
          if (entry.content !== undefined) refuse(`${JSON.stringify(entry.path)} can't be deleted and written at once.`);
        } else if ((entry.content === undefined) === (entry.sha === undefined)) {
          refuse(`${JSON.stringify(entry.path)} needs its content or a blob's id, one of the two.`);
        }
        assertInside(entry.path, scope.folder);
        const folded = entry.path.normalize("NFC").toLowerCase();
        if (seen.has(folded)) refuse(`${JSON.stringify(entry.path)} is in the tree twice.`);
        seen.add(folded);
      }
      return tree;
    }

    case "/git/commits": {
      const commit = parsed(CommitBody, body, "a commit");
      const marker = ciSkipMarker(commit.message) ?? renderPreviewMarker(commit.message);
      if (marker) refuse(`the commit message holds ${JSON.stringify(marker)}.`);
      return commit;
    }

    case "/git/refs": {
      const ref = parsed(RefBody, body, "a ref");
      const branch = ref.ref.startsWith("refs/heads/") ? ref.ref.slice("refs/heads/".length) : null;
      if (!branch || !branch.startsWith(APP_BRANCH_PREFIX) || !isBranchName(branch)) {
        refuse(`the App writes branches under ${APP_BRANCH_PREFIX} only, not ${JSON.stringify(ref.ref)}.`);
      }
      if (branch === record.defaultBranch || record.defaultBranch.startsWith(APP_BRANCH_PREFIX)) {
        refuse("the App never writes the default branch.");
      }
      return ref;
    }

    case "/pulls": {
      const pull = parsed(PullBody, body, "a pull request");
      if (!pull.head.startsWith(APP_BRANCH_PREFIX) || !isBranchName(pull.head)) {
        refuse(`a pull request comes from a branch under ${APP_BRANCH_PREFIX} in this repository.`);
      }
      if (pull.base !== record.defaultBranch) refuse("a pull request goes into the default branch only.");
      if (UNPRINTABLE.test(pull.title)) refuse("a pull request's title is one line.");
      const marker = ciSkipMarker(pull.title) ?? renderPreviewMarker(pull.title);
      if (marker) refuse(`the title holds ${JSON.stringify(marker)}.`);
      return pull;
    }

    default:
      return refuse(`the App doesn't POST to ${JSON.stringify(suffix)}.`);
  }
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
