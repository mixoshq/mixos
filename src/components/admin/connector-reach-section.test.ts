/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Details tab's Reach section, rendered on the server: each app that
 * declares the connector, what it may call, and what it called, with the calls
 * streamed in after the rest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import ConnectorReachSection, { ReachList, type ReachSectionProps } from "./connector-reach-section";
import ConnectorTile from "./connector-tile";
import type { ConnectorWithStatus } from "./connector-registry-list";
import { connectorReach, type ObservedCall, type ObservedCalls } from "@/lib/connectors/reach";
import type { ConnectorTelemetryDefinition } from "@/lib/connectors/types";

/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const METHODS: ConnectorTelemetryDefinition[] = [
  { method: "listDeals", operation: "GET /deals" },
  { method: "getDeal", operation: "GET /deals/{id}" },
  { method: "createDeal", operation: "POST /deals", mutates: true },
];

const APPS = [
  { slug: "pipeline", name: "Pipeline", connectorRequirements: [{ name: "crm", optional: false, access: "write" as const }] },
  { slug: "reports", name: "Reports", connectorRequirements: [{ name: "crm", optional: true, access: "read" as const }] },
  { slug: "archive", name: "Archive", connectorRequirements: [{ name: "crm", optional: false, access: "write" as const }] },
];

function props(over: Partial<ReachSectionProps> & { changesAllowed?: boolean; active?: Record<string, boolean> | null } = {}) {
  const { changesAllowed = true, active = { pipeline: true, reports: true, archive: false }, ...rest } = over;
  return {
    reach: connectorReach({ connector: { name: "crm", telemetry: METHODS }, apps: APPS, active, disabled: false, changesAllowed }),
    connectorName: "crm",
    declaredWrites: 1,
    disabled: false,
    userScoped: false,
    authenticates: true,
    writeGrantMissing: false,
    ...rest,
  } satisfies ReachSectionProps;
}

const call = (
  appSlug: string | null,
  method: string,
  calls: number,
  errors = 0,
  appName: string | null = null,
  refused = 0,
): ObservedCall => ({
  appSlug,
  appName,
  method,
  calls,
  errors,
  refused,
});

const list = (p: ReturnType<typeof props>, observed: Parameters<typeof ReachList>[0]["observed"]) =>
  text(renderToStaticMarkup(createElement(ReachList, { ...p, observed })));

test("each app: required or optional, whether it runs, and what it may call", () => {
  const words = list(props(), { state: "read", calls: [] });
  assert.match(words, /Used by 2 active apps · 1 can change data\./);
  assert.match(words, /They all use the same credential, so revoking it at the provider stops every one of them\./);
  // Running apps first, by name; the inactive one last.
  assert.ok(words.indexOf("Pipeline") < words.indexOf("Reports"));
  assert.ok(words.indexOf("Reports") < words.indexOf("Archive"));
  assert.match(words, /Pipeline Required Changes data Can call 3 methods, 1 of which changes data\./);
  assert.match(
    words,
    /Reports Optional Can call 2 methods that read\. It doesn't ask to change data, so the method that changes data is refused\./,
  );
  // Inactive: it keeps what activating it hands it, and isn't counted as writing.
  assert.match(words, /Archive Required Inactive Can call 3 methods, 1 of which changes data\./);
  assert.doesNotMatch(words, /Archive Required Inactive Changes data/);
  assert.match(words, /MCP tools and search only ever read\./);
});

test("read-only: an app that asks to change data says so, and nothing is counted as writing", () => {
  const words = list(props({ changesAllowed: false }), { state: "read", calls: [] });
  assert.match(words, /Used by 2 active apps · none can change data\./);
  assert.match(
    words,
    /Pipeline Required Read-only here Can call 2 methods that read\. It asks to change data, and the method that changes data is off while this connector is read-only\./,
  );
  assert.doesNotMatch(words, /Changes data/);
});

test("the calls each app made, how many failed, and a method it can't call now", () => {
  const words = list(props({ changesAllowed: false }), {
    state: "read",
    calls: [call("pipeline", "listDeals", 1240, 2), call("pipeline", "createDeal", 3), call("reports", "getDeal", 1)],
  });
  assert.match(words, /In the last 30 days: listDeals 1,240, 2 failed · createDeal 3, not callable now/);
  assert.match(words, /Reports Optional .*In the last 30 days: getDeal 1/);
  assert.match(words, /Archive .*No calls in the last 30 days\./);
});

test("a refused call is counted apart", () => {
  const words = list(props(), { state: "read", calls: [call("reports", "createDeal", 0, 0, null, 2)] });
  assert.match(words, /In the last 30 days: createDeal 0, 2 refused, not callable now/);
});

