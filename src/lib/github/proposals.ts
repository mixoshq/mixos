/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The App's open pull requests, with what their checks say, for Admin > Apps,
 * Connectors and Themes, beside the installs waiting there.
 *
 * Read with a read token, on every render of the page: the pull requests open
 * from a branch the App names (`mixos/install/<kind>-<slug>`, `mixos/update/…`
 * or `mixos/remove/…`, or for a MixOS update `mixos/update-<tag>`, ./names.ts),
 * in the linked repository, into its default branch. Each is joined to the
 * `<kind>.propose` audit row (for a MixOS update, `mixos.update.propose`) that
 * recorded the commit the App made and what it proposed, and two things are
 * said plainly:
 *
 *   - "No CI ran", in the danger tone, when nothing has checked the head
 *     commit ten minutes after it arrived. With GitHub Actions off for the
 *     repository (GitHub keeps it off on a new fork until its owner turns it
 *     on), nothing runs at all, and a pull request with no checks looks like
 *     one still waiting.
 *   - "Changed since proposed", when the head isn't the commit the App made:
 *     anyone who can push to the repository can add a commit to the branch
 *     after the App opens the pull request, and what was verified is the App's
 *     commit, not theirs.
 *
 * Nothing here writes, and nothing is taken from a response to build a link:
 * links are built from the stored repository and the pull request's number.
 */

import type { AdminActor } from "@/lib/apps/admin-audit";
import { sql } from "@/lib/db/client";
import { GitHubError } from "./api";
import { GitHubLinkError, featureRefusal, withLinkedRepository } from "./link";
import { repositoryUrl } from "./manifest";
import { parseProposalBranch, type ProposalAction } from "./names";
import type { ProposalKind, ProposalsView, ProposedPullRequest } from "./outcomes";
import {
  CheckRunsSchema,
  CombinedStatusSchema,
  PullRequestListSchema,
  Sha,
  parseAnswer,
  type CheckRuns,
  type CombinedStatus,
} from "./schemas";
import { readGitHubState } from "./store";

/** How long a head commit may wait for its first check before "No CI ran". */
export const NO_CI_AFTER_MS = 10 * 60 * 1000;

/** Pull requests listed per page; the rest are counted. Each costs two requests. */
const MAX_LISTED = 20;

/** Check run conclusions that mean it didn't pass. */
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/**
 * What the checks on a head commit say. `since` is when the head arrived: the
 * proposal, for the App's own commit. A check run that was skipped counts as
 * nothing having run.
 */
export function ciState(runs: CheckRuns, status: CombinedStatus, since: Date, now: Date): ProposedPullRequest["ci"] {
  const counted = runs.check_runs.filter((r) => !(r.status === "completed" && r.conclusion === "skipped"));
  const uncounted = Math.max(0, runs.total_count - runs.check_runs.length);
  const statuses = status.statuses;

  const failed =
    counted.some((r) => r.status === "completed" && FAILED.has(r.conclusion ?? "")) ||
    statuses.some((s) => s.state === "failure" || s.state === "error");
  if (failed) {
    return {
      state: "failed",
      label: "Checks failed",
      tone: "danger",
      detail: "A check failed on its head commit. Read it on GitHub before you merge.",
    };
  }
  if (counted.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending")) {
    return { state: "running", label: "Checks running", tone: "neutral", detail: "Its checks are still running." };
  }
  if (counted.length > 0 || statuses.length > 0 || uncounted > 0) {
    return { state: "passed", label: "Checks passed", tone: "success", detail: "Every check on its head commit passed." };
  }
  if (now.getTime() - since.getTime() >= NO_CI_AFTER_MS) {
    return {
      state: "none",
      label: "No CI ran",
      tone: "danger",
      detail:
        "Nothing has checked its head commit in ten minutes. Check that GitHub Actions is on for the repository. " +
        "Don't merge it unchecked.",
    };
  }
  return { state: "waiting", label: "Waiting for CI", tone: "neutral", detail: "Its checks haven't started yet." };
}

/** What a `<kind>.propose` row recorded about one pull request. */
interface Proposed {
  head: string;
  branch: string;
  slug: string;
  version: string | null;
  at: string;
  by: string;
}

/** The audit action that records a proposal of `kind`. */
export function proposeAction(kind: ProposalKind): string {
  return kind === "mixos" ? "mixos.update.propose" : `${kind}.propose`;
}

/**
 * The latest `<kind>.propose` row for each of `numbers` in the repository with
 * id `repositoryId`, by pull request number.
 */
