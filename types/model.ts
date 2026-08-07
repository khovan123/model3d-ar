export type ModelRecord = {
  id: string;
  name: string;
  description: string;
  originalFileName: string;
  storedFileName?: string;
  storagePath?: string;
  storageProvider?: "local" | "supabase";
  mimeType: string;
  size: number;
  createdAt: string;
};

export type PublicModel = Omit<ModelRecord, "storedFileName" | "storagePath" | "storageProvider"> & {
  viewerPath: string;
  assetPath: string;
};
