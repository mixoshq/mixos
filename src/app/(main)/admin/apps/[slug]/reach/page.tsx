/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import { notFound } from "next/navigation";
import { appRegistry } from "@/generated/app-registry";
import { connectorRegistry } from "@/generated/connector-registry";
import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { sql } from "@/lib/db/client";
import { appLabels, hostTier } from "@/lib/apps/labels";
import { getAppTrust } from "@/lib/apps/app-review";
import { getCapabilityStatus } from "@/lib/apps/capability-approvals";
import { describeCapability } from "@/lib/apps/capabilities";
import { getObservedActivity, getOpenAnomalies } from "@/lib/apps/detection";
import { describeAnomaly } from "@/lib/apps/anomaly";
import { getAppNarrowings } from "@/lib/connectors/app-access";
import { getAppCredentialRows } from "@/lib/connectors/app-config";
import { getWritableConnectors } from "@/lib/connectors/writable";
import { getDisabledConnectors } from "@/lib/connectors/switch";
import { StatusPill } from "@/components/ui/status";
import { CARD_SHELL } from "@/components/ui/card";

/**
 * What one app can reach, and what it did (Item 9). Everything it can reach,
 * from its manifest, an admin's limits and switches, and the host's tier;
 * beside each, what it did in the last 30 days; its labels, each with what
 * makes it true; and its approval history. Built only from the platform's own
 * records, never from what a publisher says.
 */

export const dynamic = "force-dynamic";

/** The audit actions that are this app's trust history. */
const HISTORY = [
  "app.activate",
  "app.deactivate",
  "app.review",
  "app.update.unreviewed",
  "app.review.required",
  "app.capabilities.grew",
  "app.capabilities.approve",
  "app.capability.deny",
  "app.capability.allow",
  "app.capability.expired",
  "app.anomaly.acknowledge",
  "app.identity.changed",
];

async function safely<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error("[reach] a section couldn't be read:", err);
    return fallback;
  }
}

