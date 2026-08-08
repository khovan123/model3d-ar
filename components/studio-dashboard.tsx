"use client";

import Link from "next/link";
import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalModelMimeType, getModelFileType, SUPPORTED_MODEL_ACCEPT, SUPPORTED_MODEL_EXTENSIONS } from "@/lib/model-file-types";
import type { PublicModel } from "@/types/model";

const MAX_PREVIEW_MB = 50;
const MAX_AUDIO_MB = 20;
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "aac"]);

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  const vietnamTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const day = String(vietnamTime.getUTCDate()).padStart(2, "0");
  const month = String(vietnamTime.getUTCMonth() + 1).padStart(2, "0");
  const year = vietnamTime.getUTCFullYear();
  const hours = String(vietnamTime.getUTCHours()).padStart(2, "0");
  const minutes = String(vietnamTime.getUTCMinutes()).padStart(2, "0");

  return `${hours}:${minutes} ${day}/${month}/${year}`;
}

function canonicalAudioMimeType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "wav") return "audio/wav";
  if (extension === "ogg") return "audio/ogg";
  if (extension === "aac") return "audio/aac";
  return file.type.startsWith("audio/") ? file.type : "audio/mpeg";
}

function displayModelExtensions() {
  return SUPPORTED_MODEL_EXTENSIONS.map((extension) => `.${extension}`).join(", ");
}

const USDZ_STATUS_LABELS: Record<PublicModel["usdzStatus"], string> = {
  pending: "Đang chờ USDZ",
  processing: "Đang chuyển đổi",
  ready: "USDZ sẵn sàng",
  failed: "Chuyển đổi lỗi",
  skipped: "Không có animation",
  unsupported: "USDZ không khả dụng",
  unavailable: "Không hỗ trợ tự động"
};

const ASSET_STATUS_LABELS: Record<PublicModel["assetStatus"], string> = {
  pending: "Đang chờ tạo GLB",
  processing: "Đang tạo GLB",
  ready: "GLB sẵn sàng",
  failed: "Tạo GLB lỗi",
  unsupported: "Không hỗ trợ chuyển GLB",
  unavailable: "GLB local"
};

