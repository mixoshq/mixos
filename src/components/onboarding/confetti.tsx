/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, type CSSProperties } from "react";
import { useTour, type Celebration } from "./tour-context";

/**
 * Confetti for finishing the tour. It bursts from the "is yours" card's
 * button (./installed.tsx) as the card fades, and loosely spells the name:
 * 40% of the pieces (SPELLERS) fly to spots inside its letters, set across
 * the whole width of the screen, hang there together for about 470ms, then
 * all let go at once and crumble down unevenly. The other 60% burst out
 * evenly over the whole screen, the word included, and start falling as
 * soon as they get there, through and over it. One piece is a straggler: it
 * goes straight up, hangs, then takes its time coming down, the last to go.
 *
 * NO TWO FALL ALIKE. Each piece falls at its own speed, within FALL_SPREAD
 * of the average, so the same drop takes each its own time; flutters from
 * side to side with its own swing and period once it lets go; and tumbles
 * round its own tilted axis at its own rate, end over end or spinning flat.
 *
 * Pure CSS motion: each piece is a `<span>` positioned at the origin, with
 * the coloured bit inside it, and its spot, timings, swing and axis as inline
 * custom properties; `confetti-out`, `confetti-fall`, `confetti-flutter` and
 * `confetti-tumble` in globals.css do the rest. Pointer-events off, so the
 * dashboard underneath is usable throughout; the component unmounts itself
 * once the straggler is down.
 *
 * THE GEOMETRY IS COMPUTED, NOT RANDOMISED. Render must be pure, so there
 * is no `Math.random` here: a small hash of the piece index gives each one
 * its spot, colour, speed, swing and spin, the same on every render. The
 * word's spots come in with the burst (`spellSpots`, run where the burst is
 * set off, which can read the DOM), as do the viewport and origin.
 *
 * Colours are the theme's — its categorical ramp, its primary and its brand
 * accent — each piece's picked at random from them, so a rebranded install
 * celebrates in its own colours and neighbours rarely match.
 */

const PIECES = 1983;
const STRAGGLER_MS = 5500;

/** The pieces that spell the word: 40% of them, the straggler aside. */
export const SPELLERS = Math.round((PIECES - 1) * 0.4);

/** Up to this long before a piece sets off, so the burst isn't one flat shot. */
const MAX_DELAY_MS = 120;
/** A word piece's flight to its letter: every one lands within this window. */
const SPELL_OUT_MS = [900, 1030] as const;
/** How long the whole word hangs, from its last piece landing to letting go. */
const HOLD_MS = 470;
/** When every word piece lets go, together. */
const RELEASE_MS = MAX_DELAY_MS + SPELL_OUT_MS[1] + HOLD_MS;
/** A scattered piece's flight out to its spot. */
const SCATTER_OUT_MS = [750, 1150] as const;
/** A fall from the top of the screen to below it, at the average speed. */
const FALL_FULL_MS = 1600;
/** Each piece falls at the average speed, give or take this share of it. */
const FALL_SPREAD = 0.2;
/** The straggler: up to just under the top, a hang there, then the slow way down. */
const STRAGGLER_OUT_MS = 900;
const STRAGGLER_HANG_MS = 700;

const COLORS = [
  "var(--cat-1)",
  "var(--cat-2)",
  "var(--cat-3)",
  "var(--cat-4)",
  "var(--cat-5)",
  "var(--cat-6)",
  "var(--primary)",
  "var(--brand-accent)",
];

/** Less ink than this, in px², and the word could not be read: spell nothing. */
const MIN_INK = 1500;

