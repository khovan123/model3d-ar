import { NextRequest, NextResponse } from "next/server";
import { getStoredModel } from "@/lib/models";
import { createSignedDownload, storageObjectExists } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

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
  const timer = createRouteTimer();
  const { id } = await context.params;

  try {
    const signedUrl = await resolveAudio(id);
    if (!signedUrl) {
      const response = NextResponse.json({ message: "Model này chưa có âm thanh." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    // USDZ authoring needs the raw bytes in the browser. Proxy them through the
    // same origin to avoid relying on the storage provider's CORS policy.
    if (request.nextUrl.searchParams.get("embed") === "1") {
      const response = await proxyAudio(signedUrl);
      logRoute(request, response.status, timer);
      return response;
    }

    const response = NextResponse.redirect(signedUrl, 307);
    response.headers.set("Cache-Control", "private, max-age=300");
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    console.error("Read model audio failed", error);
    const response = NextResponse.json({ message: "Không thể tải âm thanh." }, { status: 500 });
    logRouteError(request, timer);
    return response;
  }
}

async function handleHEAD(request: NextRequest, context: Context) {
  const timer = createRouteTimer();
  const { id } = await context.params;

  try {
    const signedUrl = await resolveAudio(id);
    const response = new NextResponse(null, { status: signedUrl ? 204 : 404 });
    logRoute(request, response.status, timer);
    return response;
  } catch {
    const response = new NextResponse(null, { status: 404 });
    logRoute(request, response.status, timer);
    return response;
  }
}

export const GET = handleGET;
export const HEAD = handleHEAD;
