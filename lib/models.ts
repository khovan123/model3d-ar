import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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

function serialize(record: ModelRecord): PublicModel {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
    viewerPath: `/view/${record.id}`,
    assetPath: `/api/assets/${record.id}`
  };
}

export async function listModels(): Promise<PublicModel[]> {
  const records = await readRecords();
  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(serialize);
}

export async function getModel(id: string): Promise<PublicModel | null> {
  const records = await readRecords();
  const record = records.find((item) => item.id === id);
  return record ? serialize(record) : null;
}

export async function getStoredModel(id: string): Promise<ModelRecord | null> {
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

  return serialize(record);
}

export async function deleteModel(id: string): Promise<boolean> {
  let deleted: ModelRecord | undefined;

  writeQueue = writeQueue.then(async () => {
    const records = await readRecords();
    deleted = records.find((item) => item.id === id);
    if (!deleted) return;
    await writeRecords(records.filter((item) => item.id !== id));
  });
  await writeQueue;

  if (!deleted) return false;
  await unlink(path.join(UPLOAD_DIR, deleted.storedFileName)).catch(() => undefined);
  return true;
}

export function getUploadPath(storedFileName: string) {
  return path.join(UPLOAD_DIR, path.basename(storedFileName));
}
