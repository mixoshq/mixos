/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import Notice from "@/components/ui/notice";
import { startAppCreationAction } from "@/lib/github/actions";
import type { GitHubOutcome } from "@/lib/github/outcomes";
import { OutcomeNotice, PermissionsList } from "./github-parts";

/**
 * Step 1: create the App on GitHub from a manifest.
 *
 * The server action keeps a one-time state for this admin and answers with the
 * manifest and GitHub's URL; this then posts the manifest there in a plain form,
 * as GitHub's manifest flow requires. The page's Content-Security-Policy lets a
 * form on this page, and only this page, post to github.com (src/proxy.ts).
 */
export default function CreateApp({ origin, defaultName }: { origin: string | null; defaultName: string }) {
  const [account, setAccount] = useState<"user" | "organization">("user");
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<GitHubOutcome | null>(null);
  const [post, setPost] = useState<{ action: string; manifest: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (post) form.current?.submit();
  }, [post]);

  const start = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const outcome = await startAppCreationAction({
        account,
        organization: account === "organization" ? organization : undefined,
        name,
      });
      if (outcome.ok) setPost({ action: outcome.action, manifest: outcome.manifest });
      else {
        setRefusal(outcome);
        setBusy(false);
      }
    } catch {
      setRefusal({ ok: false, code: "error", message: "That didn't reach the server. Try again.", tone: "warning" });
      setBusy(false);
    }
  };

  return (
    <Card as="section">
      <CardHeader
        title="Create the App"
        description="Step 1 of 3. A private GitHub App, on the account that owns the repository this instance is built from."
      />
      <CardBody>
        <div className="space-y-5">
          <p className="text-sm text-foreground">
            GitHub shows what the App asks for before you confirm. It asks for this, on the one repository you
            install it on:
          </p>
          <PermissionsList />
          {!origin && (
            <Notice tone="warning">
              This instance&apos;s public URL isn&apos;t set, so GitHub would have nowhere to send you back. Set{" "}
              <code className="font-mono text-xs">NEXTAUTH_URL</code> first.
            </Notice>
          )}
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && origin) void start();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Owner</legend>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="account"
                  checked={account === "user"}
                  onChange={() => setAccount("user")}
                />
                My GitHub account
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="radio"
                  name="account"
                  checked={account === "organization"}
                  onChange={() => setAccount("organization")}
                />
                An organization
              </label>
            </fieldset>
            {account === "organization" && (
              <Field label="Organization" hint="Its login, as in github.com/<login>.">
                {(field) => (
                  <Input
                    {...field}
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="font-mono"
                  />
                )}
              </Field>
            )}
            <Field label="App name" hint="Up to 34 characters, unique on GitHub. You can change it there.">
              {(field) => (
                <Input
                  {...field}
                  value={name}
                  maxLength={34}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            {refusal && <OutcomeNotice outcome={refusal} />}
            <Button type="submit" variant="primary" busy={busy} busyLabel="Opening GitHub…" disabled={!origin}>
              Create on GitHub
            </Button>
          </form>
        </div>
        {/* GitHub's manifest flow: a plain POST of the manifest, from this page. */}
        <form ref={form} method="post" action={post?.action} hidden aria-hidden>
          <input type="hidden" name="manifest" value={post?.manifest ?? ""} readOnly />
        </form>
      </CardBody>
    </Card>
  );
}
