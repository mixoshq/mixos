/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lightweight skeleton placeholder.
 *
 * Usage:
 *   <Skeleton className="h-8 w-32" />                  — single block
 *   <Skeleton className="h-4 w-full" repeat={3} />     — repeated lines
 *   <Skeleton className="h-4 w-full" pulse={false} />  — inert placeholder
 *
 * THE PULSE IS A PROMISE. An animated skeleton says "content is on its way,
 * wait" — which is true while something is loading and a lie when it is
 * standing in for content that will not arrive until the user acts. An empty
 * state built from pulsing bars leaves someone waiting for a request that was
 * never made. Pass `pulse={false}` there.
 */
export function Skeleton({
  className = "",
  repeat = 1,
  pulse = true,
}: {
  className?: string;
  repeat?: number;
  /** False for a placeholder that is not waiting on anything. */
  pulse?: boolean;
}) {
  const base = `${pulse ? "animate-pulse " : ""}rounded bg-muted ${className}`;
  if (repeat <= 1) {
    return <div className={base} aria-hidden />;
  }
  return (
    <>
      {Array.from({ length: repeat }, (_, i) => (
        <div key={i} className={base} aria-hidden />
      ))}
    </>
  );
}
