/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the detector raises about an app (./detection.ts), as the admin pages
 * show it. Pure, and safe on the client.
 */

export type AnomalyKind = "new-write" | "new-host" | "refused" | "spike" | "too-many-subjects";

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** "<connector>.<method>", a host, "connector:<c>.<m>:<why>", "egress:<host>:<why>", an hour, or "subjects". */
  subject: string;
  detail: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  /** How many times it was seen. */
  count: number;
}

/** One anomaly, in a line an admin can act on. */
export function describeAnomaly(a: Anomaly): string {
  switch (a.kind) {
    case "new-write":
      return `First call to ${a.subject}, which changes data.`;
    case "new-host":
      return `First contact with ${a.subject}, which its egress allows only through a wildcard.`;
    case "refused": {
      const [where, what, why] = splitRefusal(a.subject);
      const times = a.count === 1 ? "once" : `${a.count.toLocaleString("en-US")} times`;
      return where === "egress"
        ? `Tried to reach ${what}, refused ${times} (${REASON[why] ?? why}).`
        : `Called ${what}, refused ${times} (${REASON[why] ?? why}).`;
    }
    case "spike": {
      const hour = Number(a.detail.lastHour ?? 0);
      const mean = Number(a.detail.hourlyMean ?? 0);
      return `${hour.toLocaleString("en-US")} calls in an hour, against about ${Math.round(mean).toLocaleString("en-US")} an hour in the week before.`;
    }
    case "too-many-subjects":
      return "More distinct methods and hosts than detection keeps track of: what's new past that isn't flagged.";
  }
}

/** Why a call was refused, in words. */
const REASON: Record<string, string> = {
  undeclared: "a method its connector doesn't declare",
  "write-not-asked": "a write its manifest doesn't ask for",
  "write-not-allowed": "a write the connector isn't allowed to make",
  narrowed: "outside the limits an admin set for it",
  budget: "over its route's connector budget",
  disabled: "the connector is disabled",
  host: "a host its egress doesn't list",
  scheme: "a scheme other than http or https",
  address: "a private address",
};

/** "connector:crm.deleteDeal:write-not-asked" → ["connector", "crm.deleteDeal", "write-not-asked"]. */
function splitRefusal(subject: string): [string, string, string] {
  const first = subject.indexOf(":");
  const last = subject.lastIndexOf(":");
  return [subject.slice(0, first), subject.slice(first + 1, last), subject.slice(last + 1)];
}
