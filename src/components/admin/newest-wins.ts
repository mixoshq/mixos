/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * For a panel that reads the same list again after each change: each read
 * takes a ticket, and only the newest ticket's answer is applied.
 *
 * Two changes in quick succession each ask for the list, and the answers can
 * arrive out of order. Applied as they came, the older one could land last
 * and show what was true before the second change: someone still holding the
 * app that was just taken from them.
 *
 *   const ticket = newestWins();
 *   const isNewest = ticket();
 *   read().then((answer) => { if (isNewest()) show(answer); });
 */
export function newestWins(): () => () => boolean {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}
