/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useId } from "react";

/**
 * MixOS's mark as strokes, so it can draw itself on: the end of the welcome
 * tour (./installed.tsx) plays it once.
 *
 * TRACED, NOT DESIGNED. The mark exists as a PNG (themes/mixos/assets/
 * logo.png, 256×244); this is that image measured and rebuilt in its own
 * coordinates — the overlap is 94%, the rest the PNG's soft edges, and the
 * colours within 5/255. So it stands for that file and no other: a theme or
 * app with a mark of its own gets its image instead (`isMixosMark`).
 *
 * TWO LOOPS, WOVEN. Each is a six-sided ring — two corners squared off, two
 * long sides at 45° — and the second is the first's mirror. They cross four
 * times and take turns on top; where one passes under, it stops short of the
 * other by a gap, cut with a mask so it works on any background.
 */

type Pt = readonly [number, number];

/** Strand width, the corners' radius at the strand's centre line, and the gap around an over-strand. */
const WIDTH = 15.5;
const RADIUS = 13.5;
const GAP = 13.5;

/** Top-left corner to bottom-right, and its mirror, top-right to bottom-left. */
const LOOP_A: Pt[] = [
  [27.5, 24],
  [90.5, 24],
  [225, 158.5],
  [225, 221],
  [162.5, 221],
  [27.5, 86],
];
const LOOP_B: Pt[] = [
  [225, 24],
  [162.5, 24],
  [27.5, 159],
  [27.5, 221],
  [90.5, 221],
  [225, 86.5],
];

/** The crossings: A is over at the top and bottom, B at the left and right. */
const A_OVER: Pt[] = [
  [126.5, 60],
  [126.5, 185],
];
const B_OVER: Pt[] = [
  [189, 122.5],
  [64, 122.5],
];

/** Gradients as sampled from the PNG: A darkens to violet along x+y, B runs blue to cyan along x−y. */
const GRADIENT_A = {
  from: [28, 28] as Pt,
  to: [220.5, 220.5] as Pt,
  stops: [
    [0, "#025389"],
    [0.22, "#02548a"],
    [0.34, "#085c99"],
    [0.41, "#2a62b8"],
    [0.48, "#4c6bd2"],
    [0.64, "#567ce1"],
    [0.82, "#656fec"],
    [1, "#7068f0"],
  ] as const,
};
const GRADIENT_B = {
  from: [32.25, 216.5] as Pt,
  to: [224.25, 24.5] as Pt,
  stops: [
    [0, "#016394"],
    [0.05, "#016e9b"],
    [0.16, "#0181a8"],
    [0.29, "#0195b6"],
    [0.49, "#08aac5"],
    [0.62, "#1dbec5"],
    [0.75, "#25c8c8"],
    [1, "#28cac8"],
  ] as const,
};

/**
 * Six colours across the mark's two gradients, navy to cyan and on to
 * violet: the celebration's confetti, when the mark is this one.
 */
export const MIXOS_MARK_COLOURS = [
  "#02548a",
  "#0181a8",
  "#08aac5",
  "#28cac8",
  "#4c6bd2",
  "#7068f0",
] as const;

const n = (v: number) => Number(v.toFixed(2));

/**
 * A closed polygon with every corner rounded to `r`, starting just past its
 * first corner, so a stroke drawn on along it begins on a straight side.
 */
