/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When the lease talks to the database, with the database replaced by a
 * stand-in that answers as a free lock would. What each statement does in
 * Postgres is lock.integration.test.ts's job.
 *
 * The lease's timer runs on node:test's mocked clock, which moves only when a
 * test moves it, so what a test sees doesn't depend on how busy the machine is.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { LockLostError, withPlatformLock, type LockName } from "./lock";

// ── fixtures ────────────────────────────────────────────────────────────────

const NAME = "repository.register" as LockName;

// The lock reaches Postgres through the lazy pool in src/lib/db/client.ts,
// which uses globalThis.__pg once it is set. Each statement is recorded by its
// first word, and `ours` decides whether the row still names this holder.
const sent: string[] = [];
let ours = true;
(globalThis as { __pg?: unknown }).__pg = async (strings: TemplateStringsArray) => {
  const verb = strings[0].trim().split(/\s+/)[0];
  sent.push(verb);
  if (verb === "insert") return [{ holder: "this one" }];
  if (verb === "update") return ours ? [{ held: 1 }] : [];
  return [];
};

const renewals = () => sent.filter((verb) => verb === "update").length;

/** One turn of the event loop, with the mocked clock left where it is. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Move the mocked clock on `ms`, a millisecond at a time, with a turn of the
 * event loop before each step and after the last, so a renewal the timer
 * starts has its answer before the next one is due, as it would from a
 * database that answers at once.
 */
async function elapse(ms: number): Promise<void> {
  for (let i = 0; i < ms; i++) {
    await turn();
    mock.timers.tick(1);
  }
  await turn();
}

function reset(): void {
  sent.length = 0;
  ours = true;
}

// ── renewal ─────────────────────────────────────────────────────────────────

test("a holder renews its lease while it works, and not once it has released", async (t) => {
  reset();
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());

  await withPlatformLock(NAME, () => elapse(140), { renewEveryMs: 25 });

  // One for each 25 ms the work took: at 25, 50, 75, 100 and 125.
  assert.equal(renewals(), 5);
  assert.equal(sent.at(-1), "delete");

  const after = sent.length;
  await elapse(100);
  assert.equal(sent.length, after, "a renewal ran after the release");
});

// ── the fence ───────────────────────────────────────────────────────────────

test("assertHeld() renews while the row is this holder's, and stops it for good once not", async (t) => {
  reset();
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  await withPlatformLock(
    NAME,
    async (lease) => {
      const before = renewals();
      await lease.assertHeld();
      assert.equal(renewals(), before + 1);

      // Taken over while this holder was paused.
      ours = false;
      await assert.rejects(lease.assertHeld(), LockLostError);

      // Final: the row can never name this acquisition again, so neither the
      // next check nor the timer asks the database.
      ours = true;
      const asked = renewals();
      await assert.rejects(lease.assertHeld(), LockLostError);
      await elapse(80);
      assert.equal(renewals(), asked);
    },
    { renewEveryMs: 20 },
  );
});