function scatter(i: number, salt: number): number {
  let h = (i + 1) * 2654435761 + salt * 40503;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface WordBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * `count` spots inside the letters of `text`, set as large as fits in `box`
 * and centred in it, in the box's (viewport) coordinates — and the `grain`,
 * the spacing between them, which sizes the pieces that land there.
 *
 * The word is drawn on an offscreen canvas in the given font, and a grid
 * laid over it keeps one spot per cell that lands on ink, jittered within
 * its cell: evenly spread over the letters, and loose. The grid is sized for
 * `count` cells of ink and tightened until it has at least that many, then
 * thinned evenly to exactly `count`. No spots when the word would be too
 * small to read, or there is no canvas.
 */
export function spellSpots(
  text: string,
  box: WordBox,
  fontFamily: string,
  count: number,
): { spots: [number, number][]; grain: number } {
  const none = { spots: [], grain: 0 };
  const w = Math.floor(box.width);
  const h = Math.floor(box.height);
  if (w < 1 || h < 1 || count < 1 || !text.trim()) return none;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return none;

  // Measured at 100px, then scaled so the ink — not the em box — fills the
  // box: a word with no descenders shouldn't leave room for them.
  const font = (px: number) => `800 ${px}px ${fontFamily}`;
  ctx.font = font(100);
  const probe = ctx.measureText(text);
  const probeW = probe.actualBoundingBoxLeft + probe.actualBoundingBoxRight;
  const probeH = probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent;
  if (!probeW || !probeH) return none;
  ctx.font = font(Math.min((100 * w) / probeW, (100 * h) / probeH));
  const m = ctx.measureText(text);
  const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  ctx.fillText(
    text,
    (w - inkW) / 2 + m.actualBoundingBoxLeft,
    (h - inkH) / 2 + m.actualBoundingBoxAscent,
  );

  const { data } = ctx.getImageData(0, 0, w, h);
  const inked = (x: number, y: number) =>
    data[(Math.floor(y) * w + Math.floor(x)) * 4 + 3] > 127;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 127) ink++;
  if (ink < MIN_INK) return none;

  const sample = (step: number) => {
    const found: [number, number][] = [];
    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        if (!inked(x, y)) continue;
        const k = found.length;
        found.push([
          box.left + x + (scatter(k, 11) - 0.5) * step,
          box.top + y + (scatter(k, 12) - 0.5) * step,
        ]);
      }
    }
    return found;
  };
  let grain = Math.sqrt(ink / count);
  let spots = sample(grain);
  for (let tries = 0; spots.length < count && tries < 6; tries++) {
    grain *= spots.length ? Math.sqrt(spots.length / count) * 0.97 : 0.5;
    spots = sample(grain);
  }
  if (spots.length > count) {
    const all = spots;
    spots = Array.from(
      { length: count },
      (_, k) => all[Math.floor((k * all.length) / count)],
    );
  }
  return { spots, grain };
}

/**
 * A scattered piece's landing spot at the top of its burst, spread evenly
 * over the screen: a grid of about one cell per piece, laid over the whole
 * viewport, with each piece somewhere random inside its own cell. Even, with
 * no clumps and no bare patches, as a random spread alone wouldn't be; and
 * jittered, so it isn't a grid either. Cells go to pieces in a scattered
 * order (stepping by a prime, coprime to any grid this size), so neighbours
 * on screen don't share a start.
 */
function landingSpot(
  i: number,
  count: number,
  r: (salt: number) => number,
  vw: number,
  vh: number,
): [number, number] {
  const cols = Math.max(1, Math.round(Math.sqrt((count * vw) / vh)));
  const rows = Math.ceil(count / cols);
  const cell = (i * 7919) % (cols * rows);
  return [
    ((cell % cols) + r(1)) * (vw / cols),
    (Math.floor(cell / cols) + r(2)) * (vh / rows),
  ];
}

type Kind = "straggler" | "speller" | "scatter";

/**
 * Piece 0 is the straggler; the next `word.length` spell the word; the rest
 * scatter.
 */
function kindOf(i: number, spellers: number): Kind {
  if (i === 0) return "straggler";
  return i <= spellers ? "speller" : "scatter";
}

/**
 * A word piece's size: about the grain it was spread at, so a small word's
 * pieces fill its letters without swamping their shapes and a large word's
 * fill it without gaps — within what still looks like confetti.
 */
function spellerSize(grain: number, r: (salt: number) => number): [number, number] {
  const unit = Math.min(Math.max(grain * 1.1, 4), 10);
  return [unit * (0.6 + r(8) * 0.5), unit * (0.95 + r(9) * 0.6)];
}

/** Between `lo` and `hi`, by `t` in 0–1. */
const between = (lo: number, hi: number, t: number) => lo + (hi - lo) * t;

