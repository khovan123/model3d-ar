import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { createSignedUpload } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "aac"]);

const requestSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.string().max(100).default("audio/mpeg")
});

async function handlePOST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ message: "Thông tin file âm thanh không hợp lệ." }, { status: 400 });
    }

    const extension = parsed.data.fileName.split(".").pop()?.toLowerCase() ?? "";
    const looksLikeAudio = parsed.data.mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);
    if (!looksLikeAudio || !AUDIO_EXTENSIONS.has(extension)) {
      return NextResponse.json(
        { message: "Âm thanh hỗ trợ MP3, M4A, WAV, OGG hoặc AAC." },
        { status: 415 }
      );
    }

    const maxSizeMb = Number(process.env.MAX_AUDIO_SIZE_MB ?? 20);
    const maxSize = (Number.isFinite(maxSizeMb) ? maxSizeMb : 20) * 1024 * 1024;
    if (parsed.data.fileSize > maxSize) {
      return NextResponse.json(
        { message: `File âm thanh vượt quá giới hạn ${Math.round(maxSize / 1024 / 1024)} MB.` },
        { status: 413 }
      );
    }

    // The path is deterministic, so audio can be associated with a model
    // without adding a database column/migration.
    const storagePath = `audio/${parsed.data.id}`;
    const uploadUrl = await createSignedUpload(storagePath);
    return NextResponse.json({ data: { storagePath, uploadUrl, expiresIn: 7200 } });
  } catch (error) {
    throw new RequestError(500, "Không thể tạo đường dẫn upload âm thanh.", {
      cause: error,
      code: "AUDIO_UPLOAD_URL_FAILED"
    });
  }
}

export const POST = withRequestLogging(handlePOST);
