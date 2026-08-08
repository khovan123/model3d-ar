import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getStoredModel, getUploadPath } from "@/lib/models";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { createSignedDownload } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const model = await getStoredModel(id);
  if (!model) {
    return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  }

  if (model.storageProvider === "supabase") {
    if (model.assetStatus === "pending" || model.assetStatus === "processing") {
      return NextResponse.json(
        { message: "Model đang được chuyển sang GLB để hiển thị." },
        { status: 425, headers: { "Retry-After": "10" } }
      );
    }
    if (model.assetStatus === "failed" || model.assetStatus === "unsupported") {
      return NextResponse.json(
        { message: model.assetError ?? "Định dạng model này chưa thể chuyển sang GLB." },
        { status: 422 }
      );
    }

    const assetStoragePath = model.assetStoragePath ?? model.storagePath;
    if (!assetStoragePath) {
      return NextResponse.json({ message: "Model không có file GLB hợp lệ." }, { status: 404 });
    }
    try {
      const url = await createSignedDownload(assetStoragePath);
      return NextResponse.redirect(url, {
        status: 307,
        headers: { "Cache-Control": "private, no-store" }
      });
    } catch (error) {
      throw new RequestError(502, "Không thể đọc file từ Supabase.", {
        cause: error,
        code: "MODEL_SIGNED_URL_FAILED"
      });
    }
  }

  if (!model.storedFileName) {
    return NextResponse.json({ message: "Model không có file hợp lệ." }, { status: 404 });
  }

  const filePath = getUploadPath(model.storedFileName);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) {
    return NextResponse.json({ message: "File model không còn tồn tại." }, { status: 404 });
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
      return new NextResponse(null, { status: 416 });
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;
    if (start >= fileStat.size || end >= fileStat.size || start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileStat.size}` }
      });
    }

    const stream = createReadStream(filePath, { start, end });
    return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...commonHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${fileStat.size}`
      }
    });
  }

  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: { ...commonHeaders, "Content-Length": String(fileStat.size) }
  });
}

export const GET = withRequestLogging(handleGET);
