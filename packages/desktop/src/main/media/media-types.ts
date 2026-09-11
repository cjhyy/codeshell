/** The trusted Host binding, never a guest-supplied filesystem scope. */
export interface MediaScope {
  appId: string;
  projectPath: string;
}

export interface MediaAsset {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

export type MediaJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MediaJobProgress {
  fraction?: number;
  stage?: string;
  message?: string;
}

export interface MediaJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MediaJob {
  id: string;
  type: string;
  status: MediaJobStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  progress?: MediaJobProgress;
  result?: unknown;
  error?: MediaJobError;
}

export interface MediaJobContext {
  scope: MediaScope;
  jobId: string;
  attempt: number;
  signal: AbortSignal;
  workDir: string;
  outputDir: string;
  cacheDir: string;
  reportProgress(progress: MediaJobProgress): Promise<void>;
}

export interface MediaJobProcessor {
  /** Only explicitly idempotent processors may rerun after an interrupted Host. */
  recovery?: "fail" | "restart";
  run(input: unknown, context: MediaJobContext): Promise<unknown>;
}
