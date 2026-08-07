import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { createSupabaseModel, getStoredModel, listModels } from "@/lib/models";
import { storageObjectExists } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

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
  storagePath: z.string().regex(/^models\/[0-9a-f-]+\.glb$/)
});

async function handleGET(request: NextRequest) {
  const timer = createRouteTimer();

  try {
    const models = await listModels();
    const response = NextResponse.json({ data: models });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    logRouteError(request, timer);
    throw error;
  }
}

async function handlePOST(request: NextRequest) {
  const timer = createRouteTimer();

  if (!isAuthorized(request)) {
    const response = NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
    logRoute(request, response.status, timer);
    return response;
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

    if (parsed.data.storagePath !== `models/${parsed.data.id}.glb`) {
      return NextResponse.json({ message: "Đường dẫn upload không hợp lệ." }, { status: 400 });
    }

    if (await getStoredModel(parsed.data.id)) {
      return NextResponse.json({ message: "Model này đã được lưu trước đó." }, { status: 409 });
    }

    if (!(await storageObjectExists(parsed.data.storagePath))) {
      return NextResponse.json({ message: "File chưa được upload lên Supabase." }, { status: 400 });
    }

    const model = await createSupabaseModel(parsed.data);

    const response = NextResponse.json({ data: model }, { status: 201 });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    console.error("Upload model failed", error);
    const response = NextResponse.json({ message: "Không thể tải model lên. Vui lòng thử lại." }, { status: 500 });
    logRoute(request, response.status, timer);
    return response;
  }
}

export const GET = handleGET;
export const POST = handlePOST;
