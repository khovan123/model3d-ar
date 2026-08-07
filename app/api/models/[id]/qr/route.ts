import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getPublicOrigin } from "@/lib/http";
import { getModel } from "@/lib/models";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: NextRequest, context: Context) {
  const timer = createRouteTimer();
  const { id } = await context.params;
  try {
    const model = await getModel(id);
    if (!model) {
      const response = NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    const viewerUrl = `${getPublicOrigin(request)}${model.viewerPath}`;
    const svg = await QRCode.toString(viewerUrl, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 2,
      width: 640,
      color: { dark: "#101114", light: "#ffffff" }
    });

    const response = new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `inline; filename="${id}.svg"`,
        "Cache-Control": "no-store, max-age=0"
      }
    });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    logRouteError(request, timer);
    throw error;
  }
}

export const GET = handleGET;
