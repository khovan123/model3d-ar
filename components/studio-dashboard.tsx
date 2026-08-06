"use client";

import Link from "next/link";
import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicModel } from "@/types/model";

const MAX_PREVIEW_MB = 50;

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function StudioDashboard() {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState("");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadModels = useCallback(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    const result = await response.json();
    setModels(result.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadModels().finally(() => {
      setToken(sessionStorage.getItem("modelspace-admin-token") ?? "");
    });
  }, [loadModels]);

  const selectedInfo = useMemo(() => {
    if (!file) return null;
    return `${file.name} · ${formatBytes(file.size)}`;
  }, [file]);

  function selectFile(selected: File | null) {
    setMessage(null);
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".glb")) {
      setMessage({ type: "error", text: "Vui lòng chọn file .glb." });
      return;
    }
    if (selected.size > MAX_PREVIEW_MB * 1024 * 1024) {
      setMessage({ type: "error", text: `File không được vượt quá ${MAX_PREVIEW_MB} MB.` });
      return;
    }
    setFile(selected);
    if (!name) setName(selected.name.replace(/\.glb$/i, "").replace(/[-_]+/g, " "));
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setMessage({ type: "error", text: "Vui lòng chọn model trước khi tải lên." });
      return;
    }

    setSubmitting(true);
    setMessage(null);
    sessionStorage.setItem("modelspace-admin-token", token);

    const data = new FormData();
    data.set("file", file);
    data.set("name", name);
    data.set("description", description);

    const response = await fetch("/api/models", {
      method: "POST",
      headers: token ? { "x-upload-token": token } : undefined,
      body: data
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      setMessage({ type: "error", text: result.message ?? "Không thể tải model lên." });
      setSubmitting(false);
      return;
    }

    setMessage({ type: "success", text: "Đã tải model lên và tạo QR thành công." });
    setFile(null);
    setName("");
    setDescription("");
    if (inputRef.current) inputRef.current.value = "";
    await loadModels();
    setSubmitting(false);
  }

  async function copyUrl(model: PublicModel) {
    const url = `${window.location.origin}${model.viewerPath}`;
    await navigator.clipboard.writeText(url);
    setMessage({ type: "success", text: "Đã sao chép đường dẫn xem model." });
  }

  async function deleteItem(model: PublicModel) {
    if (!window.confirm(`Xóa model “${model.name}”?`)) return;
    const response = await fetch(`/api/models/${model.id}`, {
      method: "DELETE",
      headers: token ? { "x-upload-token": token } : undefined
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      setMessage({ type: "error", text: result.message ?? "Không thể xóa model." });
      return;
    }
    setModels((items) => items.filter((item) => item.id !== model.id));
    setMessage({ type: "success", text: "Đã xóa model." });
  }

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <Link href="/" className="brand">MODEL<span>SPACE</span></Link>
        <div><p>DESIGNER CONSOLE</p><h1>3D Studio</h1></div>
      </header>

      <div className="studio-grid">
        <section className="panel upload-panel">
          <div className="section-heading"><span>01</span><div><h2>Tải model mới</h2><p>Định dạng hỗ trợ: GLB</p></div></div>
          <form onSubmit={onSubmit}>
            <div
              className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === "Enter") inputRef.current?.click(); }}
            >
              <input ref={inputRef} type="file" accept=".glb,model/gltf-binary" hidden onChange={onFileChange} />
              <div className="upload-mark">{file ? "✓" : "+"}</div>
              <strong>{file ? "Model đã sẵn sàng" : "Thả file GLB vào đây"}</strong>
              <span>{selectedInfo ?? "hoặc bấm để chọn file · tối đa 50 MB"}</span>
            </div>

            <label className="field"><span>Tên model</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="Ví dụ: Villa Concept 01" /></label>
            <label className="field"><span>Mô tả</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={4} placeholder="Thông tin ngắn hiển thị cho người xem" /></label>
            <label className="field"><span>Mã quản trị <small>(nếu server có cấu hình)</small></span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_UPLOAD_TOKEN" /></label>

            {message && <div className={`notice notice-${message.type}`}>{message.text}</div>}
            <button className="button button-primary submit-button" disabled={submitting}>{submitting ? "Đang xử lý…" : "Tải lên và tạo QR"}</button>
          </form>
        </section>

        <section className="panel library-panel">
          <div className="section-heading"><span>02</span><div><h2>Thư viện model</h2><p>{models.length} model đã xuất bản</p></div></div>
          {loading ? <div className="empty-state">Đang tải thư viện…</div> : models.length === 0 ? (
            <div className="empty-state"><strong>Chưa có model nào</strong><p>Model đầu tiên sẽ xuất hiện tại đây cùng mã QR.</p></div>
          ) : (
            <div className="model-list">
              {models.map((model) => (
                <article className="model-card" key={model.id}>
                  <div className="model-index">{String(models.indexOf(model) + 1).padStart(2, "0")}</div>
                  <div className="model-info"><h3>{model.name}</h3><p>{model.description || model.originalFileName}</p><small>{formatBytes(model.size)} · {formatDate(model.createdAt)}</small></div>
                  <div className="qr-box">
                    {/* QR SVG is generated dynamically and should not be optimized by next/image. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/models/${model.id}/qr`} alt={`QR mở ${model.name}`} />
                  </div>
                  <div className="model-actions">
                    <Link href={model.viewerPath} target="_blank" className="mini-button">Mở</Link>
                    <button type="button" className="mini-button" onClick={() => void copyUrl(model)}>Sao chép</button>
                    <a className="mini-button" href={`/api/models/${model.id}/qr`} download={`${model.name}.svg`}>Tải QR</a>
                    <button type="button" className="mini-button danger" onClick={() => void deleteItem(model)}>Xóa</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
