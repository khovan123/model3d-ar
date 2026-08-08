export type UsdzStatus = "pending" | "processing" | "ready" | "failed" | "unavailable";

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
  usdzStatus?: Exclude<UsdzStatus, "unavailable">;
  usdzStoragePath?: string;
  usdzError?: string;
  usdzAttempts?: number;
  usdzUpdatedAt?: string;
};

export type PublicModel = Omit<
  ModelRecord,
  | "storedFileName"
  | "storagePath"
  | "storageProvider"
  | "usdzStatus"
  | "usdzStoragePath"
  | "usdzError"
> & {
  viewerPath: string;
  assetPath: string;
  usdzStatus: UsdzStatus;
  usdzPath?: string;
};
