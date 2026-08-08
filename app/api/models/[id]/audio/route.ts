import { NextRequest, NextResponse } from "next/server";
import { getStoredModel } from "@/lib/models";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { createSignedDownload, storageObjectExists } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function resolveAudio(id: string) {
  const model = await getStoredModel(id);
  if (!model || model.storageProvider !== "supabase") return null;

  const storagePath = `audio/${id}`;
  if (!(await storageObjectExists(storagePath))) return null;
  return createSignedDownload(storagePath, 3600);
}

async function proxyAudio(signedUrl: string) {
  const upstream = await fetch(signedUrl, { cache: "no-store" });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Audio upstream returned ${upstream.status}.`);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  const contentLength = upstream.headers.get("content-length");
  if (contentType) headers.set("Content-Type", contentType);
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Content-Disposition", "inline");

  return new NextResponse(upstream.body, { status: 200, headers });
}

async function handleGET(request: NextRequest, context: Context) {
  const { id } = await context.params;

  try {
    const signedUrl = await resolveAudio(id);
    if (!signedUrl) {
      return NextResponse.json({ message: "Model này chưa có âm thanh." }, { status: 404 });
    }

    // USDZ authoring needs the raw bytes in the browser. Proxy them through the
    // same origin to avoid relying on the storage provider's CORS policy.
    if (request.nextUrl.searchParams.get("embed") === "1") {
      return proxyAudio(signedUrl);
    }

    const response = NextResponse.redirect(signedUrl, 307);
    response.headers.set("Cache-Control", "private, max-age=300");
    return response;
  } catch (error) {
    throw new RequestError(500, "Không thể tải âm thanh.", {
      cause: error,
      code: "AUDIO_READ_FAILED"
    });
  }
}

async function handleHEAD(request: NextRequest, context: Context) {
  const { id } = await context.params;

  try {
    const signedUrl = await resolveAudio(id);
    return new NextResponse(null, { status: signedUrl ? 204 : 404 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

export const GET = withRequestLogging(handleGET);
export const HEAD = withRequestLogging(handleHEAD);
