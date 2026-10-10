/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptLogo,
  acceptName,
  eligibleFilters,
  LastGood,
  onceReporter,
  runFilters,
  type BrandApp,
  type BrandProblem,
  type BrandRegistration,
} from "./bounded";
import type { BrandHook, BrandLogo, BrandLogoAsset } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────

function app(slug: string, hooks: BrandHook[], logos: BrandLogoAsset[] = []): BrandApp {
  return { slug, branding: { hooks, reason: "Fixture app for the brand tests.", logos } };
}

function reg(
  appSlug: string | undefined,
  callback: (value: unknown) => unknown,
  { priority = 10, entrypoint = true } = {},
): BrandRegistration {
  return { appSlug, callback, priority, entrypoint };
}

function problems() {
  const seen: BrandProblem[] = [];
  return { seen, report: (p: BrandProblem) => void seen.push(p) };
}

const mark: BrandLogo = { src: "/themes/mixos/logo.png", width: 256, height: 244 };
const acmeMark: BrandLogoAsset = {
  file: "branding/acme.png",
  url: "/branding/apps/acme/acme.png",
  width: 600,
  height: 150,
};

// ── which filters count ─────────────────────────────────────────────────────

test("only declared registrations from an app's hooks.ts count", () => {
  const apps = [app("acme", ["brand-name"]), app("other", ["login-logo"])];
  const counted = reg("acme", () => "Acme");
  const filters = eligibleFilters(
    "brand-name",
    [
      counted,
      reg(undefined, () => "Bare singleton"),
      reg("acme", () => "Per-request registrar", { entrypoint: false }),
      reg("other", () => "Undeclared for this hook"),
      reg("uninstalled", () => "Not in the registry"),
    ],
    apps,
  );
  assert.deepEqual(
    filters.map((f) => f.registration),
    [counted],
  );
});

test("filters run by priority, then slug — never by registration order", () => {
  const apps = ["zeta", "alpha", "mid"].map((s) => app(s, ["brand-name"]));
  const filters = eligibleFilters(
    "brand-name",
    [
      reg("zeta", () => "z"),
      reg("alpha", () => "a"),
      reg("mid", () => "m", { priority: 5 }),
    ],
    apps,
  );
  assert.deepEqual(
    filters.map((f) => f.app.slug),
    ["mid", "alpha", "zeta"],
  );
});

// ── running them ────────────────────────────────────────────────────────────

test("each filter receives the previous one's value; the last one's wins", async () => {
  const apps = [app("alpha", ["brand-name"]), app("beta", ["brand-name"])];
  const seenByBeta: unknown[] = [];
  const filters = eligibleFilters(
    "brand-name",
    [
      reg("beta", (v) => {
        seenByBeta.push(v);
        return "Beta";
      }),
      reg("alpha", () => "Alpha"),
    ],
    apps,
  );
  const { seen, report } = problems();
  const outcome = await runFilters({
    hook: "brand-name",
    seed: "MixOS",
    accept: acceptName,
    filters,
    budgetMs: 1000,
    report,
  });
  assert.deepEqual(seenByBeta, ["Alpha"]);
  assert.deepEqual(outcome, { value: "Beta", clean: true, ran: ["alpha", "beta"] });
  assert.deepEqual(seen, [{ kind: "conflict", hook: "brand-name", apps: ["alpha", "beta"] }]);
});

test("a throw or a refused value keeps the value before it", async () => {
  const apps = [app("a", ["brand-name"]), app("b", ["brand-name"]), app("c", ["brand-name"])];
  const filters = eligibleFilters(
    "brand-name",
    [
      reg("a", () => "Acme"),
      reg("b", () => {
        throw new Error("boom");
      }),
      reg("c", () => "x".repeat(500)),
    ],
    apps,
  );
  const { seen, report } = problems();
  const outcome = await runFilters({
    hook: "brand-name",
    seed: "MixOS",
    accept: acceptName,
    filters,
    budgetMs: 1000,
    report,
  });
  assert.equal(outcome.value, "Acme");
  assert.equal(outcome.clean, false);
  assert.deepEqual(
    seen.map((p) => [p.kind, "app" in p ? p.app : null]),
    [
      ["threw", "b"],
      ["rejected", "c"],
      ["conflict", null],
    ],
  );
});

