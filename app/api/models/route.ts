import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { getModelExtension, isSupportedModelFile } from "@/lib/model-file-types";
import { createSupabaseModel, getStoredModel, listModels } from "@/lib/models";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { storageObjectExists } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const metadataSchema = z.object({
  name: z.string().trim().min(2, "Tên model phải có ít nhất 2 ký tự.").max(100),
  description: z.string().trim().max(500).default("")
});

const uploadedModelSchema = metadataSchema.extend({
  id: z.string().uuid(),
  originalFileName: z.string().min(1).max(255),
  mimeType: z.string().default("model/gltf-binary"),
  size: z.number().int().positive(),
  storagePath: z.string().regex(/^models\/[0-9a-f-]+\.[a-z0-9]+$/)
});

async function handleGET() {
  const models = await listModels();
  return NextResponse.json({ data: models });
}

async function handlePOST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = uploadedModelSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { message: parsed.error.issues[0]?.message ?? "Thông tin model không hợp lệ." },
        { status: 400 }
      );
    }

    const maxSizeMb = Number(process.env.MAX_MODEL_SIZE_MB ?? 50);
    const maxSize = (Number.isFinite(maxSizeMb) ? maxSizeMb : 50) * 1024 * 1024;
    if (parsed.data.size > maxSize) {
      return NextResponse.json(
        { message: `File vượt quá giới hạn ${Math.round(maxSize / 1024 / 1024)} MB.` },
        { status: 413 }
      );
    }

    const extension = getModelExtension(parsed.data.storagePath);
    if (
      !extension ||
      !isSupportedModelFile(parsed.data.storagePath) ||
      parsed.data.storagePath !== `models/${parsed.data.id}.${extension}`
    ) {
      return NextResponse.json({ message: "Đường dẫn upload không hợp lệ." }, { status: 400 });
    }

    if (await getStoredModel(parsed.data.id)) {
      return NextResponse.json({ message: "Model này đã được lưu trước đó." }, { status: 409 });
    }

    if (!(await storageObjectExists(parsed.data.storagePath))) {
      return NextResponse.json({ message: "File chưa được upload lên Supabase." }, { status: 400 });
    }

    const model = await createSupabaseModel(parsed.data);

    return NextResponse.json({ data: model }, { status: 201 });
  } catch (error) {
    throw new RequestError(500, "Không thể tải model lên. Vui lòng thử lại.", {
      cause: error,
      code: "MODEL_CREATE_FAILED"
    });
  }
}

export const GET = withRequestLogging(handleGET);
export const POST = withRequestLogging(handlePOST);
