import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/http";
import { deleteModel, getModel } from "@/lib/models";

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
  const deleted = await deleteModel(id);
  if (!deleted) return NextResponse.json({ message: "Không tìm thấy model." }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
