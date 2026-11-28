/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition, type ReactNode, useMemo } from "react";
import Image from "next/image";
import {
  Check,
  X,
  Copy,
  ExternalLink,
  HelpCircle,
  Link2,
  Plug,
  PlugZap,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status";
import FolderTabs from "@/components/ui/folder-tabs";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Provenance, RemoveAction } from "./provenance";
import { useClientValue } from "@/lib/use-client-value";
import type {
  ConnectorDocLink,
  ConnectorScope,
  ConnectorSetupStep,
  ConnectorTelemetryDefinition,
} from "@/lib/connectors/types";
import type { ConnectorConfigState } from "@/lib/connectors/status";
import type { ConnectorTestOutcome } from "@/lib/connectors/test-connection";
import { describeDependents } from "@/lib/connectors/dependents";
import {
  grantHoldsWriteScopes,
  isScopeRequested,
  writeMethods,
  writeScopes,
} from "@/lib/connectors/write-policy";
import type { ObservedCalls } from "@/lib/connectors/reach";
import type { ConnectorWithStatus } from "./connector-registry-list";
import ConnectorReachSection from "./connector-reach-section";
import type { AppCredentialActions } from "./app-credentials-panel";

type DialogTab = "details" | "configure" | "methods" | "scopes" | "logs";

interface Props {
  connector: ConnectorWithStatus;
  open: boolean;
  onClose: () => void;
  /**
   * Which tab to land on. "details" for a normal open; "configure" when the
   * admin is mid-setup and did not choose to be here — coming back from the
   * provider's consent screen, where being dropped on Details would read as
   * having lost their place.
   */
  initialTab?: DialogTab;
  /** Returns whether the connector now holds a usable credential set. */
  configureAction: (formData: FormData) => Promise<boolean>;
  testAction: (connectorName: string) => Promise<ConnectorTestOutcome>;
  /** Allow the connector to change data, or make it read-only again. */
  changesAction: (connectorName: string, allowed: boolean) => Promise<void>;
  /** Opens the Remove dialog in this one's place, from the footer's Remove. */
  onRemove?: () => void;
  /** What apps called through each connector lately, for the Reach section; the page streams it. */
  observed?: Promise<ObservedCalls | null>;
  /** Give one app its own credentials, from its Reach row. */
  appCredentialActions?: AppCredentialActions;
  /** An app whose own credentials to open on arrival: set by the way back from its Connect. */
  initialApp?: string | null;
}

/** "in 52 minutes" / "3 days ago" — enough for an admin to judge freshness. */
function formatRelative(epochMs: number): string {
  const deltaMin = Math.round((epochMs - Date.now()) / 60000);
  const abs = Math.abs(deltaMin);
  const unit =
    abs < 1
      ? "just now"
      : abs < 60
        ? `${abs} min`
        : abs < 1440
          ? `${Math.round(abs / 60)} hr`
          : `${Math.round(abs / 1440)} days`;
  if (unit === "just now") return unit;
  return deltaMin >= 0 ? `in ${unit}` : `${unit} ago`;
}

const STATUS_LABEL: Record<ConnectorConfigState, string> = {
  ready: "Configured",
  "needs-authorization": "Needs authorization",
  unconfigured: "Not configured",
};

/** Read is neutral; anything that can write is not. */
const SCOPE_TONE = {
  read: "neutral",
  write: "warning",
  "read-write": "warning",
} as const;

const SCOPE_LABEL = {
  read: "Read",
  write: "Write",
  "read-write": "Read+Write",
} as const;

const STATUS_TONE = {
  ready: "success",
  "needs-authorization": "warning",
  unconfigured: "neutral",
} as const;

/**
 * External link out to a provider's console. `rel="noreferrer noopener"` on
 * every one — these point at third-party admin consoles, and the opener
 * reference is not something to hand across that boundary. The URLs are proven
 * `https:` at build time by the manifest schema, so nothing sanitizes here.
 */
function DocLink({ link }: { link: ConnectorDocLink }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-baseline gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
    >
      {link.label}
      <ExternalLink className="h-3 w-3 shrink-0 self-center" aria-hidden />
    </a>
  );
}

/**
 * Index of `label` in `text` as a standalone phrase, or -1.
 *
 * Word-boundary checked rather than a bare indexOf, so a label like "API" does
 * not light up the middle of "APIs". Done with adjacency tests instead of a
 * lookbehind regex — the same result, without depending on a regex feature for
 * something this small.
 */
function findPhrase(text: string, label: string): number {
  const isWord = (c: string) => /\w/.test(c);
  for (let from = 0; ;) {
    const i = text.indexOf(label, from);
    if (i === -1) return -1;
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + label.length] ?? "";
    if (!isWord(before) && !isWord(after)) return i;
    from = i + 1;
  }
}

/**
 * A step's sentence, with its link woven in and its values emboldened.
 *
 * Both decorations are the same problem — find a phrase, wrap that span — so
 * they are collected as ranges and applied in one pass. Doing them as two
 * successive string replacements is what produces the classic bug where a value
 * sitting inside a link label gets a `<strong>` spliced through the anchor.
 *
 * Where the sentence names the link's destination — "On the OAuth consent
 * screen, set User type to Internal" — that phrase becomes the link, because
 * that is the thing being pointed at and the reader's eye is already on it. A
 * trailing "OAuth consent screen ↗" after the full stop makes them read the
 * name twice and click the second one. Where the label does not appear, the
 * link trails the sentence: a legitimate outcome for a destination the sentence
 * never names, not a fallback for a mistake.
 */
