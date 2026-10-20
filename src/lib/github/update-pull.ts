/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An update of MixOS itself as a pull request on the linked repository: what
 * the release notice's "Open an update pull request" does, on a built
 * deployment whose linked repository is a fork of upstream MixOS. The work
 * behind ./update-pull-actions.ts, and what the notice offers
 * (mixosUpdateOffer()).
 *
 * ── WHY GITHUB IS ASKED FIRST ───────────────────────────────────────────────
 *
 * The release list gives a tag and a commit. GitHub resolves any commit in a
 * fork network through any repository in it, a stranger's fork included, so a
 * branch created at the list's commit would put whatever that commit is into
 * an "Update MixOS to v0.5.0" pull request in every linked repository: a wrong
 * local tag on mixos.org's side, an edited feed, or a compromised deploy of
 * mixos.org would do it. So before anything is written, with a read token,
 * GitHub has to say (D21):
 *
 *   - `compare/<commit>...mixoshq:<tag>` is `identical`: upstream's tag is at
 *     that commit;
 *   - `compare/mixoshq:main...<commit>` is `behind` or `identical`: the commit
 *     is on upstream's main.
 *
 * Both name upstream from ./identifiers.ts, never from input or an answer. A
 * mismatch, or an answer GitHub won't give (a 404 while upstream is private,
 * or any error), refuses, audited, and the admin gets the compare link to
 * merge by hand.
 *
 * ── THE STEPS ───────────────────────────────────────────────────────────────
 *
 * Under the `github.app` lock, so one proposal or link change runs at a time:
 *
 *   1. From what is stored, nothing from the request but the tag: the link (a
 *      fork of upstream, by its recorded parent's id), the preview checklist,
 *      and the release on record for the tag, whose commit is the one used,
 *      newer than this build.
 *   2. With a read token: the default branch as a proposal reads it
 *      (./propose.ts: the rule, read again; the workflows, render.yaml and, on
 *      Vercel, vercel.json), the two compares above, the compare of the
 *      default branch with the commit (GitHub's numbers for the body, and the
 *      files the release changes: one under .github/workflows/ refuses, since
 *      the App has no `workflows` permission and GitHub would refuse the
 *      push), and whether `mixos/update-<tag>` exists. If it does, its open
 *      pull request is the answer, and nothing is written.
 *   3. With a write token scoped to that one ref at that one commit
 *      (./repository.ts): the branch, then the pull request. No blob, tree or
 *      commit: the commit is upstream's, shared across the fork network.
 *   4. Audit `mixos.update.propose` with the pull request, its branch and the
 *      commit, or `mixos.update.propose.rejected` with the reason.
 *
 * Nothing here merges, touches the default branch or turns on auto-merge, and
 * nothing could: the client can't send the requests that would (./api.ts,
 * ./repository.ts).
 *
 * ── WHAT THE NOTICE SHOWS ───────────────────────────────────────────────────
 *
 * The notice is on every admin page, so what it offers is read from this
 * instance alone, never from GitHub: the link, and this instance's own record
 * of having opened a pull request for the release. Admin > GitHub, one page,
 * reads GitHub for the open update pull requests and their checks
 * (./proposals.ts), and offers the button again when the recorded pull request
 * is no longer open there.
 */

import { z } from "zod";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { sql } from "@/lib/db/client";
import { isBuiltDeployment } from "@/lib/platform/build";
import { readReleaseCheckState } from "@/lib/platform/release-check";
import { UPGRADE_GUIDE_URL, mergeCommand, onChannel, releasePageUrl, type ReleaseNotice } from "@/lib/platform/releases";
import { mixosCommit, mixosVersion } from "@/lib/platform/version";
import { compareRelease } from "@/lib/platform/version-floor";
import { releaseChannel } from "@/lib/repository/policy";
import type { CoreRelease } from "@/lib/repository/types";
import { GitHubError, segment } from "./api";
import { UPSTREAM_REPOSITORY, isForkOfUpstream } from "./identifiers";
import { featureRefusal, locked, refused, ruleRecord, withLinkedRepository } from "./link";
import { GITHUB_WEB_ORIGIN, repositoryUrl } from "./manifest";
import { isReleaseTag, updateBranch, updateTitle } from "./names";
import type { OutcomeLink, ProposalCheckLine, UpdateCompare, UpdateOffer, UpdateOutcome } from "./outcomes";
import {
  ProposalRefusal,
  branchHead,
  describe,
  inspectDefaultBranch,
  judgeDefaultBranch,
  offReason,
  thisHost,
  type DefaultBranchInspection,
  type ProposeContext,
} from "./propose";
import type { LinkedRepository } from "./repository";
import { CompareSchema, GitRefSchema, PullRequestListSchema, PullRequestSchema, parseAnswer, type Compare } from "./schemas";
import { readGitHubState, saveBranchRule, type GitHubState, type RepositoryRecord } from "./store";
import { updateBody } from "./update-pull-body";

