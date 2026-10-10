/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When the lease talks to the database, with the database replaced by a
 * stand-in that answers as a free lock would. What each statement does in
 * Postgres is lock.integration.test.ts's job.
 */

import { test } from "node:test";
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function reset(): void {
  sent.length = 0;
  ours = true;
}

// ── renewal ─────────────────────────────────────────────────────────────────

test("a holder renews its lease while it works, and not once it has released", async () => {
  reset();
  await withPlatformLock(NAME, () => sleep(140), { renewEveryMs: 25 });

  assert.ok(renewals() >= 3, `expected at least 3 renewals, saw ${renewals()}`);
  assert.equal(sent.at(-1), "delete");

  const after = sent.length;
  await sleep(100);
  assert.equal(sent.length, after, "a renewal ran after the release");
});

// ── the fence ───────────────────────────────────────────────────────────────

test("assertHeld() renews while the row is this holder's, and stops it for good once not", async () => {
  reset();
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
      await sleep(80);
      assert.equal(renewals(), asked);
    },
    { renewEveryMs: 20 },
  );
});
