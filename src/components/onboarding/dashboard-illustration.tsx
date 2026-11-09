/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import {
  GitPullRequest,
  MessageSquare,
  Sheet,
  SquareKanban,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { fitLogo, type LogoBox } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";

/** The menu bar's mark, at the picture's scale. */
const MINI_LOGO_BOX: LogoBox = { height: 12, maxWidth: 80 };

/**
 * The welcome tour's picture of a workspace: a menu bar over a dashboard of
 * widgets, each one fed by a tool the copy beside it names — a sheet, a team
 * chat, pull requests, a board — and one number they add up to.
 *
 * Drawn, not screenshotted: every colour is a theme token, so it shows the
 * workspace the person is about to see, in its colours, under any theme, and
 * it can't drift from a real dashboard nobody has built yet. The lines and
 * dots are placeholders for content, as a wireframe's are; only the titles are
 * words, and the bar's brand, which is the install's own mark and name: the
 * one that just flew to the corner above it.
 *
 * Decorative: the sentence under it says the same thing in words, so the
 * whole picture is hidden from assistive technology.
 *
 * `shown` brings the widgets in one after another, once the frame is up.
 */
export default function DashboardIllustration({
  logo,
  name,
  shown,
}: {
  logo: BrandLogo | null;
  name: string;
  shown: boolean;
}) {
  const mark = logo ? fitLogo(logo, MINI_LOGO_BOX) : null;
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-xl border border-brand-foreground/15 text-left shadow-2xl shadow-black/30"
    >
      {/* The menu bar, as the real one lays it out: brand left, then
          Dashboard and Apps, the account at the far end. */}
      <div className="flex h-6 items-center gap-1.5 border-b border-brand-foreground/10 bg-brand px-2.5 sm:h-7">
        {mark && <Image src={mark.src} alt="" width={mark.width} height={mark.height} />}
        <span className="max-w-[40%] truncate font-heading text-[9px] font-bold leading-none text-brand-foreground sm:text-[10px]">
          {name}
        </span>
        <span className="ml-2 h-1.5 w-7 rounded-full bg-brand-foreground/25" />
        <span className="h-1.5 w-5 rounded-full bg-brand-foreground/25" />
        <span className="ml-auto h-2.5 w-2.5 rounded-full bg-brand-foreground/30" />
      </div>

      <div className="grid grid-cols-6 gap-1.5 bg-muted p-1.5 sm:gap-2 sm:p-2">
        <Widget span="col-span-4" icon={Sheet} tint="text-cat-3" title="Pipeline" shown={shown} order={0}>
          <div className="space-y-1">
            {[0.9, 0.7, 0.8, 0.6].map((w, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Line className="w-[38%]" style={{ opacity: w }} />
                <Line className="w-[22%]" />
                <span
                  className={`ml-auto h-1.5 w-6 rounded-full ${
                    i % 2 ? "bg-cat-1/40" : "bg-success/40"
                  }`}
                />
              </div>
            ))}
          </div>
        </Widget>

        <Widget span="col-span-2" icon={TrendingUp} tint="text-success" title="Revenue" shown={shown} order={1}>
          <div className="flex h-full flex-col justify-between gap-1">
            <span className="font-heading text-sm font-bold leading-none text-card-foreground sm:text-base">
              $48.2k
            </span>
            <div className="flex h-5 items-end gap-0.5">
              {[35, 50, 42, 60, 55, 75, 90].map((h, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-[1px] bg-success/50"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </div>
        </Widget>

        <Widget span="col-span-2" icon={MessageSquare} tint="text-cat-2" title="Team chat" shown={shown} order={2}>
          <div className="space-y-1.5">
            {["bg-cat-2/50", "bg-cat-4/50", "bg-cat-5/50"].map((dot, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                <Line className={i === 1 ? "w-1/2" : "w-3/4"} />
              </div>
            ))}
          </div>
        </Widget>

        <Widget span="col-span-2" icon={GitPullRequest} tint="text-cat-1" title="Pull requests" shown={shown} order={3}>
          <div className="space-y-1.5">
            {["bg-success", "bg-warning", "bg-success"].map((dot, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <Line className={i === 2 ? "w-2/3" : "w-4/5"} />
              </div>
            ))}
          </div>
        </Widget>

        <Widget span="col-span-2" icon={SquareKanban} tint="text-cat-4" title="Sprint board" shown={shown} order={4}>
          <div className="grid grid-cols-3 gap-0.5">
            {[2, 3, 1].map((cards, col) => (
              <div key={col} className="space-y-0.5 rounded-sm bg-muted p-0.5">
                {Array.from({ length: cards }, (_, i) => (
                  <span key={i} className="block h-1.5 rounded-[1px] bg-card shadow-sm" />
                ))}
              </div>
            ))}
          </div>
        </Widget>
      </div>
    </div>
  );
}

function Widget({
  span,
  icon: Icon,
  tint,
  title,
  shown,
  order,
  children,
}: {
  span: string;
  icon: LucideIcon;
  tint: string;
  title: string;
  shown: boolean;
  order: number;
  children: ReactNode;
}) {
  return (
    <div
      className={`${span} flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-card p-1.5 transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none sm:p-2 ${
        shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
      style={{ transitionDelay: shown ? `${order * 120}ms` : "0ms" }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Icon className={`h-2.5 w-2.5 shrink-0 sm:h-3.5 sm:w-3.5 ${tint}`} />
        <span className="truncate text-[8px] font-semibold leading-none text-card-foreground sm:text-[11px]">
          {title}
        </span>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Line({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      className={`block h-1 rounded-full bg-muted-foreground/25 ${className}`}
      style={style}
    />
  );
}
