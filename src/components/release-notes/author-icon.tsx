/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Image from "next/image";
import LucideIcon from "@/components/lucide-icon";
import type { ReleaseNoteAuthor } from "@/lib/release-notes/types";
import { cn } from "@/lib/utils";

/**
 * The mark beside a release note's author: an app's Lucide icon, a connector's
 * own icon file, or the icon standing in for MixOS or a theme. Decorative: the
 * author's name is always beside it.
 */
export default function AuthorIcon({
  icon,
  className,
}: {
  icon: ReleaseNoteAuthor["icon"];
  className?: string;
}) {
  if ("src" in icon) {
    return (
      <Image
        src={icon.src}
        alt=""
        width={16}
        height={16}
        className={cn("h-4 w-4 shrink-0 object-contain", className)}
      />
    );
  }
  return (
    <LucideIcon
      name={icon.lucide}
      aria-hidden
      className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)}
    />
  );
}
