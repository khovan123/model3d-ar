import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { createModel, listModels } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const metadataSchema = z.object({
  name: z.string().trim().min(2, "Tên model phải có ít nhất 2 ký tự.").max(100),
  description: z.string().trim().max(500).default("")
});

export async function GET() {
  const models = await listModels();
  return NextResponse.json({ data: models });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const parsed = metadataSchema.safeParse({
      name: formData.get("name"),
      description: formData.get("description") ?? ""
    });

    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Thông tin model không hợp lệ." },
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ message: "Vui lòng chọn file model." }, { status: 400 });
    }

    const extension = file.name.toLowerCase().split(".").pop();
    if (extension !== "glb") {
      return NextResponse.json(
        { message: "Hiện tại hệ thống chỉ nhận file .glb để đảm bảo đầy đủ texture và material." },
        { status: 415 }
      );
    }

    const maxSizeMb = Number(process.env.MAX_MODEL_SIZE_MB ?? 50);
    const maxSize = (Number.isFinite(maxSizeMb) ? maxSizeMb : 50) * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { message: `File vượt quá giới hạn ${Math.round(maxSize / 1024 / 1024)} MB.` },
        { status: 413 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const model = await createModel({
      ...parsed.data,
      originalFileName: file.name,
      mimeType: file.type,
      bytes
    });

    return NextResponse.json({ data: model }, { status: 201 });
  } catch (error) {
    console.error("Upload model failed", error);
    return NextResponse.json({ message: "Không thể tải model lên. Vui lòng thử lại." }, { status: 500 });
  }
}
