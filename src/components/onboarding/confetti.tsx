/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, type CSSProperties } from "react";
import { useTour, type BurstOrigin } from "./tour-context";

/**
 * Confetti for finishing the tour. It shoots up from the bottom centre of the
 * screen like a fountain, fanning left and right until it reaches the top and
 * the sides, then falls under gravity until it is off the bottom. One piece
 * is a straggler: it reaches its edge and then takes its time coming down.
 *
 * Pure CSS motion. Each piece is a `<span>` positioned at the origin with
 * its own burst vector, drift, spin, duration and delay as inline custom
 * properties; `confetti-burst` (and `confetti-straggle` for the one) in
 * globals.css do the rest. Pointer-events off, so the dashboard underneath
 * is usable throughout; the component unmounts itself once the straggler
 * is down.
 *
 * THE GEOMETRY IS COMPUTED, NOT RANDOMISED. Render must be pure, so there
 * is no `Math.random` here: a small hash of the piece index gives each one
 * its angle and reach, the same on every render. The burst target is the
 * point where that angle's ray from the origin meets the viewport edge,
 * scaled back by a per-piece fraction, so the burst fills the screen without
 * its front tracing the viewport's rectangle. The viewport and origin
 * come in as props, measured in the click handler.
 *
 * Colours are the theme's tokens, so the burst matches the running theme.
 */

const PIECES = 1983;
const STRAGGLER_MS = 5500;

const COLORS = [
  "var(--brand)",
  "var(--primary)",
  "var(--accent-foreground)",
  "var(--brand-foreground)",
  "var(--destructive)",
];

function scatter(i: number, salt: number): number {
  let h = (i + 1) * 2654435761 + salt * 40503;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Distance from (x, y) to the viewport edge along the unit vector (dx, dy). */
function reachToEdge(
  x: number,
  y: number,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): number {
  const tx = dx > 0 ? (vw - x) / dx : dx < 0 ? -x / dx : Infinity;
  const ty = dy > 0 ? (vh - y) / dy : dy < 0 ? -y / dy : Infinity;
  return Math.min(tx, ty);
}

function pieceStyles(origin: BurstOrigin): CSSProperties[] {
  const { x, y, vw, vh } = origin;
  const fallY = vh + 80 - y; // below the viewport, relative to the origin
  return Array.from({ length: PIECES }, (_, i) => {
    const r = (salt: number) => scatter(i, salt);
    const straggler = i === 0;
    // The origin is the bottom centre, so the whole burst fans upward —
    // from up-and-left (1.18π) through straight up (1.5π) to up-and-right
    // (1.82π), clear of the floor on either side, so every piece is seen
    // rising before it falls. The straggler goes straight up.
    const angle = straggler ? Math.PI * 1.5 : Math.PI * (1.18 + r(1) * 0.64);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // How far along its ray a piece gets, as a fraction of the distance to
    // the edge. Square-rooting the hash skews the spread toward the far end
    // — enough pieces reach the edges to cover the screen — while the rest
    // stop anywhere from a quarter of the way out, so the burst's front is
    // a cloud, not the outline of the viewport.
    const fraction = 0.25 + 0.75 * Math.sqrt(r(2));
    const reach = reachToEdge(x, y, dx, dy, vw, vh) * fraction;
    return {
      "--burst-x": `${dx * reach}px`,
      "--burst-y": `${dy * reach}px`,
      "--fall-y": `${fallY}px`,
      "--drift": `${(r(3) - 0.5) * 160}px`,
      "--spin-1": `${(r(4) - 0.5) * 720}deg`,
      "--spin-2": `${(r(4) - 0.5) * 720 + (r(5) - 0.5) * 1440}deg`,
      "--confetti-duration": straggler
        ? `${STRAGGLER_MS}ms`
        : `${2200 + r(6) * 900}ms`,
      "--confetti-delay": `${r(7) * 120}ms`,
      "--confetti-color": COLORS[i % COLORS.length],
      width: `${6 + r(8) * 6}px`,
      height: `${10 + r(9) * 8}px`,
    } as CSSProperties;
  });
}

export default function Confetti() {
  const { celebrating, celebrated } = useTour();
  if (!celebrating) return null;
  return <Burst origin={celebrating} onDone={celebrated} />;
}

function Burst({
  origin,
  onDone,
}: {
  origin: BurstOrigin;
  onDone: () => void;
}) {
  useEffect(() => {
    const t = window.setTimeout(onDone, STRAGGLER_MS + 300);
    return () => clearTimeout(t);
  }, [onDone]);

  const styles = pieceStyles(origin);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[120] overflow-hidden"
      style={
        {
          "--origin-x": `${origin.x}px`,
          "--origin-y": `${origin.y}px`,
        } as CSSProperties
      }
    >
      {styles.map((style, i) => (
        <span
          key={i}
          className={
            i === 0 ? "confetti-piece confetti-straggler" : "confetti-piece"
          }
          style={style}
        />
      ))}
    </div>
  );
}
