import type { Metadata } from "next";
import { StudioDashboard } from "@/components/studio-dashboard";
import { listModels } from "@/lib/models";

export const metadata: Metadata = { title: "Studio" };
export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const models = await listModels();
  return <StudioDashboard initialModels={models} />;
}
