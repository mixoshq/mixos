/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { describeFloor } from "@/lib/platform/version-floor";
import type { ListingFacts } from "@/lib/repository/pending-outcomes";
import type { PendingReview } from "@/lib/repository/review";
import Notice from "@/components/ui/notice";
import WithCode from "./with-code";

/**
 * What an admin reads before registering a pending install.
 *
 * Registering is when the package's code first runs, so this repeats, from
 * the pending install itself, what will run and when; what install's check
 * couldn't read as text and left to registration; what the package's manifest
 * declares beside what the publisher claims on the catalogue; whether this
 * checkout's version meets the release's floor; and where to read the source,
 * at the commit that was verified, from the install record.
 *
 * The manifest's declarations are what this instance enforces. The
 * publisher's claims are their own words on the listing, shown beside them
 * so a difference is visible, never as a guarantee.
 */
export default function ReviewPanel({
  review,
  listing,
}: {
  review: PendingReview;
  listing: ListingFacts;
}) {
  const { release, sourceUrl } = review;
  return (
    <div className="space-y-6">
      <p className="text-sm text-foreground">
        It is waiting in <Path>{review.folder}/</Path>, where none of its code
        has run. Registering moves it to <Path>{review.target}/</Path> and runs
        the registry generator, which loads its code for the first time, as
        the user this server runs as. From then on the dev server runs it with
        the server&apos;s full environment.
      </p>

      {review.problem && (
        <Notice tone="warning" title="It can't be registered as it is">
          <WithCode text={review.problem} />
        </Notice>
      )}

      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="Version">
          {release.version}
          {release.gitTag && <span className="text-muted-foreground"> ({release.gitTag})</span>}
          {release.yankedAccepted && (
            <span className="text-muted-foreground"> · withdrawn by its publisher, installed anyway</span>
          )}
        </Row>
        <Row label="Commit">
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all font-mono text-xs underline underline-offset-2"
            >
              {release.commitSha}
              <ExternalLink className="ml-1 inline h-3 w-3 align-[-0.125em]" aria-hidden />
              <span className="sr-only"> (the source on GitHub, opens in a new tab)</span>
            </a>
          ) : (
            <code className="break-all font-mono text-xs">{release.commitSha}</code>
          )}
        </Row>
        <Row label="Verified">
          <code className="break-all font-mono text-xs">{release.contentHash}</code>
        </Row>
        <Row label="Contents">
          {release.fileCount} files · {Math.max(1, Math.round(release.byteCount / 1024))} KB
        </Row>
        <Row label="Installed">
          {formatInstant(release.installedAt)} by {release.installedBy}
        </Row>
        <Row label="From">{release.source}</Row>
      </dl>

      <Section title="What will run">
        <ul className="space-y-3">
          {review.runs.map((group) => (
            <li key={group.label} className="text-sm">
              <p>
                <span className="font-medium text-foreground">{group.label}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · <WithCode text={group.note} />
                </span>
              </p>
              {group.files.length === 0 ? (
                <p className="mt-1 text-muted-foreground">None in this package.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {group.files.map((file) => (
                    <li key={file}>
                      <code className="break-all font-mono text-xs text-foreground">{file}</code>
                    </li>
                  ))}
                  {group.more > 0 && (
                    <li className="text-xs text-muted-foreground">and {group.more} more</li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Checked when it is registered">
        {review.deferred.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing. Install&apos;s check read all of it as text.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Install&apos;s check reads code as text and runs none of it. It
              couldn&apos;t read these as written, so the registry generator
              checks them when it loads them.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
              {review.deferred.map((line) => (
                <li key={line} className="break-words">
                  <WithCode text={line} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="What it declares, and what its publisher says">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="text-sm font-medium text-foreground">The package&apos;s manifest</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              What this instance enforces.
            </p>
            {review.declared === null ? (
              <p className="mt-2 text-sm text-muted-foreground">Its manifest can&apos;t be read.</p>
            ) : (
              <dl className="mt-2 space-y-2 text-sm">
                {review.declared.map((d) => (
                  <div key={d.label}>
                    <dt className="text-muted-foreground">{d.label}</dt>
                    <dd className="text-foreground">
                      {d.values.length === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        <span className="break-words">{d.values.join(", ")}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div>
            <h4 className="text-sm font-medium text-foreground">Its publisher</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Their words on {listing.origin.replace(/^https?:\/\//, "")}, not a guarantee.
            </p>
            {listing.state === "unavailable" ? (
              <p className="mt-2 text-sm text-muted-foreground">
                <WithCode text={listing.message} />
              </p>
            ) : listing.claims.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No permissions declared.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {listing.claims.map((claim) => (
                  <li key={`${claim.scope}:${claim.reason}`}>
                    <code className="break-all font-mono text-xs text-foreground">{claim.scope}</code>
                    <span className="block text-muted-foreground">{claim.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section title="MixOS version">
        <p className="text-sm text-foreground">{describeFloor(review.requiresMixOS)}</p>
      </Section>

      <Section title="Source">
        {sourceUrl ? (
          <p className="text-sm text-foreground">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              Read it on GitHub at the commit that was verified
              <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-0.125em]" aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            , or in <Path>{review.folder}/</Path> in this checkout.
          </p>
        ) : (
          <p className="text-sm text-foreground">
            Read it in <Path>{review.folder}/</Path> in this checkout.
          </p>
        )}
        {listing.state === "ok" && listing.note && (
          <p className="mt-2 text-sm text-muted-foreground">
            <WithCode text={listing.note} />
          </p>
        )}
      </Section>
    </div>
  );
}

/** An ISO instant, as a reader in any time zone can place it. */
function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs">{children}</code>;
}
