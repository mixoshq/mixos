/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HookConsentError, HookSystem } from "./hook-system";
import { consentedListens, hookOwner, qualifyHookName, type HookWiring } from "./scope";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A hook system whose active apps are exactly `active`, read on each dispatch. */
function system(active: Iterable<string> = []) {
  const on = new Set(active);
  const sys = new HookSystem();
  sys.setActivation(async (slug) => on.has(slug));
  return { sys, on };
}

function wiring(slug: string, w: Partial<HookWiring> = {}): HookWiring {
  return { slug, emits: [], listensTo: [], ...w };
}

const isConsentError = (err: unknown) => err instanceof HookConsentError;

// ── names ───────────────────────────────────────────────────────────────────

test("a bare name is the app's own; core names and full names are kept", () => {
  assert.equal(qualifyHookName("ready", "crm"), "crm:ready");
  assert.equal(qualifyHookName("user-display-name", "crm"), "user-display-name");
  assert.equal(qualifyHookName("brand-name", "crm"), "brand-name");
  assert.equal(qualifyHookName("sales:deal-won", "crm"), "sales:deal-won");
  assert.equal(hookOwner("sales:deal-won"), "sales");
  assert.equal(hookOwner("init"), null);
  assert.equal(hookOwner("ready"), null);
});

test("consent needs both halves: the listener's listensTo and the emitter's consumers", () => {
  const apps = [
    wiring("sales", {
      emits: [
        { name: "deal-won", consumers: ["reporting"] },
        { name: "deal-lost", consumers: "*" },
        { name: "quota-set", consumers: ["finance"] },
      ],
    }),
    wiring("reporting", {
      listensTo: [
        { app: "sales", hook: "deal-won" },
        { app: "sales", hook: "deal-lost" },
        // Declared, but sales does not allow it.
        { app: "sales", hook: "quota-set" },
        // Declared, but sales emits no such hook.
        { app: "sales", hook: "renamed" },
        // Declared, but there is no such app.
        { app: "gone", hook: "thing" },
      ],
    }),
  ];
  assert.deepEqual(
    [...consentedListens("reporting", apps)].sort(),
    ["sales:deal-lost", "sales:deal-won"],
  );
  // Allowed by "*", but never declared by the listener.
  assert.deepEqual([...consentedListens("sales", apps)], []);
});

// ── listening (RB-15) ───────────────────────────────────────────────────────

test("a registrar refuses a listener on another app's hook it has no consent for", async () => {
  const { sys } = system(["sales", "spy"]);
  const spy = sys.createRegistrar("spy");
  const heard: unknown[] = [];

  assert.throws(() => spy.addAction("sales:deal-won", (d) => void heard.push(d)), isConsentError);
  assert.throws(() => spy.addFilter("sales:discount", (v) => v), isConsentError);

  await sys.createRegistrar("sales").doAction("deal-won", { id: 1 });
  assert.deepEqual(heard, []);
});

test("a consented listener on another app's hook is registered and hears it", async () => {
  const { sys } = system(["sales", "reporting"]);
  const reporting = sys.createRegistrar("reporting", {
    listens: new Set(["sales:deal-won"]),
  });
  const heard: unknown[] = [];
  reporting.addAction("sales:deal-won", (d) => void heard.push(d));

  await sys.createRegistrar("sales").doAction("deal-won", { id: 7 });
  assert.deepEqual(heard, [{ id: 7 }]);
});

test("an app listens to its own hooks and to core hooks with no declaration", async () => {
  const { sys } = system(["crm"]);
  const crm = sys.createRegistrar("crm");
  const heard: string[] = [];
  crm.addAction("ready", () => void heard.push("own, bare"));
  crm.addAction("crm:ready", () => void heard.push("own, full"));
  crm.addFilter("user-display-name", (name: string) => `${name}!`);

  await crm.doAction("ready");
  assert.deepEqual(heard, ["own, bare", "own, full"]);
  assert.equal(await sys.applyFilters("user-display-name", "Ada"), "Ada!");
});

// ── firing (RB-16) ──────────────────────────────────────────────────────────

