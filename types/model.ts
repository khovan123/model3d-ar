export type UsdzStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "skipped"
  | "unsupported"
  | "unavailable";

export type AssetStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "unsupported"
  | "unavailable";

export type ModelRecord = {
  id: string;
  name: string;
  description: string;
  originalFileName: string;
  storedFileName?: string;
  storagePath?: string;
  storageProvider?: "local" | "supabase";
  assetStatus?: Exclude<AssetStatus, "unavailable">;
  assetStoragePath?: string;
  assetError?: string;
  assetAttempts?: number;
  assetUpdatedAt?: string;
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
  | "assetStatus"
  | "assetStoragePath"
  | "assetError"
  | "usdzStatus"
  | "usdzStoragePath"
  | "usdzError"
> & {
  viewerPath: string;
  assetPath: string;
  assetStatus: AssetStatus;
  usdzStatus: UsdzStatus;
  usdzPath?: string;
};
