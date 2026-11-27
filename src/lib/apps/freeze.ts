/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Freeze a value and everything it holds, in place, and return it.
 *
 * WHY. What `context` hands an app has to be something the app can't change
 * for anyone else. `context.manifest` is the app's entry in the generated
 * registry, the very object the platform reads again to decide the app's
 * egress, which connectors it is given and with what access, whether it is
 * global, and what it consumes. `context.user` is the object the services
 * broker reads to say who is asking. An app that could write to either could
 * widen its own declarations, or ask another app's service as someone else,
 * with an ordinary assignment, which no build check refuses: the scan refuses
 * writes through what an app imports, and `context` is a parameter.
 *
 * Frozen, a write to either throws in strict code (every app module is an ES
 * module, and so strict) and is ignored anywhere else.
 *
 * Objects and arrays are frozen to their leaves. Functions are frozen too,
 * but what they close over is not reachable from here and is left alone.
 */
/** Roots already frozen to their leaves by deepFreeze. */
const frozenRoots = new WeakSet<object>();

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    // A context is built per request, and a manifest is the same object every
    // time: walk it once.
    if (frozenRoots.has(value)) return value;
    freeze(value, new Set());
    frozenRoots.add(value);
    return value;
  }
  freeze(value, new Set());
  return value;
}

function freeze(value: unknown, seen: Set<object>): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const d = Reflect.getOwnPropertyDescriptor(value, key);
    if (d && "value" in d) freeze(d.value, seen);
  }
  Object.freeze(value);
}
