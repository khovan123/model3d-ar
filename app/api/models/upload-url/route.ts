import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { canonicalModelMimeType, getModelExtension, SUPPORTED_MODEL_EXTENSIONS } from "@/lib/model-file-types";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { createSignedUpload } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().max(100).default("model/gltf-binary")
});

async function handlePOST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ message: "Thông tin file không hợp lệ." }, { status: 400 });
    }

    const extension = getModelExtension(parsed.data.fileName);
    if (!extension || !SUPPORTED_MODEL_EXTENSIONS.includes(extension)) {
      return NextResponse.json(
        { message: `Hệ thống hỗ trợ file 3D: ${SUPPORTED_MODEL_EXTENSIONS.map((item) => `.${item}`).join(", ")}.` },
        { status: 415 }
      );
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
    const storagePath = `models/${id}.${extension}`;
    const uploadUrl = await createSignedUpload(storagePath);

    return NextResponse.json({
      data: { id, storagePath, uploadUrl, mimeType: canonicalModelMimeType(parsed.data.fileName, parsed.data.mimeType), expiresIn: 7200 }
    });
  } catch (error) {
    throw new RequestError(500, "Không thể kết nối Supabase Storage. Hãy kiểm tra cấu hình server.", {
      cause: error,
      code: "MODEL_UPLOAD_URL_FAILED"
    });
  }
}

export const POST = withRequestLogging(handlePOST);
