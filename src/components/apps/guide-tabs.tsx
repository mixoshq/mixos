/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { appRegistry } from "@/generated/app-registry";
import { Expander } from "@/components/guide-primitives";
import GuideTabsShell, { type GuideTabDef } from "@/components/guide-tabs-shell";

const TABS: Array<{ id: string; label: string; file: string }> = [
  { id: "architecture", label: "Architecture", file: "architecture.md" },
  { id: "pages", label: "Pages", file: "pages.md" },
  { id: "widgets", label: "Widgets", file: "widgets.md" },
  { id: "api", label: "API Routes", file: "api-routes.md" },
  { id: "roles", label: "Roles & Permissions", file: "roles.md" },
  { id: "assets", label: "Assets", file: "assets.md" },
  { id: "connectors", label: "Connectors", file: "connectors.md" },
  { id: "database", label: "Database", file: "database.md" },
  { id: "notifications", label: "Notifications", file: "notifications.md" },
  { id: "scheduled-jobs", label: "Scheduled Jobs", file: "scheduled-jobs.md" },
  { id: "data-freshness", label: "Data Freshness", file: "data-freshness.md" },
  { id: "hooks", label: "Hooks", file: "hooks.md" },
  { id: "app-services", label: "App Services", file: "app-services.md" },
  { id: "ux", label: "UX & Visual Quality", file: "ux.md" },
  { id: "app-shell", label: "App Shell & IA", file: "app-shell.md" },
  { id: "telemetry", label: "Telemetry", file: "telemetry.md" },
  { id: "mcp", label: "MCP Tools", file: "mcp.md" },
];

async function readDoc(file: string): Promise<string> {
  const filePath = path.join(process.cwd(), "docs", "apps", file);
  return fs.readFile(filePath, "utf8");
}

interface GuideTabsProps {
  registeredSlugs: string[];
}

export default async function GuideTabs({ registeredSlugs }: GuideTabsProps) {
  const markdowns = await Promise.all(TABS.map((t) => readDoc(t.file)));

  const registeredApps = appRegistry
    .filter((a) => registeredSlugs.includes(a.slug))
    .filter(
      (a) =>
        a.hooks.emits.actions.length > 0 ||
        a.hooks.emits.filters.length > 0 ||
        a.hooks.listens.actions.length > 0 ||
        a.hooks.listens.filters.length > 0,
    );

  const hooksAppend =
    registeredApps.length > 0 ? (
      <div className="mt-6 space-y-2">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Registered Apps
        </p>
        {registeredApps.map((app) => {
          const listens = [
            ...app.hooks.listens.actions,
            ...app.hooks.listens.filters,
          ];
          return (
            <Expander key={app.slug} title={`${app.name} (${app.slug})`}>
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">{app.description}</p>
                <div>
                  <p className="font-medium">Actions</p>
                  {app.hooks.emits.actions.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {app.hooks.emits.actions.map((h) => (
                        <li key={h}>
                          <code className="rounded bg-muted px-1 py-0.5 text-xs">
                            {h}
                          </code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      No actions registered. When added, they will be prefixed
                      as{" "}
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {app.slug}:&lt;action-name&gt;
                      </code>
                    </p>
                  )}
                </div>
                <div>
                  <p className="font-medium">Filters</p>
                  {app.hooks.emits.filters.length > 0 ? (
                    <ul className="mt-1 space-y-0.5">
                      {app.hooks.emits.filters.map((h) => (
                        <li key={h}>
                          <code className="rounded bg-muted px-1 py-0.5 text-xs">
                            {h}
                          </code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-muted-foreground">
                      No filters registered. When added, they will be prefixed
                      as{" "}
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {app.slug}:&lt;filter-name&gt;
                      </code>
                    </p>
                  )}
                </div>
                {listens.length > 0 && (
                  <div>
                    <p className="font-medium">Listens for</p>
                    <ul className="mt-1 space-y-0.5">
                      {listens.map((h) => (
                        <li key={h}>
                          <code className="rounded bg-muted px-1 py-0.5 text-xs">
                            {h}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Expander>
          );
        })}
      </div>
    ) : null;

  const serviceApps = appRegistry
    .filter((a) => registeredSlugs.includes(a.slug))
    .filter((a) => a.provides.length > 0 || a.consumes.length > 0);

  const appServicesAppend =
    serviceApps.length > 0 ? (
      <div className="mt-6 space-y-2">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Registered Apps
        </p>
        {serviceApps.map((app) => (
          <Expander key={app.slug} title={`${app.name} (${app.slug})`}>
            <div className="space-y-3 text-sm">
              {app.provides.length > 0 && (
                <div>
                  <p className="font-medium">Provides</p>
                  <ul className="mt-1 space-y-0.5">
                    {app.provides.map((s) => (
                      <li key={s.name}>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          {app.slug}:{s.name}
                        </code>{" "}
                        <span className="text-muted-foreground">
                          ({s.audience ?? "user"} ·{" "}
                          {s.consumers === "*"
                            ? "any consumer"
                            : `${s.consumers.length} consumer(s)`}
                          )
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {app.consumes.length > 0 && (
                <div>
                  <p className="font-medium">Consumes</p>
                  <ul className="mt-1 space-y-0.5">
                    {app.consumes.map((d) => (
                      <li key={`${d.app}:${d.service}`}>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          {d.app}:{d.service}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Expander>
        ))}
      </div>
    ) : null;

  const mcpApps = appRegistry
    .filter((a) => registeredSlugs.includes(a.slug))
    .filter((a) => a.mcp.length > 0);

  const mcpAppend =
    mcpApps.length > 0 ? (
      <div className="mt-6 space-y-2">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Registered Apps
        </p>
        {mcpApps.map((app) => (
          <Expander key={app.slug} title={`${app.name} (${app.slug})`}>
            <div className="space-y-3 text-sm">
              <ul className="space-y-1.5">
                {app.mcp.map((t) => (
                  <li key={t.name}>
                    <code className="rounded bg-muted px-1 py-0.5 text-xs">
                      {app.slug}__{t.name}
                    </code>
                    <p className="mt-0.5 text-muted-foreground">{t.description}</p>
                    {t.hint && (
                      <p className="mt-0.5 text-xs italic text-muted-foreground">
                        {t.hint}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </Expander>
        ))}
      </div>
    ) : null;

  const tabs: GuideTabDef[] = TABS.map((t, i) => ({
    id: t.id,
    label: t.label,
    markdown: markdowns[i],
    append:
      t.id === "hooks"
        ? hooksAppend
        : t.id === "app-services"
          ? appServicesAppend
          : t.id === "mcp"
            ? mcpAppend
            : undefined,
  }));

  return <GuideTabsShell tabs={tabs} />;
}
