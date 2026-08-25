"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import {
  toggleAppRegistration,
  getAppSchema,
  type AppSchemaTable,
} from "@/lib/apps/admin-actions";
import LucideIcon from "@/components/lucide-icon";
import { renderAuthors, formatLastUpdated } from "@/lib/apps/display";
import AppVisibilityPanel from "./app-visibility-panel";
import AppPasswordPanel from "./app-password-panel";

interface MissingConnector {
  name: string;
  displayName: string;
}

interface AppRegisterListProps {
  app: AppManifest;
  registered: boolean;
  missingConnectors: MissingConnector[];
}

export default function AppRegisterList({
  app,
  registered,
  missingConnectors,
}: AppRegisterListProps) {
  const [isPending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(false);
  const [schema, setSchema] = useState<AppSchemaTable[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Block registering when any declared connector lacks tenant config.
  // Deregistering is always allowed, so the gate only fires while !registered.
  const blockRegistration = !registered && missingConnectors.length > 0;
  const toggleDisabled = isPending || blockRegistration;

  useEffect(() => {
    if (!expanded || !app.database || schema !== null || schemaLoading) return;
    setSchemaLoading(true);
    getAppSchema(app.slug)
      .then((s) => setSchema(s))
      .catch((e) => setSchemaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSchemaLoading(false));
  }, [expanded, app.database, app.slug, schema, schemaLoading]);

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (blockRegistration) return;
    setActionError(null);
    startTransition(async () => {
      try {
        await toggleAppRegistration(app.slug, registered);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  return (
    <div>
      <div
        className="flex cursor-pointer items-start justify-between px-6 py-4 hover:bg-accent/50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <LucideIcon name={app.icon} className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">{app.name}</p>
            <p className="text-sm text-muted-foreground">{app.description}</p>
            <div className="mt-1 flex items-center gap-2">
              {app.global && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  Global App
                </span>
              )}
              {app.hasPages && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                  Full App
                </span>
              )}
              {app.widgets.length > 0 && (
                <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                  {app.widgets.length} {app.widgets.length === 1 ? "Widget" : "Widgets"}
                </span>
              )}
              {(app.hookCounts.actions > 0 || app.hookCounts.filters > 0) && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  {app.hookCounts.actions} {app.hookCounts.actions === 1 ? "Action" : "Actions"}, {app.hookCounts.filters} {app.hookCounts.filters === 1 ? "Filter" : "Filters"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className={`flex shrink-0 flex-col items-end gap-3 ${isPending ? "opacity-50" : ""}`}>
          <p className="text-[10px] leading-none text-muted-foreground">
            <strong className="font-semibold">Updated</strong>{" "}
            {formatLastUpdated(app.lastUpdated, "Not yet committed")}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {registered ? "Registered" : "Unregistered"}
            </span>
            <button
              onClick={handleToggle}
              disabled={toggleDisabled}
              aria-disabled={toggleDisabled}
              title={
                blockRegistration
                  ? `Configure these connectors first: ${missingConnectors.map((m) => m.displayName).join(", ")}`
                  : undefined
              }
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                registered ? "bg-mixnavy" : "bg-muted"
              } ${blockRegistration ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span
                className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  registered ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          {app.authors && app.authors.length > 0 && (
            <p className="text-[10px] leading-none text-muted-foreground">
              <strong className="font-semibold">Authored By</strong>{" "}
              {renderAuthors(app.authors)}
            </p>
          )}
        </div>
      </div>

      {blockRegistration && (
        <div
          className="border-l-4 border-mixcoral bg-mixcoral/10 px-6 py-2.5 dark:bg-mixcoral/20"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mixcoral" />
            <span>
              <span className="font-semibold">{app.name}</span> can't be
              registered until{" "}
              {missingConnectors.map((m, i) => (
                <span key={m.name}>
                  {i > 0 && (i === missingConnectors.length - 1 ? " and " : ", ")}
                  <span className="font-semibold">{m.displayName}</span>
                </span>
              ))}{" "}
              {missingConnectors.length === 1 ? "is" : "are"} configured.{" "}
              <Link
                href="/admin/connectors"
                className="font-medium text-mixcoral underline underline-offset-2"
              >
                Open Connector Registry →
              </Link>
            </span>
          </p>
        </div>
      )}

      {actionError && (
        <div
          className="bg-rose-500/15 px-6 py-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="flex items-start gap-2 text-xs text-rose-700 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{actionError}</span>
          </p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border bg-accent/20 px-6 py-4 pl-12">
          {(() => {
            const declaresPassword = (
              sets: Record<string, string[]> | undefined,
            ) => Object.values(sets ?? {}).some((a) => a.includes("password"));
            const hasPasswordRoute =
              declaresPassword(app.pageVisibility) ||
              declaresPassword(app.apiVisibility);
            return (
              <>
                <AppVisibilityPanel app={app} />
                {hasPasswordRoute && (
                  <AppPasswordPanel slug={app.slug} appName={app.name} />
                )}
              </>
            );
          })()}
          <div className="mt-4 grid grid-cols-4 gap-6 text-sm">
            <div>
              <p className="font-medium">Widgets</p>
              {app.widgets.length > 0 ? (
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {app.widgets.map((w) => (
                    <li key={w.id}>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">{w.id}</code>
                      {" "}&mdash; {w.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">None</p>
              )}
            </div>
            <div>
              <p className="font-medium">Connectors</p>
              {app.connectors.length > 0 ? (
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {/*
                    Every connector is tenant-scoped, so the name is the whole
                    story here. This list used to badge some of them
                    "(per-user)"; the user-scoped OAuth model that badge
                    described was removed along with the generated
                    `userScopedConnectorNames` set it read from. See
                    docs/connectors/architecture.md.
                  */}
                  {app.connectors.map((name) => (
                    <li key={name}>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {name}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">None</p>
              )}
            </div>
            <div>
              <p className="font-medium">Database</p>
              {!app.database ? (
                <p className="mt-1 text-muted-foreground">None</p>
              ) : schemaLoading ? (
                <p className="mt-1 text-muted-foreground">Loading schema…</p>
              ) : schemaError ? (
                <p className="mt-1 text-destructive">Error: {schemaError}</p>
              ) : schema && schema.length > 0 ? (
                <ul className="mt-1 space-y-2 text-muted-foreground">
                  {schema.map((t) => (
                    <li key={t.name}>
                      <code className="rounded bg-muted px-1 py-0.5 text-xs">
                        {t.name}
                      </code>
                      <ul className="mt-1 ml-3 space-y-0.5">
                        {t.columns.map((c) => (
                          <li key={c.name} className="text-xs">
                            {c.name}{" "}
                            <span className="text-muted-foreground/70">
                              &mdash; {c.type}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  Scoped database enabled (no tables)
                </p>
              )}
            </div>
            <div>
              <p className="font-medium">Hooks</p>
              {(() => {
                const emits = [
                  ...app.hooks.emits.actions,
                  ...app.hooks.emits.filters,
                ];
                const listens = [
                  ...app.hooks.listens.actions,
                  ...app.hooks.listens.filters,
                ];
                if (emits.length === 0 && listens.length === 0) {
                  return <p className="mt-1 text-muted-foreground">None</p>;
                }
                return (
                  <div className="mt-1 space-y-2 text-muted-foreground">
                    {emits.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider">
                          Fires
                        </p>
                        <ul className="mt-0.5 space-y-0.5">
                          {emits.map((h) => (
                            <li key={`emit-${h}`}>
                              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                                {h}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {listens.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider">
                          Listens
                        </p>
                        <ul className="mt-0.5 space-y-0.5">
                          {listens.map((h) => (
                            <li key={`listen-${h}`}>
                              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                                {h}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div>
              <p className="font-medium">App Services</p>
              {app.provides.length === 0 && app.consumes.length === 0 ? (
                <p className="mt-1 text-muted-foreground">None</p>
              ) : (
                <div className="mt-1 space-y-2 text-muted-foreground">
                  {app.provides.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider">
                        Provides
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {app.provides.map((s) => (
                          <li key={`prov-${s.name}`}>
                            <code className="rounded bg-muted px-1 py-0.5 text-xs">
                              {app.slug}:{s.name}
                            </code>{" "}
                            <span className="text-[10px]">
                              ({s.audience ?? "user"})
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {app.consumes.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider">
                        Consumes
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {app.consumes.map((d) => (
                          <li key={`cons-${d.app}-${d.service}`}>
                            <code className="rounded bg-muted px-1 py-0.5 text-xs">
                              {d.app}:{d.service}
                            </code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
