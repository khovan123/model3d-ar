const supabaseUrl = process.env.SUPABASE_URL
  ?.replace(/\/(?:rest|storage)\/v1\/?$/, "")
  .replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "models";

function requireConfig() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY.");
  }
}

function objectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function storageRequest(path: string, init: RequestInit = {}) {
  requireConfig();
  const headers = new Headers(init.headers);
  headers.set("apikey", serviceRoleKey!);
  headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(`${supabaseUrl}/storage/v1${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase Storage ${response.status}: ${detail}`);
  }
  return response;
}

function signedUrl(value: string) {
  return value.startsWith("http") ? value : `${supabaseUrl}/storage/v1${value}`;
}

export async function createSignedUpload(path: string) {
  const response = await storageRequest(`/object/upload/sign/${encodeURIComponent(bucket)}/${objectPath(path)}`, {
    method: "POST",
    body: JSON.stringify({ allowOverwrite: false })
  });
  const data = (await response.json()) as { url?: string; signedUrl?: string; signedURL?: string };
  const url = data.url ?? data.signedUrl ?? data.signedURL;
  if (!url) throw new Error("Supabase không trả về signed upload URL.");
  return signedUrl(url);
}

export async function createSignedDownload(path: string, expiresIn = 3600) {
  const response = await storageRequest(`/object/sign/${encodeURIComponent(bucket)}/${objectPath(path)}`, {
    method: "POST",
    body: JSON.stringify({ expiresIn })
  });
  const data = (await response.json()) as { signedURL?: string; signedUrl?: string; url?: string };
  const url = data.signedURL ?? data.signedUrl ?? data.url;
  if (!url) throw new Error("Supabase không trả về signed download URL.");
  return signedUrl(url);
}

export async function storageObjectExists(path: string) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const response = await storageRequest(`/object/list/${encodeURIComponent(bucket)}`, {
    method: "POST",
    body: JSON.stringify({ prefix: parent, search: name, limit: 100 })
  });
  const items = (await response.json()) as Array<{ name?: string }>;
  return items.some((item) => item.name === name);
}

export async function removeStorageObject(path: string) {
  await storageRequest(`/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: [path] })
  });
}

export function getStorageBucket() {
  return bucket;
}
