/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Archive, ArrowUpCircle, ExternalLink, ShieldAlert } from "lucide-react";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { registryInstalls } from "@/generated/registry-installs";
import { themeRegistry } from "@/generated/theme-registry";
import Notice from "@/components/ui/notice";
import { getAppActiveMap } from "@/lib/apps/access";
import { docsUrl } from "@/lib/docs";
import { isBuiltDeployment } from "@/lib/platform/build";
import { repositoryBaseUrl } from "@/lib/repository/client";
import { checkoutRoot } from "@/lib/repository/install";
import { listPendingInstalls } from "@/lib/repository/pending";
import { installEnabled, updateCheckEnabled } from "@/lib/repository/policy";
import type { ExtensionKind } from "@/lib/repository/types";
import { readUpdateCheckState } from "@/lib/repository/update-check";
import { registryNotices, type RegistryNotice, type UpdateCheckState } from "@/lib/repository/updates";
import RegistryNoticeDeactivate from "./registry-notice-deactivate";
import RegistryNoticeUpdate, { RegistryNoticeUpdates } from "./registry-notice-update";

/** The docs section that says exactly what the update check sends, and how to turn it off. */
const WHAT_IS_SENT = docsUrl("security/surface#the-update-check");

/** How to update an extension: in a checkout, then commit and deploy. */
const HOW_TO_UPDATE = docsUrl("operating/hosting#updating-an-extension");

/**
 * What a withdrawn or newer notice offers for updating: the Update button in a
 * checkout; a link to how updating works on a built deployment; a note when an
 * update of it already waits in pending; nothing when installing that kind is
 * off.
 */
type UpdateOffer = "button" | "docs" | "pending" | null;

/** An extension's name as this build has it, for the notices' text. */
function nameOf(kind: ExtensionKind, slug: string): string {
  if (kind === "app") return appRegistry.find((a) => a.slug === slug)?.name ?? slug;
  if (kind === "connector") return connectorRegistry.find((c) => c.name === slug)?.displayName ?? slug;
  return themeRegistry.find((t) => t.slug === slug)?.name ?? slug;
}

/**
 * What the update check found, under the header of Admin > Apps, Connectors
 * and Themes (src/lib/repository/updates.ts says what each notice means):
 *
 *   - a withdrawn release, in the danger tone on all three pages, with
 *     Deactivate for an app that is on, and Update;
 *   - a newer or different current release, with Update, or a listing no
 *     longer published, on its kind's page;
 *   - a folder modified locally, or installed from another catalogue, muted;
 *   - one muted line saying when the catalogue was last asked, linking to what
 *     is sent.
 *
 * Absent when nothing in this build was installed from a Registry. Read on
 * every render, from the build and the stored answer, never from the network:
 * the tick asks the catalogue, and a page waits on nobody. A database that
 * can't be read costs the answer, not the page.
 *
 * Update opens the update dialog, in a checkout. A built deployment has no
 * checkout to change, so its notice links to how updating works instead. The
 * dialog is owned by the wrapper around the list (./registry-notice-update.tsx),
 * because the update's actions revalidate this page and the notice that opened
 * it changes, or goes, while it is open.
 */
