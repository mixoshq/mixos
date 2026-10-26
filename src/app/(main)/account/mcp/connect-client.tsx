/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, Plus } from "lucide-react";
import { CopyButton } from "@/components/admin/copy-button";
import { Card } from "@/components/ui/card";
import FolderTabs from "@/components/ui/folder-tabs";
import Notice from "@/components/ui/notice";

/**
 * How to connect an MCP client, one tab per client.
 *
 * Every client gets the same three things: the URL, a way to copy it, and a
 * link to the screen in that client where it gets pasted. None of them needs a
 * key or a client secret — MixOS is an OAuth server with open dynamic client
 * registration (src/app/api/oauth/register/route.ts), so each client registers
 * itself and then sends the user to the consent screen. That is why the steps
 * all end the same way, and why "leave the OAuth fields empty" is the advice.
 *
 * The menu paths are the clients', not ours, and they move. When one changes,
 * this is the only place to update.
 */

type ClientKey = "claude" | "chatgpt" | "copilot";

interface ClientGuide {
  key: ClientKey;
  label: string;
  intro: string;
  open: { href: string; label: string };
  steps: ReactNode[];
  note?: ReactNode;
}

const CLIENTS: ClientGuide[] = [
  {
    key: "claude",
    label: "Claude",
    intro: "Add MixOS to Claude as a custom connector.",
    open: { href: "https://claude.ai/customize/connectors", label: "Open Claude" },
    steps: [
      <>
        In Claude, go to <strong>Customize → Connectors</strong>.
      </>,
      <>
        Click <strong>+ Add</strong>, then <strong>Add custom connector</strong>.
      </>,
      <>
        Name it <strong>MixOS</strong>, paste the URL above, and click{" "}
        <strong>Continue</strong>.
      </>,
      <>
        Keep the sign-in settings Claude detects. Leave the OAuth client ID and
        secret empty, then click <strong>Add</strong>.
      </>,
      <>
        Sign in to MixOS when asked, and choose which apps Claude may read.
      </>,
      <>
        In a chat, turn MixOS on under <strong>+ → Connectors</strong>.
      </>,
    ],
    note: (
      <>
        On a Team or Enterprise plan, an owner adds the connector under{" "}
        <strong>Organization settings → Connectors</strong>. Everyone else then
        clicks <strong>Connect</strong> on it.
      </>
    ),
  },
  {
    key: "chatgpt",
    label: "ChatGPT",
    intro: "Add MixOS to ChatGPT as an MCP app, using Developer mode.",
    open: { href: "https://chatgpt.com/", label: "Open ChatGPT" },
    steps: [
      <>
        In ChatGPT, go to <strong>Settings → Security and sign-in</strong> and
        turn on <strong>Developer mode</strong>.
      </>,
      <>
        Open <strong>Plugins</strong>, click <strong>+</strong>, then{" "}
        <strong>Create an MCP app</strong>.
      </>,
      <>
        Name it <strong>MixOS</strong>, paste the URL above into{" "}
        <strong>Connection</strong>, and leave <strong>Authentication</strong>{" "}
        on <strong>OAuth</strong>.
      </>,
      <>
        Tick <strong>I understand and want to continue</strong>, then click{" "}
        <strong>Create</strong>.
      </>,
      <>
        Sign in to MixOS when asked, and choose which apps ChatGPT may read.
      </>,
      <>
        In a new chat, ask for MixOS by name: &ldquo;Use MixOS to…&rdquo;.
        Temporary chats can&apos;t use it.
      </>,
    ],
    note: (
      <>
        Developer mode needs a Plus, Pro, Business, Enterprise or Edu plan. On
        Business and Enterprise, a workspace admin has to allow it first.
      </>
    ),
  },
  {
    key: "copilot",
    label: "Copilot",
    intro:
      "Add MixOS as a tool on a Copilot Studio agent, then use that agent in Microsoft 365 Copilot.",
    open: {
      href: "https://copilotstudio.microsoft.com/",
      label: "Open Copilot Studio",
    },
    steps: [
      <>In Copilot Studio, open the agent that should read MixOS, or create one.</>,
      <>
        Go to <strong>Tools → Add a tool → New tool → Model Context Protocol</strong>.
      </>,
      <>
        Name it <strong>MixOS</strong>, describe it as &ldquo;Read-only data
        from my MixOS apps&rdquo;, and paste the URL above as the{" "}
        <strong>Server URL</strong>.
      </>,
      <>
        For <strong>Authentication</strong>, choose <strong>OAuth 2.0</strong>,
        then <strong>Dynamic discovery</strong>, and click{" "}
        <strong>Create</strong>.
      </>,
      <>
        Choose <strong>Create a new connection</strong>, sign in to MixOS and
        choose which apps Copilot may read, then click{" "}
        <strong>Add to agent</strong>.
      </>,
      <>
        To use it in Microsoft 365 Copilot or Teams, publish the agent to the{" "}
        <strong>Teams and Microsoft 365 Copilot</strong> channel.
      </>,
    ],
  },
];

