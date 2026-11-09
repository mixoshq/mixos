/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The guide that follows the welcome screens, one step per thing worth
 * pointing at. A step names a `data-tour` target; the Guide measures it live
 * and draws the bubble next to it — and draws nothing while the target is not
 * on the page, which is how a step waits for the user to come back to it.
 *
 * Every step ends on something the user does, and moves on the moment the
 * page shows it happened: an element appearing (`doneWhen`), counted only
 * after an event the page announces (`armedBy`) where that element can be
 * there before the user acts. No Next button: the action is the button. A
 * step waits as long as it takes, with Skip tour throughout.
 *
 * What happens between steps is left alone on purpose. Once App Manager is
 * open the guide says nothing until the dashboard is back — someone
 * installing apps may want more than one — and once the user is editing it
 * says nothing until they are done, however many widgets they add.
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
  /**
   * Optional: a step whose title says it all needs no second sentence.
   * `**…**` sets a part in bold, for the names of the things to click, and
   * `{apps}` draws the icon on the Apps button (guide.tsx's BODY_ICONS).
   */
  body?: string;
  /** Which side of the target the bubble sits on. Default `below`. */
  placement?: "below" | "above";
  /**
   * Where along the target's width the bubble's left edge starts, as a
   * fraction (0 = the target's left edge). Default 0. The bubble is kept
   * on-screen regardless, and its arrow always points at the target.
   */
  along?: number;
  /** A selector whose element appearing says the thing this step asked for is done. */
  doneWhen: string;
  /**
   * A window event that has to fire, while the step is up, before `doneWhen`
   * counts: for an element that may be on the page before the user acts.
   */
  armedBy?: string;
  /**
   * Draw the dim around the spotlight. Default true. Off where the user is
   * arranging their own work, where a dim reads as the page being disabled.
   */
  dim?: boolean;
}

/** The `data-tour` name the dashboard step points at: the empty dashboard's Add Widgets. */
export const DASHBOARD_TARGET = "edit-dashboard";

export const GUIDE_STEPS: GuideStep[] = [
  {
    target: "menu-bar",
    title: "This is your menu bar.",
    body: "Install an app by clicking **{apps} Apps → App Manager**.",
    along: 0.3,
    // Up until App Manager opens, through the Apps menu or any other way.
    doneWhen: '[data-tour="app-manager-page"]',
  },
  {
    target: [DASHBOARD_TARGET, "dashboard-pencil"],
    title: "Now, add a widget to your dashboard.",
    body: "A widget is a small piece of an app.",
    // Only while something installed has a widget: otherwise the empty
    // dashboard offers "Install Apps with widgets" instead, with no target
    // here, and the step waits for them to install one.
    //
    // Done when they finish editing with a widget added: the pencil is back
    // once editing is over and there is a widget. Adding one only arms it,
    // so they can add as many as they like first. The pencil is there before
    // any of this too, on a dashboard that has widgets already.
    armedBy: "dashboard:widget-added",
    doneWhen: '[data-tour="dashboard-pencil"]',
  },
];

/**
 * The step that first talks about the dashboard. Everything before it is
 * about the menu bar and App Manager, so the dashboard keeps its empty state
 * out of sight until then — derived, not a number, so reordering the steps
 * cannot leave the empty state hidden during its own step.
 */
export const DASHBOARD_STEP = GUIDE_STEPS.findIndex((s) =>
  (Array.isArray(s.target) ? s.target : [s.target]).includes(DASHBOARD_TARGET),
);
