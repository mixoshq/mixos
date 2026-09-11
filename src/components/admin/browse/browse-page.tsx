/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { repositoryBaseUrl } from "@/lib/repository/client";
import { checkInstallable } from "@/lib/repository/install";
import { KIND_LABEL, type ExtensionKind } from "@/lib/repository/types";
import ExtensionBrowser from "./extension-browser";

/**
 * The shell all three browse routes share: the gate, the header, and the two
 * server-side facts the client browser needs.
 *
 * The three routes differ only in which kind they name and which generated
 * registry they read to answer "is this one already here" — so they are three
 * six-line files over this, rather than three copies of a page that would drift
 * the way the admin navs did before `sections.ts`.
 *
 * ADMIN GATE HERE AND IN EVERY ACTION. This one guards the render. It is not
 * what protects the search or the install: those are server actions, reachable
 * without ever loading this page, and each re-authorises itself.
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

  // Answered on the server so a deployment that cannot write to its own
  // checkout says so at the top of the page, rather than after an admin has
  // chosen something and waited for a download that was never going to land.
  const { ok, reason } = await checkInstallable(kind);

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

  const label = KIND_LABEL[kind];

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Browse {label.many}</h1>
          {/*
            Two sentences, because a header that promises registering while the
            banner underneath says this instance cannot register is the page
            arguing with itself. Browsing is the same either way; only the
            second half of the story changes.
          */}
          <p className="mt-1 text-sm text-muted-foreground">
            {ok ? (
              <>
                {label.many} published to {host}. Registering one downloads it from
                GitHub, verifies it against the checksum {host} published, runs it
                through this instance&rsquo;s registry checks, and copies it into
                this deployment — where anyone on it can install it.
              </>
            ) : (
              <>
                {label.many} published to {host}. This instance can browse the
                catalogue but cannot register from it — see below.
              </>
            )}
          </p>
        </div>
        <Link
          href={backHref}
          className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Installed {label.many}
        </Link>
      </div>

      <ExtensionBrowser
        kind={kind}
        repositoryOrigin={origin}
        installedSlugs={installedSlugs}
        installable={ok ? null : (reason ?? null)}
      />
    </div>
  );
}
