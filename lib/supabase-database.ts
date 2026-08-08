import type { ModelRecord } from "@/types/model";

const supabaseUrl = process.env.SUPABASE_URL
  ?.replace(/\/(?:rest|storage)\/v1\/?$/, "")
  .replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

type ModelRow = {
  id: string;
  name: string;
  description: string;
  original_file_name: string;
  stored_file_name: string | null;
  storage_path: string | null;
  storage_provider: "local" | "supabase" | null;
  mime_type: string;
  size: number;
  created_at: string;
  usdz_status: "pending" | "processing" | "ready" | "failed";
  usdz_storage_path: string | null;
  usdz_error: string | null;
  usdz_attempts: number;
  usdz_updated_at: string;
};

export function isSupabaseDatabaseConfigured() {
  return Boolean(supabaseUrl && serviceRoleKey && process.env.SUPABASE_DATABASE_ENABLED !== "false");
}

async function databaseRequest(path: string, init: RequestInit = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  }

  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    ...init,
    headers,
    cache: "no-store"
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase Database ${response.status}: ${detail}`);
  }
  return response;
}

function fromRow(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    originalFileName: row.original_file_name,
    storedFileName: row.stored_file_name ?? undefined,
    storagePath: row.storage_path ?? undefined,
    storageProvider: row.storage_provider ?? undefined,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: row.created_at,
    usdzStatus: row.usdz_status,
    usdzStoragePath: row.usdz_storage_path ?? undefined,
    usdzError: row.usdz_error ?? undefined,
    usdzAttempts: row.usdz_attempts,
    usdzUpdatedAt: row.usdz_updated_at
  };
}

function toRow(record: ModelRecord): ModelRow {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    original_file_name: record.originalFileName,
    stored_file_name: record.storedFileName ?? null,
    storage_path: record.storagePath ?? null,
    storage_provider: record.storageProvider ?? null,
    mime_type: record.mimeType,
    size: record.size,
    created_at: record.createdAt,
    usdz_status: record.usdzStatus ?? "pending",
    usdz_storage_path: record.usdzStoragePath ?? null,
    usdz_error: record.usdzError ?? null,
    usdz_attempts: record.usdzAttempts ?? 0,
    usdz_updated_at: record.usdzUpdatedAt ?? record.createdAt
  };
}

export async function listDatabaseModels() {
  const response = await databaseRequest("/models?select=*&order=created_at.desc");
  const rows = (await response.json()) as ModelRow[];
  return rows.map(fromRow);
}

export async function getDatabaseModel(id: string) {
  const query = new URLSearchParams({ select: "*", id: `eq.${id}`, limit: "1" });
  const response = await databaseRequest(`/models?${query}`);
  const rows = (await response.json()) as ModelRow[];
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function insertDatabaseModel(record: ModelRecord) {
  const response = await databaseRequest("/models", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(toRow(record))
  });
  const rows = (await response.json()) as ModelRow[];
  if (!rows[0]) throw new Error("Supabase không trả về metadata model vừa tạo.");
  return fromRow(rows[0]);
}

export async function deleteDatabaseModel(id: string) {
  const query = new URLSearchParams({ id: `eq.${id}` });
  const response = await databaseRequest(`/models?${query}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });
  const rows = (await response.json()) as ModelRow[];
  return rows.length > 0;
}

export async function retryDatabaseModelUsdz(id: string) {
  const query = new URLSearchParams({ id: `eq.${id}` });
  const response = await databaseRequest(`/models?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      usdz_status: "pending",
      usdz_storage_path: null,
      usdz_error: null,
      usdz_attempts: 0,
      usdz_updated_at: new Date().toISOString()
    })
  });
  const rows = (await response.json()) as ModelRow[];
  return rows[0] ? fromRow(rows[0]) : null;
}
