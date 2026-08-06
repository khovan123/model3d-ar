export type ModelRecord = {
  id: string;
  name: string;
  description: string;
  originalFileName: string;
  storedFileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type PublicModel = Omit<ModelRecord, "storedFileName"> & {
  viewerPath: string;
  assetPath: string;
};
