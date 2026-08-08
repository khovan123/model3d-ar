import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModelViewer } from "@/components/model-viewer-client";
import { getModel, getStoredModel, toPublicModel } from "@/lib/models";
import { storageObjectExists } from "@/lib/supabase-storage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const model = await getModel(id);
  if (!model) return { title: "Không tìm thấy model" };
  return { title: model.name, description: model.description || `Xem model 3D ${model.name}` };
}

export default async function ViewerPage({ params }: Props) {
  const { id } = await params;
  const record = await getStoredModel(id);
  if (!record) notFound();

  const model = toPublicModel(record);
  let audioUrl: string | undefined;

  if (record.storageProvider === "supabase") {
    try {
      const hasAudio = await storageObjectExists(`audio/${record.id}`);
      if (hasAudio) audioUrl = `/api/models/${record.id}/audio`;
    } catch (error) {
      // Audio is optional. A storage availability check must never prevent the
      // model viewer itself from rendering.
      console.warn(`[ModelSpace] Unable to check audio for model ${record.id}.`, error);
    }
  }

  return (
    <ModelViewer
      modelName={model.name}
      description={model.description}
      assetUrl={model.assetPath}
      audioUrl={audioUrl}
    />
  );
}