const nowOf = (ctx: { now?(): Date }) => (ctx.now ? ctx.now() : new Date());

/** GitHub lists at most this many files in a compare answer: at the cap, the list may be short. */
export const COMPARE_FILES_CAP = 300;

/** The audit actions. */
export const UPDATE_PROPOSE_ACTION = "mixos.update.propose";
export const UPDATE_REJECTED_ACTION = "mixos.update.propose.rejected";

/** What a MixOS update is audited against. */
const TARGET_TYPE = "mixos";

const UPSTREAM = `${UPSTREAM_REPOSITORY.owner}/${UPSTREAM_REPOSITORY.name}`;

function fullName(record: Pick<RepositoryRecord, "owner" | "name">): string {
  return `${record.owner}/${record.name}`;
}

/** `1 commit`, `2 commits`. */
export function count(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/* -------------------------------------------------------------------------- */
/*  The fallback: the compare link, and the merge by hand                       */
/* -------------------------------------------------------------------------- */

/** This build, as upstream's compare page can name it: its commit, or its version's tag. */
export function thisBuildRef(): string | null {
  const commit = mixosCommit();
  if (commit) return commit;
  const tag = `v${mixosVersion()}`;
  return isReleaseTag(tag) ? tag : null;
}

/**
 * What changed between this build and the release, on upstream's compare
 * page: built from ./identifiers.ts, this build's commit and the validated
 * tag, nothing else. Null when this build's commit isn't known.
 */
export function upstreamCompareUrl(from: string | null, tag: string): string | null {
  if (!from || !isReleaseTag(tag) || !/^(?:[0-9a-f]{40}|v[0-9A-Za-z.-]+)$/.test(from)) return null;
  const base = `${GITHUB_WEB_ORIGIN}/${encodeURIComponent(UPSTREAM_REPOSITORY.owner)}/${encodeURIComponent(UPSTREAM_REPOSITORY.name)}`;
  return `${base}/compare/${encodeURIComponent(from)}...${encodeURIComponent(tag)}`;
}

function compareLinks(tag: string): OutcomeLink[] {
  const url = upstreamCompareUrl(thisBuildRef(), tag);
  return url ? [{ label: "What changed, on GitHub", href: url }] : [];
}

/* -------------------------------------------------------------------------- */
/*  What the notice offers                                                      */
/* -------------------------------------------------------------------------- */

/** The latest `mixos.update.propose` row for `tag` in the repository with id `repositoryId`. */
async function recordedProposal(
  repositoryId: number,
  tag: string,
): Promise<{ number: number; at: string; by: string } | null> {
  const rows = (await sql`
    select actor_email, created_at, details
    from public.admin_audit_log
    where action = ${UPDATE_PROPOSE_ACTION}
      and target_id = ${tag}
      and details->>'repositoryId' = ${String(repositoryId)}
    order by created_at desc
    limit 1
  `) as unknown as { actor_email: string; created_at: Date | string; details: Record<string, unknown> }[];
  const row = rows[0];
  const number = Number(row?.details.pullRequest);
  if (!row || !Number.isSafeInteger(number) || number <= 0) return null;
  return { number, at: new Date(row.created_at).toISOString(), by: row.actor_email };
}

/**
 * What the release notice offers under `notice`, from what is stored: null,
 * and the notice stays as rank 22 built it, on a checkout, with the App off,
 * nothing linked, or the link off. Otherwise the button (a fork of upstream),
 * the merge by hand (any other repository), or the pull request this instance
 * already opened for the release. `evenIfProposed` skips that last answer:
 * Admin > GitHub, which can see that the recorded pull request is no longer
 * open, offers the button again.
 */
export async function mixosUpdateOffer(
  notice: Pick<ReleaseNotice, "tag" | "commitSha">,
  options: { evenIfProposed?: boolean } = {},
): Promise<UpdateOffer | null> {
  if (!isBuiltDeployment() || featureRefusal() || !isReleaseTag(notice.tag)) return null;
  let state: GitHubState;
  try {
    state = await readGitHubState();
  } catch {
    // A record that can't be read: Admin > GitHub says so.
    return null;
  }
  if (!state.app || !state.link || state.link.disabled) return null;
  const record = state.link.repository;
  const repository = fullName(record);
  const tag = notice.tag;
  const compareUrl = upstreamCompareUrl(thisBuildRef(), tag);

  if (!isForkOfUpstream(record)) {
    return { kind: "copy", tag, repository, compareUrl, command: mergeCommand(tag) };
  }
  if (!options.evenIfProposed) {
    const proposed = await recordedProposal(record.id, tag);
    if (proposed) {
      return {
        kind: "proposed",
        tag,
        repository,
        number: proposed.number,
        url: `${repositoryUrl(record.owner, record.name)}/pull/${proposed.number}`,
        at: proposed.at,
        by: proposed.by,
      };
    }
  }
  return {
    kind: "fork",
    tag,
    commitSha: notice.commitSha,
    repository,
    defaultBranch: record.defaultBranch,
    branch: updateBranch(tag),
    title: updateTitle(tag),
    off: offReason(state),
    compareUrl,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading GitHub                                                              */
/* -------------------------------------------------------------------------- */

/** A compare answer, or the message GitHub's refusal or a bad answer left. */
type Compared = { answer: Compare } | { problem: string };

/**
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` on the linked
 * repository. `base` and `head` are a commit, a branch, or `owner:ref` for a
 * repository in the same fork network; GitHub takes the whole as one path
 * segment, percent-encoded, which is how ./repository.ts sends it.
 */
async function compare(repo: LinkedRepository, base: string, head: string): Promise<Compared> {
  try {
    const data = await repo.get(`/compare/${segment(`${base}...${head}`)}`);
    return { answer: parseAnswer(CompareSchema, data, "GET /repos/{owner}/{repo}/compare/{basehead}") };
  } catch (err) {
    if (err instanceof GitHubError) return { problem: err.message };
    throw err;
  }
}

/** What step 2 read for an update. */
interface UpdateInspection extends DefaultBranchInspection {
  /** `<commit>...mixoshq:<tag>`. */
  tagCompare: Compared;
  /** `mixoshq:main...<commit>`. */
  mainCompare: Compared;
  /** `<default branch>...<commit>`: the pull request's own compare. */
  changes: Compared;
  /** `mixos/update-<tag>`, when it exists: its head, and the open pull request from it, if any. */
  existing: { head: string; pull: number | null } | null;
}

/** The open pull request from `branch` into the default branch, in this repository, or null. */
async function openPullFrom(repo: LinkedRepository, branch: string): Promise<number | null> {
  const record = repo.record;
  const pulls = parseAnswer(
    PullRequestListSchema,
    await repo.get("/pulls", new URLSearchParams({ state: "open", head: `${record.owner}:${branch}`, per_page: "100" })),
    "GET /repos/{owner}/{repo}/pulls",
  );
  const open = pulls.find(
    (p) => p.head.ref === branch && p.head.repo?.id === record.id && p.base.ref === record.defaultBranch,
  );
  return open?.number ?? null;
}

async function inspect(repo: LinkedRepository, branch: string, release: CoreRelease, onVercel: boolean): Promise<UpdateInspection> {
  const base = await inspectDefaultBranch(repo, branch, onVercel);
  const sha = release.commitSha;
  const tagCompare = await compare(repo, sha, `${UPSTREAM_REPOSITORY.owner}:${release.tag}`);
  const mainCompare = await compare(repo, `${UPSTREAM_REPOSITORY.owner}:${UPSTREAM_REPOSITORY.defaultBranch}`, sha);
  const changes = await compare(repo, repo.record.defaultBranch, sha);
  const head = await branchHead(repo, branch);
  const existing = head === null ? null : { head, pull: await openPullFrom(repo, branch) };
  return { ...base, tagCompare, mainCompare, changes, existing };
}

/* -------------------------------------------------------------------------- */
/*  Judging what was read                                                       */
/* -------------------------------------------------------------------------- */

const isWorkflowPath = (path: string | undefined) => path !== undefined && /^\.github\/workflows\//.test(path);
const isPlatformMigration = (path: string) => /^supabase\/migrations\/[^/]+\.sql$/.test(path);

/** The files the release changes under `.github/workflows/`, by either name. */
function workflowFiles(answer: Compare): string[] {
  return [
    ...new Set(
      (answer.files ?? []).flatMap((f) => [f.filename, f.previous_filename].filter(isWorkflowPath) as string[]),
    ),
  ].sort();
}

/** A line, with the refusal code and tone it carries when it doesn't hold. */
interface UpdateLine extends ProposalCheckLine {
  code?: string;
  tone?: "info" | "warning" | "danger";
}

/** The lines, in the order a refusal names them. */
function judge(
  inspection: UpdateInspection,
  state: GitHubState,
  release: CoreRelease,
  branch: string,
  onVercel: boolean,
): UpdateLine[] {
  const lines: UpdateLine[] = judgeDefaultBranch(inspection, state, onVercel);
  const short = release.commitSha.slice(0, 12);
  const defaultBranch = inspection.rules.branch;
  const unconfirmed = (what: string, problem: string): UpdateLine => ({
    id: "tag",
    ok: false,
    label: what,
    detail: `GitHub couldn't confirm it: ${problem} Upstream is private, or the App can't see it, so merge the release by hand.`,
    code: "unverified",
    tone: "warning",
  });

  // 6. Upstream's tag is at the release list's commit.
  if ("problem" in inspection.tagCompare) {
    lines.push(unconfirmed("Upstream's tag", inspection.tagCompare.problem));
  } else {
    const { status, merge_base_commit } = inspection.tagCompare.answer;
    const ok = status === "identical" && merge_base_commit.sha === release.commitSha;
    lines.push({
      id: "tag",
      ok,
      label: "Upstream's tag",
      detail: ok
        ? `GitHub compared commit ${short} with ${UPSTREAM}'s tag ${release.tag}: identical.`
        : `GitHub compared commit ${short} with ${UPSTREAM}'s tag ${release.tag}: ${status}, not identical. The release ` +
          "list and upstream disagree about where the release is, so nothing was written. Merge the release by hand, " +
          "from upstream's own tag.",
      code: "tag-mismatch",
      tone: "danger",
    });
  }

  // 7. The commit is on upstream's main.
  if ("problem" in inspection.mainCompare) {
    lines.push({ ...unconfirmed("On upstream's main", inspection.mainCompare.problem), id: "main" });
  } else {
    const { status, merge_base_commit } = inspection.mainCompare.answer;
    const ok = (status === "behind" || status === "identical") && merge_base_commit.sha === release.commitSha;
    lines.push({
      id: "main",
      ok,
      label: "On upstream's main",
      detail: ok
        ? `Commit ${short} is on ${UPSTREAM}'s ${UPSTREAM_REPOSITORY.defaultBranch}.`
        : `Commit ${short} isn't on ${UPSTREAM}'s ${UPSTREAM_REPOSITORY.defaultBranch} (GitHub says ${status}), so it isn't ` +
          "a release of MixOS as the list claims. Nothing was written.",
      code: "not-on-main",
      tone: "danger",
    });
  }

  // 8. What the release changes here: GitHub's numbers, no workflow, and not merged already.
  if ("problem" in inspection.changes) {
    lines.push({ ...unconfirmed("What it changes", inspection.changes.problem), id: "changes" });
  } else {
    const answer = inspection.changes.answer;
    const files = answer.files ?? [];
    const workflows = workflowFiles(answer);
    const merged = answer.status === "identical" || answer.status === "behind";
    const tooMany = files.length >= COMPARE_FILES_CAP;
    const numbers = `${count(answer.ahead_by, "commit")} ahead of ${defaultBranch}, ${answer.behind_by} behind, ${count(files.length, "file")} changed.`;
    lines.push({
      id: "changes",
      ok: !merged && !tooMany && workflows.length === 0,
      label: "What it changes",
      detail: merged
        ? `${defaultBranch} already has ${release.tag}'s commit. Deploy it, or wait for the deploy to finish.`
        : tooMany
          ? `${numbers} GitHub lists at most ${COMPARE_FILES_CAP} files, so the check can't see whether a workflow ` +
            "changes. Merge the release by hand."
          : workflows.length > 0
            ? `${numbers} It changes ${workflows.map((f) => `\`${f}\``).join(", ")}, which the App can't push: it has no ` +
              "workflows permission. Merge the release by hand."
            : `${numbers} No workflow changes.`,
      code: merged ? "already-merged" : tooMany ? "too-many-files" : "workflows-changed",
      tone: "info",
      ...(workflows.length > 0 ? { findings: workflows.map((file) => ({ file, problem: "changes in this release." })) } : {}),
    });
  }

  // 9. The branch.
  const existing = inspection.existing;
  const open = existing !== null && existing.pull !== null;
  lines.push({
    id: "branch",
    ok: existing === null,
    label: "Branch",
    detail:
      existing === null
        ? `${branch} doesn't exist yet.`
        : open
          ? `${branch} already exists, and pull request #${existing.pull} is open from it.`
          : `${branch} already exists, with no open pull request. Open one from it on GitHub, or delete the branch and try again.`,
    code: open ? "pull-request-open" : "branch-exists",
    tone: open ? "info" : "warning",
  });
  return lines;
}

/** The first line that doesn't hold, as a refusal, or null. */
function refusalFor(
  lines: UpdateLine[],
  inspection: UpdateInspection,
  record: RepositoryRecord,
  tag: string,
  branch: string,
): ProposalRefusal | null {
  const failed = lines.find((l) => !l.ok);
  if (!failed) return null;
  const repository = fullName(record);
  const base = repositoryUrl(record.owner, record.name);
  const links: OutcomeLink[] = [];
  const details: Record<string, unknown> = {};
  let code = failed.code ?? failed.id;
  let tone: "info" | "warning" | "danger" = failed.tone ?? "danger";
  let message: string;

  switch (failed.id) {
    case "rule":
      code = "branch-rule";
      tone = "warning";
      message = `Not opened. ${failed.detail}`;
      break;
    case "checklist":
      tone = "warning";
      message = `Not opened. ${failed.detail}`;
      break;
    case "workflows":
    case "render":
    case "vercel": {
      const findings = lines.flatMap((l) => l.findings ?? []);
      const named = findings.length > 0 ? ` ${findings.map((f) => `\`${f.file}\` ${f.problem}`).join(" ")}` : "";
      message = `Not opened: something in ${repository} would build the branch with secrets.${named} ${failed.detail}`;
      details.files = [...new Set(findings.map((f) => f.file))];
      break;
    }
    case "tag":
    case "main":
    case "changes":
      message = `Not opened. ${failed.detail}`;
      links.push(...compareLinks(tag));
      if ("answer" in inspection.tagCompare) details.tagCompare = inspection.tagCompare.answer.status;
      else details.tagCompare = inspection.tagCompare.problem;
      if ("answer" in inspection.mainCompare) details.mainCompare = inspection.mainCompare.answer.status;
      else details.mainCompare = inspection.mainCompare.problem;
      if (failed.findings) details.files = failed.findings.map((f) => f.file);
      break;
    case "branch": {
      const existing = inspection.existing!;
      details.branchHead = existing.head;
      if (existing.pull !== null) {
        message = `Pull request #${existing.pull} is already open for ${tag}.`;
        links.push({ label: `Pull request #${existing.pull}`, href: `${base}/pull/${existing.pull}` });
        details.pullRequest = existing.pull;
      } else {
        message = `Not opened. ${failed.detail}`;
        links.push({ label: "The branch on GitHub", href: `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}` });
      }
      break;
    }
    default:
      message = `Not opened. ${failed.detail}`;
  }
  return new ProposalRefusal(
    {
      ok: false,
      code,
      message: message.replace(/\s+/g, " ").trim(),
      tone,
      ...(links.length > 0 ? { links } : {}),
      ...(failed.findings ? { findings: failed.findings } : {}),
    },
    details,
  );
}

