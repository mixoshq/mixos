/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from "path";
import { appRegistry } from "@/generated/app-registry";
import { registryInstalls } from "@/generated/registry-installs";
import { sql } from "@/lib/db/client";
import { recordAdminAction, type AdminActor } from "@/lib/apps/admin-audit";
import { githubSourceUrl, type RegistryInstall } from "@/lib/repository/install-record";
import { sourceHost } from "@/lib/repository/provenance";
import { describeIdentity, parseIdentity } from "@/lib/repository/identity";
import { appCodeHash } from "../../../scripts/app-code-hash";

/**
 * Trust tiers for apps: an app installed from a Registry runs only once an
 * admin of this instance has reviewed the exact code it runs.
 *
 * Two tiers. **Local** apps, with no install record (`.registry.json`), are
 * the ones you wrote or copied here, and nothing changes for them. **Third-
 * party** apps, installed from a Registry, are someone else's code:
 *
 *   - Activate refuses one until a review here matches its code hash
 *     (`setAppActive`, ./access.ts). The check is on the server; the button
 *     is a convenience.
 *   - The release step switches an active one off, and flags it, when its code
 *     no longer matches a review (scripts/sync-app-registry.ts): an update, a
 *     local edit, or the first release after this shipped.
 *
 * The code hash is the release step's (scripts/app-code-hash.ts), over the
 * app's folder as deployed, so a review counts for exactly that code, local
 * edits included. Read from the folder at the moment of the review and of
 * Activate, which every host carries (`outputFileTracingIncludes`,
 * next.config.ts), falling back to the hash the release step recorded.
 *
 * What a review is: an admin's record that they read what the app declares
 * and where it came from, and accept it. It doesn't make the code safe; the
 * runtime isolation does what it can either way (docs/threat-model.md).
 */

/** Where an app's folder is on this server: the project root under every host. */
function appDir(slug: string): string {
  return path.join(process.cwd(), "apps", slug);
}

/** The app's install record in this build, or null for a local app. */
export function registryInstallOf(slug: string): RegistryInstall | null {
  return registryInstalls.find((i) => i.kind === "app" && i.slug === slug) ?? null;
}

/**
 * The hash of the code the app runs: its folder as deployed, or, when the
 * folder can't be read here, what the release step recorded. Null when
 * neither is known, which no review matches.
 */
export async function currentCodeHash(slug: string): Promise<string | null> {
  const live = appCodeHash(appDir(slug));
  if (live) return live;
  const [row] = await sql<{ code_hash: string | null }[]>`
    select code_hash from public.apps where slug = ${slug}
  `;
  return row?.code_hash ?? null;
}

/** Whether a review here matches `codeHash`. */
export async function isReviewed(slug: string, codeHash: string | null): Promise<boolean> {
  if (!codeHash) return false;
  const rows = await sql`
    select 1 from public.app_reviews where app_slug = ${slug} and code_hash = ${codeHash}
  `;
  return rows.length > 0;
}

/** Thrown when a Registry app is activated without a review of its code. */
export class UnreviewedAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreviewedAppError";
  }
}

/** "mixos.org · acme/mixos-files · 1.2.0", the line the tile's pill explains. */
export function provenanceText(install: RegistryInstall): string {
  return `${sourceHost(install.source)} · ${install.repository.owner}/${install.repository.name} · ${install.version}`;
}

/**
 * Where a third-party app came from, in words, or null for a local app. The
 * build's install record first; then the identity the release step recorded,
 * so a server that hasn't reloaded its generated files since an app was
 * registered still counts it as third-party. A recorded identity this version
 * can't read counts as third-party too: fails closed.
 */
async function thirdPartySource(slug: string): Promise<{ text: string; modified: boolean } | null> {
  const install = registryInstallOf(slug);
  if (install) return { text: provenanceText(install), modified: install.modified };
  const [row] = await sql<{ identity: string | null }[]>`select identity from public.apps where slug = ${slug}`;
  if (!row?.identity) return null;
  const parsed = parseIdentity(row.identity);
  if (parsed?.local) return null;
  return {
    text: parsed ? describeIdentity(row.identity).replace(/^from /, "") : "a source this version can't read",
    modified: false,
  };
}

/**
 * Refuse to activate a third-party app with no review of its code. Nothing
 * for a local app. Fails closed: a code hash that can't be worked out matches
 * no review.
 */
export async function assertReviewedForActivation(slug: string): Promise<void> {
  const source = await thirdPartySource(slug);
  if (!source) return;
  const hash = await currentCodeHash(slug);
  if (await isReviewed(slug, hash)) return;
  const name = appRegistry.find((a) => a.slug === slug)?.name ?? slug;
  throw new UnreviewedAppError(
    `${name} is from ${source.text}, and nobody here has reviewed the code it runs` +
      `${source.modified ? ", which has been changed since it was installed" : ""}. Review it, then activate it.`,
  );
}

/** What the admin pages show about one app's trust tier. Null for a local app. */
export interface AppTrust {
  /** "mixos.org · acme/mixos-files · 1.2.0". */
  provenance: string;
  version: string;
  commitSha: string;
  /** The release's source on GitHub, at its commit, when the record says where. */
  sourceUrl: string | null;
  /** Its files have changed since it was installed. */
  modified: boolean;
  /** The hash of the code it runs now, or null when it can't be worked out. */
  codeHash: string | null;
  /** A review here matches that code. */
  reviewed: boolean;
  /** When, and by whom, for the matching review. */
  reviewedAt: string | null;
  reviewedBy: string | null;
  /** Some earlier code of it was reviewed here, and this isn't: "Updated, needs review". */
  previouslyReviewed: boolean;
  /** When the release step switched it off for want of a review. */
  reviewNeededSince: string | null;
}

