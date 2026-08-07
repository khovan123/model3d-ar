import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getStoredModel, getUploadPath } from "@/lib/models";
import { createSignedDownload } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: NextRequest, context: Context) {
  const timer = createRouteTimer();
  const { id } = await context.params;
  try {
    const model = await getStoredModel(id);
    if (!model) {
      const response = NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    if (model.storageProvider === "supabase" && model.storagePath) {
      try {
        const url = await createSignedDownload(model.storagePath);
        const response = NextResponse.redirect(url, {
          status: 307,
          headers: { "Cache-Control": "private, no-store" }
        });
        logRoute(request, response.status, timer);
        return response;
      } catch (error) {
        console.error("Create signed model URL failed", error);
        const response = NextResponse.json({ message: "Không thể đọc file từ Supabase." }, { status: 502 });
        logRoute(request, response.status, timer);
        return response;
      }
    }

    if (!model.storedFileName) {
      const response = NextResponse.json({ message: "Model không có file hợp lệ." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    const filePath = getUploadPath(model.storedFileName);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) {
      const response = NextResponse.json({ message: "File model không còn tồn tại." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    const range = request.headers.get("range");
    const commonHeaders = {
      "Content-Type": model.mimeType || "model/gltf-binary",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(model.originalFileName)}`
    };

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        const response = new NextResponse(null, { status: 416 });
        logRoute(request, response.status, timer);
        return response;
      }

      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : fileStat.size - 1;
      if (start >= fileStat.size || end >= fileStat.size || start > end) {
        const response = new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${fileStat.size}` }
        });
        logRoute(request, response.status, timer);
        return response;
      }

      const stream = createReadStream(filePath, { start, end });
      const response = new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${fileStat.size}`
        }
      });
      logRoute(request, response.status, timer);
      return response;
    }

    const stream = createReadStream(filePath);
    const response = new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      headers: { ...commonHeaders, "Content-Length": String(fileStat.size) }
    });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    logRouteError(request, timer);
    throw error;
  }
}

export const GET = handleGET;
