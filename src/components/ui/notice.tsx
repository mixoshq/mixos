/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  XCircle,
} from "lucide-react";

/**
 * A boxed message: the install, review and register screens, and the notices
 * under the Apps, Connectors and Themes pages' headers
 * (../admin/registry-notices.tsx).
 *
 * Six tones, by what the reader has to do. `info` is how something works,
 * such as a built deployment not installing: nothing is wrong, so it is not
 * dressed as a warning. `neutral` is a wait, such as a lock someone else
 * holds, or news that asks nothing. `accent` is news worth acting on that
 * isn't a fault, such as a new release: the brand's accent with a bar down
 * its left edge, as the admin pages' other callouts are drawn. `warning` asks
 * for something; `danger` is a fault; `success` is done. There is no info
 * colour among the theme tokens, so `info` is the neutral ground with its own
 * icon.
 */
export type Tone = "info" | "neutral" | "accent" | "warning" | "danger" | "success";

const TONES: Record<Tone, string> = {
  info: "border-border bg-muted",
  accent: "border-transparent border-l-4 border-l-brand-accent bg-brand-accent/10",
  neutral: "border-border bg-muted",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/40 bg-destructive/10",
  success: "border-success/40 bg-success/10",
};

const ICONS: Record<Tone, ReactNode> = {
  info: <Info className="h-4 w-4" aria-hidden />,
  neutral: <Clock className="h-4 w-4" aria-hidden />,
  accent: <Info className="h-4 w-4" aria-hidden />,
  warning: <AlertTriangle className="h-4 w-4" aria-hidden />,
  danger: <XCircle className="h-4 w-4" aria-hidden />,
  success: <CheckCircle2 className="h-4 w-4" aria-hidden />,
};

export default function Notice({
  tone,
  title,
  children,
  icon,
}: {
  tone: Tone;
  /** A first line in bold, when the message needs a headline. */
  title?: string;
  children?: ReactNode;
  /** Replaces the tone's own icon. */
  icon?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      data-tone={tone}
      className={`rounded-lg border px-4 py-3 text-sm text-foreground ${TONES[tone]}`}
    >
      <div className="flex gap-2">
        <span className={`mt-0.5 shrink-0 ${tone === "accent" ? "text-primary" : ""}`}>
          {icon ?? ICONS[tone]}
        </span>
        <div className="min-w-0">
          {title && <p className="font-medium">{title}</p>}
          {children && <div className={title ? "mt-1" : undefined}>{children}</div>}
        </div>
      </div>
    </div>
  );
}