export function StudioDashboard({ initialModels }: { initialModels: PublicModel[] }) {
  const [models, setModels] = useState<PublicModel[]>(initialModels);
  const [file, setFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const loadModels = useCallback(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    const result = await response.json();
    setModels(result.data ?? []);
  }, []);

  const selectedInfo = useMemo(() => {
    if (!file) return null;
    return `${file.name} · ${formatBytes(file.size)}`;
  }, [file]);

  const selectedAudioInfo = useMemo(() => {
    if (!audioFile) return "Không bắt buộc · MP3, M4A, WAV, OGG, AAC · tối đa 20 MB";
    return `${audioFile.name} · ${formatBytes(audioFile.size)}`;
  }, [audioFile]);

  useEffect(() => {
    if (!models.some((model) =>
      model.assetStatus === "pending" ||
      model.assetStatus === "processing" ||
      model.usdzStatus === "pending" ||
      model.usdzStatus === "processing"
    )) {
      return;
    }

    const timer = window.setInterval(() => void loadModels(), 10000);
    return () => window.clearInterval(timer);
  }, [loadModels, models]);

  function selectFile(selected: File | null) {
    setMessage(null);
    if (!selected) return;
    if (!getModelFileType(selected.name)) {
      setMessage({ type: "error", text: `Vui lòng chọn file 3D hợp lệ: ${displayModelExtensions()}.` });
      return;
    }
    if (selected.size > MAX_PREVIEW_MB * 1024 * 1024) {
      setMessage({ type: "error", text: `File không được vượt quá ${MAX_PREVIEW_MB} MB.` });
      return;
    }
    setFile(selected);
    if (!name) setName(selected.name.replace(/\.[^.]+$/i, "").replace(/[-_]+/g, " "));
  }

  function selectAudio(selected: File | null) {
    setMessage(null);
    if (!selected) {
      setAudioFile(null);
      return;
    }

    const extension = selected.name.split(".").pop()?.toLowerCase() ?? "";
    if (!AUDIO_EXTENSIONS.has(extension)) {
      setMessage({ type: "error", text: "Âm thanh hỗ trợ MP3, M4A, WAV, OGG hoặc AAC." });
      if (audioInputRef.current) audioInputRef.current.value = "";
      return;
    }
    if (selected.size > MAX_AUDIO_MB * 1024 * 1024) {
      setMessage({ type: "error", text: `Âm thanh không được vượt quá ${MAX_AUDIO_MB} MB.` });
      if (audioInputRef.current) audioInputRef.current.value = "";
      return;
    }
    setAudioFile(selected);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function onAudioChange(event: ChangeEvent<HTMLInputElement>) {
    selectAudio(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function uploadOptionalAudio(modelId: string, authHeaders: { "x-upload-token": string } | undefined) {
    if (!audioFile) return true;

    const audioMimeType = canonicalAudioMimeType(audioFile);
    const signedResponse = await fetch("/api/models/audio-upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        id: modelId,
        fileName: audioFile.name,
        fileSize: audioFile.size,
        mimeType: audioMimeType
      })
    });
    const signedResult = await signedResponse.json().catch(() => ({}));
    if (!signedResponse.ok) {
      setMessage({ type: "error", text: `Model đã tạo nhưng audio chưa tải được: ${signedResult.message ?? "không thể tạo upload URL"}` });
      return false;
    }

    const audioUpload = signedResult.data as { uploadUrl: string };
    const uploadResponse = await fetch(audioUpload.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": audioMimeType,
        "x-upsert": "false"
      },
      body: audioFile
    });

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => "");
      console.error("Supabase audio upload failed", uploadResponse.status, detail);
      setMessage({ type: "error", text: "Model đã tạo nhưng Supabase không nhận được file âm thanh. Hãy kiểm tra allowed MIME types của bucket." });
      return false;
    }
    return true;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setMessage({ type: "error", text: "Vui lòng chọn model trước khi tải lên." });
      return;
    }

    setSubmitting(true);
    setMessage(null);
    const authHeaders = token ? { "x-upload-token": token } : undefined;
    const signedResponse = await fetch("/api/models/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size, mimeType: canonicalModelMimeType(file.name, file.type) })
    });
    const signedResult = await signedResponse.json().catch(() => ({}));

    if (!signedResponse.ok) {
      setMessage({ type: "error", text: signedResult.message ?? "Không thể tạo đường dẫn upload." });
      setSubmitting(false);
      return;
    }

    const upload = signedResult.data as { id: string; storagePath: string; uploadUrl: string; mimeType?: string };
    const modelMimeType = upload.mimeType || canonicalModelMimeType(file.name, file.type);
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": modelMimeType,
        "x-upsert": "false"
      },
      body: file
    });

    if (!uploadResponse.ok) {
      setMessage({ type: "error", text: "Supabase không nhận được file model." });
      setSubmitting(false);
      return;
    }

    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        id: upload.id,
        storagePath: upload.storagePath,
        name,
        description,
        originalFileName: file.name,
        mimeType: modelMimeType,
        size: file.size
      })
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      setMessage({ type: "error", text: result.message ?? "File đã upload nhưng không thể lưu thông tin model." });
      setSubmitting(false);
      return;
    }

    const audioUploaded = await uploadOptionalAudio(upload.id, authHeaders);
    if (audioUploaded) {
      setMessage({ type: "success", text: audioFile ? "Đã tải model + âm thanh và tạo QR thành công." : "Đã tải model lên và tạo QR thành công." });
    }

    setFile(null);
    setAudioFile(null);
    setName("");
    setDescription("");
    if (inputRef.current) inputRef.current.value = "";
    if (audioInputRef.current) audioInputRef.current.value = "";
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

  function beginEdit(model: PublicModel) {
    setMessage(null);
    setEditingId(model.id);
    setEditName(model.name);
    setEditDescription(model.description);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditDescription("");
  }

  async function saveMetadata(model: PublicModel) {
    const nextName = editName.trim();
    if (nextName.length < 2) {
      setMessage({ type: "error", text: "Tên model phải có ít nhất 2 ký tự." });
      return;
    }

    setSavingId(model.id);
    setMessage(null);
    const response = await fetch(`/api/models/${model.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-upload-token": token } : {})
      },
      body: JSON.stringify({
        name: nextName,
        description: editDescription.trim()
      })
    });
    const result = await response.json().catch(() => ({}));
    setSavingId(null);

    if (!response.ok) {
      setMessage({ type: "error", text: result.message ?? "Không thể cập nhật thông tin model." });
      return;
    }

    const updated = result.data as PublicModel;
    setModels((items) => items.map((item) => item.id === model.id ? updated : item));
    cancelEdit();
    setMessage({ type: "success", text: "Đã cập nhật tên và mô tả model." });
  }

  async function retryUsdz(model: PublicModel) {
    const response = await fetch(`/api/models/${model.id}/usdz/retry`, {
      method: "POST",
      headers: token ? { "x-upload-token": token } : undefined
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage({ type: "error", text: result.message ?? "Không thể chạy lại chuyển đổi USDZ." });
      return;
    }

    const updated = result.data as PublicModel;
    setModels((items) => items.map((item) => item.id === model.id ? updated : item));
    setMessage({ type: "success", text: "Đã đưa model vào lại hàng đợi USDZ." });
  }

  async function retryAsset(model: PublicModel) {
    const response = await fetch(`/api/models/${model.id}/convert/retry`, {
      method: "POST",
      headers: token ? { "x-upload-token": token } : undefined
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage({ type: "error", text: result.message ?? "Không thể chạy lại chuyển đổi GLB." });
      return;
    }

    const updated = result.data as PublicModel;
    setModels((items) => items.map((item) => item.id === model.id ? updated : item));
    setMessage({ type: "success", text: "Đã đưa model vào lại hàng đợi chuyển sang GLB." });
  }

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <Link href="/" className="brand">MODEL<span>SPACE</span></Link>
        <div><p>DESIGNER CONSOLE</p><h1>3D Studio</h1></div>
      </header>

      <div className="studio-grid">
        <section className="panel upload-panel">
          <div className="section-heading"><span>01</span><div><h2>Tải model mới</h2><p>Định dạng hỗ trợ: {displayModelExtensions()}</p></div></div>
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
              <input ref={inputRef} type="file" accept={SUPPORTED_MODEL_ACCEPT} hidden onChange={onFileChange} />
              <div className="upload-mark">{file ? "✓" : "+"}</div>
                <strong>{file ? "Model đã sẵn sàng" : "Thả file 3D vào đây"}</strong>
              <span>{selectedInfo ?? "hoặc bấm để chọn file · tối đa 50 MB"}</span>
            </div>

            <label className="field"><span>Tên model</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="Ví dụ: Blue Iris" /></label>
            <label className="field"><span>Mô tả</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={4} placeholder="Thông tin hiển thị khi người xem chạm vào model" /></label>
            <label className="field">
              <span>Âm thanh <small>(tùy chọn)</small></span>
              <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac" onChange={onAudioChange} />
              <small>{selectedAudioInfo}</small>
            </label>
            <label className="field"><span>Mã quản trị <small>(nếu server có cấu hình)</small></span><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_UPLOAD_TOKEN" /></label>

            {message && <div className={`notice notice-${message.type}`}>{message.text}</div>}
            <button className="button button-primary submit-button" disabled={submitting}>{submitting ? "Đang xử lý…" : "Tải lên và tạo QR"}</button>
          </form>
        </section>

        <section className="panel library-panel">
          <div className="section-heading"><span>02</span><div><h2>Thư viện model</h2><p>{models.length} model đã xuất bản</p></div></div>
          {models.length === 0 ? (
            <div className="empty-state"><strong>Chưa có model nào</strong><p>Model đầu tiên sẽ xuất hiện tại đây cùng mã QR.</p></div>
          ) : (
            <div className="model-list">
              {models.map((model) => (
                <article className="model-card" key={model.id}>
                  <div className="model-index">{String(models.indexOf(model) + 1).padStart(2, "0")}</div>
                  <div className="model-info">
                    {editingId === model.id ? (
                      <div className="model-edit-fields">
                        <input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          maxLength={100}
                          aria-label="Tên model"
                          autoFocus
                        />
                        <textarea
                          value={editDescription}
                          onChange={(event) => setEditDescription(event.target.value)}
                          maxLength={500}
                          rows={3}
                          aria-label="Mô tả model"
                          placeholder="Mô tả model"
                        />
                        <small>{editDescription.length}/500 ký tự</small>
                      </div>
                    ) : (
                      <>
                        <h3>{model.name}</h3>
                        <p>{model.description || model.originalFileName}</p>
                      </>
                    )}
                    <small>{formatBytes(model.size)} · {formatDate(model.createdAt)}</small>
                    <span className={`usdz-status usdz-status-${model.assetStatus}`}>
                      {ASSET_STATUS_LABELS[model.assetStatus]}
                      {model.assetStatus === "processing" && model.assetAttempts
                        ? ` · lần ${model.assetAttempts}`
                        : ""}
                    </span>
                    <span className={`usdz-status usdz-status-${model.usdzStatus}`}>
                      {USDZ_STATUS_LABELS[model.usdzStatus]}
                      {model.usdzStatus === "processing" && model.usdzAttempts
                        ? ` · lần ${model.usdzAttempts}`
                        : ""}
                    </span>
                  </div>
                  <div className="qr-box">
                    {/* QR SVG is generated dynamically and should not be optimized by next/image. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/models/${model.id}/qr`} alt={`QR mở ${model.name}`} />
                  </div>
                  <div className="model-actions">
                    {editingId === model.id ? (
                      <>
                        <button
                          type="button"
                          className="mini-button"
                          disabled={savingId === model.id}
                          onClick={() => void saveMetadata(model)}
                        >
                          {savingId === model.id ? "Đang lưu…" : "Lưu"}
                        </button>
                        <button type="button" className="mini-button" disabled={savingId === model.id} onClick={cancelEdit}>
                          Hủy
                        </button>
                      </>
                    ) : (
                      <button type="button" className="mini-button" onClick={() => beginEdit(model)}>Sửa</button>
                    )}
                    {model.assetStatus === "ready" ? (
                      <Link href={model.viewerPath} target="_blank" className="mini-button">Mở</Link>
                    ) : (
                      <span className="mini-button mini-button-disabled">Chưa thể mở</span>
                    )}
                    <button type="button" className="mini-button" onClick={() => void copyUrl(model)}>Sao chép</button>
                    <a className="mini-button" href={`/api/models/${model.id}/qr`} download={`${model.name}.svg`}>Tải QR</a>
                    {model.usdzStatus === "failed" && (
                      <button type="button" className="mini-button" onClick={() => void retryUsdz(model)}>
                        Chạy lại USDZ
                      </button>
                    )}
                    {(model.assetStatus === "failed" || model.assetStatus === "unsupported") && (
                      <button type="button" className="mini-button" onClick={() => void retryAsset(model)}>
                        Chạy lại GLB
                      </button>
                    )}
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
