import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getStoredModel, getUploadPath } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const model = await getStoredModel(id);
  if (!model) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });

  const filePath = getUploadPath(model.storedFileName);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) return NextResponse.json({ message: "File model không còn tồn tại." }, { status: 404 });

  const range = request.headers.get("range");
  const commonHeaders = {
    "Content-Type": model.mimeType || "model/gltf-binary",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(model.originalFileName)}`
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new NextResponse(null, { status: 416 });

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
