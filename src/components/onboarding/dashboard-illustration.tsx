/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
 * widgets, each one fed by a different kind of tool — a sheet, a team chat,
 * pull requests, a board — and one number they add up to.
 *
 * Framed at 16:10, a laptop screen's shape, so it reads as the screen the
 * person is about to look at rather than a diagram.
 *
 * Drawn, not screenshotted: every colour is a theme token, so it shows the
 * workspace the person is about to see, in its colours, under any theme, and
 * it can't drift from a real dashboard nobody has built yet. The lines and
 * dots are placeholders for content, as a wireframe's are; only the titles are
 * words, and the bar's brand, which is the install's own mark and name: the
 * one that just flew to the corner above it.
 *
 * IT PLAYS, ON A LOOP, ONCE IT IS UP. What a dashboard does, then what you can
 * do to one: the widgets' contents move twice — the number ticks, a message
 * arrives, a pull request's check moves on, a card moves along the board —
 * then a rest, then the widgets themselves move and resize into another
 * arrangement, then a rest, and round again, back the other way. Contents are
 * drawn from `step`, which only counts up, so every change is the next one
 * rather than a reset. Reduced motion gets the first frame, still.
 *
 * Decorative: the sentence under it says the same thing in words, so the
 * whole picture is hidden from assistive technology.
 */

/** Waits before each beat of the loop. The first waits for the widgets to come in. */
const START_MS = 1400;
const STEP_MS = 1200;
const REST_MS = 1400;
const MOVE_MS = 900;

/** A widget's place on a six-column, three-row dashboard. */
type Slot = { x: number; y: number; w: number; h: number };
type WidgetKey = "pipeline" | "revenue" | "chat" | "pulls" | "board";

const COLS = 6;
const ROWS = 3;

/**
 * Where each widget sits in the two arrangements the loop moves between.
 * Each fills the grid exactly, and every widget moves between them; Revenue
 * and Pull requests change size as well.
 */
const ARRANGEMENTS: Record<WidgetKey, [Slot, Slot]> = {
  pipeline: [{ x: 0, y: 0, w: 4, h: 1 }, { x: 2, y: 0, w: 4, h: 1 }],
  revenue: [{ x: 4, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 2, h: 1 }],
  chat: [{ x: 0, y: 1, w: 2, h: 2 }, { x: 4, y: 1, w: 2, h: 2 }],
  pulls: [{ x: 2, y: 1, w: 2, h: 1 }, { x: 0, y: 2, w: 4, h: 1 }],
  board: [{ x: 2, y: 2, w: 4, h: 1 }, { x: 0, y: 1, w: 4, h: 1 }],
};

