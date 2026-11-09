/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, type CSSProperties } from "react";
import { useTour, type Celebration } from "./tour-context";

/**
 * Confetti for finishing the tour. It bursts from the centre of the screen,
 * from behind the message card (./installed.tsx, which sits above it), out in
 * every direction until it reaches the edges, then falls under gravity until
 * it is off the bottom. One piece is a straggler: it goes straight up, then
 * takes its time coming down.
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
 * its spot, spin and timing, the same on every render. At the top of the
 * burst the pieces cover the screen evenly (`landingSpot`), each having
 * flown its own distance to get there, before they all fall. The viewport
 * and origin come in as props, measured where the tour ends.
 *
 * Colours are the burst's own when it brings some — MixOS's mark's, when the
 * mark on the card is MixOS's (./installed.tsx) — and otherwise the theme's
 * tokens, so a rebranded install celebrates in its own colours.
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

/**
 * Each piece's landing spot at the top of its burst, spread evenly over the
 * screen: a grid of about one cell per piece, laid over the whole viewport,
 * with each piece somewhere random inside its own cell. Even, with no clumps
 * and no bare patches, as a random spread alone wouldn't be; and jittered, so
 * it isn't a grid either. Cells go to pieces in a scattered order (stepping
 * by a prime, coprime to any grid this size), so neighbours on screen don't
 * share a colour or a start.
 */
function landingSpot(
  i: number,
  r: (salt: number) => number,
  vw: number,
  vh: number,
): [number, number] {
  const cols = Math.max(1, Math.round(Math.sqrt((PIECES * vw) / vh)));
  const rows = Math.ceil(PIECES / cols);
  const cell = (i * 7919) % (cols * rows);
  return [
    ((cell % cols) + r(1)) * (vw / cols),
    (Math.floor(cell / cols) + r(2)) * (vh / rows),
  ];
}

function pieceStyles(origin: Celebration): CSSProperties[] {
  const { x, y, vw, vh } = origin;
  const colors = origin.colors?.length ? origin.colors : COLORS;
  const fallY = vh + 80 - y; // below the viewport, relative to the origin
  return Array.from({ length: PIECES }, (_, i) => {
    const r = (salt: number) => scatter(i, salt);
    const straggler = i === 0;
    // Out to its spot, wherever on the screen that is, from the origin. The
    // straggler goes straight up, to just under the top.
    const [tx, ty] = straggler ? [x, vh * 0.04] : landingSpot(i, r, vw, vh);
    return {
      "--burst-x": `${tx - x}px`,
      "--burst-y": `${ty - y}px`,
      "--fall-y": `${fallY}px`,
      "--drift": `${(r(3) - 0.5) * 160}px`,
      "--spin-1": `${(r(4) - 0.5) * 720}deg`,
      "--spin-2": `${(r(4) - 0.5) * 720 + (r(5) - 0.5) * 1440}deg`,
      "--confetti-duration": straggler
        ? `${STRAGGLER_MS}ms`
        : `${2200 + r(6) * 900}ms`,
      "--confetti-delay": `${r(7) * 120}ms`,
      "--confetti-color": colors[i % colors.length],
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
  origin: Celebration;
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
