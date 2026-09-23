/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

import { createServiceClient } from "@/lib/db/server";
import {
  requireReadOnlySession,
  requireServerSession,
} from "@/lib/auth/session";
import { getUserById, isAppActive } from "@/lib/apps/access";
import { revalidatePath } from "next/cache";

export interface LayoutItem {
  i: string; // widget instance ID
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface DashboardWidget {
  id: string;
  app_slug: string;
  widget_id: string;
  config: Record<string, unknown>;
}

export async function getDashboard(): Promise<{
  layout: LayoutItem[];
  widgets: DashboardWidget[];
}> {
  const session = await requireReadOnlySession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return { layout: [], widgets: [] };

  const supabase = createServiceClient();

  const [layoutRes, widgetsRes] = await Promise.all([
    supabase
      .from("dashboard_layouts")
      .select("layout")
      .eq("user_id", dbUser.id)
      .single(),
    supabase
      .from("dashboard_widgets")
      .select("id, app_slug, widget_id, config")
      .eq("user_id", dbUser.id),
  ]);

  // A widget whose app has been deactivated is not shown. The ROW stays —
  // deactivating is a switch, not a deletion, and reactivating has to put
  // everyone's dashboard back exactly as they left it — so this filters the
  // read rather than the table. The layout is left whole for the same reason:
  // react-grid-layout ignores entries with no matching child, and rewriting it
  // here would quietly forget where the widget used to sit.
  const widgets = (widgetsRes.data as DashboardWidget[]) ?? [];
  const active = await Promise.all(widgets.map((w) => isAppActive(w.app_slug)));

  return {
    layout: (layoutRes.data?.layout as LayoutItem[]) ?? [],
    widgets: widgets.filter((_, i) => active[i]),
  };
}

export async function saveLayout(layout: LayoutItem[]): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return;

  const supabase = createServiceClient();
  await supabase.from("dashboard_layouts").upsert(
    {
      user_id: dbUser.id,
      layout: JSON.parse(JSON.stringify(layout)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
}

export async function addWidget(
  appSlug: string,
  widgetId: string,
  config: Record<string, unknown>,
  layoutItem: LayoutItem,
): Promise<string> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) throw new Error("User not found");

  const supabase = createServiceClient();

  // Insert widget instance
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .insert({
      user_id: dbUser.id,
      app_slug: appSlug,
      widget_id: widgetId,
      config,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to add widget: ${error.message}`);

  // Update layout
  const { layout } = await getDashboard();
  const newLayout = [...layout, { ...layoutItem, i: data.id }];
  await saveLayout(newLayout);

  revalidatePath("/");
  return data.id;
}

export async function removeWidget(widgetInstanceId: string): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return;

  const supabase = createServiceClient();

  await supabase
    .from("dashboard_widgets")
    .delete()
    .eq("id", widgetInstanceId)
    .eq("user_id", dbUser.id);

  // Remove from layout
  const { layout } = await getDashboard();
  const newLayout = layout.filter((item) => item.i !== widgetInstanceId);
  await saveLayout(newLayout);

  revalidatePath("/");
}

export async function updateWidgetConfig(
  widgetInstanceId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const session = await requireServerSession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) return;

  const supabase = createServiceClient();
  await supabase
    .from("dashboard_widgets")
    .update({ config })
    .eq("id", widgetInstanceId)
    .eq("user_id", dbUser.id);

  revalidatePath("/");
}