function roundedLoop(points: Pt[], r: number): string {
  const corners = points.map((v, i) => {
    const p = points[(i + points.length - 1) % points.length];
    const q = points[(i + 1) % points.length];
    const l1 = Math.hypot(p[0] - v[0], p[1] - v[1]);
    const l2 = Math.hypot(q[0] - v[0], q[1] - v[1]);
    const u1 = [(p[0] - v[0]) / l1, (p[1] - v[1]) / l1];
    const u2 = [(q[0] - v[0]) / l2, (q[1] - v[1]) / l2];
    const theta = Math.acos(
      Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])),
    );
    const t = r / Math.tan(theta / 2);
    const turn = (v[0] - p[0]) * (q[1] - v[1]) - (v[1] - p[1]) * (q[0] - v[0]);
    return {
      a: [v[0] + u1[0] * t, v[1] + u1[1] * t],
      b: [v[0] + u2[0] * t, v[1] + u2[1] * t],
      sweep: turn > 0 ? 1 : 0,
    };
  });
  let d = `M${n(corners[0].b[0])} ${n(corners[0].b[1])}`;
  for (const { a, b, sweep } of [...corners.slice(1), corners[0]]) {
    d += `L${n(a[0])} ${n(a[1])}A${r} ${r} 0 0 ${sweep} ${n(b[0])} ${n(b[1])}`;
  }
  return `${d}Z`;
}

/** A short stroke along the over-strand at a crossing, as wide as its gap. */
function cut([x, y]: Pt, [dx, dy]: Pt): string {
  const l = 13;
  return `M${n(x - dx * l)} ${n(y - dy * l)}L${n(x + dx * l)} ${n(y + dy * l)}`;
}

const PATH_A = roundedLoop(LOOP_A, RADIUS);
const PATH_B = roundedLoop(LOOP_B, RADIUS);
const S = Math.SQRT1_2;
const CUTS_A = B_OVER.map((p) => cut(p, [-S, S])).join("");
const CUTS_B = A_OVER.map((p) => cut(p, [S, S])).join("");

/** The mark's own file, as both built-in themes ship it. */
const MIXOS_MARK_SRCS = new Set([
  "/themes/mixos/logo.png",
  "/themes/mixos-dark/logo.png",
]);

/** Whether `src` is MixOS's mark, the one these strokes were traced from. */
export function isMixosMark(src: string | undefined): boolean {
  return !!src && MIXOS_MARK_SRCS.has(src);
}

/**
 * The mark, each loop drawing itself on from its top corner, mirror-wise, in
 * the `mark-draw` animation (globals.css). Decorative.
 */
export default function MixosMarkDrawn({
  height,
  onDrawn,
}: {
  height: number;
  /** When the strokes finish drawing; both end together, so it may come twice. */
  onDrawn?: () => void;
}) {
  // Ids for the gradients and masks, unique to this copy, and safe in url().
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradient = (key: string, g: typeof GRADIENT_A | typeof GRADIENT_B) => (
    <linearGradient
      id={`${id}${key}`}
      gradientUnits="userSpaceOnUse"
      x1={g.from[0]}
      y1={g.from[1]}
      x2={g.to[0]}
      y2={g.to[1]}
    >
      {g.stops.map(([offset, color]) => (
        <stop key={offset} offset={offset} stopColor={color} />
      ))}
    </linearGradient>
  );
  const mask = (key: string, cuts: string) => (
    <mask
      id={`${id}${key}`}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="256"
      height="244"
    >
      <rect width="256" height="244" fill="#fff" />
      <path d={cuts} stroke="#000" strokeWidth={GAP * 2} />
    </mask>
  );
  return (
    <svg
      onAnimationEnd={(e) => {
        if (e.animationName === "mark-draw") onDrawn?.();
      }}
      aria-hidden
      viewBox="0 0 256 244"
      height={height}
      width={(height * 256) / 244}
    >
      <defs>
        {gradient("ga", GRADIENT_A)}
        {gradient("gb", GRADIENT_B)}
        {mask("ma", CUTS_A)}
        {mask("mb", CUTS_B)}
      </defs>
      <g fill="none" strokeWidth={WIDTH} strokeLinejoin="round">
        <path
          className="mark-draw"
          d={PATH_B}
          pathLength={1}
          stroke={`url(#${id}gb)`}
          mask={`url(#${id}mb)`}
        />
        <path
          className="mark-draw"
          d={PATH_A}
          pathLength={1}
          stroke={`url(#${id}ga)`}
          mask={`url(#${id}ma)`}
        />
      </g>
    </svg>
  );
}