function StepText({ step }: { step: ConnectorSetupStep }) {
  const { text, link, values } = step;

  type Span = { start: number; end: number; kind: "link" | "value" };
  const spans: Span[] = [];
  const overlaps = (start: number, end: number) =>
    spans.some((sp) => start < sp.end && end > sp.start);

  // The link claims its range first: an anchor that also happens to be a value
  // should stay an anchor rather than being split by a nested <strong>.
  if (link) {
    const at = findPhrase(text, link.label);
    if (at >= 0)
      spans.push({ start: at, end: at + link.label.length, kind: "link" });
  }
  for (const value of values ?? []) {
    const at = findPhrase(text, value);
    if (at >= 0 && !overlaps(at, at + value.length)) {
      spans.push({ start: at, end: at + value.length, kind: "value" });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const linkInline = spans.some((sp) => sp.kind === "link");
  const parts: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((sp, i) => {
    if (sp.start > cursor) parts.push(text.slice(cursor, sp.start));
    parts.push(
      sp.kind === "link" ? (
        <DocLink key={i} link={link!} />
      ) : (
        <strong key={i} className="font-semibold text-foreground">
          {text.slice(sp.start, sp.end)}
        </strong>
      ),
    );
    cursor = sp.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return (
    <>
      {parts}
      {link && !linkInline && (
        <>
          {" "}
          <DocLink link={link} />
        </>
      )}
    </>
  );
}

/**
 * A log timestamp, rendered only on the client.
 *
 * Both the relative phrasing and the local-time formatting depend on the
 * reader's clock and zone, so neither can be produced during the server pass —
 * and this dialog IS server-rendered when the OAuth return reopens it.
 * `useClientValue` is the sanctioned way to defer that without a hydration
 * mismatch; the dash is what the server renders.
 */
function LogTime({ at }: { at: number }) {
  const text = useClientValue(() => formatRelative(at), null);
  const exact = useClientValue(() => new Date(at).toLocaleString(), null);
  return <span title={exact ?? undefined}>{text ?? "—"}</span>;
}

/**
 * The identifying tail of a scope, without the boilerplate.
 *
 * `https://www.googleapis.com/auth/gmail.readonly` is fourteen characters of
 * information wrapped in thirty of prefix that is identical on every row — and
 * the prefix is what wraps onto a second line in a dialog. The last path
 * segment is what a provider's own docs call the scope.
 *
 * Falls back to the host for a scope that is a bare origin
 * (`https://mail.google.com/`), and returns the input untouched for a provider
 * whose scopes are not URLs at all — Slack's `channels:read`, for instance.
 */
function shortScopeId(scope: string): string {
  try {
    const url = new URL(scope);
    // `new URL("channels:read")` does NOT throw — it parses as protocol
    // `channels:` with pathname `read`, so an unguarded version returned "read"
    // for a Slack scope and silently discarded half of it.
    if (url.protocol !== "https:" && url.protocol !== "http:") return scope;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? url.host;
  } catch {
    return scope;
  }
}

type ScopeVerdict = "held" | "refused" | "unused";

/**
 * Whether one documented scope actually works for this connector.
 *
 * Read from `connector_scope_status`, which is written at the OAuth callback —
 * the only moment the answer can change. It is not re-derived here: the grant
 * lives server-side, and a screen that recomputed it from whatever lists it
 * happened to be handed is exactly how a permissions view starts disagreeing
 * with itself.
 *
 * "unused" carries most of the rows: a scope this connector never asks for is
 * not broken, it is simply not part of what this connector does. Rendering that
 * as a cross would report a dozen failures on a perfectly healthy connector.
 */
const STATUS_TO_VERDICT: Record<string, ScopeVerdict> = {
  granted: "held",
  refused: "refused",
  unknown: "unused",
};

function ScopeStatusIcon({ verdict }: { verdict: ScopeVerdict }) {
  if (verdict === "held") {
    return (
      <Check
        role="img"
        aria-label="Granted by the provider"
        className="h-4 w-4 shrink-0 text-success"
      />
    );
  }
  if (verdict === "refused") {
    return (
      <X
        role="img"
        aria-label="Requested but not granted — calls needing this will be refused"
        className="h-4 w-4 shrink-0 text-destructive"
      />
    );
  }
  return (
    <HelpCircle
      role="img"
      aria-label="Not requested by this connector"
      className="h-4 w-4 shrink-0 text-muted-foreground"
    />
  );
}

/**
 * That a scope comes with another one: the provider grants it as part of each
 * scope listed, and may name only that one in the grant.
 */
function IncludedInPill({ scopes }: { scopes: string[] }) {
  const names = scopes.map(shortScopeId);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  const tip =
    names.length === 1
      ? `The provider grants it as part of ${list}, and may name only ${list} in the grant. Either one in the grant holds it.`
      : `The provider grants it as part of ${list}, and may name only that scope in the grant. Any of them in the grant holds it.`;
  return (
    <InfoTooltip tip={tip}>
      <StatusPill tone="neutral">Included in {names.join(", ")}</StatusPill>
    </InfoTooltip>
  );
}

/**
 * The one thing about a method an admin most needs to know before an app calls
 * it, or null when nothing stands in its way. First match wins: a write that is
 * off says so before anything about its scopes, since the platform refuses it
 * before the provider is asked.
 */
function methodNote(
  m: ConnectorTelemetryDefinition,
  scopeOf: Map<string, ConnectorScope>,
  verdictOf: (scope: string) => ScopeVerdict,
  changesAllowed: boolean,
): { tone: "neutral" | "warning" | "danger"; label: string; tip: string } | null {
  if (m.mutates && !changesAllowed) {
    return {
      tone: "neutral",
      label: "Off while read-only",
      tip: "It changes data, and this connector is read-only, so it is refused before the provider is asked. An admin allows changes on the Configure tab.",
    };
  }
  const scopes = m.scopes ?? [];
  const forWrites = scopes.filter((s) => scopeOf.get(s)?.requested === "write");
  if (!m.mutates && !changesAllowed && forWrites.length > 0) {
    return {
      tone: "warning",
      label: "Works once changes are allowed",
      tip: `It only reads, but the provider authorizes it only with ${forWrites.map(shortScopeId).join(", ")}, which this connector asks for once changes are allowed. Until then the provider refuses it.`,
    };
  }
  const refused = scopes.filter((s) => verdictOf(s) === "refused");
  if (refused.length > 0) {
    return {
      tone: "danger",
      label: "Scope refused",
      tip: `The provider didn't grant ${refused.map(shortScopeId).join(", ")}, so it fails. Connect again and approve every permission.`,
    };
  }
  return null;
}

/**
 * Every method an app can call, each with the scopes it needs and what the
 * grant says about them: the Scopes tab's verdicts, joined to the calls they
 * decide. An admin reads here which calls a refused scope breaks, and which
 * scope a failing call was missing.
 *
 * A method whose manifest entry names no `scopes` says so rather than guessing
 * from the catalogue: a read could need any of the read scopes, and a wrong
 * answer here is worse than none.
 */
function MethodsPanel({
  connector,
  catalogue,
  statusByScope,
  changesAllowed,
  authenticates,
}: {
  connector: ConnectorWithStatus;
  catalogue: ConnectorScope[];
  statusByScope: Map<string, string>;
  changesAllowed: boolean;
  authenticates: boolean;
}) {
  const scopeOf = new Map(catalogue.map((s) => [s.scope, s]));
  /** The Scopes tab's verdict for one scope, on this install. */
  const verdictOf = (scope: string): ScopeVerdict => {
    const entry = scopeOf.get(scope);
    if (!entry || !isScopeRequested(entry, changesAllowed)) return "unused";
    return STATUS_TO_VERDICT[statusByScope.get(scope) ?? ""] ?? "unused";
  };
  const declaresScopes = connector.telemetry.some((m) => m.scopes !== undefined);

  if (connector.telemetry.length === 0) {
    return (
      <div className="px-5 py-4">
        <p className="text-sm text-muted-foreground">This connector declares no methods, so apps can call nothing through it.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-5 py-4">
      {authenticates && declaresScopes && !connector.access.grantedKnown && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          {connector.userScoped
            ? "Each person holds their own grant, and you haven't connected your own account yet"
            : "Nobody has connected this yet"}
          , so whether the provider grants each scope below is unknown until someone does.
        </p>
      )}

      {/* The Scopes tab's key, worded for a method: the same three icons. */}
      {authenticates && declaresScopes && (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {[
            {
              verdict: "held" as const,
              label: "Granted",
              tip: "The provider granted it, so calls needing it can work.",
            },
            {
              verdict: "refused" as const,
              label: "Refused",
              tip: "This connector asks for it and the provider didn't grant it. Calls needing it fail until someone connects again and approves it.",
            },
            {
              verdict: "unused" as const,
              label: "Unknown",
              tip: "Not granted on this install: nobody has connected yet, or this connector asks for it only once changes are allowed.",
            },
          ].map((item) => (
            <InfoTooltip key={item.verdict} tip={item.tip}>
              <span className="inline-flex items-center gap-1">
                <ScopeStatusIcon verdict={item.verdict} />
                {item.label}
              </span>
            </InfoTooltip>
          ))}
        </div>
      )}

      {/* Striped as the Scopes tab is, for the same reason, and at the same
          ceiling: `text-muted-foreground` on `bg-muted/60` is 4.51:1. */}
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {connector.telemetry.map((m, i) => {
          const note = methodNote(m, scopeOf, verdictOf, changesAllowed);
          return (
            <li key={m.method} className={`px-3 py-2 ${i % 2 === 1 ? "bg-muted/60" : ""}`}>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-sm text-foreground">{m.method}</span>
                <span className="font-mono text-xs text-muted-foreground">{m.operation}</span>
                {m.mutates && <StatusPill tone="warning">Changes data</StatusPill>}
                {note && (
                  <InfoTooltip tip={note.tip}>
                    <StatusPill tone={note.tone}>{note.label}</StatusPill>
                  </InfoTooltip>
                )}
              </span>
              {m.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{m.description}</span>
              )}
              {authenticates && (
                <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Needs</span>
                  {m.scopes === undefined ? (
                    <span className="text-muted-foreground">scopes not declared</span>
                  ) : m.scopes.length === 0 ? (
                    <span className="text-muted-foreground">no scope</span>
                  ) : (
                    m.scopes.map((scope) => (
                      <span key={scope} className="inline-flex items-center gap-1">
                        <ScopeStatusIcon verdict={verdictOf(scope)} />
                        <span className="font-mono text-foreground" title={scope}>
                          {shortScopeId(scope)}
                        </span>
                      </span>
                    ))
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {!authenticates && (
        <p className="text-xs text-muted-foreground">
          This connector reaches a public API and authenticates with nothing, so its methods need no permissions.
        </p>
      )}
    </div>
  );
}

/** A note the manifest attaches to one step, shown at the control it concerns. */
function StepNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
      {children}
    </p>
  );
}

interface Step {
  id: string;
  title: string;
  done: boolean;
  /**
   * This step must be finished before any later step opens.
   *
   * True for the steps that take a value or prove something — credentials,
   * authorization, verification — and false for the one that only tells you
   * what to do in someone else's console, which has nothing to complete and so
   * has no business blocking anything.
   */
  mustComplete?: boolean;
  body: ReactNode;
  /**
   * The step's primary control, rendered bottom-right of the panel — always the
   * same corner, whether it is "Save credentials", "Connect" or "Verify". A
   * wizard whose button moves per step makes the reader hunt for it four times.
   *
   * Omitted by a step with nothing to validate, which gets a plain "Next"
   * instead: that is the difference between a step the platform can check and
   * one it cannot.
   */
  action?: ReactNode;
}

/** Ties the submit button, which lives in the action row, to the form above it. */
const CREDENTIALS_FORM_ID = "connector-credentials-form";

/**
 * The progress rail: every step as a circle, only one panel below it.
 *
 * WHY A RAIL AND NOT A LIST OF COLLAPSED ROWS. Showing one step at a time is
 * the point — an admin pasting a client secret does not need three other steps
 * in view — but hiding the others costs the two things a list gave for free:
 * where am I, and how much is left. The rail gives both back in one line, and
 * it is where the green ticks live, so progress stays visible while content
 * does not.
 *
 * Circles are buttons. Going back to re-copy a redirect URI or replace a leaked
 * secret has to be possible, and this is the only way back once a step is no
 * longer rendered.
 */
function StepRail({
  steps,
  currentId,
  maxReachable,
  onSelect,
}: {
  steps: Step[];
  currentId: string;
  /** Index of the furthest step that can be opened. Later ones are locked. */
  maxReachable: number;
  onSelect: (id: string) => void;
}) {
  const blocker = steps[maxReachable];
  return (
    <ol className="flex items-center">
      {steps.map((step, i) => {
        const isCurrent = step.id === currentId;
        const locked = i > maxReachable;
        return (
          <li key={step.id} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              onClick={() => onSelect(step.id)}
              disabled={locked}
              aria-current={isCurrent ? "step" : undefined}
              // The number/tick is decorative next to this: the label is what
              // carries the step's name and its state to a screen reader —
              // including *why* a locked step cannot be opened, which a greyed
              // circle communicates to nobody.
              aria-label={`Step ${i + 1} of ${steps.length}: ${step.title}${
                step.done
                  ? " (completed)"
                  : locked && blocker
                    ? ` (locked — finish "${blocker.title}" first)`
                    : ""
              }`}
              title={
                locked && blocker
                  ? `Finish "${blocker.title}" first`
                  : step.title
              }
              // Dimming is legal here and almost nowhere else: WCAG 1.4.3
              // exempts inactive controls. See docs/apps/ux.md#never-dim-a-token.
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                step.done
                  ? "border-success bg-success text-success-foreground"
                  : isCurrent
                    ? "border-primary bg-primary text-primary-foreground"
                    : locked
                      ? "cursor-not-allowed border-border bg-muted text-foreground disabled:opacity-50"
                      : "border-border bg-muted text-foreground hover:border-primary"
              }`}
            >
              {step.done ? <Check className="h-4 w-4" aria-hidden /> : i + 1}
            </button>
            {i < steps.length - 1 && (
              // The connector turns green only once the step behind it is done,
              // so the rail reads as a filling progress bar rather than as
              // decoration between circles.
              <span
                aria-hidden
                className={`mx-1.5 h-0.5 flex-1 rounded-full ${
                  step.done ? "bg-success" : "bg-border"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function ConnectorConfigureDialog({
  connector,
  open,
  onClose,
  initialTab = "details",
  configureAction,
  testAction,
  changesAction,
  onRemove,
  observed,
  appCredentialActions,
  initialApp = null,
}: Props) {
  const [tab, setTab] = useState<DialogTab>(initialTab);
  const [saving, startSave] = useTransition();
  const [changing, startChange] = useTransition();
  const [testing, startTest] = useTransition();
  const [outcome, setOutcome] = useState<ConnectorTestOutcome | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Which step the admin has navigated to, or `undefined` to follow the
   * checklist — the first unfinished step. Clearing it after a successful
   * action is what makes the wizard advance on its own: save the credentials
   * and the next render lands on authorizing.
   *
   * There is no "closed" state: exactly one step is always showing.
   */
  const [pinnedStep, setPinnedStep] = useState<string | undefined>(undefined);
  const [showDone, setShowDone] = useState(false);

  const { oauth, setup, state, verification } = connector;
  const isOAuth = oauth !== null;
  /**
   * Every scope the provider documents, straight from the manifest. This is the
   * committed catalogue, so it is the same on every install and cannot be empty
   * because a third party's docs page moved.
   */
  const catalogue = useMemo(
    () => connector.auth?.scopes ?? [],
    [connector.auth],
  );
  /**
   * Each scope another one includes, with the scopes that include it. Read from
   * the manifest: the verdict already counts them (`heldScopes`), and the pill
   * says why a scope the provider didn't name reads as granted.
   */
  const includedIn = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const s of catalogue) {
      for (const included of s.includes ?? []) by.set(included, [...(by.get(included) ?? []), s.scope]);
    }
    return by;
  }, [catalogue]);
  /**
   * Whether an admin allowed this connector to change data. It decides which
   * scopes Connect asks for, so it is read before any of them are listed.
   */
  const changesAllowed = connector.changesAllowed;
  /** Only what this connector actually asks for, for the consent step. */
  const requestedScopes = useMemo(
    () => catalogue.filter((s) => isScopeRequested(s, changesAllowed)),
    [catalogue, changesAllowed],
  );
  /** The methods that change data, which Allow changes is about. */
  const writes = writeMethods(connector);
  /** The scopes asked for only once changes are allowed. */
  const scopesForWrites = writeScopes(connector.auth);
  /**
   * Whether the grant holds those scopes: false for one taken while the
   * connector was read-only, which needs connecting again.
   */
  const grantWrites = grantHoldsWriteScopes(
    connector.auth,
    connector.access.granted,
    connector.access.grantedKnown,
  );
  /** The grant snapshot, keyed for lookup while rendering rows. */
  const statusByScope = useMemo(
    () => new Map(connector.scopeStatus.map((r) => [r.scope, r.status])),
    [connector.scopeStatus],
  );

  const credentialsSaved = state !== "unconfigured";
  /*
    Allowed to change data, on a grant taken before that was allowed: the
    provider never granted the write scopes, so Connect has to run again.
  */
  const reconnectForWrites =
    isOAuth && oauth.connected && changesAllowed && grantWrites === false;
  const authorized = isOAuth ? oauth.connected && !reconnectForWrites : true;
  /*
    Read-only again, on a grant that still holds the write scopes: nothing
    here calls them, and connecting again gives them back.
  */
  const writeScopesUnused =
    isOAuth && oauth.connected && !changesAllowed && scopesForWrites.length > 0 &&
    grantHoldsWriteScopes(connector.auth, connector.access.granted, connector.access.grantedKnown) === true;
  const verified = verification.verifiedAt !== null;
  const disabled = connector.disabledAt !== null;

  /*
    Both of these are relative to *now*, so neither can be computed during the
    server pass — this dialog is server-rendered whenever `initialOpen` is set,
    which is exactly what happens on the way back from the OAuth round trip.
  */
  const expiryText = useClientValue(
    () => (oauth?.expiresAt ? formatRelative(oauth.expiresAt) : null),
    null,
  );
  const verifiedText = useClientValue(
    () =>
      verification.verifiedAt ? formatRelative(verification.verifiedAt) : null,
    null,
  );
  const configuredText = useClientValue(
    () =>
      verification.configuredAt
        ? formatRelative(verification.configuredAt)
        : null,
    null,
  );
  const disabledText = useClientValue(() => {
    const at = connector.disabledAt ? Date.parse(connector.disabledAt) : NaN;
    return Number.isFinite(at) ? formatRelative(at) : null;
  }, null);

  async function copyRedirectUri() {
    if (!oauth?.redirectUri) return;
    try {
      await navigator.clipboard.writeText(oauth.redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, insecure origin). The
      // input is readOnly-and-selectable precisely so this stays recoverable by
      // hand rather than being a dead end.
    }
  }

  const credentialNames = connector.credentialFields
    .map((f) => f.label)
    .join(" and ");

  const steps: Step[] = [];

  /*
    Move forward to a named step.

    NEVER by clearing the pin. "Follow the checklist" resolves to the first
    unfinished step, and immediately after a save the revalidated props have not
    landed yet — so the checklist still says step one, the wizard snaps back
    there, and then jumps forward again a moment later. Pinning the next step by
    id is the only form of advancing that cannot go backwards.
  */
  function advanceFrom(stepId: string) {
    const i = steps.findIndex((st) => st.id === stepId);
    const next = i >= 0 ? steps[i + 1] : undefined;
    if (next) setPinnedStep(next.id);
  }

  /*
    Step one is the provider's own console, which we cannot check — nothing here
    can tell whether the Gmail API got enabled. It ticks when the credentials
    arrive instead: you cannot hold a Client ID you never created an app for. An
    inferred tick beats a checkbox the admin ticks themselves, which records
    only that they clicked it.
  */
  if (setup) {
    steps.push({
      id: "provider",
      title: setup.title ?? "Get your credentials",
      done: credentialsSaved,
      body: (
        <>
          <ol className="space-y-2">
            {setup.steps.map((step, i) => (
              <li key={i} className="flex gap-2.5 text-sm">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-foreground"
                >
                  {i + 1}
                </span>
                <span className="text-foreground">
                  <StepText step={step} />
                  {/*
                    The rationale sits behind the "?" rather than in the
                    sentence. InfoTooltip opens on focus as well as hover, so
                    this is not a mouse-only explanation the way a `title=`
                    would be.
                  */}
                  {step.why && (
                    <>
                      {" "}
                      <InfoTooltip tip={step.why} className="align-text-bottom">
                        <HelpCircle
                          aria-label={`Why: ${step.text}`}
                          role="img"
                          className="h-4 w-4 text-muted-foreground hover:text-foreground"
                        />
                      </InfoTooltip>
                    </>
                  )}

                  {/*
                    Directly under the step that asks for it. This is the only
                    value in the guide the manifest cannot carry — it is built
                    from this deployment's origin — and it is worth nothing
                    anywhere except beside the field it gets pasted into.
                  */}
                  {step.showRedirectUri && isOAuth && (
                    <span className="mt-2 block">
                      {oauth.redirectUri ? (
                        <span className="flex gap-2">
                          <input
                            readOnly
                            value={oauth.redirectUri}
                            aria-label="Redirect URI"
                            onFocus={(e) => e.currentTarget.select()}
                            className="min-w-0 flex-1 rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs text-foreground shadow-sm"
                          />
                          <Button
                            size="sm"
                            onClick={copyRedirectUri}
                            icon={
                              copied ? (
                                <Check className="h-4 w-4" aria-hidden />
                              ) : (
                                <Copy className="h-4 w-4" aria-hidden />
                              )
                            }
                          >
                            {copied ? "Copied" : "Copy"}
                          </Button>
                        </span>
                      ) : (
                        <span className="block rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
                          Set{" "}
                          <code className="font-mono text-xs">
                            NEXTAUTH_URL
                          </code>{" "}
                          to this deployment&apos;s public URL — the redirect
                          URI is built from it and cannot be shown until it is
                          set.
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </>
      ),
    });
  }

  const credentialsStep: Step = {
    id: "credentials",
    title: `Save your ${credentialNames}`,
    done: credentialsSaved,
    mustComplete: true,
    body: (
      <>
        {setup?.notes?.credentials && (
          <StepNote>{setup.notes.credentials}</StepNote>
        )}
        <form
          id={CREDENTIALS_FORM_ID}
          action={(formData) =>
            startSave(async () => {
              const saved = await configureAction(formData);
              // Only a save that actually stored something completes this step;
              // advancing regardless would let an empty submit skip straight past
              // it.
              if (saved) advanceFrom("credentials");
            })
          }
          className="space-y-4"
        >
          <input type="hidden" name="connectorName" value={connector.name} />
          {connector.credentialFields.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              // Required only while nothing is stored. Once it is, blank means
              // "keep what is there", which is the hint below.
              required={!credentialsSaved}
              hint={
                credentialsSaved
                  ? "Already saved. Leave blank to keep the current value."
                  : undefined
              }
            >
              {(args) => (
                <input
                  {...args}
                  type={field.type === "password" ? "password" : "text"}
                  name={field.key}
                  required={!credentialsSaved}
                  autoComplete="off"
                  placeholder={
                    credentialsSaved ? "••••••••" : `Enter ${field.label}`
                  }
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </Field>
          ))}
        </form>
      </>
    ),
    action: (
      <Button
        type="submit"
        form={CREDENTIALS_FORM_ID}
        variant="primary"
        size="sm"
        busy={saving}
        busyLabel="Saving…"
      >
        {credentialsSaved ? "Update credentials" : "Save credentials"}
      </Button>
    ),
  };
  // A connector that declares no credential fields — a public API — has
  // nothing to save, so the wizard goes from the provider's steps to Verify.
  const hasCredentials = connector.credentialFields.length > 0;
  if (hasCredentials) steps.push(credentialsStep);

  /*
    Whether the connector may change data, for one that declares a method
    doing so. Before Connect, because it decides which scopes Connect asks for.

    Read-only is a finished choice, so the step needs nothing done — except
    while an app asks to change data in it and changes aren't allowed: that
    app can't be activated, so the checklist stops here and says which app.
    It never blocks a later step: keeping a connector read-only is allowed.
  */
  if (writes.length > 0) {
    const neededBy = connector.dependents.writes;
    steps.push({
      id: "changes",
      title: "Choose whether it can change data",
      done: changesAllowed || neededBy.length === 0,
      body: (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <StatusPill tone={changesAllowed ? "warning" : "neutral"}>
              {changesAllowed ? "Changes allowed" : "Read-only"}
            </StatusPill>
            <span className="text-muted-foreground">
              {changesAllowed
                ? "Apps that ask to change data can call these methods."
                : "Apps can read, and nothing calls these methods."}
            </span>
          </p>
          <ul className="space-y-1 text-sm">
            {writes.map((m) => (
              <li key={m.method} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-foreground">{m.method}</span>
                <span className="text-muted-foreground">
                  {m.description ?? m.operation}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            {neededBy.length > 0
              ? `${neededBy.join(", ")} ${neededBy.length === 1 ? "asks" : "ask"} to change data in ${connector.displayName}${changesAllowed ? "." : ", and can't be activated until changes are allowed."}`
              : "No app asks to change data in it yet. An app that does says so in its app.json, and still needs this."}
          </p>
          {isOAuth && scopesForWrites.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">
                Allowing changes also asks for, at Connect:
              </p>
              <ul className="mt-1 space-y-0.5">
                {scopesForWrites.map((scope) => (
                  <li key={scope} className="break-all font-mono text-[11px] text-muted-foreground">
                    {scope}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reconnectForWrites && (
            <StepNote>
              Changes are allowed, but the grant was made while it was read-only.
              Connect again so the provider grants the write access.
            </StepNote>
          )}
          {writeScopesUnused && (
            <StepNote>
              It is read-only, but its grant still holds write access at the
              provider. Connect again to give that up.
            </StepNote>
          )}
        </>
      ),
      action: (
        <Button
          size="sm"
          variant={changesAllowed || neededBy.length === 0 ? "secondary" : "primary"}
          busy={changing}
          busyLabel="Saving…"
          onClick={() =>
            startChange(async () => {
              await changesAction(connector.name, !changesAllowed);
              // Allowing changes on an OAuth connector is finished by
              // Connect, which asks for the write scopes; go there.
              advanceFrom("changes");
            })
          }
        >
          {changesAllowed ? "Make read-only" : "Allow changes"}
        </Button>
      ),
    });
  }

  if (isOAuth) {
    steps.push({
      id: "authorize",
      title: connector.userScoped ? "Connect your account" : "Authorize access",
      done: authorized,
      mustComplete: true,
      body: (
        <>
          {/*
            A user-scoped connector has no deployment-wide grant: each person
            connects their own. The admin connects theirs here, which proves
            the app registration works and gives Verify a grant to test with.
          */}
          {connector.userScoped ? (
            <p className="text-sm text-muted-foreground">
              Each person signs in with their own account, from My
              Connections. Connect yours here to prove the app registration
              works; Verify then tests with your account. The token comes back
              encrypted and refreshes itself.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              You will be sent to the provider to sign in and approve. The
              token comes back encrypted and refreshes itself; there is one
              credential set for the whole deployment, not one per person.
            </p>
          )}
          {setup?.notes?.authorize && (
            <StepNote>{setup.notes.authorize}</StepNote>
          )}
          {reconnectForWrites && (
            <StepNote>
              Changes are now allowed. Connect again to grant the write access,
              which the current grant doesn&apos;t hold.
            </StepNote>
          )}

          {/* Only the requested subset. `oauth.scopes` is the provider's whole
              catalogue, and listing all of it here would misrepresent what this
              consent screen is about to ask for. */}
          {requestedScopes.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Access requested:</p>
              <ul className="mt-1 space-y-0.5">
                {requestedScopes.map((s) => (
                  <li
                    key={s.scope}
                    className="break-all font-mono text-[11px] text-muted-foreground"
                  >
                    {s.scope}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {authorized && expiryText && (
            <p className="text-sm text-muted-foreground">
              Connected — the access token expires {expiryText} and refreshes
              itself.
            </p>
          )}

          {!credentialsSaved && (
            <p className="text-sm text-warning">
              Save the {credentialNames} first — the authorization request is
              built from them.
            </p>
          )}
        </>
      ),
      action: (
        <>
          {/*
            Two elements, one control. When it works it must be a plain anchor:
            this starts a full-page navigation out to the provider and back, and
            `return` carries the connector name so the dialog reopens on the way
            back. When it cannot work yet it is a real disabled <button>, which
            is both the honest semantics and the only legal way to render an
            inactive control here — dimming a token is allowed for a genuinely
            disabled control and nowhere else (docs/apps/ux.md#never-dim-a-token).
          */}
          {credentialsSaved ? (
            <a
              href={`/api/connectors/${encodeURIComponent(connector.name)}/oauth/start?return=${encodeURIComponent(
                `/admin/connectors?connector=${connector.name}`,
              )}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Link2 className="h-4 w-4" aria-hidden />
              {oauth.connected ? "Reconnect" : "Connect"}
            </a>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled
              icon={<Link2 className="h-4 w-4" aria-hidden />}
            >
              Connect
            </Button>
          )}
        </>
      ),
    });
  }

  steps.push({
    id: "verify",
    title: "Verify the connection",
    done: verified,
    mustComplete: true,
    body: (
      <>
        <p className="text-sm text-muted-foreground">
          Makes one real call to the service. This is what turns
          &ldquo;configured&rdquo; from a claim into a fact — a key pasted with
          a trailing space fails here instead of through a broken widget next
          week.
        </p>
        {setup?.notes?.verify && <StepNote>{setup.notes.verify}</StepNote>}

        {outcome && !testing && (
          <StatusPill tone={outcome.ok ? "success" : "danger"}>
            {outcome.ok ? "Connection works" : "Connection failed"}
          </StatusPill>
        )}

        {outcome && !testing && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {outcome.ok
                ? (outcome.detail ?? "The service accepted our credentials.")
                : outcome.message}
            </p>
            {!outcome.ok && outcome.adminHint && (
              <p className="text-xs text-muted-foreground">
                {outcome.adminHint}
              </p>
            )}
            {!outcome.ok && outcome.upstreamRequestId && (
              <p className="font-mono text-[11px] text-muted-foreground">
                Reference: {outcome.upstreamRequestId}
              </p>
            )}
          </div>
        )}

        {verified && !outcome && verifiedText && (
          <p className="text-xs text-muted-foreground">
            Last verified {verifiedText}
            {verification.detail ? ` — ${verification.detail}` : ""}.
          </p>
        )}
      </>
    ),
    action: (
      <Button
        size="sm"
        variant={verified ? "secondary" : "primary"}
        onClick={() =>
          startTest(async () => {
            const result = await testAction(connector.name);
            setOutcome(result);
            // Nothing to advance to — verify is the last step. A pass makes
            // `allDone` true, which swaps the wizard for the completed summary
            // on its own; clearing the pin here would only risk a flash of step
            // one while the revalidated props are still in flight.
          })
        }
        busy={testing}
        busyLabel="Testing…"
        icon={<PlugZap className="h-4 w-4" aria-hidden />}
      >
        {verified ? "Verify again" : "Verify connection"}
      </Button>
    ),
  });

  /** The provider's scope reference page, cited under the capability list. */
  const scopesUrl = connector.auth?.scopesUrl;
  /** A public API: no credential, so no permissions and no scope page. */
  const authenticates = (connector.auth?.strategy ?? "none") !== "none";
  const dependentsText = describeDependents(connector.dependents);

  const tabs: Array<{ key: DialogTab; label: string }> = [
    { key: "details", label: "Details" },
    { key: "configure", label: "Configure" },
    { key: "methods", label: "Methods" },
    { key: "scopes", label: "Scopes" },
    { key: "logs", label: "Usage Logs" },
  ];

  const allDone = steps.every((s) => s.done);
  const firstUnfinished = steps.find((s) => !s.done)?.id;

  /*
    How far the wizard is open. The first step that must complete and has not
    is itself reachable — you have to be able to work on it — and everything
    after it is locked, because it cannot be attempted yet anyway: Connect
    without a client secret is a request the provider rejects, and Verify
    without a grant is a call that cannot be made.

    Enforced on the CONTROLS — the rail's buttons and the Next button — rather
    than by clamping the open step. Clamping would fight the moment right after
    a save, when the server has confirmed the write but the revalidated props
    have not arrived, and the wizard would snap backwards again.
  */
  const blockedAt = steps.findIndex((st) => st.mustComplete && !st.done);
  const maxReachable = blockedAt === -1 ? steps.length - 1 : blockedAt;
  const currentId = pinnedStep ?? firstUnfinished ?? steps[0].id;
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === currentId),
  );
  const current = steps[currentIndex];
  const nextStep = steps[currentIndex + 1];
  const wizardVisible = !allDone || showDone;

  /*
    Step one is the only step with nothing to validate — its tick is inferred
    from the credentials arriving later — so it is the only one that needs an
    explicit way forward. Every other step advances by succeeding at its own
    action, which is the whole reason the others do not carry a Next.
  */
  const canAdvance = nextStep != null && currentIndex < maxReachable;
  const advance: ReactNode = canAdvance ? (
    <Button
      variant="primary"
      size="sm"
      onClick={() => setPinnedStep(nextStep!.id)}
    >
      Next
    </Button>
  ) : null;

  /** Open one step from outside the wizard, revealing it if it is collapsed. */
  function jumpTo(stepId: string) {
    setTab("configure");
    setShowDone(true);
    setPinnedStep(stepId);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={connector.displayName}
      subtitle={connector.description}
      fixedHeight
      footer={<Provenance lastUpdated={connector.lastUpdated} authors={connector.authors} />}
      /*
        Where this connector's source lives, alongside the provenance the footer
        already carries, then Remove. Same slot, same wording as the app
        registry's dialog — an admin moving between the two registries should
        not have to learn two places to find an item's path, or its Remove.
      */
      footerAside={
        <span className="flex items-center gap-4">
          <code className="font-mono text-xs text-muted-foreground">
            /connectors/{connector.name}/
          </code>
          {onRemove && <RemoveAction name={connector.displayName} onClick={onRemove} />}
        </span>
      }
      tabs={
        // The band, not a panel: status belongs to the connection rather than to
        // any one tab, so it stays put while the tabs switch beneath it.
        <div className="flex items-center justify-between gap-3">
          <FolderTabs
            items={tabs}
            active={tab}
            onChange={setTab}
            surface="card"
          />
          <span className="flex shrink-0 items-center gap-1.5">
            {disabled && <StatusPill tone="warning">Disabled</StatusPill>}
            <StatusPill tone={STATUS_TONE[state]}>
              {STATUS_LABEL[state]}
            </StatusPill>
          </span>
        </div>
      }
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
          {connector.icon ? (
            <Image
              src={connector.icon}
              alt=""
              width={32}
              height={32}
              className="h-6 w-6 object-contain"
            />
          ) : (
            <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
        </span>
      }
    >
      <div className="space-y-4">
        {tab === "details" && (
          <div className="space-y-5">
            {/*
              First, because it changes what the rest of this dialog can do:
              Connect and Verify are refused while it is off.
            */}
            {disabled && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
                <p className="text-sm font-medium text-foreground">
                  Disabled{disabledText ? ` ${disabledText}` : ""}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Apps can&apos;t call it, and Connect and Verify are refused
                  until it is enabled. Its credentials are kept.
                  {connector.replacement &&
                    " A different connector had this name before, so enabling it asks you to type its name."}
                </p>
              </div>
            )}

            {/*
              The way in, and only while there is a way in to offer. Right
              justified so the button lands where every other primary action in
              this dialog does.
            */}
            {!credentialsSaved ? (
              /*
                Loud on purpose. Everything else on this tab describes a
                connector that works; until it does, the only thing worth
                looking at is the way to make it work — and the dependency
                count says what is waiting on that.
              */
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Not configured yet
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {dependentsText}
                  </p>
                </div>
                <Button variant="primary" onClick={() => setTab("configure")}>
                  Configure
                </Button>
              </div>
            ) : (
              <dl className="space-y-1 text-sm">
                {configuredText && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Configured</dt>
                    <dd className="text-foreground">
                      {configuredText}
                      {verification.configuredBy
                        ? ` by ${verification.configuredBy}`
                        : ""}
                    </dd>
                  </div>
                )}
                {verified && verifiedText && (
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">Last verified</dt>
                    <dd className="text-foreground">
                      {verifiedText}
                      {verification.detail ? ` — ${verification.detail}` : ""}
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {/* ── What apps can call ───────────────────────────────────────
                How many methods, and how many change data: everything an app
                can reach through this connector, and the only things. Each one,
                with the scopes it needs, is on the Methods tab. */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                What apps can call
              </h3>
              <p className="mt-1 text-sm text-foreground">
                Version {connector.version} ·{" "}
                {connector.telemetry.length === 1
                  ? "1 method"
                  : `${connector.telemetry.length} methods`}
                {writes.length > 0
                  ? `, ${writes.length} of which ${writes.length === 1 ? "changes" : "change"} data${
                      changesAllowed ? "" : `, off while it is read-only`
                    }.`
                  : ", none of which changes data."}
              </p>
              {connector.telemetry.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTab("methods")}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2 hover:no-underline"
                >
                  Show methods
                </button>
              )}
            </section>

            {/* ── Who can reach it ─────────────────────────────────────────
                Every app that declares it, whether it runs, what MixOS lets
                it call and what it called lately: what a change here
                affects, and what one of them could do with it. Shown before
                the credentials are saved too, since saving them is what
                hands it to these apps. Last, because it lists every app:
                the one-line sections above stay in view however many
                there are. */}
            <ConnectorReachSection
              reach={connector.reach}
              connectorName={connector.name}
              observed={observed}
              declaredWrites={writes.length}
              disabled={disabled}
              userScoped={connector.userScoped === true}
              authenticates={authenticates}
              writeGrantMissing={reconnectForWrites && connector.userScoped !== true}
              ownCredentials={connector.ownCredentials}
              ownCredentialsSetup={
                connector.userScoped !== true && authenticates && appCredentialActions
                  ? {
                      displayName: connector.displayName,
                      fields: connector.credentialFields,
                      isOAuth,
                      actions: appCredentialActions,
                    }
                  : undefined
              }
              initialApp={initialApp}
            />
          </div>
        )}

        {tab === "methods" && (
          <MethodsPanel
            connector={connector}
            catalogue={catalogue}
            statusByScope={statusByScope}
            changesAllowed={changesAllowed}
            authenticates={authenticates}
          />
        )}

        {tab === "scopes" && (
          <div className="space-y-4 px-5 py-4">
            <section>
              {/*
                First thing on the tab, because it explains why every row below
                resolves to the same value. Read after the key, it arrives once
                the reader has already tried to make sense of fourteen unknowns.
              */}
              {catalogue.length > 0 && !connector.access.grantedKnown && (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
                  {connector.userScoped
                    ? "Each person holds their own grant, and these verdicts are for yours. You have not connected your own account yet, so every scope reads as unknown until you do"
                    : "Nobody has connected this yet, so there is no grant to check against. Every scope reads as unknown until someone does"}{" "}
                  — which is not the same as having been refused.
                </p>
              )}

              {/*
                The key sits above the table, not below it: the icons mean
                nothing on first read, and a key you meet after scanning
                fourteen rows is a key you needed fourteen rows ago.
              */}
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {catalogue.length > 0 && (
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {[
                      {
                        verdict: "held" as const,
                        label: "Granted",
                        tip: "This connector asks for it and the provider granted it, by name or with a scope that includes it. Calls needing it will work.",
                      },
                      {
                        verdict: "refused" as const,
                        label: "Refused",
                        tip: "This connector asks for it and the provider did not grant it — most often because it was unticked on the consent screen, or because the connector was updated to ask for more than the existing grant covers. Reconnect and approve every permission.",
                      },
                      {
                        verdict: "unused" as const,
                        label: "Unknown",
                        tip: "This API documents it, but this connector never asks for it. Not a fault — simply not part of what this connector does.",
                      },
                    ].map((item) => (
                      <InfoTooltip key={item.verdict} tip={item.tip}>
                        <span className="inline-flex items-center gap-1">
                          <ScopeStatusIcon verdict={item.verdict} />
                          {item.label}
                        </span>
                      </InfoTooltip>
                    ))}
                  </span>
                )}
              </div>

              {catalogue.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {authenticates
                    ? "This connector declares no scopes. A developer adds them by running the scopes refresh against the provider's own documentation."
                    : "This connector reaches a public API and authenticates with nothing, so there are no permissions to grant or check."}
                </p>
              ) : (
                /* Striped rather than spaced: fourteen two-line rows read as one
                   wall of text, and a band per row is what lets the eye carry a
                   scope across to its verdict on the right. */
                <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border">
                  {catalogue.map((sc, i) => {
                    const verdict: ScopeVerdict = isScopeRequested(sc, changesAllowed)
                      ? (STATUS_TO_VERDICT[statusByScope.get(sc.scope) ?? ""] ??
                        "unused")
                      : "unused";
                    return (
                      <li
                        key={sc.scope}
                        /*
                          60% is the ceiling, not a taste call. Measured against
                          this theme's tokens, `text-muted-foreground` — which
                          both the description and an unused row's id use — sits
                          on the stripe at 4.51:1 here, 4.46:1 at 75%, and 4.34:1
                          on solid `bg-muted`. The floor is 4.5:1, so a darker
                          band would push the very text it is meant to make
                          readable under it.
                        */
                        className={`flex items-start gap-2 px-3 py-2 ${
                          i % 2 === 1 ? "bg-muted/60" : ""
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {/* The id leads: it is what the provider's console
                                and its docs both call this scope, so it is what
                                someone scanning for one is looking for. */}
                            <span
                              title={sc.scope}
                              className={`break-all font-mono text-sm ${
                                verdict === "unused"
                                  ? "text-muted-foreground"
                                  : "text-foreground"
                              }`}
                            >
                              {shortScopeId(sc.scope)}
                            </span>
                            {sc.access && (
                              <StatusPill tone={SCOPE_TONE[sc.access]}>
                                {SCOPE_LABEL[sc.access]}
                              </StatusPill>
                            )}
                            {/* Asked for only on an install that allows
                                changes, which the verdict beside it follows. */}
                            {sc.requested === "write" && (
                              <StatusPill tone="neutral">
                                {changesAllowed ? "Requested: changes allowed" : "Requested once changes are allowed"}
                              </StatusPill>
                            )}
                            {/* Granted with a broader scope, which may be
                                the only one the provider names. */}
                            {includedIn.has(sc.scope) && (
                              <IncludedInPill scopes={includedIn.get(sc.scope)!} />
                            )}
                          </span>
                          {sc.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {sc.description}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5">
                          <ScopeStatusIcon verdict={verdict} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/*
                No Refresh button, deliberately. The catalogue is committed to
                connector.json and changes only when a developer runs the scopes
                refresh and ships the diff — so there is nothing here for an
                admin to re-read, and a button implying otherwise would be a
                control that cannot affect what is on screen.
              */}
              {scopesUrl && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Source:{" "}
                  <DocLink
                    link={{
                      label: `${connector.displayName} API scopes documentation`,
                      url: scopesUrl,
                    }}
                  />
                </p>
              )}

              {!isOAuth && authenticates && (
                <p className="mt-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                  This connector authenticates with an API key. What that key is
                  permitted to do was decided in the provider&apos;s own console
                  and is not visible here — check it there.
                </p>
              )}
            </section>
          </div>
        )}

        {tab === "logs" && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Last {connector.access.log.length || 100} requests
            </h3>
            {connector.access.log.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing recorded yet. No app has called this connector.
              </p>
            ) : (
              /*
                Scrolls inside itself rather than growing the dialog: the panel
                is a fixed height, and a hundred rows must not be the thing that
                decides how tall it is.
              */
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        When
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        App
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        User
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-semibold">
                        Method
                      </th>
                      <th scope="col" className="py-1.5 font-semibold">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {connector.access.log.map((row, i) => (
                      <tr key={`${row.at}-${i}`} className="align-top">
                        <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                          <LogTime at={row.at} />
                        </td>
                        <td className="py-1.5 pr-3 text-foreground">
                          {row.appSlug ?? "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {/* No user means a scheduled job or a public surface
                              call, not a missing record. */}
                          {row.userName ?? "System"}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-foreground">
                          {row.method}
                        </td>
                        <td className="py-1.5">
                          {row.outcome === "ok" ? (
                            <Check
                              role="img"
                              aria-label="Succeeded"
                              className="h-4 w-4 text-success"
                            />
                          ) : row.outcome === "error" ? (
                            <StatusPill tone="danger">
                              {row.errorCategory ?? "failed"}
                            </StatusPill>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section hidden={tab !== "configure"}>
          {/*
            Configured: the wizard has nothing left to walk anyone through, so
            it gives way to the one fact worth having — when, and by whom — and
            a way back in. Re-reading four completed steps is not what someone
            opens this tab for.
          */}
          {allDone && !showDone && (
            <div className="rounded-lg border border-success/40 bg-success/10 p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
                <span className="font-medium">Configured</span>
                {configuredText && (
                  <span className="text-muted-foreground">
                    {configuredText}
                    {verification.configuredBy
                      ? ` by ${verification.configuredBy}`
                      : ""}
                  </span>
                )}
              </p>
              {verified && verifiedText && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last verified {verifiedText}
                  {verification.detail ? ` — ${verification.detail}` : ""}.
                </p>
              )}
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setShowDone(true);
                  setPinnedStep(steps[0].id);
                }}
              >
                Update configuration
              </Button>
            </div>
          )}

          {wizardVisible && (
            <>
              <div className={allDone ? "mt-3" : ""}>
                <StepRail
                  steps={steps}
                  currentId={currentId}
                  maxReachable={maxReachable}
                  onSelect={setPinnedStep}
                />

                <div className="mt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {current.title}
                    </h3>
                    {/* The green tick again, in words, for the step you are
                        actually looking at — the rail's tick is 8px of glyph. */}
                    {current.done && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                        <Check className="h-3.5 w-3.5" aria-hidden />
                        Completed
                      </span>
                    )}
                  </div>

                  <div className="mt-3 space-y-3">{current.body}</div>

                  {/* Always this corner, every step. */}
                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                    {currentIndex > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mr-auto"
                        onClick={() =>
                          setPinnedStep(steps[currentIndex - 1].id)
                        }
                      >
                        Back
                      </Button>
                    )}
                    {current.action}
                    {(current.action == null || current.done) && advance}
                  </div>
                </div>
              </div>
            </>
          )}
          {/* The three things an admin opens a working connector for. Each
              jumps to the step that owns it rather than duplicating its
              controls. */}
          {allDone && (
            <div className="mt-4 flex flex-wrap gap-2">
              {hasCredentials && (
                <Button size="sm" onClick={() => jumpTo("credentials")}>
                  Update credentials
                </Button>
              )}
              {writes.length > 0 && (
                <Button size="sm" onClick={() => jumpTo("changes")}>
                  Change access
                </Button>
              )}
              {isOAuth && (
                <Button size="sm" onClick={() => jumpTo("authorize")}>
                  Reconnect
                </Button>
              )}
              <Button size="sm" onClick={() => jumpTo("verify")}>
                Verify again
              </Button>
            </div>
          )}

          {/*
            Reference material, below the checklist rather than inside a step:
            a scope table under "Create a Google Cloud OAuth app" reads as part
            of that step and gets done or skipped accordingly. A link here has
            no sentence around it, so its "?" says when to open it.
          */}
          {setup?.docs && setup.docs.length > 0 && (
            <section className="mt-5 border-t border-border pt-3">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Reference
              </h3>
              <ul className="mt-2 space-y-1.5">
                {setup.docs.map((doc) => (
                  <li key={doc.url} className="text-sm">
                    <DocLink link={doc} />{" "}
                    <InfoTooltip tip={doc.why} className="align-text-bottom">
                      <HelpCircle
                        aria-label={`When to open ${doc.label}`}
                        role="img"
                        className="h-4 w-4 text-muted-foreground hover:text-foreground"
                      />
                    </InfoTooltip>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      </div>
    </Dialog>
  );
}
