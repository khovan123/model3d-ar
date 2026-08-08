export type ModelFileType = {
  extension: string;
  mimeType: string;
  canConvertToGlb: boolean;
};

const MODEL_FILE_TYPES: ModelFileType[] = [
  { extension: "glb", mimeType: "model/gltf-binary", canConvertToGlb: true },
  { extension: "gltf", mimeType: "model/gltf+json", canConvertToGlb: true },
  { extension: "usdz", mimeType: "model/vnd.usdz+zip", canConvertToGlb: true },
  { extension: "obj", mimeType: "model/obj", canConvertToGlb: true },
  { extension: "fbx", mimeType: "application/octet-stream", canConvertToGlb: true },
  { extension: "stl", mimeType: "model/stl", canConvertToGlb: true },
  { extension: "dae", mimeType: "model/vnd.collada+xml", canConvertToGlb: true },
  { extension: "ply", mimeType: "application/octet-stream", canConvertToGlb: true },
  { extension: "3mf", mimeType: "model/3mf", canConvertToGlb: true },
  { extension: "blend", mimeType: "application/octet-stream", canConvertToGlb: true }
];

export const SUPPORTED_MODEL_EXTENSIONS = MODEL_FILE_TYPES.map((item) => item.extension);
export const SUPPORTED_MODEL_ACCEPT = SUPPORTED_MODEL_EXTENSIONS.map((extension) => `.${extension}`).join(",");

export function getModelExtension(fileNameOrPath: string) {
  const clean = fileNameOrPath.split(/[?#]/)[0] ?? "";
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function getModelFileType(fileNameOrPath: string) {
  const extension = getModelExtension(fileNameOrPath);
  if (!extension) return null;
  return MODEL_FILE_TYPES.find((item) => item.extension === extension) ?? null;
}

export function isSupportedModelFile(fileNameOrPath: string) {
  return Boolean(getModelFileType(fileNameOrPath));
}

export function canConvertToGlb(fileNameOrPath: string) {
  return getModelFileType(fileNameOrPath)?.canConvertToGlb ?? false;
}

export function canonicalModelMimeType(fileNameOrPath: string, fallback?: string) {
  return getModelFileType(fileNameOrPath)?.mimeType || fallback || "application/octet-stream";
}