/** Each Registry app's trust, by slug. Local apps aren't in the map. */
export async function getAppTrust(slugs: readonly string[]): Promise<Record<string, AppTrust>> {
  const out: Record<string, AppTrust> = {};
  const third = slugs.filter((slug) => registryInstallOf(slug));
  if (third.length === 0) return out;
  const reviews = await sql<
    { app_slug: string; code_hash: string; reviewed_at: Date; display_name: string | null }[]
  >`
    select r.app_slug, r.code_hash, r.reviewed_at, u.display_name
      from public.app_reviews r
      left join public.users u on u.id = r.reviewed_by
     where r.app_slug = any(${third}::text[])
  `;
  const flags = await sql<{ slug: string; review_needed_since: Date | null }[]>`
    select slug, review_needed_since from public.apps where slug = any(${third}::text[])
  `;
  for (const slug of third) {
    const install = registryInstallOf(slug)!;
    const codeHash = await currentCodeHash(slug);
    const mine = reviews.filter((r) => r.app_slug === slug);
    const match = codeHash ? mine.find((r) => r.code_hash === codeHash) : undefined;
    out[slug] = {
      provenance: provenanceText(install),
      version: install.version,
      commitSha: install.commitSha,
      sourceUrl: githubSourceUrl(install.repository, install.commitSha, install.repository.subpath),
      modified: install.modified,
      codeHash,
      reviewed: match !== undefined,
      reviewedAt: match ? match.reviewed_at.toISOString() : null,
      reviewedBy: match?.display_name ?? null,
      previouslyReviewed: match === undefined && mine.length > 0,
      reviewNeededSince: flags.find((f) => f.slug === slug)?.review_needed_since?.toISOString() ?? null,
    };
  }
  return out;
}

/**
 * Record the review Register makes (src/lib/repository/register.ts): the
 * admin read what will run and confirmed it before the code was put in place,
 * and Register refuses anything but the files they were shown. So the app's
 * folder, as registered, counts as reviewed, in this checkout's database.
 * Another instance's database has no such row, and its admin reviews it there.
 */
export async function recordRegisteredReview(
  actor: AdminActor,
  opts: { slug: string; root: string; source: string; version: string; commitSha: string },
): Promise<void> {
  const codeHash = appCodeHash(path.join(opts.root, "apps", opts.slug));
  if (!codeHash) return;
  const manifest = appRegistry.find((a) => a.slug === opts.slug);
  await sql.begin(async (tx) => {
    await tx`
      insert into public.apps (slug, name, is_active)
      values (${opts.slug}, ${manifest?.name ?? opts.slug}, false)
      on conflict (slug) do nothing
    `;
    await tx`
      insert into public.app_reviews (app_slug, code_hash, version, commit_sha, source, modified, reviewed_by)
      values (${opts.slug}, ${codeHash}, ${opts.version}, ${opts.commitSha}, ${opts.source}, false, ${actor.id})
      on conflict (app_slug, code_hash) do update
        set reviewed_by = excluded.reviewed_by, reviewed_at = now()
    `;
    await tx`update public.apps set review_needed_since = null where slug = ${opts.slug}`;
  });
  await recordAdminAction(actor, {
    action: "app.review",
    targetType: "app",
    targetId: opts.slug,
    details: { codeHash, version: opts.version, commitSha: opts.commitSha, source: opts.source, via: "register" },
  });
}

/**
 * Record that `actor` reviewed the code a Registry app runs now, and clear its
 * "needs review" flag. Audited as `app.review`, with what was reviewed.
 * Activating it is a separate act.
 */
export async function recordAppReview(actor: AdminActor, slug: string): Promise<AppTrust> {
  const install = registryInstallOf(slug);
  if (!install) throw new Error(`${slug} isn't installed from a Registry, so it has nothing to review.`);
  const manifest = appRegistry.find((a) => a.slug === slug);
  if (!manifest) throw new Error(`${slug} isn't in this build.`);
  const codeHash = await currentCodeHash(slug);
  if (!codeHash) throw new Error(`The code ${manifest.name} runs can't be read here, so it can't be reviewed.`);

  await sql.begin(async (tx) => {
    // The release step makes the row; one registered in this checkout may
    // not have had it run yet. Inactive, as the release step makes it.
    await tx`
      insert into public.apps (slug, name, description, icon, is_active)
      values (${slug}, ${manifest.name}, ${manifest.description ?? null}, ${manifest.icon ?? null}, false)
      on conflict (slug) do nothing
    `;
    await tx`
      insert into public.app_reviews (app_slug, code_hash, version, commit_sha, source, modified, reviewed_by)
      values (${slug}, ${codeHash}, ${install.version}, ${install.commitSha}, ${install.source},
              ${install.modified}, ${actor.id})
      on conflict (app_slug, code_hash) do update
        set reviewed_by = excluded.reviewed_by, reviewed_at = now()
    `;
    await tx`update public.apps set review_needed_since = null where slug = ${slug}`;
  });

  await recordAdminAction(actor, {
    action: "app.review",
    targetType: "app",
    targetId: slug,
    details: {
      codeHash,
      version: install.version,
      commitSha: install.commitSha,
      source: install.source,
      repository: `${install.repository.owner}/${install.repository.name}`,
      modified: install.modified,
    },
  });
  return (await getAppTrust([slug]))[slug];
}