async function proposedRows(kind: ProposalKind, repositoryId: number, numbers: number[]): Promise<Map<number, Proposed>> {
  const found = new Map<number, Proposed>();
  if (numbers.length === 0) return found;
  const rows = (await sql`
    select target_id, actor_email, created_at, details
    from public.admin_audit_log
    where action = ${proposeAction(kind)}
      and details->>'repositoryId' = ${String(repositoryId)}
      and details->>'pullRequest' = any(${numbers.map(String)})
    order by created_at desc
    limit 200
  `) as unknown as { target_id: string | null; actor_email: string; created_at: Date | string; details: Record<string, unknown> }[];
  for (const row of rows) {
    const number = Number(row.details.pullRequest);
    const head = Sha.safeParse(row.details.head);
    if (found.has(number) || !head.success || typeof row.details.branch !== "string" || !row.target_id) continue;
    found.set(number, {
      head: head.data,
      branch: row.details.branch,
      slug: row.target_id,
      version: typeof row.details.version === "string" ? row.details.version : null,
      at: new Date(row.created_at).toISOString(),
      by: row.actor_email,
    });
  }
  return found;
}

/** The branch's slug, or for a MixOS update its tag, and what it proposes, when the branch proposes `kind`. */
function proposalOf(kind: ProposalKind, ref: string): { slug: string; action: ProposalAction } | null {
  const branch = parseProposalBranch(ref);
  if (!branch) return null;
  if (kind === "mixos") return branch.action === "mixos-update" ? { slug: branch.tag, action: branch.action } : null;
  return branch.action !== "mixos-update" && branch.kind === kind ? { slug: branch.slug, action: branch.action } : null;
}

/**
 * The App's open pull requests for `kind`, with their checks. `actor` is the
 * admin looking: a check that finds the installation widened switches the
 * link off, audited against them (./link.ts).
 */
export async function readProposals(actor: AdminActor, kind: ProposalKind, now: Date = new Date()): Promise<ProposalsView> {
  if (featureRefusal()) return { state: "off" };
  let record;
  try {
    const state = await readGitHubState();
    if (!state.app || !state.link) return { state: "off" };
    record = state.link.repository;
  } catch {
    return { state: "off" };
  }
  const base = repositoryUrl(record.owner, record.name);

  try {
    return await withLinkedRepository("read", actor, async (repo) => {
      const pulls = parseAnswer(
        PullRequestListSchema,
        await repo.get(
          "/pulls",
          new URLSearchParams({ state: "open", sort: "created", direction: "desc", per_page: "100" }),
        ),
        "GET /repos/{owner}/{repo}/pulls",
      );
      const ours = pulls.flatMap((pull) => {
        const branch = proposalOf(kind, pull.head.ref);
        const sameRepository = pull.head.repo?.id === repo.record.id;
        if (!branch || !sameRepository || pull.base.ref !== repo.record.defaultBranch) return [];
        return [{ pull, ...branch }];
      });
      const listed = ours.slice(0, MAX_LISTED);
      const proposed = await proposedRows(kind, repo.record.id, listed.map((o) => o.pull.number));

      const items: ProposedPullRequest[] = [];
      for (const { pull, slug, action } of listed) {
        const sha = pull.head.sha;
        const [runs, status] = await Promise.all([
          repo.get(`/commits/${sha}/check-runs`, new URLSearchParams({ per_page: "100" })),
          repo.get(`/commits/${sha}/status`),
        ]);
        const row = proposed.get(pull.number);
        // The branch's name says what it proposes, so a row for it does too.
        const recorded = row !== undefined && row.branch === pull.head.ref && row.slug === slug;
        const changed = recorded && row.head !== sha;
        const since = recorded && !changed ? new Date(row.at) : new Date(pull.updated_at);
        items.push({
          number: pull.number,
          url: `${base}/pull/${pull.number}`,
          kind,
          slug,
          action,
          branch: pull.head.ref,
          version: recorded ? row.version : null,
          proposedAt: recorded ? row.at : null,
          proposedBy: recorded ? row.by : null,
          unrecorded: !recorded,
          changed,
          ci: ciState(
            parseAnswer(CheckRunsSchema, runs, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs"),
            parseAnswer(CombinedStatusSchema, status, "GET /repos/{owner}/{repo}/commits/{ref}/status"),
            Number.isNaN(since.getTime()) ? now : since,
            now,
          ),
        });
      }
      return {
        state: "ok",
        repository: `${repo.record.owner}/${repo.record.name}`,
        repositoryUrl: base,
        pulls: items,
        more: ours.length - listed.length,
      };
    });
  } catch (err) {
    if (err instanceof GitHubLinkError) return { state: "unavailable", message: err.outcome.message };
    if (err instanceof GitHubError) {
      return { state: "unavailable", message: `The App's pull requests couldn't be read from GitHub. ${err.message}` };
    }
    console.error(`[github] Reading pull requests: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`);
    return { state: "unavailable", message: "The App's pull requests couldn't be read. The server log says why." };
  }
}