/* -------------------------------------------------------------------------- */
/*  Proposing                                                                   */
/* -------------------------------------------------------------------------- */

const InputSchema = z.object({ tag: z.string().max(64).refine(isReleaseTag) });

/** What stops an update before anything is read, or null. */
function precondition(tag: string) {
  if (!isBuiltDeployment()) {
    return refused("checkout", `This is a checkout. Merge the release here: ${mergeCommand(tag)}.`, "info");
  }
  return featureRefusal();
}

/** The release on record for `tag`: the one whose commit is used, newer than this build. */
async function releaseOnRecord(tag: string): Promise<CoreRelease> {
  const state = await readReleaseCheckState();
  const latest = state?.latest ?? null;
  if (!latest || latest.tag !== tag) {
    throw new ProposalRefusal(
      refused("stale", `${tag} isn't the release on record any more. Reload the page: the release check may have found a newer one.`, "info"),
    );
  }
  if (!onChannel(latest, releaseChannel())) {
    throw new ProposalRefusal(refused("channel", `${tag} isn't on this instance's release channel.`, "info"));
  }
  const current = mixosVersion();
  if (compareRelease(tag, current)?.order !== "newer") {
    throw new ProposalRefusal(
      refused("not-newer", `This instance runs ${current}, which isn't older than ${tag}, so there is nothing to update.`, "info"),
    );
  }
  return latest;
}