test("all of a slot's filters share one budget", async () => {
  const apps = [app("a", ["brand-name"]), app("b", ["brand-name"])];
  // A fake clock: the hanging filter "takes" the whole budget the moment it
  // is called, so whether the next one is skipped does not depend on timers.
  let clock = 0;
  const filters = eligibleFilters(
    "brand-name",
    [
      reg("a", () => {
        clock = 50;
        return new Promise(() => {});
      }),
      reg("b", () => "Never asked"),
    ],
    apps,
  );
  const { seen, report } = problems();
  const started = Date.now();
  const outcome = await runFilters({
    hook: "brand-name",
    seed: "MixOS",
    accept: acceptName,
    filters,
    budgetMs: 50,
    report,
    now: () => clock,
  });
  assert.ok(Date.now() - started < 1000, "a hung filter is cut off at the budget");
  assert.deepEqual(outcome, { value: "MixOS", clean: false, ran: ["a"] });
  assert.deepEqual(
    seen.map((p) => p.kind),
    ["timeout", "skipped"],
  );
});

test("a filter cannot change the value it was handed", async () => {
  const apps = [app("acme", ["menu-bar-logo"])];
  const current = { ...mark };
  const filters = eligibleFilters(
    "menu-bar-logo",
    [
      reg("acme", (v) => {
        (v as BrandLogo).src = "https://evil.example/pixel.png";
        return v;
      }),
    ],
    apps,
  );
  const { report } = problems();
  const outcome = await runFilters({
    hook: "menu-bar-logo",
    seed: current,
    accept: acceptLogo,
    filters,
    budgetMs: 1000,
    report,
  });
  // Whether the write threw (strict mode) or was silently dropped, the value
  // carried forward is the platform's own, untouched.
  assert.equal(outcome.value, current);
  assert.equal(current.src, mark.src);
});

// ── what a logo filter may return ───────────────────────────────────────────

test("a logo filter may hide the mark, pass it, or pick its own declared file", () => {
  const acme = app("acme", ["menu-bar-logo"], [acmeMark]);
  assert.equal(acceptLogo(null, acme, mark), null);
  assert.equal(acceptLogo({ ...mark }, acme, mark), mark);
  assert.deepEqual(acceptLogo("branding/acme.png", acme, mark), {
    src: acmeMark.url,
    width: acmeMark.width,
    height: acmeMark.height,
  });
});

test("a logo filter may not return a URL, another app's file, or a look-alike", () => {
  const acme = app("acme", ["menu-bar-logo"], [acmeMark]);
  const other = app("other", ["menu-bar-logo"]);
  assert.equal(acceptLogo("https://evil.example/pixel.png", acme, mark), undefined);
  assert.equal(acceptLogo("branding/acme.png", other, mark), undefined);
  assert.equal(acceptLogo({ src: "/elsewhere.png", width: 1, height: 1 }, acme, mark), undefined);
  assert.equal(acceptLogo(undefined, acme, mark), undefined);
});

// ── last good value ─────────────────────────────────────────────────────────

test("a failed run serves the last clean value for the same apps and theme", () => {
  const store = new LastGood<string>();
  assert.equal(store.settle("k", "mixos", { value: "Acme", clean: true, ran: ["a"] }), "Acme");
  assert.equal(store.settle("k", "mixos", { value: "MixOS", clean: false, ran: [] }), "Acme");
});

test("a stored value from a different key is not served", () => {
  const store = new LastGood<string>();
  store.settle("k1", "mixos", { value: "Acme", clean: true, ran: ["a"] });
  assert.equal(store.settle("k2", "mixos", { value: "Degraded", clean: false, ran: [] }), "Degraded");
});

test("after a lookup failure, the last value under the same theme, else the seed", () => {
  const store = new LastGood<string>();
  assert.equal(store.fallback("mixos", "MixOS"), "MixOS");
  store.settle("k", "mixos", { value: "Acme", clean: true, ran: ["a"] });
  assert.equal(store.fallback("mixos", "MixOS"), "Acme");
  assert.equal(store.fallback("mixos-dark", "MixOS"), "MixOS");
});

// ── logging ─────────────────────────────────────────────────────────────────

test("each distinct problem is logged once", () => {
  const logged: BrandProblem[] = [];
  const report = onceReporter((p) => logged.push(p));
  const rejected: BrandProblem = { kind: "rejected", hook: "brand-name", app: "acme" };
  report(rejected);
  report(rejected);
  report({ kind: "rejected", hook: "login-logo", app: "acme" });
  report({ kind: "threw", hook: "brand-name", app: "acme", error: new Error("x") });
  report({ kind: "threw", hook: "brand-name", app: "acme", error: new Error("y") });
  assert.deepEqual(
    logged.map((p) => `${p.kind}:${p.hook}`),
    ["rejected:brand-name", "rejected:login-logo", "threw:brand-name"],
  );
});
