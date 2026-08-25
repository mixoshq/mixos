"use client";

import { useEffect, useState } from "react";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushPermission,
  isPushSubscribed,
  isPushSupported,
  type PushEnableResult,
} from "@/lib/apps/sdk";

/**
 * Browser notification opt-in for My Account → Preferences. Web Push is one
 * subscription per browser, shared across all MixOS apps, so enabling here
 * covers every app that sends notifications. Detects the current state and
 * shows the matching control + guidance.
 */
export default function NotificationsPreference() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  );
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when an enable attempt surfaces a state the booleans don't capture.
  const [lastResult, setLastResult] = useState<PushEnableResult | null>(null);

  useEffect(() => {
    const ok = isPushSupported();
    setSupported(ok);
    setPermission(getPushPermission());
    if (ok) isPushSubscribed().then(setSubscribed);
    else setSubscribed(false);
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const result = await enablePushNotifications();
      setLastResult(result);
      setPermission(getPushPermission());
      setSubscribed(await isPushSubscribed());
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await disablePushNotifications();
      setLastResult(null);
      setSubscribed(await isPushSubscribed());
    } finally {
      setBusy(false);
    }
  }

  const enabled = supported === true && permission === "granted" && subscribed === true;

  return (
    <div className="border-t border-border pt-6">
      <div className="mb-1 text-sm font-medium text-foreground">
        Notifications
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Get browser notifications from MixOS apps (e.g. deal wins, lunch
        arrivals) even when no MixOS tab is focused. This applies to this
        browser on this device.
      </p>

      {/* Still detecting state on first paint. */}
      {supported === null || subscribed === null ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : !supported ? (
        <Note tone="muted">
          This browser doesn’t support web push notifications. Try a recent
          Chrome, Edge, or Firefox on desktop. On iOS, notifications work only
          when MixOS is installed to your Home Screen (iOS 16.4+).
        </Note>
      ) : enabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-sm font-medium text-emerald-900">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Enabled on this browser
          </span>
          <button
            onClick={disable}
            disabled={busy}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            {busy ? "Working…" : "Disable"}
          </button>
        </div>
      ) : permission === "denied" ? (
        <Note tone="warning">
          Notifications are blocked for this site in your browser. To turn them
          on, open your browser’s site settings for MixOS, allow
          notifications, then reload this page.
        </Note>
      ) : (
        <div className="space-y-3">
          <button
            onClick={enable}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-md bg-mixnavy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixnavy/90 disabled:opacity-50"
          >
            🔔 {busy ? "Enabling…" : "Enable notifications"}
          </button>
          {lastResult === "not-configured" && (
            <Note tone="warning">
              Push isn’t configured on this server yet. Contact your
              administrator to set up notification keys.
            </Note>
          )}
          {lastResult === "error" && (
            <Note tone="warning">
              Something went wrong enabling notifications. Please try again.
            </Note>
          )}
        </div>
      )}
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "muted" | "warning";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warning"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : "border-border bg-muted/50 text-muted-foreground";
  return (
    <div className={`rounded-md border p-3 text-xs ${cls}`}>{children}</div>
  );
}
