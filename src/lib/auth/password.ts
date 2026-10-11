/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import bcrypt from "bcryptjs";

export const BCRYPT_ROUNDS = 12;

/**
 * A hash whose password nobody has: bcrypt of 32 random bytes that were thrown
 * away. Sign-in compares against it when an email has no account, or an
 * account has no password (./config.ts), so that answer costs one hash, as a
 * wrong password does. That holds only while it matches hashPassword()'s
 * library, cost and `$2a$` format, which password.test.ts checks.
 */
export const DUMMY_PASSWORD_HASH =
  "$2a$12$ZSICekxxj75mWYhVz..K7OhtTUchlVgrULb9xRjLSioTxFUTQ1OMm";

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