function pieceStyles(origin: Celebration): CSSProperties[] {
  const { x, y, vw, vh, word, grain } = origin;
  const spellers = Math.min(word.length, PIECES - 1);
  const scattered = PIECES - 1 - spellers;
  // Clear of the bottom edge, swing and all.
  const bottom = vh + 60;
  return Array.from({ length: PIECES }, (_, i) => {
    const r = (salt: number) => scatter(i, salt);
    const kind = kindOf(i, spellers);
    // Out to its spot, from the origin: a letter's, an even share of the
    // screen's, or — for the straggler — straight up, to just under the top.
    const [tx, ty] =
      kind === "straggler"
        ? [x, vh * 0.04]
        : kind === "speller"
          ? word[i - 1]
          : landingSpot(i - 1 - spellers, scattered, r, vw, vh);

    // When it sets off, how long it takes to get there, when it lets go and
    // how long its fall takes: the word's pieces let go together, after the
    // hold; a scattered piece the moment it arrives, each falling at its own
    // speed; the straggler last, slowly.
    let delay = r(7) * MAX_DELAY_MS;
    let outMs: number;
    let fallDelay: number;
    let fallMs: number;
    if (kind === "straggler") {
      delay = 0;
      outMs = STRAGGLER_OUT_MS;
      fallDelay = STRAGGLER_OUT_MS + STRAGGLER_HANG_MS;
      fallMs = STRAGGLER_MS - fallDelay;
    } else {
      outMs =
        kind === "speller"
          ? between(SPELL_OUT_MS[0], SPELL_OUT_MS[1], r(6))
          : between(SCATTER_OUT_MS[0], SCATTER_OUT_MS[1], r(6));
      fallDelay = kind === "speller" ? RELEASE_MS : delay + outMs;
      const speed =
        (bottom / FALL_FULL_MS) * between(1 - FALL_SPREAD, 1 + FALL_SPREAD, r(13));
      fallMs = Math.max(200, (bottom - ty) / speed);
    }

    const [w, h] =
      kind === "speller"
        ? spellerSize(grain, r)
        : [between(6, 12, r(8)), between(10, 18, r(9))];
    // Tumbling round its own axis — tilted any way, so some pieces flip end
    // over end and some spin flat — at its own rate, either way round. The
    // word's pieces turn slower, so the word doesn't shimmer away while it
    // hangs.
    const axis = [r(15) * 2 - 1, r(16) * 2 - 1, between(0.3, 1.3, r(17))]
      .map((n) => n.toFixed(2))
      .join(" ");
    const tumbleMs =
      kind === "straggler"
        ? 2400
        : kind === "speller"
          ? between(1400, 3000, r(5))
          : between(500, 2200, r(5));
    const swing = kind === "straggler" ? 26 : between(6, 18, r(10));
    return {
      "--burst-x": `${(tx - x).toFixed(1)}px`,
      "--burst-y": `${(ty - y).toFixed(1)}px`,
      "--fall-y": `${(bottom - ty).toFixed(1)}px`,
      "--drift": `${((r(3) - 0.5) * 120).toFixed(1)}px`,
      "--delay": `${delay.toFixed(0)}ms`,
      "--out-ms": `${outMs.toFixed(0)}ms`,
      "--fall-delay": `${fallDelay.toFixed(0)}ms`,
      "--fall-ms": `${fallMs.toFixed(0)}ms`,
      "--sway": `${(r(14) < 0.5 ? -swing : swing).toFixed(1)}px`,
      "--flutter-ms": `${(kind === "straggler" ? 1600 : between(600, 1300, r(11))).toFixed(0)}ms`,
      "--axis": axis,
      "--spin-from": `${(r(4) * 360).toFixed(0)}deg`,
      "--spin": `${r(12) < 0.5 ? -360 : 360}deg`,
      "--tumble-ms": `${tumbleMs.toFixed(0)}ms`,
      "--confetti-color": COLORS[Math.floor(r(18) * COLORS.length)],
      width: `${w.toFixed(1)}px`,
      height: `${h.toFixed(1)}px`,
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

  const pieces = pieceStyles(origin);

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
      {pieces.map((style, i) => (
        <span key={i} className="confetti-piece" style={style}>
          <span className="confetti-bit" />
        </span>
      ))}
    </div>
  );
}
