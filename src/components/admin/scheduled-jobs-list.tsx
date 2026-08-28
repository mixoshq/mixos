/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Clock } from "lucide-react";
import cronstrue from "cronstrue";
import RunNowButton from "./run-now-button";
import SchedulerToggleButton from "./scheduler-toggle-button";

/** One historical run of a job, newest first in `JobView.runs`. */
export interface RunView {
  startedAt: string;
  finishedAt: string | null;
  status: string | null;
  error: string | null;
  durationMs: number | null;
  trigger: "scheduled" | "manual";
}

export interface JobView {
  appSlug: string;
  appName: string;
  jobName: string;
  /** Interval cadence in minutes, or null when the job uses `cron`. */
  intervalMinutes: number | null;
  /** CRON expression, or null when the job uses `intervalMinutes`. */
  cron: string | null;
  /** IANA timezone for `cron` (null = UTC). */
  timezone: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  running: boolean;
  /** Materialized next fire time; null = due on the next tick. */
  nextRunAt: string | null;
  /** Recent runs, newest first (capped by the page's history limit). */
  runs: RunView[];
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Human cadence label for the "Schedule" column. */
function cadenceLabel(j: JobView): string {
  if (j.cron) return j.cron;
  if (j.intervalMinutes != null) return `${j.intervalMinutes}m`;
  return "—";
}

/** Plain-English gloss shown in small print under the raw cadence. */
function describeSchedule(j: JobView): string | null {
  if (j.cron) {
    let text: string;
    try {
      text = cronstrue.toString(j.cron, {
        use24HourTimeFormat: true,
        verbose: false,
      });
    } catch {
      return null; // never let a display helper throw
    }
    return `${text} · ${j.timezone ?? "UTC"}`;
  }
  if (j.intervalMinutes != null) {
    const m = j.intervalMinutes;
    if (m % 1440 === 0) return `Every ${m / 1440} day${m / 1440 === 1 ? "" : "s"}`;
    if (m % 60 === 0) return `Every ${m / 60} hour${m / 60 === 1 ? "" : "s"}`;
    return `Every ${m} minutes`;
  }
  return null;
}

/** Format the materialized next-run timestamp. NULL = due on the next tick. */
function nextDue(nextRunAt: string | null): string {
  if (!nextRunAt) return "due now";
  const mins = Math.round((new Date(nextRunAt).getTime() - Date.now()) / 60_000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

function StatusBadge({ status, running }: { status: string | null; running: boolean }) {
  if (running) {
    return (
      <span className="inline-flex rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
        running…
      </span>
    );
  }
  const map: Record<string, string> = {
    ok: "bg-success text-success-foreground",
    error: "bg-destructive text-destructive-foreground",
    timeout: "bg-warning text-warning-foreground",
  };
  const cls = status ? map[status] : "bg-muted text-foreground";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status ?? "never run"}
    </span>
  );
}

function TriggerBadge({ trigger }: { trigger: "scheduled" | "manual" }) {
  const cls =
    trigger === "manual"
      ? "bg-cat-2 text-background"
      : "bg-muted text-foreground";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {trigger}
    </span>
  );
}

