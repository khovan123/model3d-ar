import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/http";
import { deleteModel, getModel, getStoredModel } from "@/lib/models";
import { removeStorageObject } from "@/lib/supabase-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const model = await getModel(id);
  if (!model) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  return NextResponse.json({ data: model });
}

export async function DELETE(request: NextRequest, context: Context) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ message: "Mã quản trị không hợp lệ." }, { status: 401 });
  }

  const { id } = await context.params;
  const storedModel = await getStoredModel(id);
  if (!storedModel) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });

  if (storedModel.storageProvider === "supabase" && storedModel.storagePath) {
    try {
      await removeStorageObject(storedModel.storagePath);
    } catch (error) {
      console.error("Delete Supabase model failed", error);
      return NextResponse.json({ message: "Không thể xóa file trên Supabase." }, { status: 502 });
    }
  }

  const deleted = await deleteModel(id);
  if (!deleted) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
