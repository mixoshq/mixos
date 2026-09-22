/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The guide that follows the welcome screens, one step per thing worth
 * pointing at. A step names a `data-tour` target; the Guide measures it live
 * and draws the bubble next to it.
 *
 * Two kinds of step. A `next` step is read and dismissed with its button. An
 * `auto` step asks the user to do something real — click Edit Dashboard, add
 * the widget — and moves on the moment the page shows it happened, which
 * `done()` decides from the DOM. No Next button on those: the action is the
 * button.
 *
 * Add a step by adding an entry here and a `data-tour="<name>"` on the
 * element it should point at.
 */
export interface GuideStep {
  /**
   * The `data-tour` value(s) of the element to spotlight. With several, the
   * first one present wins — the dashboard's edit control is a centred button
   * while the dashboard is empty and a pencil once it is not.
   */
  target: string | string[];
  title: string;
  body: string;
  /** Which side of the target the bubble sits on. Default `below`. */
  placement?: "below" | "above";
  /**
   * Where along the target's width the bubble's left edge starts, as a
   * fraction (0 = the target's left edge). Default 0. The bubble is kept
   * on-screen regardless, and its arrow always points at the target.
   */
  along?: number;
  /** `next` (default): a Next/Done button. `auto`: advances when `done()` is true. */
  advance?: "next" | "auto";
  /** For `auto` steps: is the thing this step asked for now done? */
  done?: () => boolean;
  /**
   * Draw the dim around the spotlight. Default true. Off for the last two
   * steps: the user is now arranging their own dashboard, and a dim over
   * their own work reads as the page being disabled.
   */
  dim?: boolean;
}

const has = (selector: string) => document.querySelector(selector) !== null;

export const GUIDE_STEPS: GuideStep[] = [
  {
    target: "menu-bar",
    title: "This is your menu bar.",
    body: "Open Apps, pin your favorites, manage your account.",
    along: 0.3,
  },
  {
    target: "apps-menu",
    title: "Your apps live here.",
    body: "Everything you've installed is in this menu. Or install something new with App Manager.",
  },
  {
    target: ["edit-dashboard", "dashboard-pencil"],
    title: "Everything else is your dashboard.",
    body: "Your dashboard is a collection of widgets. A widget is a small piece of an app. Let's add one, click Edit Dashboard.",
    placement: "above",
    advance: "auto",
    // Entering edit mode opens the catalog by itself during the tour (see
    // DashboardGrid), so "done" is the catalog being open.
    done: () => has('[data-tour="widget-wall-e"]'),
  },
  {
    target: "widget-wall-e",
    title: "Try Wall-E.",
    body: "Wall-E is a simple app that shows a line from the film on your dashboard. Let's add it.",
    advance: "auto",
    done: () =>
      !has('[data-tour="widget-wall-e"]') &&
      has('[data-tour-widget-instance="wall-e"]'),
  },
  {
    target: "done-editing",
    title: "Great, you added your first widget!",
    body: "Drag it around or resize it. When it looks right, click Done Editing Dashboard.",
    placement: "above",
    dim: false,
    advance: "auto",
    done: () => has('[data-tour="dashboard-pencil"]'),
  },
  {
    target: "dashboard-pencil",
    title: "That's all for now.",
    body: "The pencil is always here to edit your dashboard. Enjoy MixOS!",
    placement: "above",
    dim: false,
    along: 1,
  },
];
