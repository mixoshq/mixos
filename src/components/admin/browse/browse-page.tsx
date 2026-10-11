/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { registryInstalls } from "@/generated/registry-installs";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { isBuiltDeployment } from "@/lib/platform/build";
import { repositoryBaseUrl } from "@/lib/repository/client";
import { checkInstallable, checkoutRoot } from "@/lib/repository/install";
import { listPendingInstalls } from "@/lib/repository/pending";
import { installEnabled } from "@/lib/repository/policy";
import { provenanceOf, type Provenance } from "@/lib/repository/provenance";
import { KIND_LABEL, type ExtensionKind } from "@/lib/repository/types";
import ExtensionBrowser from "./extension-browser";

/**
 * The shell all three browse routes share: the gate, the header, and the
 * server-side facts the client browser needs: what is installed already and
 * where each came from, and what waits in pending.
 *
 * The three routes differ only in which kind they name and which generated
 * registry they read to answer "is this one already here" — so they are three
 * six-line files over this, rather than three copies of a page that would drift
 * the way the admin navs did before `sections.ts`.
 *
 * ADMIN GATE HERE AND IN EVERY ACTION. This one guards the render. It is not
 * what protects the search or the install: those are server actions, reachable
 * without ever loading this page, and each re-authorises itself.
 *
 * The same holds for the kind's install flag (INSTALL_APPS and friends,
 * lib/repository/policy.ts). Turned off, this page does not exist — a 404,
 * not a page explaining that it is switched off — and the actions refuse the
 * kind on their own.
 */
export default async function BrowsePage({
  kind,
  installedSlugs,
  backHref,
}: {
  kind: ExtensionKind;
  installedSlugs: string[];
  backHref: string;
}) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  if (!installEnabled(kind)) notFound();

  // Answered on the server so a deployment that doesn't install says so at the
  // top of the page, rather than after an admin has chosen something and
  // waited for a download that was never going to land.
  const { ok, reason, code } = await checkInstallable(kind);

  // Installed but not yet registered: their tiles offer the review instead of
  // an install the server would refuse. A theme registers as it installs.
  const pendingSlugs =
    ok && kind !== "theme"
      ? listPendingInstalls(checkoutRoot())
          .filter((p) => p.kind === kind)
          .map((p) => p.slug)
      : [];

  // Two forms of the same fact: the host for the header sentence, the full
  // origin for links out to individual listings.
  let origin = "https://mixos.org";
  try {
    origin = repositoryBaseUrl();
  } catch {
    // A misconfigured MIXOS_REPOSITORY_URL is reported by the search itself,
    // with the message the client needs. The header just keeps its label.
  }
  const host = origin.replace(/^https?:\/\//, "");

  // Where each extension of this kind in the build came from, from the install
  // records the registry generator read, for the line its listing shows in
  // place of an install button.
  const installed: Record<string, Provenance> = Object.fromEntries(
    installedSlugs.map((slug) => [slug, provenanceOf(kind, slug, registryInstalls, origin)]),
  );

  const label = KIND_LABEL[kind];

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Browse {label.many}
          </h1>
          {/*
            Two sentences, because a header that promises installing while the
            banner underneath says this instance cannot install is the page
            arguing with itself. Browsing is the same either way; only the
            second half of the story changes.
          */}
          <p className="mt-1 text-sm text-muted-foreground">
            {ok ? (
              kind === "theme" ? (
                <>
                  {label.many} published to {host}. Installing one downloads it
                  from GitHub, verifies it against the checksum {host}{" "}
                  published, runs this instance&rsquo;s registry checks on it,
                  and adds it to <code className="font-mono text-xs">themes/</code>.
                </>
              ) : (
                <>
                  {label.many} published to {host}. Installing one downloads it
                  from GitHub, verifies it against the checksum {host}{" "}
                  published, and checks it without running it. It then waits
                  in <code className="font-mono text-xs">.mixos/pending/</code>{" "}
                  until you review and register it.
                </>
              )
            ) : (
              <>
                {label.many} published to {host}. Browse them here; see below
                for where to install them.
              </>
            )}
          </p>
        </div>
        <Link
          href={backHref}
          className="shrink-0 self-start inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Installed {label.many}
        </Link>
      </div>

      <ExtensionBrowser
        kind={kind}
        repositoryOrigin={origin}
        repositoryOverridable={!isBuiltDeployment()}
        installed={installed}
        pendingSlugs={pendingSlugs}
        installable={ok ? null : (reason ?? null)}
        installableTone={code === "built-deployment" ? "info" : "warning"}
      />
    </div>
  );
}
