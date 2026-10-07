/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BrandLogo } from "./types";

/**
 * The box a mark is drawn into: a fixed height, and a width cap so a long
 * horizontal lockup cannot take over the menu bar.
 */
export interface LogoBox {
  height: number;
  maxWidth: number;
}

/** h-10 bar, mark at 23px high — the size the default mark was drawn at. */
export const MENU_BAR_LOGO_BOX: LogoBox = { height: 23, maxWidth: 160 };

/** Three times the bar's mark, as the sign-in lockup always was. */
export const LOGIN_LOGO_BOX: LogoBox = { height: 69, maxWidth: 240 };

/**
 * Display size for a measured mark: the box's height, the width that keeps the
 * mark's own aspect ratio, and both scaled down together if that width is over
 * the cap.
 *
 * Passed to next/image as `width`/`height`, which is what makes its `srcset`
 * 1x and 2x of the size actually shown rather than of the source file.
 */
export function fitLogo(logo: BrandLogo, box: LogoBox): BrandLogo {
  const ratio = logo.width / logo.height;
  let height = box.height;
  let width = Math.round(height * ratio);
  if (width > box.maxWidth) {
    width = box.maxWidth;
    height = Math.max(1, Math.round(width / ratio));
  }
  return { src: logo.src, width, height };
}
