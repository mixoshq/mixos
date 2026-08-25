/**
 * Bound how long a caller waits on a promise.
 *
 * Extracted because three call sites needed it: the MCP tool broker, the App
 * Services broker, and now the route pipeline. The first two shipped identical
 * private copies that differed only in which Error they constructed, which is
 * exactly how a shared behaviour becomes three subtly-diverging dialects.
 *
 * IMPORTANT — THIS DOES NOT CANCEL ANYTHING. It rejects the *caller's* promise
 * and leaves the underlying work running to completion. A timeout here bounds
 * latency, not resource use: a runaway handler keeps burning connector quota and
 * writing rows after the 504 has been sent. When the work itself must stop, the
 * callee has to take an `AbortSignal` — see `SystemAppContext.signal`, which is
 * how scheduled jobs solve the same problem properly.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
