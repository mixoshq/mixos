/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The guide that follows the welcome screens, one step per thing worth
 * pointing at. A step names a `data-tour` target; the Guide measures it live
 * and draws the bubble next to it — and draws nothing while the target is not
 * on the page, which is how a step waits for the user to come back to it.
 *
 * Every step ends on something the user does — opens the Apps menu, closes
 * it, adds a widget — and moves on the moment the page shows it happened:
 * an element appearing (`doneWhen`), the target going (`endsWithTarget`), or
 * an event the page announces (`doneOn`). No Next button: the action is the
 * button. A step waits as long as it takes, with Skip tour on it throughout.
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
  /** Optional: a step whose title says it all needs no second sentence. */
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
  doneWhen?: string;
  /** A window event that says the thing this step asked for is done. */
  doneOn?: string;
  /**
   * The page the step happens on. The guide goes there when the step starts,
   * once: after that the user is free to wander off, and the step waits for
   * its target to be back.
   */
  route?: string;
  /**
   * A window event the guide dispatches once the step's page is up, for a
   * target that something has to open first: the Apps menu.
   */
  opens?: string;
  /**
   * Closing what the step points at dismisses the step, as its button does.
   * For a target inside a menu, which closes on any click outside it: the
   * bubble would otherwise be left pointing at nothing, and the tour held
   * where nobody can see it.
   */
  endsWithTarget?: boolean;
  /** The last step: where the confetti bursts from when it is done. */
  celebrateAt?: () => Element | null;
  /**
   * Draw the dim around the spotlight. Default true. Off where the user is
   * arranging their own work, where a dim reads as the page being disabled.
   */
  dim?: boolean;
}

/** The `data-tour` name the dashboard step points at. */
export const DASHBOARD_TARGET = "edit-dashboard";

/** The `data-tour` name of App Manager in the Apps menu. */
export const APP_MANAGER_LINK = "apps-menu-app-manager";

/** Opens the Apps menu (AppsDropdown listens for it). */
export const OPEN_APPS_MENU = "tour:open-apps-menu";

export const GUIDE_STEPS: GuideStep[] = [
  {
    target: "menu-bar",
    title: "This is your menu bar.",
    body: "Install an app by clicking Apps.",
    along: 0.3,
    // The Apps menu, open: App Manager is in it.
    doneWhen: `[data-tour="${APP_MANAGER_LINK}"]`,
  },
  {
    target: APP_MANAGER_LINK,
    title: "Install apps in App Manager.",
    body: "Switch one on to add it to your workspace. You can always find this page again in the Apps menu.",
    route: "/apps",
    opens: OPEN_APPS_MENU,
    endsWithTarget: true,
  },
  {
    target: [DASHBOARD_TARGET, "dashboard-pencil"],
    title: "Now, add a widget to your dashboard.",
    body: "A widget is a small piece of an app. Start here.",
    // DashboardGrid's, once a widget from the catalog is on the dashboard.
    doneOn: "dashboard:widget-added",
    // The dashboard appends, so the widget just added is the last one.
    celebrateAt: () => {
      const widgets = document.querySelectorAll("[data-tour-widget-instance]");
      return widgets[widgets.length - 1] ?? null;
    },
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
