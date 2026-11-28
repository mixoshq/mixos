/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AppManifest } from "./types";

/**
 * Labels for an app, from what is enforced, never from what a publisher
 * claims (Item 9). Each one has a written definition, the enforcement point
 * that makes it true, and the escape-suite cases that try to break it
 * (tests/escapes/catalogue.ts). A label with no enforcement behind it isn't
 * one of these.
 *
 * Read from the app's manifest, which is what the platform holds it to, and
 * the host's tier. Pure, and safe on the client.
 */

export type LabelId = "stays-here" | "read-only" | "own-data" | "no-public-routes" | "isolated" | "in-process";

export interface LabelDefinition {
  id: LabelId;
  label: string;
  /** When it is true, in words. */
  definition: string;
  /** What makes it true: the code that refuses otherwise. */
  enforcement: string;
  /** Escape-suite cases that try to break it (tests/escapes/catalogue.ts). */
  escapes: string[];
}

export const LABELS: Record<LabelId, LabelDefinition> = {
  "stays-here": {
    id: "stays-here",
    label: "Stays on this instance",
    definition: "It declares no egress host and no connector, so nothing it does leaves this instance through MixOS.",
    enforcement:
      "context.http exists only for an app with egress, and refuses any host not declared (src/lib/apps/http.ts); connectors are only the declared ones (src/lib/apps/context.ts); the build refuses raw network access (scripts/app-containment.ts).",
    escapes: ["egress-undeclared", "raw-network", "redirect-ssrf"],
  },
  "read-only": {
    id: "read-only",
    label: "Read-only",
    definition: "No connector entry asks to change data, so it can't change anything in an outside service. Its own tables it may.",
    enforcement:
      "The connector facade refuses every write an entry doesn't ask for (src/lib/apps/connector-reach.ts).",
    escapes: ["connector-undeclared-write", "connector-request"],
  },
  "own-data": {
    id: "own-data",
    label: "Its own data only",
    definition: "It asks no other app's services and listens to no other app's hooks, and its queries reach only its own tables.",
    enforcement:
      "The services broker needs a declared dependency (src/lib/apps/services.ts); every query runs as its own database role (src/lib/db/query.ts, mixos_run).",
    escapes: ["other-app-schema", "reset-role", "services-impersonation"],
  },
  "no-public-routes": {
    id: "no-public-routes",
    label: "No public routes",
    definition: "Every route needs a signed-in person: none answers anyone, a password or an API key.",
    enforcement: "The gateway resolves the caller's tier before a route runs, and refuses a tier the route doesn't declare (src/lib/apps/route.ts).",
    escapes: ["public-tier"],
  },
  isolated: {
    id: "isolated",
    label: "Runs isolated",
    definition: "Its code runs in a process of its own, with none of the platform's secrets.",
    enforcement: "Not built: see docs/plans/20261128_0146-out-of-process-runners.md. No app has this label yet.",
    escapes: [],
  },
  "in-process": {
    id: "in-process",
    label: "Runs in the server process",
    definition:
      "Its code runs inside MixOS's own server, held by the build's checks and the runtime's. Code written to get around them could reach further.",
    enforcement: "docs/threat-model.md, the first row: what in-process isolation stops and what it can't.",
    escapes: ["function-by-reflection", "global-process", "pool-on-global", "connector-reads-another"],
  },
};

/** How the host runs app code. Every host runs it in the server process today. */
export type HostTier = "in-process" | "isolated";

export function hostTier(): HostTier {
  return "in-process";
}

/**
 * An app's labels, from its manifest and the host's tier. Without `routes`
 * (a pending package's app.json, read before its code is), "No public
 * routes" can't be worked out, and is left off rather than guessed.
 */
export function appLabels(
  app: Partial<
    Pick<AppManifest, "slug" | "egress" | "connectorRequirements" | "consumes" | "listensTo" | "routes" | "pageVisibility">
  >,
  tier: HostTier = hostTier(),
): LabelDefinition[] {
  const out: LabelDefinition[] = [];
  const connectors = app.connectorRequirements ?? [];
  if ((app.egress ?? []).length === 0 && connectors.length === 0) out.push(LABELS["stays-here"]);
  if (connectors.every((c) => c.access !== "write")) out.push(LABELS["read-only"]);
  const othersHooks = (app.listensTo ?? []).filter((l) => l.app !== app.slug);
  if ((app.consumes ?? []).length === 0 && othersHooks.length === 0) out.push(LABELS["own-data"]);
  if (app.routes !== undefined) {
    const open = (tiers: readonly string[]) => tiers.some((t) => t === "public" || t === "password" || t === "key");
    const anyOpen =
      app.routes.some((r) => r.methods.some((m) => open(m.auth))) ||
      Object.values(app.pageVisibility ?? {}).some((tiers) => open(tiers));
    if (!anyOpen) out.push(LABELS["no-public-routes"]);
  }
  out.push(tier === "isolated" ? LABELS.isolated : LABELS["in-process"]);
  return out;
}
