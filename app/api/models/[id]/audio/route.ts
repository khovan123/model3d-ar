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
