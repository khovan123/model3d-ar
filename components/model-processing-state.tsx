"use client";

import { useEffect } from "react";
import type { AssetStatus } from "@/types/model";

export function ModelProcessingState({ status }: { status: AssetStatus }) {
  const waiting = status === "pending" || status === "processing";

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => window.location.reload(), 10000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  return (
    <main className="viewer-error">
      {waiting && <div className="loader-ring" />}
      <strong>{waiting ? "Model đang được chuẩn bị" : "Không thể xử lý model"}</strong>
      <p>
        {waiting
          ? "Hệ thống đang chuyển file nguồn sang GLB. Trang sẽ tự kiểm tra lại sau ít phút."
          : "Quá trình chuyển file nguồn sang GLB đã lỗi. Quản trị viên cần chạy lại conversion."}
      </p>
      <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
        Kiểm tra lại
      </button>
    </main>
  );
}