/** What step 3 made. */
interface Opened {
  number: number;
  url: string;
  head: string;
}

/** Step 3, with a write token scoped to the one ref at the one commit. */
async function write(
  repo: LinkedRepository,
  branch: string,
  sha: string,
  title: string,
  body: string,
  lease: { assertHeld(): Promise<void> },
): Promise<Opened> {
  const record = repo.record;
  const base = repositoryUrl(record.owner, record.name);
  const branchUrl = `${base}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
  /** A refusal once the branch may be on GitHub: say so, and how to finish or undo it. */
  const leftBranch = (what: string, created: boolean | "unknown") =>
    new ProposalRefusal(
      refused(
        "pull-request",
        `${what}. Look for ${branch} on GitHub: open a pull request from it if there isn't one, or delete it and try again.`,
        "danger",
        [{ label: "The branch on GitHub", href: branchUrl }],
      ),
      { branchCreated: created, branch, head: sha },
    );
  const unsure = (err: unknown) =>
    err instanceof GitHubError && (err.failure === "malformed" || err.failure === "unreachable");

  await lease.assertHeld();
  let ref;
  try {
    ref = parseAnswer(GitRefSchema, await repo.post("/git/refs", { ref: `refs/heads/${branch}`, sha }), "POST /repos/{owner}/{repo}/git/refs");
  } catch (err) {
    if (unsure(err)) throw leftBranch("GitHub's answer to creating the branch didn't come back whole", "unknown");
    throw err;
  }
  if (ref.object.sha !== sha) throw leftBranch("GitHub put the branch at another commit", true);

  let pull;
  try {
    await lease.assertHeld();
    pull = parseAnswer(
      PullRequestSchema,
      await repo.post("/pulls", { title, head: branch, base: record.defaultBranch, body }),
      "POST /repos/{owner}/{repo}/pulls",
    );
  } catch (err) {
    throw leftBranch(
      err instanceof GitHubError
        ? `The branch was created, but GitHub didn't confirm the pull request (${err.message.replace(/[.\s]+$/, "")})`
        : "The branch was created, but the pull request wasn't opened",
      true,
    );
  }
  if (pull.head.ref !== branch || pull.base.ref !== record.defaultBranch || pull.head.sha !== sha) {
    throw new GitHubError(`GitHub's pull request #${pull.number} isn't the one asked for. Look at it on GitHub.`, "malformed");
  }
  return { number: pull.number, url: `${base}/pull/${pull.number}`, head: sha };
}

