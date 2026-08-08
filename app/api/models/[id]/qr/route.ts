import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getPublicOrigin } from "@/lib/http";
import { getModel } from "@/lib/models";
import { withRequestLogging } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handleGET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const model = await getModel(id);
  if (!model) {
    return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  }

  const viewerUrl = `${getPublicOrigin(request)}${model.viewerPath}`;
  const svg = await QRCode.toString(viewerUrl, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 2,
    width: 640,
    color: { dark: "#101114", light: "#ffffff" }
  });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `inline; filename="${id}.svg"`,
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

export const GET = withRequestLogging(handleGET);
