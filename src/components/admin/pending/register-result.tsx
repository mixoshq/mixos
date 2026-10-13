/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { activateInCheckoutAction } from "@/lib/repository/pending-actions";
import {
  describeHosts,
  type ActivateOutcome,
  type Registered,
} from "@/lib/repository/pending-outcomes";
import HandBackPanel from "./hand-back";
import Notice from "@/components/ui/notice";
import WithCode from "./with-code";

/**
 * What Register did, and what comes next: turning the app on, and shipping it.
 *
 * Turning it on is per database. "Activate in this checkout" is offered only
 * when this checkout's database is on this machine and this server runs what
 * was registered now; on a database other instances may share, activating
 * here would turn the app on for all of them, so the result says where to do
 * it instead. The action checks the database again before it acts.
 *
 * Shipping is a commit and a deploy, which the server never does: a web
 * process committing to its own checkout would commit whatever else is in it.
 * So the result hands back what to commit and how (./hand-back.tsx): the files,
 * a commit message prepared from the install record, the commands, the source
 * at the verified commit, and what shipping means on each host.
 *
 * An update keeps the app's switch, grants and settings, which belong to its
 * slug, so it offers nothing to turn on. It says what it replaced, that the
 * dev server may keep serving the old code until it restarts, and how to roll
 * the update back once it is deployed.
 */
export default function RegisterResult({
  result,
  name,
}: {
  result: Registered;
  name: string;
}) {
  const isApp = result.kind === "app";
  if (result.update) return <UpdatedResult result={result} update={result.update} />;
  return (
    <div className="space-y-5">
      <Notice tone="success" title={`Registered to ${result.installPath}`}>
        <p>
          The registry generator loaded its code and accepted it
          {result.deferredChecked > 0 ? ", including what install's check left for registration" : ""}
          .{" "}
          {result.servesNow ? (
            "The dev server runs it now."
          ) : (
            <>
              This server runs a production build of this checkout, so it runs
              the new code after <code className="font-mono text-xs">npm run build</code>{" "}
              and a restart.
            </>
          )}
        </p>
      </Notice>

      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="Version">
          {result.version}
          {result.gitTag && <span className="text-muted-foreground"> ({result.gitTag})</span>}
        </Row>
        <Row label="Commit">
          <code className="break-all font-mono text-xs">{result.commitSha}</code>
        </Row>
        <Row label="From">{result.handBack.host}</Row>
        <Row label="Database">
          {describeHosts(result.database)}
          <span className="text-muted-foreground">
            {result.database.local ? " · on this machine" : " · other instances may use it"}
          </span>
        </Row>
      </dl>

      {isApp ? (
        <Section title="Turn it on">
          <Activation result={result} name={name} />
        </Section>
      ) : (
        <Section title="Set it up">
          <p className="text-sm text-foreground">
            Configure it in Admin &gt; Connectors
            {result.servesNow ? "" : ", once this server has been rebuilt and restarted"}.
          </p>
        </Section>
      )}

      <Section title="Ship it">
        <HandBackPanel handBack={result.handBack} isApp={isApp} />
      </Section>
    </div>
  );
}

/** What Register did with an update: the swap, what carries over, and what to do next. */
function UpdatedResult({ result, update }: { result: Registered; update: NonNullable<Registered["update"]> }) {
  const isApp = result.kind === "app";
  const migrations = update.migrationsAdded;
  return (
    <div className="space-y-5">
      <Notice tone="success" title={`Updated ${result.installPath} to ${result.version}`}>
        <p>
          The registry generator loaded the new code and accepted it, and the backup of {update.from.version} was
          deleted.{" "}
          {result.servesNow ? (
            <>
              The dev server can keep serving the code it compiled from {update.from.version} until it restarts:
              restart <code className="font-mono text-xs">npm run dev</code> before you try it.
            </>
          ) : (
            <>
              This server runs a production build of this checkout, so it runs the new code after{" "}
              <code className="font-mono text-xs">npm run build</code> and a restart.
            </>
          )}
        </p>
      </Notice>

      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="From">{update.from.version}</Row>
        <Row label="To">
          {result.version}
          {result.gitTag && <span className="text-muted-foreground"> ({result.gitTag})</span>}
          {update.direction === "older" && <span className="text-muted-foreground"> · an older release</span>}
        </Row>
        <Row label="Commit">
          <code className="break-all font-mono text-xs">{result.commitSha}</code>
        </Row>
        {update.localChangesDiscarded && <Row label="Your changes">Discarded</Row>}
      </dl>

      <Section title="What carries over">
        <p className="text-sm text-foreground">
          {isApp
            ? "Its activation, grants and settings belong to its slug, in the database, so they carry over."
            : "Its credentials and its users' connections belong to its name, in the database, so they carry over."}
          {migrations.length > 0 && (
            <>
              {" "}
              It has {migrations.length} new {migrations.length === 1 ? "migration" : "migrations"}: run{" "}
              <code className="font-mono text-xs">npm run migrate:apps</code> in this checkout to apply{" "}
              {migrations.length === 1 ? "it" : "them"}. Migrations can&apos;t be undone.
            </>
          )}
        </p>
      </Section>

      <Section title="Ship it">
        <HandBackPanel handBack={result.handBack} isApp={isApp} />
      </Section>
    </div>
  );
}

function Activation({ result, name }: { result: Registered; name: string }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActivateOutcome | null>(null);
  const hosts = describeHosts(result.database);

  if (result.activation === "elsewhere") {
    return (
      <p className="text-sm text-foreground">
        This checkout&apos;s database is on {hosts}, which other instances may
        use too, so {name} isn&apos;t turned on from here: that would turn it on
        for every instance on that database. Activate it in Admin &gt; Apps on
        the instance that serves it.
      </p>
    );
  }
  if (result.activation === "after-rebuild") {
    return (
      <p className="text-sm text-foreground">
        This checkout&apos;s database is on this machine. Once this server has
        been rebuilt and restarted, activate {name} in Admin &gt; Apps.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground">
        This checkout&apos;s database is on this machine, so turning {name} on
        here changes nothing anywhere else.
        {result.migrations > 0 && (
          <>
            {" "}
            It has {result.migrations} {result.migrations === 1 ? "migration" : "migrations"}: run{" "}
            <code className="font-mono text-xs">npm run migrate:apps</code> in this checkout
            first, or it waits until you do.
          </>
        )}
      </p>
      {outcome?.ok ? (
        <Notice tone="success" title="Active in this checkout">
          Grant it to people in Admin &gt; Users.
        </Notice>
      ) : (
        <>
          {outcome && !outcome.ok && (
            <Notice tone={outcome.tone}>
              <WithCode text={outcome.message} />
            </Notice>
          )}
          <Button
            variant="primary"
            busy={busy}
            busyLabel="Activating…"
            onClick={async () => {
              setBusy(true);
              try {
                setOutcome(await activateInCheckoutAction({ slug: result.slug }));
              } finally {
                setBusy(false);
              }
            }}
          >
            Activate in this checkout
          </Button>
        </>
      )}
    </div>
  );
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
