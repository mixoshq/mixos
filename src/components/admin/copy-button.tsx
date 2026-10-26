/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";

/**
 * Copies `text`, and says so for two seconds. Selecting the text by hand still
 * works when it can't. The hand-backs use it, and so do the release notice and
 * banner, for `/mixos upgrade`. It writes to the clipboard and does nothing
 * else.
 *
 * `iconOnly` is for a row with no room for the word: `label` becomes the
 * accessible name instead, and the check mark alone says it worked.
 */
export function CopyButton({
  text,
  label,
  iconOnly = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const icon = copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />;
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, an insecure origin).
    }
  };

  if (iconOnly) {
    return (
      <IconButton
        variant="ghost"
        size="sm"
        label={copied ? "Copied" : label}
        icon={icon}
        onClick={onClick}
      />
    );
  }

  return (
    <Button variant="ghost" size="sm" icon={icon} onClick={onClick}>
      {copied ? "Copied" : label}
    </Button>
  );
}