/** The expandable per-job run-history panel, rendered as a full-width sub-row. */
function HistoryRow({ job, colSpan }: { job: JobView; colSpan: number }) {
  return (
    <tr className="border-b border-border last:border-0 bg-muted/30">
      <td colSpan={colSpan} className="px-4 py-3">
        {job.runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs recorded yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Trigger</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                  <th className="px-3 py-1.5 font-medium">Started</th>
                  <th className="px-3 py-1.5 font-medium">Duration</th>
                  <th className="px-3 py-1.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {job.runs.map((r, i) => (
                  <tr key={i} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-1.5">
                      <TriggerBadge trigger={r.trigger} />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusBadge status={r.status} running={false} />
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground" suppressHydrationWarning>
                      {relative(r.startedAt)}
                    </td>
                    <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                      {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.error ? (
                        <span
                          className="block max-w-md truncate text-destructive"
                          title={r.error}
                        >
                          {r.error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function ScheduledJobsList({
  jobs,
  schedulerEnabled,
  setEnabledAction,
  runNowAction,
  setSchedulerEnabledAction,
}: {
  jobs: JobView[];
  schedulerEnabled: boolean;
  setEnabledAction: (formData: FormData) => Promise<void>;
  runNowAction: (formData: FormData) => Promise<void>;
  setSchedulerEnabledAction: (formData: FormData) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The global scheduler switch. Kept above the table so it reads as a
  // page-level control, not a per-job one.
  const control = (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            schedulerEnabled ? "bg-success" : "bg-muted-foreground"
          }`}
        />
        <span className="font-medium text-foreground">
          Scheduler {schedulerEnabled ? "running" : "paused"}
        </span>
        <span className="text-muted-foreground">
          {schedulerEnabled
            ? "— the tick runs jobs on their schedule."
            : "— recurring runs are paused; jobs won't fire until you start the tick."}
        </span>
      </div>
      <form action={setSchedulerEnabledAction}>
        <input type="hidden" name="enabled" value={schedulerEnabled ? "false" : "true"} />
        <SchedulerToggleButton enabled={schedulerEnabled} />
      </form>
    </div>
  );

  if (jobs.length === 0) {
    return (
      <>
        {control}
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card py-16 text-center">
          <Clock className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No apps declare scheduled jobs yet. Add a <code>schedules</code> entry
            to an app&apos;s <code>app.json</code>.
          </p>
        </div>
      </>
    );
  }

  // chevron + App + Job + Schedule + Last run + Status + Next + Actions
  const COLS = 8;

  return (
    <>
      {control}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-2 py-2" />
              <th className="px-4 py-2 font-medium">App</th>
              <th className="px-4 py-2 font-medium">Job</th>
              <th className="px-4 py-2 font-medium">Schedule</th>
              <th className="px-4 py-2 font-medium">Last run</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Next</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const key = `${j.appSlug}/${j.jobName}`;
              const isOpen = expanded.has(key);
              const description = describeSchedule(j);
              return (
                <Fragment key={key}>
                  <tr className="border-b border-border last:border-0 align-top">
                    <td className="px-2 py-3">
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Hide run history" : "Show run history"}
                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">{j.appName}</td>
                    <td className="px-4 py-3 font-mono text-xs">{j.jobName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {j.cron ? (
                        <span className="font-mono text-xs">{j.cron}</span>
                      ) : (
                        <span className="tabular-nums">{cadenceLabel(j)}</span>
                      )}
                      {description && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" suppressHydrationWarning>
                      {relative(j.lastRunAt)}
                      {j.lastDurationMs != null && (
                        <span className="text-xs"> · {j.lastDurationMs}ms</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={j.lastStatus} running={j.running} />
                      {j.lastStatus === "error" && j.lastError && (
                        <p
                          className="mt-1 max-w-xs truncate text-xs text-destructive"
                          title={j.lastError}
                        >
                          {j.lastError}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" suppressHydrationWarning>
                      {j.enabled ? nextDue(j.nextRunAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <form action={runNowAction}>
                          <input type="hidden" name="appSlug" value={j.appSlug} />
                          <input type="hidden" name="jobName" value={j.jobName} />
                          <RunNowButton disabled={j.running} />
                        </form>
                        <form action={setEnabledAction}>
                          <input type="hidden" name="appSlug" value={j.appSlug} />
                          <input type="hidden" name="jobName" value={j.jobName} />
                          <input
                            type="hidden"
                            name="enabled"
                            value={j.enabled ? "false" : "true"}
                          />
                          <button
                            type="submit"
                            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                              j.enabled
                                ? "border-border hover:bg-muted"
                                : "border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
                            }`}
                          >
                            {j.enabled ? "Disable" : "Enable"}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                  {isOpen && <HistoryRow job={j} colSpan={COLS} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
