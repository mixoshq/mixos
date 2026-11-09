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
  compact = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
  /**
   * 24px tall with 12px text, for a strip as slim as the release banner over
   * the menu bar. Under the 36px touch floor `Button`'s sizes keep, which is
   * the price of that strip; anywhere with room, leave it off.
   */
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const iconSize = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  const icon = copied ? <Check className={iconSize} aria-hidden /> : <Copy className={iconSize} aria-hidden />;
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
        className={compact ? "h-6 w-6" : undefined}
      />
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={icon}
      onClick={onClick}
      className={compact ? "h-6 gap-1 px-1.5 text-xs" : undefined}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
