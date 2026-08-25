/**
 * Lightweight skeleton placeholder for loading states.
 *
 * Usage:
 *   <Skeleton className="h-8 w-32" />              — single block
 *   <Skeleton className="h-4 w-full" repeat={3} /> — repeated lines
 */
export function Skeleton({
  className = "",
  repeat = 1,
}: {
  className?: string;
  repeat?: number;
}) {
  if (repeat <= 1) {
    return (
      <div
        className={`animate-pulse rounded bg-muted ${className}`}
        aria-hidden
      />
    );
  }
  return (
    <>
      {Array.from({ length: repeat }, (_, i) => (
        <div
          key={i}
          className={`animate-pulse rounded bg-muted ${className}`}
          aria-hidden
        />
      ))}
    </>
  );
}
