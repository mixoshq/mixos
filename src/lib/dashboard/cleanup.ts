import { createServiceClient } from "@/lib/db/server";

// Delete every dashboard widget a user has for `appSlug`, and prune the
// matching entries from their saved layout JSON. Used when the user
// uninstalls an app themselves and when an admin revokes their grant —
// either way, leaving dead tiles on the dashboard pointing at an app they
// can no longer open is worse than silently cleaning them up.
export async function removeAppWidgetsForUser(
  userId: string,
  appSlug: string,
): Promise<void> {
  const supa = createServiceClient();

  const { data: widgetRows } = await supa
    .from("dashboard_widgets")
    .select("id")
    .eq("user_id", userId)
    .eq("app_slug", appSlug);
  const removedIds = widgetRows?.map((w: { id: string }) => w.id) ?? [];
  if (removedIds.length === 0) return;

  await supa
    .from("dashboard_widgets")
    .delete()
    .eq("user_id", userId)
    .eq("app_slug", appSlug);

  const { data: layoutRow } = await supa
    .from("dashboard_layouts")
    .select("layout")
    .eq("user_id", userId)
    .maybeSingle();
  const layout = (layoutRow?.layout as { i: string }[] | null) ?? [];
  const removed = new Set(removedIds);
  const nextLayout = layout.filter((item) => !removed.has(item.i));
  if (nextLayout.length === layout.length) return;

  await supa.from("dashboard_layouts").upsert(
    {
      user_id: userId,
      layout: JSON.parse(JSON.stringify(nextLayout)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
}
