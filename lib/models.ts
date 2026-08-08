import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deleteDatabaseModel,
  getDatabaseModel,
  insertDatabaseModel,
  isSupabaseDatabaseConfigured,
  listDatabaseModels,
  updateDatabaseModelMetadata
} from "@/lib/supabase-database";
import { canConvertToGlb, getModelExtension } from "@/lib/model-file-types";
import type { ModelRecord, PublicModel } from "@/types/model";

const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const INDEX_FILE = path.join(DATA_DIR, "models.json");

let writeQueue: Promise<void> = Promise.resolve();

async function ensureStorage() {
  await mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await readFile(INDEX_FILE, "utf8");
  } catch {
    await writeFile(INDEX_FILE, "[]", "utf8");
  }
}

async function readRecords(): Promise<ModelRecord[]> {
  await ensureStorage();
  const raw = await readFile(INDEX_FILE, "utf8");
  const parsed = JSON.parse(raw) as ModelRecord[];
  return Array.isArray(parsed) ? parsed : [];
}

async function writeRecords(records: ModelRecord[]) {
  const tempFile = `${INDEX_FILE}.${randomUUID()}.tmp`;
  await writeFile(tempFile, JSON.stringify(records, null, 2), "utf8");
  await rename(tempFile, INDEX_FILE);
}

export function toPublicModel(record: ModelRecord): PublicModel {
  const assetStatus = record.storageProvider === "supabase" && isSupabaseDatabaseConfigured()
    ? record.assetStatus ?? "pending"
    : "ready";
  const usdzStatus = record.storageProvider === "supabase" && isSupabaseDatabaseConfigured()
    ? record.usdzStatus ?? "pending"
    : "unavailable";
  const usdzVersion = record.usdzUpdatedAt
    ? encodeURIComponent(record.usdzUpdatedAt)
    : encodeURIComponent(record.id);

  return {
    id: record.id,
    name: record.name,
    description: record.description,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
    viewerPath: `/view/${record.id}`,
    assetPath: `/api/assets/${record.id}`,
    assetStatus,
    assetAttempts: record.assetAttempts,
    assetUpdatedAt: record.assetUpdatedAt,
    usdzStatus,
    usdzAttempts: record.usdzAttempts,
    usdzUpdatedAt: record.usdzUpdatedAt,
    ...(usdzStatus === "ready" ? { usdzPath: `/api/models/${record.id}/usdz?v=${usdzVersion}` } : {})
  };
}

export async function listModels(): Promise<PublicModel[]> {
  const localRecords = await readRecords();
  const databaseRecords = isSupabaseDatabaseConfigured() ? await listDatabaseModels() : [];
  const records = [...databaseRecords, ...localRecords.filter(
    (local) => !databaseRecords.some((database) => database.id === local.id)
  )];
  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublicModel);
}

export async function getModel(id: string): Promise<PublicModel | null> {
  const record = await getStoredModel(id);
  return record ? toPublicModel(record) : null;
}

export async function getStoredModel(id: string): Promise<ModelRecord | null> {
  if (isSupabaseDatabaseConfigured()) {
    const databaseModel = await getDatabaseModel(id);
    if (databaseModel) return databaseModel;
  }
  const records = await readRecords();
  return records.find((item) => item.id === id) ?? null;
}

export async function createModel(input: {
  name: string;
  description: string;
  originalFileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<PublicModel> {
  const id = randomUUID();
  const storedFileName = `${id}.glb`;
  const record: ModelRecord = {
    id,
    name: input.name,
    description: input.description,
    originalFileName: input.originalFileName,
    storedFileName,
    mimeType: input.mimeType || "model/gltf-binary",
    size: input.bytes.byteLength,
    createdAt: new Date().toISOString()
  };

  await ensureStorage();
  await writeFile(path.join(UPLOAD_DIR, storedFileName), input.bytes);

  writeQueue = writeQueue.then(async () => {
    const records = await readRecords();
    records.push(record);
    await writeRecords(records);
  });
  await writeQueue;

  return toPublicModel(record);
}

export async function createSupabaseModel(input: {
  id: string;
  name: string;
  description: string;
  originalFileName: string;
  mimeType: string;
  size: number;
  storagePath: string;
}) {
  const extension = getModelExtension(input.storagePath);
  const isUploadedUsdz = extension === "usdz";
  const canConvert = canConvertToGlb(input.storagePath);
  const now = new Date().toISOString();
  const record: ModelRecord = {
    id: input.id,
    name: input.name,
    description: input.description,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType || "model/gltf-binary",
    size: input.size,
    createdAt: now,
    storagePath: input.storagePath,
    storageProvider: "supabase",
    // Every supported source, including a self-contained GLB, goes through the
    // canonical GLB worker. This prevents authoring-unit differences from being
    // hidden by WebXR normalization while leaking into iPhone Quick Look.
    assetStatus: canConvert ? "pending" : "unsupported",
    assetStoragePath: undefined,
    assetAttempts: 0,
    assetUpdatedAt: now,
    usdzStatus: isUploadedUsdz ? "ready" : canConvert ? "pending" : "unsupported",
    usdzStoragePath: isUploadedUsdz ? input.storagePath : undefined,
    usdzAttempts: 0,
    usdzUpdatedAt: now
  };

  if (isSupabaseDatabaseConfigured()) {
    return toPublicModel(await insertDatabaseModel(record));
  }

  await ensureStorage();
  writeQueue = writeQueue.then(async () => {
    const records = await readRecords();
    records.push(record);
    await writeRecords(records);
  });
  await writeQueue;
  return toPublicModel(record);
}

export async function deleteModel(id: string): Promise<boolean> {
  if (isSupabaseDatabaseConfigured() && await getDatabaseModel(id)) {
    return deleteDatabaseModel(id);
  }

  let deleted: ModelRecord | undefined;

  writeQueue = writeQueue.then(async () => {
    const records = await readRecords();
    deleted = records.find((item) => item.id === id);
    if (!deleted) return;
    await writeRecords(records.filter((item) => item.id !== id));
  });
  await writeQueue;

  if (!deleted) return false;
  if (deleted.storedFileName) {
    await unlink(path.join(UPLOAD_DIR, deleted.storedFileName)).catch(() => undefined);
  }
  return true;
}

export async function updateModelMetadata(
  id: string,
  values: { name: string; description: string }
): Promise<PublicModel | null> {
  if (isSupabaseDatabaseConfigured() && await getDatabaseModel(id)) {
    const updated = await updateDatabaseModelMetadata(id, values);
    return updated ? toPublicModel(updated) : null;
  }

  let updated: ModelRecord | undefined;

  writeQueue = writeQueue.then(async () => {
    const records = await readRecords();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return;
    updated = {
      ...records[index],
      name: values.name,
      description: values.description
    };
    records[index] = updated;
    await writeRecords(records);
  });
  await writeQueue;
  return updated ? toPublicModel(updated) : null;
}

export function getUploadPath(storedFileName: string) {
  return path.join(UPLOAD_DIR, path.basename(storedFileName));
}
