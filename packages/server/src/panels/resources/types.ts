/** Trusted Host binding. Resource requests never accept a guest-supplied scope. */
export interface ResourceScope {
  appId: string;
  projectPath: string;
}

/** Stable compatibility shape: existing asset IDs and records remain unchanged. */
export interface ResourceAsset {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

/** Mutable external storage is a reference, never an immutable content digest. */
export interface ExternalResourceReference {
  id: string;
  kind: "external";
  name: string;
  mimeType: string;
  bytes: number;
  lastModified: number;
  createdAt: number;
  state: "available" | "missing" | "changed";
}
export type MediaScope = ResourceScope;
export type MediaAsset = ResourceAsset;