test("a registrar refuses to fire another app's hook, and nothing hears it", async () => {
  const { sys } = system(["sales", "reporting", "forger"]);
  const heard: unknown[] = [];
  sys
    .createRegistrar("reporting", { listens: new Set(["sales:deal-won"]) })
    .addAction("sales:deal-won", (d) => void heard.push(d));

  const forger = sys.createRegistrar("forger");
  await assert.rejects(forger.doAction("sales:deal-won", { forged: true }), isConsentError);
  await assert.rejects(forger.applyFilters("sales:price", 10), isConsentError);
  assert.deepEqual(heard, []);
});

test("the bare singleton can neither fire nor listen to an app's hook", async () => {
  const { sys } = system(["sales"]);
  await assert.rejects(sys.doAction("sales:deal-won", {}), isConsentError);
  await assert.rejects(sys.applyFilters("sales:price", 10), isConsentError);
  assert.throws(() => sys.addAction("sales:deal-won", () => {}), isConsentError);
  assert.throws(() => sys.addFilter("sales:price", (v) => v), isConsentError);

  // Core hooks are what it is for.
  sys.addFilter("user-display-name", (name: string) => name.toUpperCase());
  assert.equal(await sys.applyFilters("user-display-name", "ada"), "ADA");
});

test("the bare singleton is no back channel: an unprefixed custom name is refused too", async () => {
  const { sys } = system();
  assert.throws(() => sys.addAction("deal-won", () => {}), isConsentError);
  await assert.rejects(sys.doAction("deal-won", { id: 1 }), isConsentError);
});

test("a refused fire does not run the platform's pre-dispatch step", async () => {
  const { sys } = system(["forger"]);
  let prepared = 0;
  const forger = sys.createRegistrar("forger", {
    beforeDispatch: async () => void prepared++,
  });
  await assert.rejects(forger.doAction("sales:deal-won"), isConsentError);
  await forger.doAction("ready");
  assert.equal(prepared, 1);
});

// ── activation (RB-36) ──────────────────────────────────────────────────────

test("an app's listener runs with no dashboard render first, while its app is active", async () => {
  const { sys } = system(["sales", "reporting"]);
  const heard: string[] = [];
  sys
    .createRegistrar("reporting", { listens: new Set(["sales:deal-won"]) })
    .addAction("sales:deal-won", () => void heard.push("reporting"));

  await sys.createRegistrar("sales").doAction("deal-won");
  assert.deepEqual(heard, ["reporting"]);
});

test("activation is read on every dispatch: switching an app off stops its listeners at once", async () => {
  const { sys, on } = system(["crm"]);
  const crm = sys.createRegistrar("crm");
  let calls = 0;
  crm.addAction("ready", () => void calls++);

  await crm.doAction("ready");
  on.delete("crm");
  await crm.doAction("ready");
  on.add("crm");
  await crm.doAction("ready");
  assert.equal(calls, 2);
});

test("unattributed listeners always run; an app's need its app active", async () => {
  const { sys } = system(["on-app"]);
  const ran: string[] = [];
  sys.addAction("init", () => void ran.push("platform"));
  sys.createRegistrar("on-app").addAction("init", () => void ran.push("on-app"));
  sys.createRegistrar("off-app").addAction("init", () => void ran.push("off-app"));

  await sys.doAction("init");
  assert.deepEqual(ran.sort(), ["on-app", "platform"]);
});

test("with no activation check installed, or one that fails, an app's listeners do not run", async () => {
  const bare = new HookSystem();
  const ran: string[] = [];
  bare.addAction("init", () => void ran.push("platform"));
  bare.createRegistrar("crm").addAction("init", () => void ran.push("crm"));
  await bare.doAction("init");
  assert.deepEqual(ran, ["platform"]);

  const failing = new HookSystem();
  failing.setActivation(async () => {
    throw new Error("database unreachable");
  });
  failing.createRegistrar("crm").addAction("init", () => void ran.push("crm"));
  await failing.doAction("init");
  assert.deepEqual(ran, ["platform"]);
});

test("listeners still run in priority order across apps", async () => {
  const { sys } = system(["a", "b"]);
  const order: string[] = [];
  sys.createRegistrar("b").addAction("init", () => void order.push("b:5"), 5);
  sys.createRegistrar("a").addAction("init", () => void order.push("a:20"), 20);
  sys.addAction("init", () => void order.push("platform:10"));

  await sys.doAction("init");
  assert.deepEqual(order, ["b:5", "platform:10", "a:20"]);
});
