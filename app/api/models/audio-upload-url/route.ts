import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { createSignedUpload } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

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
  const timer = createRouteTimer();

  if (!isAuthorized(request)) {
    const response = NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
    logRoute(request, response.status, timer);
    return response;
  }

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      const response = NextResponse.json({ message: "Thông tin file âm thanh không hợp lệ." }, { status: 400 });
      logRoute(request, response.status, timer);
      return response;
    }

    const extension = parsed.data.fileName.split(".").pop()?.toLowerCase() ?? "";
    const looksLikeAudio = parsed.data.mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);
    if (!looksLikeAudio || !AUDIO_EXTENSIONS.has(extension)) {
      const response = NextResponse.json(
        { message: "Âm thanh hỗ trợ MP3, M4A, WAV, OGG hoặc AAC." },
        { status: 415 }
      );
      logRoute(request, response.status, timer);
      return response;
    }

    const maxSizeMb = Number(process.env.MAX_AUDIO_SIZE_MB ?? 20);
    const maxSize = (Number.isFinite(maxSizeMb) ? maxSizeMb : 20) * 1024 * 1024;
    if (parsed.data.fileSize > maxSize) {
      const response = NextResponse.json(
        { message: `File âm thanh vượt quá giới hạn ${Math.round(maxSize / 1024 / 1024)} MB.` },
        { status: 413 }
      );
      logRoute(request, response.status, timer);
      return response;
    }

    // The path is deterministic, so audio can be associated with a model
    // without adding a database column/migration.
    const storagePath = `audio/${parsed.data.id}`;
    const uploadUrl = await createSignedUpload(storagePath);
    const response = NextResponse.json({ data: { storagePath, uploadUrl, expiresIn: 7200 } });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    console.error("Create audio upload URL failed", error);
    const response = NextResponse.json(
      { message: "Không thể tạo đường dẫn upload âm thanh." },
      { status: 500 }
    );
    logRouteError(request, timer);
    return response;
  }
}

export const POST = handlePOST;
