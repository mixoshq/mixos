/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WidgetConfigField } from "./types";
import type { ResolvedConfig } from "../hooks/types";

/**
 * Whether `value` fills `field`, for the purpose of `required`.
 *
 * Text must have something other than whitespace in it, a select a chosen
 * option, a multiselect at least one item, and a number a finite value. A
 * checkbox is never empty: unchecked is `false`, which is an answer.
 */
export function isConfigValueFilled(
  field: WidgetConfigField,
  value: unknown,
): boolean {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value.trim() !== "";
    case "number":
      return value != null && value !== "" && Number.isFinite(Number(value));
    case "select":
      return value != null && value !== "";
    case "multiselect":
      return Array.isArray(value) && value.length > 0;
    case "boolean":
      return true;
  }
}

/**
 * The keys of the `required` fields `config` leaves empty, in declaration
 * order — what the config modal refuses to save.
 *
 * A field `resolveConfig` hides is skipped: the person configuring the widget
 * cannot see it, so cannot fill it, and requiring it would make the widget
 * impossible to save.
 */
export function missingRequiredFields(
  fields: readonly WidgetConfigField[],
  config: Record<string, unknown>,
  resolved: ResolvedConfig = {},
): string[] {
  return fields
    .filter((f) => f.required && resolved[f.key]?.visible !== false)
    .filter((f) => !isConfigValueFilled(f, config[f.key]))
    .map((f) => f.key);
}
