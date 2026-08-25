import { promises as fs } from "node:fs";
import path from "node:path";
import GuideTabsShell, { type GuideTabDef } from "@/components/guide-tabs-shell";

const TABS: Array<{ id: string; label: string; file: string }> = [
  { id: "architecture", label: "Architecture", file: "architecture.md" },
  { id: "implementation", label: "Implementation", file: "implementation.md" },
  { id: "usage", label: "Usage in Apps", file: "usage-in-apps.md" },
  { id: "failures", label: "Failure Handling", file: "failure-handling.md" },
  { id: "credentials", label: "Credentials", file: "credentials.md" },
  { id: "webhooks", label: "Webhooks", file: "webhooks.md" },
  { id: "telemetry", label: "Telemetry", file: "telemetry.md" },
];

async function readDoc(file: string): Promise<string> {
  const filePath = path.join(process.cwd(), "docs", "connectors", file);
  return fs.readFile(filePath, "utf8");
}

export default async function ConnectorGuideTabs() {
  const tabs: GuideTabDef[] = await Promise.all(
    TABS.map(async (t) => ({
      id: t.id,
      label: t.label,
      markdown: await readDoc(t.file),
    })),
  );

  return <GuideTabsShell tabs={tabs} />;
}
