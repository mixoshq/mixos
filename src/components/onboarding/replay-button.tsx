"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/lib/onboarding/actions";
import { usePreferences } from "@/components/preferences-context";

export default function ReplayTourButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { stopOnboarding } = usePreferences();

  function handleReplay() {
    startTransition(async () => {
      stopOnboarding();
      await resetOnboarding();
      router.push("/");
      router.refresh();
    });
  }

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <div className="mb-1 text-sm font-medium text-foreground">
        Welcome tour
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Replay the first-run introduction that walks you through installing an
        app and adding your first dashboard widget.
      </p>
      <button
        type="button"
        onClick={handleReplay}
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        {isPending ? "Starting…" : "Replay welcome tour"}
      </button>
    </div>
  );
}
