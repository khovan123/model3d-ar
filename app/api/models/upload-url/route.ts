import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { createSignedUpload } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().max(100).default("model/gltf-binary")
});

async function handlePOST(request: NextRequest) {
  const timer = createRouteTimer();

  if (!isAuthorized(request)) {
    const response = NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
    logRoute(request, response.status, timer);
    return response;
  }

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ message: "Thông tin file không hợp lệ." }, { status: 400 });
    }

    if (!parsed.data.fileName.toLowerCase().endsWith(".glb")) {
      return NextResponse.json({ message: "Hiện tại hệ thống chỉ nhận file .glb." }, { status: 415 });
    }

    const maxSizeMb = Number(process.env.MAX_MODEL_SIZE_MB ?? 50);
    const maxSize = (Number.isFinite(maxSizeMb) ? maxSizeMb : 50) * 1024 * 1024;
    if (parsed.data.fileSize > maxSize) {
      return NextResponse.json(
        { message: `File vượt quá giới hạn ${Math.round(maxSize / 1024 / 1024)} MB.` },
        { status: 413 }
      );
    }

    const id = randomUUID();
    const storagePath = `models/${id}.glb`;
    const uploadUrl = await createSignedUpload(storagePath);

    const response = NextResponse.json({
      data: { id, storagePath, uploadUrl, expiresIn: 7200 }
    });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    console.error("Create signed upload URL failed", error);
    const response = NextResponse.json(
      { message: "Không thể kết nối Supabase Storage. Hãy kiểm tra cấu hình server." },
      { status: 500 }
    );
    logRouteError(request, timer);
    return response;
  }
}

export const POST = handlePOST;
