import type { Metadata } from "next";
import { StudioDashboard } from "@/components/studio-dashboard";

export const metadata: Metadata = { title: "Studio" };

export default function StudioPage() {
  return <StudioDashboard />;
}
