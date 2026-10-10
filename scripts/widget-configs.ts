/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { FatalManifestError } from "./manifest-errors";

/**
 * Merge `widgets.ts` config fields into the manifest's widget entries.
 *
 * A widget's `config` is the one part of a manifest that repeats: four widgets
 * wanting a title, a selection and a display mode is the same four field
 * objects written out four times. Helpers in @/lib/apps/widget-config-presets
 * collapse that, and they also derive the widget's config TYPE — neither of
 * which JSON can do.
 *
 * So `widgets.ts` is optional, and narrow: it supplies config arrays and
 * nothing else. Identity, permissions, egress, roles and every other field a
 * reviewer cares about stay in `app.json`, as text.
 *
 *     // apps/my-app/widgets.ts
 *     export default {
 *       "widgets/favorites.tsx": favoritesConfigFields,
 *     };
 *
 * Keyed by `component`, which is a path and therefore already unique within an
 * app — `name` is prose and free to collide.
 *
 * ## Drift is refused, not reconciled
 *
 * Splitting one manifest across two files invents a way for them to disagree.
 * Both directions throw rather than shrug: a key naming no widget is a typo or
 * a rename that missed a file, and a widget declaring `config` in BOTH places
 * has two sources of truth and no rule for picking one. Neither is a state
 * anyone means to be in, and a generator that quietly picks a winner is how
 * someone edits the file that is being ignored.
 *
 * Every refusal is a `FatalManifestError`, which aborts the build, as a schema
 * error in `app.json` does. A per-app skip would leave the build green with
 * the app missing from the registry, which nobody notices until they look for
 * the app.
 */
export async function applyWidgetConfigs(
  appDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const tsPath = path.join(appDir, "widgets.ts");
  if (!fs.existsSync(tsPath)) return;

  const slug = path.basename(appDir);

  // tsx's ESM loader handles transpilation. Append a cache-busting query so
  // repeated generator runs during `next dev` pick up edits.
  const href = `${pathToFileURL(tsPath).href}?t=${Date.now()}`;
  let mod: { default?: unknown };
  try {
    mod = (await import(href)) as { default?: unknown };
  } catch (err) {
    throw new FatalManifestError(
      `apps/${slug}/widgets.ts could not be imported: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const byComponent = mod.default;

  if (!byComponent || typeof byComponent !== "object" || Array.isArray(byComponent)) {
    throw new FatalManifestError(
      `apps/${slug}/widgets.ts must default-export an object keyed by each ` +
        `widget's "component" path, e.g. { "widgets/foo.tsx": fooConfigFields }.`,
    );
  }

  const widgets = Array.isArray(manifest.widgets)
    ? (manifest.widgets as Record<string, unknown>[])
    : [];
  const declared = new Set(
    widgets.map((w) => String(w.component ?? "")).filter(Boolean),
  );

  for (const [component, fields] of Object.entries(
    byComponent as Record<string, unknown>,
  )) {
    if (!declared.has(component)) {
      throw new FatalManifestError(
        `apps/${slug}/widgets.ts has config for "${component}", which no widget ` +
          `in app.json declares. Known components: ${[...declared].join(", ") || "(none)"}.`,
      );
    }
    if (!Array.isArray(fields)) {
      throw new FatalManifestError(
        `apps/${slug}/widgets.ts: "${component}" must map to an array of config fields.`,
      );
    }
  }

  for (const widget of widgets) {
    const component = String(widget.component ?? "");
    const fields = (byComponent as Record<string, unknown>)[component];
    if (fields === undefined) continue;
    if (widget.config !== undefined) {
      throw new FatalManifestError(
        `apps/${slug}: widget "${component}" declares config in BOTH app.json and ` +
          `widgets.ts. Keep it in one — app.json for plain fields, widgets.ts for ` +
          `fields built from presets.`,
      );
    }
    // Plain data by the time it lands here; the registry is serialised with
    // JSON.stringify, so anything else would not survive the write.
    widget.config = fields;
  }
}