const REVENUE = ["$41.7k", "$44.9k", "$48.2k", "$52.6k", "$50.1k", "$55.3k"];
/** Bar heights, read seven at a time from a moving start, so the chart scrolls. */
const SERIES = [35, 50, 42, 60, 55, 75, 90, 70, 82, 64, 88, 95];
const PILLS = ["bg-success/40", "bg-cat-1/40", "bg-warning/40"];
const CHAT_DOTS = ["bg-cat-2/50", "bg-cat-4/50", "bg-cat-5/50"];
const CHAT_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-4/5"];
/** Enough to fill the chat at its tallest; shorter places clip the oldest. */
const CHAT_ROWS = 12;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function DashboardIllustration({
  logo,
  name,
  shown,
}: {
  logo: BrandLogo | null;
  name: string;
  /** Brings the widgets in one after another, then starts the loop. */
  shown: boolean;
}) {
  const mark = logo ? fitLogo(logo, MINI_LOGO_BOX) : null;
  const [step, setStep] = useState(0);
  const [arrangement, setArrangement] = useState<0 | 1>(0);

  // One timer at a time, each beat scheduling the next: contents, contents,
  // rest, rearrange, rest. Stops when the picture is hidden or unmounted.
  useEffect(() => {
    if (!shown || prefersReducedMotion()) return;
    const loop: [wait: number, run: () => void][] = [
      [MOVE_MS + REST_MS, () => setStep((s) => s + 1)],
      [STEP_MS, () => setStep((s) => s + 1)],
      [STEP_MS + REST_MS, () => setArrangement((a) => (a === 0 ? 1 : 0))],
    ];
    let i = 0;
    let timer = 0;
    const schedule = (wait: number) => {
      timer = window.setTimeout(() => {
        loop[i % loop.length][1]();
        i++;
        schedule(loop[i % loop.length][0]);
      }, wait);
    };
    schedule(START_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const place = (key: WidgetKey) => ARRANGEMENTS[key][arrangement];

  return (
    <div
      aria-hidden
      className="flex aspect-[16/10] flex-col overflow-hidden rounded-xl border border-brand-foreground/15 text-left shadow-2xl shadow-black/30"
    >
      {/* The menu bar, as the real one lays it out: brand left, then
          Dashboard and Apps, the account at the far end. */}
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-brand-foreground/10 bg-brand px-2.5 sm:h-7">
        {mark && <Image src={mark.src} alt="" width={mark.width} height={mark.height} />}
        <span className="max-w-[40%] truncate font-heading text-[9px] font-bold leading-none text-brand-foreground sm:text-[10px]">
          {name}
        </span>
        <span className="ml-2 h-1.5 w-7 rounded-full bg-brand-foreground/25" />
        <span className="h-1.5 w-5 rounded-full bg-brand-foreground/25" />
        <span className="ml-auto h-2.5 w-2.5 rounded-full bg-brand-foreground/30" />
      </div>

      {/* Placed absolutely, in percentages of a six-by-three grid, so a
          widget can glide to a new place and size; a grid track can't
          animate. The padding on each slot is the gap between widgets. Lists
          carry more rows than the smaller places show, and clip. */}
      <div className="min-h-0 flex-1 bg-muted p-[3px] sm:p-1">
        <div className="relative h-full">
          <Widget slot={place("pipeline")} icon={Sheet} tint="text-cat-3" title="Pipeline" shown={shown} order={0}>
            <div className="space-y-1.5">
              {[0.9, 0.7, 0.8, 0.6, 0.75, 0.85].map((w, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Line className="w-[38%]" style={{ opacity: w }} />
                  <Line className="w-[22%]" />
                  <span
                    className={`ml-auto h-1.5 w-6 shrink-0 rounded-full transition-colors duration-500 ${
                      PILLS[(i + step) % PILLS.length]
                    }`}
                  />
                </div>
              ))}
            </div>
          </Widget>

          <Widget slot={place("revenue")} icon={TrendingUp} tint="text-success" title="Revenue" shown={shown} order={1}>
            <div className="flex h-full flex-col justify-between gap-1">
              <span
                key={step}
                className={`font-heading text-sm font-bold leading-none text-card-foreground sm:text-base ${
                  step > 0 ? "illustration-in" : ""
                }`}
              >
                {REVENUE[step % REVENUE.length]}
              </span>
              <div className="flex h-1/2 min-h-3 items-end gap-0.5">
                {Array.from({ length: 7 }, (_, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-[1px] bg-success/50 transition-[height] duration-700 ease-out"
                    style={{ height: `${SERIES[(i + step) % SERIES.length]}%` }}
                  />
                ))}
              </div>
            </div>
          </Widget>

          <Widget slot={place("chat")} icon={MessageSquare} tint="text-cat-2" title="Team chat" shown={shown} order={2}>
            {/* The latest of an endless conversation, held to the bottom so the
                newest is always in view: each step, a new message comes in
                there and the oldest leaves off the top. */}
            <div className="flex h-full flex-col justify-end gap-1.5">
              {Array.from({ length: CHAT_ROWS }, (_, row) => {
                const k = step + row;
                return (
                  <div
                    key={k}
                    className={`flex shrink-0 items-center gap-1 ${
                      row === CHAT_ROWS - 1 && step > 0 ? "illustration-in" : ""
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${CHAT_DOTS[k % CHAT_DOTS.length]}`} />
                    <Line className={CHAT_WIDTHS[k % CHAT_WIDTHS.length]} />
                  </div>
                );
              })}
            </div>
          </Widget>

          <Widget slot={place("pulls")} icon={GitPullRequest} tint="text-cat-1" title="Pull requests" shown={shown} order={3}>
            {/* One pull request's check is running at a time, and it moves on
                each step, as checks pass and the next one starts. */}
            <div className="space-y-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-1">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-500 ${
                      (i + step) % 5 === 1 ? "bg-warning" : "bg-success"
                    }`}
                  />
                  <Line className={i % 2 ? "w-2/3" : "w-4/5"} />
                </div>
              ))}
            </div>
          </Widget>

          <Widget slot={place("board")} icon={SquareKanban} tint="text-cat-4" title="Sprint board" shown={shown} order={4}>
            {/* Three columns, and one card working its way across them. */}
            <div className="relative grid h-full grid-cols-3 gap-0.5">
              {[2, 1, 1].map((cards, col) => (
                <div key={col} className="space-y-0.5 rounded-sm bg-muted p-0.5">
                  {Array.from({ length: cards }, (_, i) => (
                    <span key={i} className="block h-1.5 rounded-[1px] bg-card shadow-sm" />
                  ))}
                </div>
              ))}
              <span
                className="absolute bottom-0.5 block h-1.5 rounded-[1px] bg-cat-4/50 shadow-sm transition-[left] duration-700 ease-in-out"
                style={{
                  left: `calc(${(step % 3) * (100 / 3)}% + 2px)`,
                  width: `calc(${100 / 3}% - 6px)`,
                }}
              />
            </div>
          </Widget>
        </div>
      </div>
    </div>
  );
}

function Widget({
  slot,
  icon: Icon,
  tint,
  title,
  shown,
  order,
  children,
}: {
  slot: Slot;
  icon: LucideIcon;
  tint: string;
  title: string;
  shown: boolean;
  order: number;
  children: ReactNode;
}) {
  // Coming in staggers; moving does not, so the dashboard rearranges as one.
  const delay = shown ? order * 120 : 0;
  const glide = `${MOVE_MS}ms cubic-bezier(0.32, 0, 0.2, 1)`;
  return (
    <div
      className={`absolute p-[3px] sm:p-1 ${
        shown ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
      style={{
        left: `${(slot.x / COLS) * 100}%`,
        top: `${(slot.y / ROWS) * 100}%`,
        width: `${(slot.w / COLS) * 100}%`,
        height: `${(slot.h / ROWS) * 100}%`,
        transition: `opacity 500ms ease-out ${delay}ms, transform 500ms ease-out ${delay}ms, left ${glide}, top ${glide}, width ${glide}, height ${glide}`,
      }}
    >
      <div className="flex h-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-md border border-border bg-card p-1.5 sm:p-2">
        <div className="flex min-w-0 items-center gap-1">
          <Icon className={`h-2.5 w-2.5 shrink-0 sm:h-3.5 sm:w-3.5 ${tint}`} />
          <span className="truncate text-[8px] font-semibold leading-none text-card-foreground sm:text-[11px]">
            {title}
          </span>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
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