export default async function RegistryNotices({ kind }: { kind: ExtensionKind }) {
  if (registryInstalls.length === 0) return null;

  let catalogue: string | null = null;
  try {
    catalogue = repositoryBaseUrl();
  } catch {
    // A bad MIXOS_REPOSITORY_URL, in a checkout. Browse says so.
  }
  const enabled = updateCheckEnabled();

  let state: UpdateCheckState | null = null;
  if (enabled && catalogue && registryInstalls.some((i) => i.source === catalogue)) {
    try {
      state = await readUpdateCheckState();
    } catch (err) {
      console.error("[update-check] could not read the last answer:", err);
    }
  }

  const { notices, status } = registryNotices({
    kind,
    installs: registryInstalls,
    catalogue,
    enabled,
    state,
    nameOf,
    now: new Date(),
  });
  if (notices.length === 0 && !status) return null;

  // Whether each withdrawn app is on, for its Deactivate button. An app with no
  // row yet is off: an app arrives inactive.
  let active: Record<string, boolean> = {};
  if (notices.some((n) => n.type === "withdrawn" && n.kind === "app")) {
    try {
      active = await getAppActiveMap();
    } catch (err) {
      console.error("[update-check] could not read which apps are active:", err);
    }
  }

  // What each notice that can lead to an update offers.
  const built = isBuiltDeployment();
  let pending = new Set<string>();
  if (!built && notices.some((n) => n.type === "withdrawn" || n.type === "newer")) {
    try {
      pending = new Set(listPendingInstalls(checkoutRoot()).map((p) => `${p.kind}/${p.slug}`));
    } catch (err) {
      console.error("[update-check] could not read what is pending:", err);
    }
  }
  const offerFor = (notice: RegistryNotice): UpdateOffer => {
    if (notice.type !== "withdrawn" && notice.type !== "newer") return null;
    if (!installEnabled(notice.kind)) return null;
    if (built) return "docs";
    return pending.has(`${notice.kind}/${notice.slug}`) ? "pending" : "button";
  };

  return (
    <section aria-label="Extensions installed from a Registry" className="mb-6 space-y-3">
      <RegistryNoticeUpdates>
        {notices.map((notice) => (
          <NoticeLine
            key={`${notice.type}:${notice.kind}/${notice.slug}`}
            notice={notice}
            isActive={active[notice.slug] === true}
            offer={offerFor(notice)}
          />
        ))}
      </RegistryNoticeUpdates>
      {status && (
        <p className="text-xs text-muted-foreground">
          {status}{" "}
          <a
            href={WHAT_IS_SENT}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            What&apos;s sent
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </section>
  );
}

function NoticeLine({
  notice,
  isActive,
  offer,
}: {
  notice: RegistryNotice;
  isActive: boolean;
  offer: UpdateOffer;
}) {
  switch (notice.type) {
    case "withdrawn":
      return (
        <Notice tone="danger" icon={<ShieldAlert className="h-4 w-4" aria-hidden />}>
          <p>{notice.text}</p>
          {notice.kind === "app" &&
            (isActive ? (
              <RegistryNoticeDeactivate slug={notice.slug} name={nameOf("app", notice.slug)} />
            ) : (
              <p className="mt-1">It&apos;s switched off on this instance.</p>
            ))}
          <UpdateLine notice={notice} offer={offer} />
        </Notice>
      );
    case "newer":
      return (
        <Notice tone="neutral" icon={<ArrowUpCircle className="h-4 w-4" aria-hidden />}>
          <p>{notice.text}</p>
          <UpdateLine notice={notice} offer={offer} />
        </Notice>
      );
    case "unlisted":
      return (
        <Notice tone="neutral" icon={<Archive className="h-4 w-4" aria-hidden />}>
          {notice.text}
        </Notice>
      );
    case "modified":
    case "elsewhere":
      return <p className="text-xs text-muted-foreground">{notice.text}</p>;
  }
}

/** What a withdrawn or newer notice offers for updating, under its text. */
function UpdateLine({ notice, offer }: { notice: RegistryNotice; offer: UpdateOffer }) {
  if (!offer) return null;
  const name = nameOf(notice.kind, notice.slug);
  if (offer === "pending") {
    return (
      <p className="mt-2 text-xs">
        An update of it is waiting to be registered{notice.kind === "theme" ? "" : ", under Waiting to register"}.
      </p>
    );
  }
  if (offer === "docs") {
    return (
      <p className="mt-2 text-xs">
        <a href={HOW_TO_UPDATE} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
          How to update {name}
          <ExternalLink className="ml-1 inline h-3 w-3 align-[-0.125em]" aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        : in a checkout of your repository, then commit and deploy.
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <RegistryNoticeUpdate kind={notice.kind} slug={notice.slug} name={name} />
      <span className="text-xs text-muted-foreground">It shows what the new release changes before anything is installed.</span>
    </div>
  );
}
