import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/http";
import { deleteModel, getModel, getStoredModel, updateModelMetadata } from "@/lib/models";
import { logWarning, RequestError, withRequestLogging } from "@/lib/request-logger";
import { removeStorageObject, storageObjectExists } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const metadataUpdateSchema = z.object({
  name: z.string().trim().min(2, "Tên model phải có ít nhất 2 ký tự.").max(100),
  description: z.string().trim().max(500)
}).strict();

async function handleGET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const model = await getModel(id);
  if (!model) {
    return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  }

  return NextResponse.json({ data: model });
}

async function handlePATCH(request: NextRequest, context: Context) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  const parsed = metadataUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Tên hoặc mô tả không hợp lệ." },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  try {
    const updated = await updateModelMetadata(id, parsed.data);
    if (!updated) {
      return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
    }
    return NextResponse.json({ data: updated });
  } catch (error) {
    throw new RequestError(500, "Không thể cập nhật thông tin model.", {
      cause: error,
      code: "MODEL_METADATA_UPDATE_FAILED"
    });
  }
}

async function handleDELETE(request: NextRequest, context: Context) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  const { id } = await context.params;
  const storedModel = await getStoredModel(id);
  if (!storedModel) {
    return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  }

  if (storedModel.storageProvider === "supabase" && storedModel.storagePath) {
    try {
      await removeStorageObject(storedModel.storagePath);
    } catch (error) {
      throw new RequestError(502, "Không thể xóa file trên Supabase.", {
        cause: error,
        code: "MODEL_STORAGE_DELETE_FAILED"
      });
    }

    // Audio is optional. Best-effort cleanup must not prevent deleting the model.
    try {
      const audioPath = `audio/${id}`;
      if (await storageObjectExists(audioPath)) await removeStorageObject(audioPath);
    } catch (error) {
      logWarning("Không thể xóa audio tùy chọn của model.", error, { modelId: id });
    }

    // Generated USDZ is derived data, so cleanup is best-effort like audio.
    try {
      const usdzPath = storedModel.usdzStoragePath ?? `usdz/${id}.usdz`;
      if (usdzPath !== storedModel.storagePath && await storageObjectExists(usdzPath)) {
        await removeStorageObject(usdzPath);
      }
    } catch (error) {
      logWarning("Không thể xóa USDZ đã tạo của model.", error, { modelId: id });
    }

    try {
      const assetPath = storedModel.assetStoragePath ?? `converted/${id}.glb`;
      if (assetPath !== storedModel.storagePath && await storageObjectExists(assetPath)) {
        await removeStorageObject(assetPath);
      }
    } catch (error) {
      logWarning("Không thể xóa GLB đã chuyển đổi của model.", error, { modelId: id });
    }
  }

  const deleted = await deleteModel(id);
  if (!deleted) {
    return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}

export const GET = withRequestLogging(handleGET);
export const PATCH = withRequestLogging(handlePATCH);
export const DELETE = withRequestLogging(handleDELETE);