test("calls from an app that doesn't declare it now, and from no app, are listed apart", () => {
  const words = list(props(), {
    state: "read",
    calls: [call("crm-sync", "listDeals", 7, 0, "CRM Sync"), call("gone", "getDeal", 2), call(null, "listDeals", 1)],
  });
  assert.match(
    words,
    /Called in the last 30 days by apps that don't declare it now CRM Sync: listDeals 7 gone: getDeal 2 No app recorded: listDeals 1/,
  );
});

test("unreadable telemetry is said as such, never as no calls", () => {
  const words = list(props(), { state: "unknown" });
  assert.match(words, /Couldn't read which methods it called\./);
  assert.doesNotMatch(words, /No calls/);
});

test("unreadable switches: a warning, and every app counted as running", () => {
  const words = list(props({ active: null }), { state: "read", calls: [] });
  assert.match(words, /Used by 3 apps · 2 can change data\./);
  assert.match(words, /Couldn't read which apps are active, so every app is shown as if it runs\./);
  assert.doesNotMatch(words, /Inactive/);
});

test("the credential: each person's own, or none at all for a public API", () => {
  assert.match(
    list(props({ userScoped: true }), { state: "read", calls: [] }),
    /Each person connects their own account, and an app uses it only on that person's requests\./,
  );
  const open = list(props({ authenticates: false }), { state: "read", calls: [] });
  assert.doesNotMatch(open, /same credential|their own account/);
});

test("disabled, and a grant without the write scopes, each say what they stop", () => {
  const disabled = list(props({ disabled: true }), { state: "read", calls: [] });
  assert.match(disabled, /While it is disabled, none of them can call it\./);
  const grant = list(props({ writeGrantMissing: true }), { state: "read", calls: [] });
  assert.match(grant, /the provider refuses these apps' changes until someone connects again/);
  // Nobody can write anyway: nothing to warn about.
  const readOnly = list(props({ writeGrantMissing: true, changesAllowed: false }), { state: "read", calls: [] });
  assert.doesNotMatch(readOnly, /provider refuses/);
});

test("while the calls stream in, the rows show without them", () => {
  const pending = new Promise<ObservedCalls | null>(() => {});
  const words = text(renderToStaticMarkup(createElement(ConnectorReachSection, { ...props(), observed: pending })));
  assert.match(words, /Reach Used by 2 active apps/);
  assert.match(words, /Reading the last 30 days' calls…/);
});

test("once they arrive, each app's calls fill its row", async () => {
  const observed = Promise.resolve<ObservedCalls | null>({ crm: [call("pipeline", "listDeals", 5)], other: [] });
  const { prelude } = await prerender(createElement(ConnectorReachSection, { ...props(), observed }));
  const words = text(await new Response(prelude).text());
  assert.match(words, /Pipeline Required Changes data Can call 3 methods, 1 of which changes data\. In the last 30 days: listDeals 5/);
  assert.doesNotMatch(words, /Reading the last/);

  const unread = await prerender(
    createElement(ConnectorReachSection, { ...props(), observed: Promise.resolve<ObservedCalls | null>(null) }),
  );
  assert.match(text(await new Response(unread.prelude).text()), /Couldn't read which methods it called\./);
});

const own = (appSlug: string, state: "ready" | "needs-authorization" | "unconfigured" | "unreadable" = "ready") => ({
  appSlug,
  state,
  configuredAt: null,
  configuredBy: null,
  verifiedAt: null,
  verifiedDetail: null,
});
const setup = {
  displayName: "Acme CRM",
  fields: [{ key: "apiKey", label: "API Key", type: "password" as const }],
  isOAuth: false,
  actions: { configure: async () => true, test: async () => ({ ok: true as const, detail: null }), remove: async () => {} },
};

test("an app with credentials of its own says so, and the sentence counts who shares", () => {
  const words = list(props({ ownCredentials: [own("pipeline")], ownCredentialsSetup: setup }), { state: "read", calls: [] });
  assert.match(words, /2 use the shared credential, and one uses its own\./);
  assert.match(words, /Pipeline Required Changes data Own credentials Its own credentials…/);
  assert.match(words, /Reports Optional Give it its own credentials…/);
  // Every one with its own.
  const all = list(
    props({ ownCredentials: [own("pipeline"), own("reports"), own("archive", "unreadable")], ownCredentialsSetup: setup }),
    { state: "read", calls: [] },
  );
  assert.match(all, /Each of them uses credentials of its own\./);
  assert.match(all, /Own credentials · unreadable/);
  // A row an app no longer declares doesn't count.
  const stray = list(props({ ownCredentials: [own("gone")] }), { state: "read", calls: [] });
  assert.match(stray, /They all use the same credential/);
});

test("without the setup, a user-scoped or public connector, there is no way to give one", () => {
  const words = list(props({ userScoped: true }), { state: "read", calls: [] });
  assert.doesNotMatch(words, /its own credentials…/);
});

test("the panel for one app: it replaces the shared ones, never falls back, and saves under its slug", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorReachSection, {
      ...props({ ownCredentials: [own("pipeline", "needs-authorization")] }),
      ownCredentialsSetup: { ...setup, isOAuth: true },
      initialApp: "pipeline",
    }),
  );
  const words = text(html);
  assert.match(words, /Pipeline uses these instead of the shared credentials, wherever its code reaches Acme CRM\./);
  assert.match(words, /If they stop working, it doesn't fall back to the shared ones\./);
  assert.match(words, /Own credentials · not connected/);
  assert.match(words, /Update its credentials Connect its account Verify its connection Use the shared credentials/);
  assert.match(html, /name="appSlug" value="pipeline"/);
  assert.match(html, /name="apiKey"/);
  // Connect names the app only in the start URL's own parameter, sealed into the cookie there.
  assert.match(
    html,
    /href="\/api\/connectors\/crm\/oauth\/start\?app=pipeline&amp;return=%2Fadmin%2Fconnectors%3Fconnector%3Dcrm%26app%3Dpipeline"/,
  );
  // Before it has any: no Connect, Verify or way back yet.
  const fresh = text(
    renderToStaticMarkup(
      createElement(ConnectorReachSection, { ...props(), ownCredentialsSetup: setup, initialApp: "reports" }),
    ),
  );
  assert.match(fresh, /Save its credentials/);
  assert.doesNotMatch(fresh, /Verify its connection|Use the shared credentials|Connect its account/);
});

test("limits: a Limited pill, and a panel that only narrows", () => {
  const narrowed = {
    ...props(),
    reach: connectorReach({
      connector: { name: "crm", telemetry: METHODS },
      apps: APPS,
      active: { pipeline: true, reports: true, archive: false },
      disabled: false,
      changesAllowed: true,
      narrowings: { pipeline: { writes: "deny", methods: null } },
    }),
    limitsSetup: {
      methods: METHODS.map((m) => ({ method: m.method, mutates: m.mutates === true })),
      setLimits: async () => {},
    },
  };
  const words = text(renderToStaticMarkup(createElement(ReachList, { ...narrowed, observed: { state: "read", calls: [] }, openApp: "limits:pipeline" })));
  assert.match(words, /Pipeline Required Limited Limits…|Pipeline Required Limited Close/);
  assert.match(words, /It asks to change data, and an admin took its writes away here\./);
  assert.match(words, /Narrow what Pipeline may call here\. This only takes away/);
  assert.match(words, /Can't change data, even though it asks to/);
  assert.match(words, /Methods it may call listDeals getDeal createDeal Changes data/);
  assert.match(words, /Save its limits Remove its limits/);
  // Reports doesn't ask to write: its panel offers only its reads.
  const reports = text(
    renderToStaticMarkup(createElement(ReachList, { ...narrowed, observed: { state: "read", calls: [] }, openApp: "limits:reports" })),
  );
  assert.match(reports, /Narrow what Reports may call here/);
  assert.doesNotMatch(reports.slice(reports.indexOf("Narrow what Reports")), /createDeal|even though it asks/);
});

test("no app declares it", () => {
  const p = props();
  const words = text(
    renderToStaticMarkup(createElement(ConnectorReachSection, { ...p, reach: { ...p.reach, apps: [] } })),
  );
  assert.match(words, /Reach No app uses this connector yet\./);
});

test("the tile says who it reaches, at a glance", () => {
  const tile = (reach: ReturnType<typeof props>["reach"]) =>
    text(
      renderToStaticMarkup(
        createElement(ConnectorTile, {
          connector: {
            name: "crm",
            displayName: "Acme CRM",
            description: "A CRM.",
            telemetry: METHODS,
            state: "ready",
            disabledAt: null,
            replacement: null,
            reach,
            authors: [],
            lastUpdated: null,
          } as unknown as ConnectorWithStatus,
          onConfigure: () => {},
          onDisable: () => {},
          onEnable: () => {},
          switching: false,
        }),
      ),
    );
  const p = props();
  assert.match(tile(p.reach), /Used by 2 active apps · 1 can change data/);
  assert.doesNotMatch(tile({ ...p.reach, apps: [] }), /Used by|Declared by/);
});
