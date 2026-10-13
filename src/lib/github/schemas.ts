/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GitHub's answers, as the link reads them. Every answer is parsed here before
 * anything is taken from it; unknown keys are dropped, and an answer that
 * doesn't fit is an error that names the fields, never their values (a token
 * answer holds the token).
 *
 * Identifiers are checked against ./identifiers.ts as they are parsed, because
 * a login or a repository name from here can end up in a stored record, and
 * from there in a path.
 */

import { z } from "zod";
import { GitHubError } from "./api";
import { isAppSlug, isBranchName, isGitHubId, isLogin, isRepositoryName } from "./identifiers";

const Id = z.number().refine(isGitHubId, "not a GitHub id");
const Login = z.string().refine(isLogin, "not a GitHub login");
const PermissionMap = z.record(z.string(), z.string());

const AccountSchema = z.object({
  id: Id,
  login: Login,
  type: z.string(),
});

/** POST /app-manifests/{code}/conversions: the new App, with its first private key. */
export const ManifestConversionSchema = z.object({
  id: Id,
  slug: z.string().refine(isAppSlug, "not an App slug"),
  name: z.string().min(1).max(200),
  owner: AccountSchema,
  permissions: PermissionMap,
  events: z.array(z.string()),
  pem: z.string().min(1),
});
export type ManifestConversion = z.infer<typeof ManifestConversionSchema>;

/** GET /app: the App a JWT speaks for. */
export const AppSchema = z.object({
  id: Id,
  slug: z.string(),
});

/** GET /app/installations/{id}, and each entry of GET /app/installations. */
export const InstallationSchema = z.object({
  id: Id,
  app_id: Id,
  account: AccountSchema.nullable(),
  repository_selection: z.string(),
  permissions: PermissionMap,
  suspended_at: z.string().nullable().optional(),
});
export type Installation = z.infer<typeof InstallationSchema>;

export const InstallationListSchema = z.array(InstallationSchema);

/** A repository, as an installation's listing and GET /repos/{owner}/{repo} give it. */
export const RepositorySchema = z.object({
  id: Id,
  name: z.string().refine(isRepositoryName, "not a repository name"),
  full_name: z.string(),
  owner: z.object({ id: Id, login: Login }),
  private: z.boolean(),
  fork: z.boolean(),
  default_branch: z.string().refine(isBranchName, "not a branch name"),
  parent: z
    .object({
      id: Id,
      full_name: z.string().refine((v) => {
        const [owner, name, ...rest] = v.split("/");
        return rest.length === 0 && isLogin(owner) && isRepositoryName(name);
      }, "not a repository's full name"),
    })
    .nullable()
    .optional(),
});
export type GitHubRepository = z.infer<typeof RepositorySchema>;

/** GET /installation/repositories. */
export const RepositoryListSchema = z.object({
  total_count: z.number().int().min(0),
  repositories: z.array(RepositorySchema),
});

/** POST /app/installations/{id}/access_tokens. Holds the token: never shown, logged or kept. */
export const AccessTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  permissions: PermissionMap,
  repository_selection: z.string().optional(),
  repositories: z.array(z.object({ id: Id })).optional(),
});

/** GET /repos/{owner}/{repo}/rules/branches/{branch}: the ruleset rules that apply to it. */
export const BranchRulesSchema = z.array(
  z.object({
    type: z.string(),
    ruleset_id: z.number().optional(),
  }),
);

/* -------------------------------------------------------------------------- */
/*  Proposals: the git data API, contents, pull requests and checks             */
/* -------------------------------------------------------------------------- */

/** A full git object id. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "not a git object id");

/** GET /repos/{owner}/{repo}/git/ref/{ref}, and POST /repos/{owner}/{repo}/git/refs. */
export const GitRefSchema = z.object({
  ref: z.string(),
  object: z.object({ sha: Sha, type: z.string() }),
});

/** GET and POST /repos/{owner}/{repo}/git/commits. */
export const GitCommitSchema = z.object({
  sha: Sha,
  tree: z.object({ sha: Sha }),
  parents: z.array(z.object({ sha: Sha })),
});

/** POST /repos/{owner}/{repo}/git/blobs. */
export const GitBlobCreatedSchema = z.object({ sha: Sha });

/** One entry of a tree, as GET and POST /repos/{owner}/{repo}/git/trees give it. */
export const GitTreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: Sha,
});

/** GET and POST /repos/{owner}/{repo}/git/trees: one level of the tree. */
export const GitTreeSchema = z.object({
  sha: Sha,
  tree: z.array(GitTreeEntrySchema),
  truncated: z.boolean(),
});

/** One entry of GET /repos/{owner}/{repo}/contents/{dir}. */
export const ContentEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number().int().min(0),
});
export const ContentDirectorySchema = z.array(ContentEntrySchema);

/** GET /repos/{owner}/{repo}/contents/{file}: a file, in base64 up to 1 MB. */
export const ContentFileSchema = z.object({
  type: z.literal("file"),
  encoding: z.string(),
  content: z.string(),
  size: z.number().int().min(0),
});

/** One pull request, as POST /pulls and GET /pulls give it. */
export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  head: z.object({
    ref: z.string(),
    sha: Sha,
    repo: z.object({ id: Id }).nullable(),
  }),
  base: z.object({ ref: z.string(), sha: Sha }),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;
export const PullRequestListSchema = z.array(PullRequestSchema);

/**
 * GET /repos/{owner}/{repo}/compare/{base}...{head}: how `head` stands to
 * `base`, the commits between them (at most 250 are listed), and the files
 * that differ from their merge base (at most 300 are listed, which is why the
 * count is checked against that cap before it is trusted).
 */
export const CompareSchema = z.object({
  status: z.enum(["identical", "ahead", "behind", "diverged"]),
  ahead_by: z.number().int().min(0),
  behind_by: z.number().int().min(0),
  total_commits: z.number().int().min(0),
  merge_base_commit: z.object({ sha: Sha }),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        previous_filename: z.string().optional(),
      }),
    )
    .optional(),
});
export type Compare = z.infer<typeof CompareSchema>;

/** GET /repos/{owner}/{repo}/commits/{ref}/check-runs. */
export const CheckRunsSchema = z.object({
  total_count: z.number().int().min(0),
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});
export type CheckRuns = z.infer<typeof CheckRunsSchema>;

/** GET /repos/{owner}/{repo}/commits/{ref}/status: the combined commit status. */
export const CombinedStatusSchema = z.object({
  state: z.string(),
  total_count: z.number().int().min(0),
  statuses: z.array(z.object({ state: z.string() })),
});
export type CombinedStatus = z.infer<typeof CombinedStatusSchema>;

/**
 * Parse one answer, or throw a GitHubError naming what didn't fit: the paths of
 * the fields, never what they held.
 */
export function parseAnswer<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(the answer)"))]
    .slice(0, 4)
    .join(", ");
  throw new GitHubError(`GitHub's answer to ${what} wasn't the expected shape (${fields}).`, "malformed");
}