/**
 * Open an update pull request for the release on record: the module
 * comment's four steps. Answers with the pull request, or why not; either way
 * audited.
 */
export async function proposeMixOSUpdate(input: unknown, ctx: ProposeContext): Promise<UpdateOutcome> {
  const actor = await ctx.admin();
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return refused("input", "That isn't a release tag.");
  const { tag } = parsed.data;
  const blocked = precondition(tag);
  if (blocked) {
    await rejected(actor, tag, null, blocked, {});
    return blocked;
  }

  let commitSha: string | null = null;
  try {
    return await locked(async (lease) => {
      const state = await readGitHubState();
      if (!state.app || !state.link) {
        throw new ProposalRefusal(refused("not-linked", "Link a repository on Admin > GitHub first.", "info"));
      }
      if (state.link.disabled) {
        throw new ProposalRefusal(
          refused("disabled", `The GitHub link is off: ${state.link.disabled.detail} Check again on Admin > GitHub.`, "danger"),
        );
      }
      const record = state.link.repository;
      const repository = fullName(record);

      // 1. From what is stored.
      const release = await releaseOnRecord(tag);
      commitSha = release.commitSha;
      if (!isForkOfUpstream(record)) {
        throw new ProposalRefusal(
          refused(
            "not-a-fork",
            `${repository} isn't a fork of ${UPSTREAM}, so the App can't open an update pull request. Merge the release by ` +
              `hand: ${mergeCommand(tag)}.`,
            "info",
            compareLinks(tag),
          ),
        );
      }
      if (!state.previewChecklist) {
        throw new ProposalRefusal(
          refused(
            "checklist",
            "Not opened. Confirm on Admin > GitHub that no host builds previews of the App's branches. The App can't " +
              "read those settings.",
            "warning",
          ),
        );
      }
      const branch = updateBranch(tag);
      const title = updateTitle(tag);
      const onVercel = thisHost() === "vercel";

      // 2. GitHub, read.
      const inspection = await withLinkedRepository("read", actor, (repo) => inspect(repo, branch, release, onVercel), ctx);
      await lease.assertHeld();
      await saveBranchRule(ruleRecord(record, inspection.rules, nowOf(ctx)));
      const lines = judge(inspection, state, release, branch, onVercel);
      const refusal = refusalFor(lines, inspection, record, tag, branch);
      if (refusal) throw refusal;
      if ("problem" in inspection.changes) throw new GitHubError(inspection.changes.problem, "malformed");
      const changes = inspection.changes.answer;
      const files = changes.files ?? [];
      const compared: UpdateCompare = {
        ahead: changes.ahead_by,
        behind: changes.behind_by,
        commits: changes.total_commits,
        files: files.length,
      };
      const migrations = files.filter((f) => f.status !== "removed" && isPlatformMigration(f.filename)).length;
      const body = updateBody({
        tag,
        commitSha: release.commitSha,
        publishedAt: release.publishedAt,
        notes: release.notes,
        current: mixosVersion(),
        repository,
        defaultBranch: record.defaultBranch,
        compare: compared,
        migrations,
        host: thisHost(),
        releaseUrl: releasePageUrl(tag) ?? UPGRADE_GUIDE_URL,
        upgradeUrl: UPGRADE_GUIDE_URL,
      });

      // 3. The two writes, scoped to that ref at that commit.
      const opened = await withLinkedRepository(
        "write",
        actor,
        (repo) => write(repo, branch, release.commitSha, title, body, lease),
        { ...ctx, scope: { refOnly: { branch, sha: release.commitSha } } },
      );

      // 4. The record.
      await recordAdminAction(actor, {
        action: UPDATE_PROPOSE_ACTION,
        targetType: TARGET_TYPE,
        targetId: tag,
        details: {
          repositoryId: record.id,
          repository,
          pullRequest: opened.number,
          url: opened.url,
          branch,
          head: opened.head,
          base: record.defaultBranch,
          baseCommit: inspection.head,
          tag,
          commitSha: release.commitSha,
          version: tag.slice(1),
          from: mixosVersion(),
          compare: compared,
          migrations,
          branchRule: inspection.rules.pullRequest ? "rule" : "override",
          previewChecklistAt: state.previewChecklist.at,
        },
      });
      return {
        ok: true,
        message:
          `Opened pull request #${opened.number} on ${repository}: ${tag}, ${count(compared.ahead, "commit")} ahead of ` +
          `${record.defaultBranch}. Its checks run there. Merging it is the deploy; nothing here merges.`,
        links: [{ label: `Pull request #${opened.number}`, href: opened.url }],
        pullRequest: { number: opened.number, url: opened.url, branch, head: opened.head },
        compare: compared,
      };
    });
  } catch (err) {
    const outcome = describe(err);
    await rejected(actor, tag, commitSha, outcome, err instanceof ProposalRefusal ? err.details : {});
    return outcome;
  }
}

async function rejected(
  actor: AdminActor,
  tag: string,
  commitSha: string | null,
  outcome: Extract<UpdateOutcome, { ok: false }>,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAdminAction(actor, {
    action: UPDATE_REJECTED_ACTION,
    targetType: TARGET_TYPE,
    targetId: tag,
    details: {
      reason: outcome.code,
      message: outcome.message,
      tag,
      commitSha,
      from: mixosVersion(),
      ...details,
    },
  });
}
