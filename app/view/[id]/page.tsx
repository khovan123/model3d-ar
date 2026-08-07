import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModelViewer } from "@/components/model-viewer-ar";
import { getModel } from "@/lib/models";

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
  const model = await getModel(id);
  if (!model) notFound();

  return (
    <ModelViewer
      modelName={model.name}
      description={model.description}
      assetUrl={model.assetPath}
      audioUrl={`/api/models/${model.id}/audio`}
    />
  );
}