function ConnectPanel({
  mcpUrl,
  notice,
}: {
  mcpUrl: string;
  /** Applies to every tab, so it sits above the tab's own content. */
  notice?: ReactNode;
}) {
  const [active, setActive] = useState<ClientKey>("claude");
  const [showSteps, setShowSteps] = useState(false);
  const client = CLIENTS.find((c) => c.key === active) ?? CLIENTS[0];
  const stepsId = "mcp-manual-instructions";

  return (
    <>
      {/* The tab band from a tabbed Dialog (App Details): it shares the
          header's muted ground, the one rule runs full width beneath it, and
          the active tab's card fill punches through into the panel. */}
      <div className="border-b border-border bg-muted/40 px-4">
        <FolderTabs
          items={CLIENTS.map(({ key, label }) => ({ key, label }))}
          active={active}
          onChange={setActive}
          surface="card"
        />
      </div>

      <div className="px-4 py-3">
        {notice && <div className="mb-3">{notice}</div>}
        <p className="text-sm text-muted-foreground">{client.intro}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2 sm:flex-nowrap">
          {/* Wraps rather than scrolls: at this width a long origin would
              otherwise hide the end of the URL people are meant to check. */}
          <code className="min-w-0 flex-1 break-all rounded bg-muted px-3 py-2 text-xs">
            {mcpUrl}
          </code>
          <CopyButton text={mcpUrl} label="Copy URL" iconOnly />
          <a
            href={client.open.href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
          >
            {client.open.label}
            <ExternalLink className="h-4 w-4" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>

        <button
          type="button"
          onClick={() => setShowSteps((v) => !v)}
          aria-expanded={showSteps}
          aria-controls={stepsId}
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-foreground hover:underline"
        >
          Manual instructions
          <ChevronDown
            className={`h-4 w-4 transition-transform ${showSteps ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>

        {showSteps && (
          <div id={stepsId} className="mt-2">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              {client.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            {client.note && (
              <p className="mt-3 text-xs text-muted-foreground">{client.note}</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Open while nothing is connected, since connecting is the only thing to do on
 * the page. Once something is, it folds down to "Connect another client" so
 * the connected list leads.
 *
 * While it's the only thing on the page, it also carries the one fact the
 * hidden "Apps you can share" list would have: that there's nothing to share
 * yet. Once a client is connected, that list says so itself.
 */
export default function ConnectClient({
  mcpUrl,
  hasClients,
  hasSharedApps,
}: {
  mcpUrl: string;
  hasClients: boolean;
  hasSharedApps: boolean;
}) {
  const [open, setOpen] = useState(false);

  // The header is a tabbed Dialog's: title and subtitle on the tab band's
  // ground whenever the tabs are showing. The card isn't overflow-hidden, so a
  // filled first child rounds its own top corners.
  const band = "rounded-t-lg bg-muted/40";
  const subtitle = (
    <p className="mt-0.5 text-sm text-muted-foreground">
      Each client sends you back here to sign in and choose which apps it may
      read.
    </p>
  );

  if (!hasClients) {
    return (
      <Card className="mt-6 max-w-3xl shadow-sm">
        <div className={`${band} px-4 py-3`}>
          <h2 className="text-base font-semibold text-foreground">
            Connect a client
          </h2>
          {subtitle}
        </div>
        <ConnectPanel
          mcpUrl={mcpUrl}
          notice={
            !hasSharedApps && (
              <Notice tone="warning">
                None of your apps share data over MCP yet, so a client would
                have nothing to read.
              </Notice>
            )
          }
        />
      </Card>
    );
  }

  return (
    <Card className="mt-6 max-w-3xl shadow-sm">
      <div className={`px-4 py-3 ${open ? band : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 text-base font-semibold text-foreground"
        >
          <span className="inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden />
            Connect another client
          </span>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
        {open && subtitle}
      </div>
      {open && <ConnectPanel mcpUrl={mcpUrl} />}
    </Card>
  );
}