export default async function AppReachPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await requireReadOnlySession();
  await requireAdmin(session);
  const { slug } = await params;
  const app = appRegistry.find((a) => a.slug === slug);
  if (!app) notFound();

  const connectorNames = app.connectorRequirements.map((r) => r.name);
  const [trust, capabilities, observed, anomalies, narrowings, own, writable, disabled, history] = await Promise.all([
    safely(async () => (await getAppTrust([slug]))[slug] ?? null, null),
    safely(async () => (await getCapabilityStatus([slug]))[slug] ?? null, null),
    safely(() => getObservedActivity(slug), null),
    safely(async () => (await getOpenAnomalies())[slug] ?? [], []),
    safely(() => getAppNarrowings(slug), null),
    safely(() => getAppCredentialRows(slug), null),
    safely(() => getWritableConnectors(connectorNames), null),
    safely(() => getDisabledConnectors(connectorNames), null),
    safely<{ action: string; actor_email: string; created_at: Date }[]>(
      async () => [
        ...(await sql<{ action: string; actor_email: string; created_at: Date }[]>`
          select action, actor_email, created_at from public.admin_audit_log
           where target_type = 'app' and target_id = ${slug} and action = any(${HISTORY}::text[])
           order by created_at desc limit 50
        `),
      ],
      [],
    ),
  ]);
  const labels = appLabels(app);
  const tier = hostTier();
  const calls = (subject: string) => observed?.connectorMethods.filter((m) => m.subject.startsWith(`${subject}.`)) ?? [];
  const reached = (host: string) => observed?.hosts.find((h) => h.host === host.toLowerCase());
  const off = new Set((capabilities?.deniable ?? []).filter((c) => c.denied).map((c) => `${c.kind}:${c.capability}`));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/apps" className="text-sm text-primary underline underline-offset-2 hover:no-underline">
          Apps
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-foreground">{app.name}: what it can reach</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          From its manifest, what an admin set here, and this host. Beside each, what it did in the last 30 days.
          Nothing here comes from what its publisher says about it.
        </p>
      </div>

      <section className={`${CARD_SHELL} p-5`}>
        <h2 className="text-lg font-medium text-foreground">Labels</h2>
        <ul className="mt-3 space-y-3">
          {labels.map((l) => (
            <li key={l.id}>
              <StatusPill tone={l.id === "in-process" ? "warning" : "neutral"}>{l.label}</StatusPill>
              <p className="mt-1 text-sm text-foreground">{l.definition}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">What makes it true: {l.enforcement}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          This host runs app code {tier === "in-process" ? "in the server process" : "isolated"}. Every label is tried by
          the escape suite (tests/escapes/) on every change.
        </p>
      </section>

      {trust && (
        <section className={`${CARD_SHELL} p-5`}>
          <h2 className="text-lg font-medium text-foreground">Where it came from</h2>
          <p className="mt-2 text-sm text-foreground">
            {trust.provenance}
            {trust.modified ? ", modified locally" : ""}.{" "}
            {trust.reviewed
              ? `Its code was reviewed here${trust.reviewedBy ? ` by ${trust.reviewedBy}` : ""}.`
              : "Nobody here has reviewed the code it runs."}
          </p>
        </section>
      )}

      <section className={`${CARD_SHELL} p-5`}>
        <h2 className="text-lg font-medium text-foreground">Connectors</h2>
        {app.connectorRequirements.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {app.connectorRequirements.map((need) => {
              const connector = connectorRegistry.find((c) => c.name === need.name);
              const limit = narrowings?.get(need.name);
              const used = calls(need.name);
              return (
                <li key={need.name} className="text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{connector?.displayName ?? need.name}</span>
                    {need.optional && <StatusPill tone="neutral">Optional</StatusPill>}
                    {need.access === "write" && writable?.has(need.name) && limit?.writes !== "deny" && (
                      <StatusPill tone="warning">Changes data</StatusPill>
                    )}
                    {limit && <StatusPill tone="neutral">Limited</StatusPill>}
                    {own?.has(need.name) && <StatusPill tone="neutral">Own credentials</StatusPill>}
                    {disabled?.has(need.name) && <StatusPill tone="warning">Disabled</StatusPill>}
                    {off.has(`optional-connector:${need.name}`) && <StatusPill tone="warning">Turned off for it</StatusPill>}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {used.length === 0
                      ? "No calls in the last 30 days."
                      : used
                          .map((m) => `${m.subject.slice(need.name.length + 1)} ${m.calls}${m.refused ? `, ${m.refused} refused` : ""}`)
                          .join(" · ")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={`${CARD_SHELL} p-5`}>
        <h2 className="text-lg font-medium text-foreground">Hosts it reaches itself</h2>
        {app.egress.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">None: it has no context.http.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-foreground">
            {app.egress.map((host) => {
              const r = reached(host);
              return (
                <li key={host} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{host}</span>
                  {off.has(`egress:${host.toLowerCase()}`) && <StatusPill tone="warning">Turned off for it</StatusPill>}
                  <span className="text-xs text-muted-foreground">
                    {r ? `${r.calls} request${r.calls === 1 ? "" : "s"}${r.refused ? `, ${r.refused} refused` : ""}` : "not reached"}
                  </span>
                </li>
              );
            })}
            {(observed?.hosts ?? [])
              .filter((h) => !app.egress.some((e) => e.toLowerCase() === h.host))
              .map((h) => (
                <li key={`x:${h.host}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{h.host}</span>
                  <StatusPill tone={h.refused === h.calls ? "danger" : "neutral"}>
                    {h.refused === h.calls ? "Refused" : "Through a wildcard"}
                  </StatusPill>
                  <span className="text-xs text-muted-foreground">
                    {h.calls} request{h.calls === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className={`${CARD_SHELL} p-5`}>
        <h2 className="text-lg font-medium text-foreground">Everything else it asks for</h2>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-foreground">
          {(capabilities ? [...(capabilities.added ?? [])] : []).length > 0 && (
            <li className="font-medium">
              Asks for more than was approved: {capabilities!.added.map(describeCapability).join("; ")}
            </li>
          )}
          {app.database && <li>Has tables of its own, reached as its own database role</li>}
          {app.notifications && <li>Sends push notifications{off.has("notifications:") ? " (turned off for it)" : ""}</li>}
          {app.consumes.map((c) => (
            <li key={`${c.app}/${c.service}`}>
              Asks {c.app}&apos;s {c.service} service{off.has(`consumes:${c.app}/${c.service}`) ? " (turned off for it)" : ""}
            </li>
          ))}
          {app.provides.map((s) => (
            <li key={s.name}>Offers the {s.name} service</li>
          ))}
          {app.mcp.length > 0 && <li>{app.mcp.length} MCP tool{app.mcp.length === 1 ? "" : "s"}, read-only</li>}
          {app.schedules.length > 0 && <li>{app.schedules.length} scheduled job{app.schedules.length === 1 ? "" : "s"}</li>}
          {app.global && <li>Everyone gets it, without a grant</li>}
        </ul>
      </section>

      {anomalies.length > 0 && (
        <section className={`${CARD_SHELL} p-5`}>
          <h2 className="text-lg font-medium text-foreground">Unusual activity</h2>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {anomalies.map((a) => (
              <li key={a.id}>{describeAnomaly(a)}</li>
            ))}
          </ul>
        </section>
      )}

      <section className={`${CARD_SHELL} p-5`}>
        <h2 className="text-lg font-medium text-foreground">History</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-foreground">
            {history.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-2">
                <span className="font-mono text-xs text-muted-foreground">{h.created_at.toISOString().slice(0, 16).replace("T", " ")}</span>
                <span>{h.action}</span>
                <span className="text-muted-foreground">by {h.actor_email}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
