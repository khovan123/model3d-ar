import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/http";
import { getStoredModel, toPublicModel } from "@/lib/models";
import {
  isSupabaseDatabaseConfigured,
  retryDatabaseModelAsset
} from "@/lib/supabase-database";
import { RequestError, withRequestLogging } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handlePOST(request: NextRequest, context: Context) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }
  if (!isSupabaseDatabaseConfigured()) {
    return NextResponse.json({ message: "Pipeline chuyển đổi cần Supabase Database." }, { status: 409 });
  }

  const { id } = await context.params;
  const model = await getStoredModel(id);
  if (!model) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  if (model.storageProvider !== "supabase") {
    return NextResponse.json({ message: "Model local không hỗ trợ chuyển đổi tự động." }, { status: 409 });
  }
  if (model.assetStatus === "processing") {
    return NextResponse.json({ message: "Model đang được chuyển đổi." }, { status: 409 });
  }

  try {
    const updated = await retryDatabaseModelAsset(id);
    if (!updated) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
    return NextResponse.json({ data: toPublicModel(updated) });
  } catch (error) {
    throw new RequestError(500, "Không thể đưa model vào lại hàng đợi chuyển đổi.", {
      cause: error,
      code: "ASSET_RETRY_FAILED"
    });
  }
}

export const POST = withRequestLogging(handlePOST);
