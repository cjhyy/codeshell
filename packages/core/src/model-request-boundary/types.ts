/** Only Host code constructs this subject from durable Session ownership. */
export interface ModelRequestSubject {
  sessionId: string;
  storageScopeId: string;
  sessionInstanceId: string;
  /** Host-established process-local ownership; never a model/RPC persistence override. */
  ephemeral?: boolean;
}

export type ModelRequestCustody = "host-encrypted" | "owner-only-plaintext" | "ephemeral-memory";
export type PrivateRequestDomain = "system" | "messages" | "wire" | "source-context";

/** Prehashes are transient IPC material and never become Transcript/log fields. */
export interface ModelRequestSignInput {
  subject: ModelRequestSubject;
  prehashes: Partial<Record<PrivateRequestDomain, string>>;
}
export interface ModelRequestSignatures {
  version: 1;
  keyId: string;
  custodyMode: ModelRequestCustody;
  digests: Partial<Record<PrivateRequestDomain, string>>;
}

/** No raw key, plaintext prompt or credential is returned to the worker/renderer. */
export interface ModelRequestSigner {
  sign(input: ModelRequestSignInput): Promise<ModelRequestSignatures>;
  /** Wipe process-local keys when the owning Host/worker generation closes. */
  dispose?(): void;
}
