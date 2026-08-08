import { NextRequest, NextResponse } from "next/server";
import { getStoredModel } from "@/lib/models";
import { RequestError, withRequestLogging } from "@/lib/request-logger";
import { createSignedDownload } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function resolveUsdz(id: string) {
  const model = await getStoredModel(id);
  if (
    !model ||
    model.storageProvider !== "supabase" ||
    model.usdzStatus !== "ready" ||
    !model.usdzStoragePath
  ) {
    return null;
  }

  return createSignedDownload(model.usdzStoragePath, 3600);
}

async function handleGET(_request: NextRequest, context: Context) {
  const { id } = await context.params;

  try {
    const signedUrl = await resolveUsdz(id);
    if (!signedUrl) {
      return NextResponse.json(
        { message: "USDZ của model chưa sẵn sàng." },
        { status: 404 }
      );
    }

    const response = NextResponse.redirect(signedUrl, 307);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    throw new RequestError(500, "Không thể tạo đường dẫn tải USDZ.", {
      cause: error,
      code: "USDZ_READ_FAILED"
    });
  }
}

async function handleHEAD(_request: NextRequest, context: Context) {
  const { id } = await context.params;

  try {
    return new NextResponse(null, { status: await resolveUsdz(id) ? 204 : 404 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

export const GET = withRequestLogging(handleGET);
export const HEAD = withRequestLogging(handleHEAD);
