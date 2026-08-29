/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePreferences } from "@/components/preferences-context";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const subscribeNoop = () => () => {};
const getTrue = () => true;
const getFalse = () => false;

/**
 * The categorical ramp, not raw hexes. Confetti is the textbook case for
 * `cat-*`: six colours whose only job is to be distinguishable from one
 * another. Reading them as vars also means the celebration follows the active
 * theme rather than pinning hexes that go stale the moment the brand moves.
 */
const CONFETTI_COLORS = [
  "var(--cat-1)",
  "var(--cat-2)",
  "var(--cat-3)",
  "var(--cat-4)",
  "var(--cat-5)",
  "var(--cat-6)",
];

// A popper has two cones (bottom corners) shooting confetti up and outward.
// `originX` is the horizontal anchor within the modal (0 = left, 1 = right).
interface PopperPiece {
  originX: number;
  angleDeg: number;
  distance: number;
  delayMs: number;
  spinDeg: number;
  color: string;
  width: number;
  height: number;
}

function buildPieces(
  count: number,
  originX: number,
  seed: number,
): PopperPiece[] {
  // Deterministic pseudo-random so SSR and the client agree.
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const pieces: PopperPiece[] = [];
  // Cone direction: left popper fires up-right, right popper fires up-left.
  const baseAngle = originX < 0.5 ? -65 : -115; // degrees, 0=right, -90=up
  for (let i = 0; i < count; i++) {
    const spread = (rand() - 0.5) * 50; // ±25°
    const angleDeg = baseAngle + spread;
    const distance = 220 + rand() * 180;
    pieces.push({
      originX,
      angleDeg,
      distance,
      delayMs: Math.floor(rand() * 400),
      spinDeg: (rand() < 0.5 ? -1 : 1) * (360 + rand() * 540),
      color: CONFETTI_COLORS[Math.floor(rand() * CONFETTI_COLORS.length)],
      width: 6 + Math.floor(rand() * 8),
      height: 10 + Math.floor(rand() * 10),
    });
  }
  return pieces;
}

interface FallingPiece {
  leftPct: number;
  driftPx: number;
  spinDeg: number;
  delayMs: number;
  durationSec: number;
  color: string;
  width: number;
  height: number;
}

function buildFallingPieces(count: number, seed: number): FallingPiece[] {
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const pieces: FallingPiece[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push({
      leftPct: rand() * 100,
      driftPx: (rand() - 0.5) * 240,
      spinDeg: (rand() < 0.5 ? -1 : 1) * (360 + rand() * 1080),
      delayMs: Math.floor(rand() * 2000),
      durationSec: 0.7 + rand() * 0.7,
      color: CONFETTI_COLORS[Math.floor(rand() * CONFETTI_COLORS.length)],
      width: 6 + Math.floor(rand() * 8),
      height: 10 + Math.floor(rand() * 10),
    });
  }
  return pieces;
}

export default function CongratulationsModal() {
  const { showCongratulations, dismissCongratulations } = usePreferences();
  const mounted = useSyncExternalStore(subscribeNoop, getTrue, getFalse);

  const pieces = useMemo(() => {
    return [...buildPieces(26, 0.08, 17), ...buildPieces(26, 0.92, 91)];
  }, []);

  const fallingPieces = useMemo(() => buildFallingPieces(120, 53), []);

  if (!mounted || !showCongratulations) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Full-screen confetti rain. Sits above the backdrop, below the modal
          card content thanks to DOM order + same stacking context, and can't
          swallow clicks because of pointer-events-none. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {fallingPieces.map((p, i) => {
          const style: CSSProperties & Record<string, string> = {
            left: `${p.leftPct}%`,
            backgroundColor: p.color,
            width: `${p.width}px`,
            height: `${p.height}px`,
            "--confetti-drift": `${p.driftPx}px`,
            "--confetti-spin": `${p.spinDeg}deg`,
            "--confetti-delay": `${p.delayMs}ms`,
            "--confetti-duration": `${p.durationSec}s`,
          };
          return <span key={i} className="confetti-piece" style={style} />;
        })}
      </div>
      <div
        className={cn(
          "mix-modal",
          CARD_SURFACE,
          "relative mx-4 w-full max-w-lg overflow-hidden shadow-xl",
        )}
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {pieces.map((p, i) => {
            const rad = (p.angleDeg * Math.PI) / 180;
            const x = Math.cos(rad) * p.distance;
            const y = Math.sin(rad) * p.distance;
            const style: CSSProperties & Record<string, string> = {
              left: `${p.originX * 100}%`,
              bottom: "8%",
              backgroundColor: p.color,
              width: `${p.width}px`,
              height: `${p.height}px`,
              "--popper-x": `${x}px`,
              "--popper-y": `${y}px`,
              "--popper-spin": `${p.spinDeg}deg`,
              "--popper-delay": `${p.delayMs}ms`,
            };
            return <span key={i} className="popper-piece" style={style} />;
          })}
        </div>

        <div className="relative bg-brand px-8 pb-10 pt-10 text-center text-brand-foreground">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            You did it
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight">
            Congratulations! 🎉
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/85">
            You&apos;re ready to use MixOS! Install more apps, pin more widgets,
            and make this workspace your own.
          </p>
        </div>

        <div className="relative flex items-center justify-center border-t border-border bg-card px-6 py-4">
          <button
            type="button"
            onClick={dismissCongratulations}
            className="rounded-md bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary/90"
          >
            Let&apos;s go
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
