import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/http";
import { deleteModel, getModel, getStoredModel } from "@/lib/models";
import { removeStorageObject, storageObjectExists } from "@/lib/supabase-storage";
import { createRouteTimer, logRoute, logRouteError } from "@/lib/request-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handleGET(_request: NextRequest, context: Context) {
  const timer = createRouteTimer();
  const { id } = await context.params;
  try {
    const model = await getModel(id);
    if (!model) {
      const response = NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
      logRoute(_request, response.status, timer);
      return response;
    }

    const response = NextResponse.json({ data: model });
    logRoute(_request, response.status, timer);
    return response;
  } catch (error) {
    logRouteError(_request, timer);
    throw error;
  }
}

async function handleDELETE(request: NextRequest, context: Context) {
  const timer = createRouteTimer();

  if (!isAuthorized(request)) {
    const response = NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
    logRoute(request, response.status, timer);
    return response;
  }

  const { id } = await context.params;
  try {
    const storedModel = await getStoredModel(id);
    if (!storedModel) {
      const response = NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    if (storedModel.storageProvider === "supabase" && storedModel.storagePath) {
      try {
        await removeStorageObject(storedModel.storagePath);
      } catch (error) {
        console.error("Delete Supabase model failed", error);
        const response = NextResponse.json({ message: "Không thể xóa file trên Supabase." }, { status: 502 });
        logRoute(request, response.status, timer);
        return response;
      }

      // Audio is optional. Best-effort cleanup must not prevent deleting the model.
      try {
        const audioPath = `audio/${id}`;
        if (await storageObjectExists(audioPath)) await removeStorageObject(audioPath);
      } catch (error) {
        console.warn("Delete optional model audio failed", error);
      }
    }

    const deleted = await deleteModel(id);
    if (!deleted) {
      const response = NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
      logRoute(request, response.status, timer);
      return response;
    }

    const response = new NextResponse(null, { status: 204 });
    logRoute(request, response.status, timer);
    return response;
  } catch (error) {
    logRouteError(request, timer);
    throw error;
  }
}

export const GET = handleGET;
export const DELETE = handleDELETE;
