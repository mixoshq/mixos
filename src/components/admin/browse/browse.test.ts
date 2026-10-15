/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What Browse renders, on the server: no Install & Activate, a pending
 * install's tile leading to its review, where an installed one came from, and
 * a built deployment saying how installing works, as information, in place of
 * an install it would refuse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { RegistryInstall } from "@/lib/repository/install-record";
import { BUILT_DEPLOYMENT_NOTICE } from "@/lib/platform/build";
import { provenanceOf, type Provenance } from "@/lib/repository/provenance";
import ExtensionBrowser from "./extension-browser";
import ExtensionCard from "./extension-card";
import FloorNotice from "./floor-notice";
import RegisterDialog from "./register-dialog";

/** The app router a page has, which the review dialog's refresh needs. Nothing navigates here. */
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
} as unknown as AppRouterInstance;
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, element));
/** The text a reader sees, tags and entities aside. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("a built deployment's Browse page says how installing works, as information", () => {
  const html = render(
    createElement(ExtensionBrowser, {
      kind: "app",
      repositoryOrigin: "https://mixos.org",
      repositoryOverridable: false,
      installed: {},
      pendingSlugs: [],
      installable: BUILT_DEPLOYMENT_NOTICE,
      installableTone: "info",
    }),
  );
  const notice = html.match(/<div role="status" data-tone="(\w+)"[^>]*>(.*?)<\/div><\/div><\/div>/);
  assert.ok(notice, "no notice");
  assert.equal(notice[1], "info");
  assert.equal(
    text(notice[2]).trim(),
    "This deployment runs a build. Install and register in a checkout of your repository, commit, and deploy.",
  );
  assert.doesNotMatch(html, /border-warning/);
  assert.doesNotMatch(text(html), /cannot|not writable/);
});

test("its install dialog shows the release and the same notice, without offering to install", () => {
  const html = render(
      createElement(RegisterDialog, {
        extension: {
          slug: "acme",
          kind: "app",
          name: "Acme Board",
          tagline: "",
          categories: [],
          keywords: [],
          author: { handle: "acme", verified: false },
          license: "MIT",
          installCount: 0,
          featured: false,
          latestVersion: "1.2.0",
        },
        notInstallable: { message: BUILT_DEPLOYMENT_NOTICE, tone: "info" },
        onClose: () => {},
        onInstalled: () => {},
        onReview: () => {},
      }),
  );
  const seen = text(html);
  assert.match(html, /data-tone="info"/);
  assert.ok(seen.includes(BUILT_DEPLOYMENT_NOTICE));
  assert.match(seen, /Close/);
  assert.doesNotMatch(seen, /Verify and install/);
});

test("the install dialog says whether this checkout meets the release's floor", () => {
  const floor = (declared: string | null, met: boolean, checked = declared !== null, where: "checkout" | "deployment" = "checkout") => ({
    declared,
    current: "0.1.0",
    where,
    met,
    checked,
    reason: null,
  });
  const shown = (f: ReturnType<typeof floor>, installable = true) =>
    render(createElement(FloorNotice, { floor: f, installable }));

  const met = shown(floor("0.1.0", true));
  assert.equal(text(met).trim(), "Requires MixOS 0.1.0 or newer. This checkout runs 0.1.0, which meets it.");
  assert.doesNotMatch(met, /data-tone/);

  // Install refuses it, so it is a warning, with what to do.
  const unmet = shown(floor("0.2.0", false));
  assert.match(unmet, /data-tone="warning"/);
  assert.equal(
    text(unmet).trim(),
    "Requires MixOS 0.2.0 or newer. This checkout runs 0.1.0, which doesn't meet it. Upgrade MixOS to install this release.",
  );
  // A built deployment doesn't install, so there's nothing to upgrade first.
  const built = shown(floor("0.2.0", false, true, "deployment"), false);
  assert.equal(text(built).trim(), "Requires MixOS 0.2.0 or newer. This deployment runs 0.1.0, which doesn't meet it.");

  assert.equal(shown(floor(null, true)), "");
  assert.match(text(shown(floor("soon", true, false))), /Its minimum MixOS version, "soon", isn't a version, so it isn't checked\./);
});

test("Browse has no Install & Activate, and a pending install's tile leads to its review", () => {
  const extension = {
    slug: "acme",
    kind: "app" as const,
    name: "Acme Board",
    tagline: "Boards.",
    categories: [],
    keywords: [],
    author: { handle: "acme", verified: false },
    license: "MIT",
    installCount: 3,
    featured: false,
    latestVersion: "1.2.0",
  };
  const card = (pending: boolean) =>
    text(
      render(
        createElement(ExtensionCard, {
          extension,
          repositoryOrigin: "https://mixos.org",
          installed: null,
          pendingSlugs: new Set(pending ? ["acme"] : []),
          onInstall: () => {},
          onReview: () => {},
        }),
      ),
    );
  assert.doesNotMatch(card(false), /Activate/);
  assert.match(card(false), /\bInstall\b/);
  assert.match(card(true), /Review and register/);
  assert.doesNotMatch(card(true), /\bInstall\b(?!s)/);
});

// ── where an installed one came from ────────────────────────────────────────

const install = (fields: Partial<RegistryInstall> = {}): RegistryInstall => ({
  kind: "app",
  slug: "acme",
  version: "1.2.0",
  gitTag: "v1.2.0",
  commitSha: "c".repeat(40),
  source: "https://mixos.org",
  repository: { owner: "acme", name: "mixos-acme", subpath: null },
  requiresMixOS: null,
  modified: false,
  ...fields,
});

test("an installed extension's listing says where it came from, in one of three lines, with no button", () => {
  const extension = {
    slug: "acme",
    kind: "app" as const,
    name: "Acme Board",
    tagline: "Boards.",
    categories: [],
    keywords: [],
    author: { handle: "acme", verified: false },
    license: "MIT",
    installCount: 3,
    featured: false,
    latestVersion: "1.2.0",
  };
  const card = (installed: Provenance) =>
    render(
      createElement(ExtensionCard, {
        extension,
        repositoryOrigin: "https://mixos.org",
        installed,
        pendingSlugs: new Set<string>(),
        onInstall: () => {},
        onReview: () => {},
      }),
    );
  const line = (installs: RegistryInstall[], origin = "https://mixos.org") =>
    text(card(provenanceOf("app", "acme", installs, origin))).trim();

  assert.match(line([install()]), /Installed from mixos\.org · 1\.2\.0 View listing$/);
  assert.match(line([install({ modified: true })]), /Installed from mixos\.org · 1\.2\.0 · modified locally View listing$/);
  assert.match(line([install({ source: "http://localhost:4321" })]), /Installed from localhost:4321; not checked here View listing$/);
  assert.match(line([]), /A local extension uses this name View listing$/);
  // Another kind's record, or another slug's, isn't this one's.
  assert.match(line([install({ kind: "connector" }), install({ slug: "other" })]), /A local extension uses this name/);
  // A catalogue other than mixos.org, when it is the one being browsed.
  assert.match(
    line([install({ source: "http://127.0.0.1:4388", version: "9f2be41" })], "http://127.0.0.1:4388"),
    /Installed from 127\.0\.0\.1:4388 · 9f2be41/,
  );
  // No install button for any of them, and never the bare "Installed" of before.
  for (const html of [card({ from: "local" }), card({ from: "elsewhere", host: "localhost:4321" })]) {
    assert.doesNotMatch(html, /<button/);
    assert.doesNotMatch(text(html), /\bInstalled\b(?! from)/);
  }
});

test("one installed from this catalogue offers Update in a checkout, how to update on a built deployment, and its review once one waits", () => {
  const extension = {
    slug: "acme",
    kind: "app" as const,
    name: "Acme Board",
    tagline: "Boards.",
    categories: [],
    keywords: [],
    author: { handle: "acme", verified: false },
    license: "MIT",
    installCount: 3,
    featured: false,
    latestVersion: "1.3.0",
  };
  const card = (fields: Partial<Parameters<typeof ExtensionCard>[0]> = {}, installed = provenanceOf("app", "acme", [install()], "https://mixos.org")) =>
    text(
      render(
        createElement(ExtensionCard, {
          extension,
          repositoryOrigin: "https://mixos.org",
          installed,
          pendingSlugs: new Set<string>(),
          onInstall: () => {},
          onReview: () => {},
          ...fields,
        }),
      ),
    ).trim();

  assert.match(card({ onUpdate: () => {} }), /Installed from mixos\.org · 1\.2\.0 Update View listing$/);
  // The current release in place: another release can still be picked.
  assert.match(card({ onUpdate: () => {}, extension: { ...extension, latestVersion: "1.2.0" } }), /Installed from mixos\.org · 1\.2\.0 Change release View listing$/);
  assert.match(card({ updateHelpUrl: "https://mixos.org/docs/install/after-you-install#updating-an-extension" }), /Installed from mixos\.org · 1\.2\.0 How to update \(opens in a new tab\) View listing$/);
  assert.match(card({ onUpdate: () => {}, pendingSlugs: new Set(["acme"]) }), /Installed from mixos\.org · 1\.2\.0 Review and register View listing$/);
  // Nothing to update for one from another catalogue, or a local one.
  assert.doesNotMatch(card({ onUpdate: () => {} }, provenanceOf("app", "acme", [install({ source: "http://localhost:4321" })], "https://mixos.org")), /Update/);
  assert.doesNotMatch(card({ onUpdate: () => {} }, provenanceOf("app", "acme", [], "https://mixos.org")), /Update/);
});
