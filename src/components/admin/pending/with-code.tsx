/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Fragment } from "react";

/**
 * Text as the server's messages write it, with each `backticked` command or
 * path shown as code. Register's and install's messages are written for the
 * terminal as well, where backticks are the convention; a page shows them as
 * code rather than as backticks.
 */
export default function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`\n]+)`/).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-xs">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
