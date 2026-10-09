/** Host-only process custody. None of these capabilities cross JSON/RPC. */
declare const permitBrand: unique symbol;
declare const resourcesBrand: unique symbol;

export interface ConstrainedProcessPermit {
  readonly [permitBrand]: true;
}

export interface ConstrainedProcessResources {
  readonly [resourcesBrand]: true;
}

export interface ConstrainedDockerRuntime {
  /** Explicit canonical executable; never resolved through PATH. */
  executable: string;
  executableSha256: string;
  /** An explicit local Unix socket, never an inherited Docker context. */
  endpoint: string;
  /** Immutable locally installed Linux image ID. Never pulled. */
  image: string;
  architecture: "arm64" | "amd64";
  /** Node within that trusted immutable runtime image. */
  nodeExecutable: string;
  nodeExecutableSha256: string;
}

export interface ConstrainedReadableResource {
  /** Host-authorized original, not supplied by the Hook. */
  path: string;
  /** Relative deterministic path within the private read-only snapshot. */
  name: string;
  /** Recheck the actual Host file authority, including revocation. */
  assertReadable(): void;
}

export interface ConstrainedProcessReceipt {
  backend: "docker-linux";
  image: string;
  policySha256: string;
  containerId: string;
  invocationId: string;
  exitCode: number;
  running: false;
  hostPid: 0;
  removed: true;
  resourcesSha256: string;
}

export interface ConstrainedProcessOutput {
  stdout: string;
  stderr: string;
  receipt: ConstrainedProcessReceipt;
}

export interface ConstrainedProcessScope {
  /** Runs only a permit issued by this exact Host scope. */
  run(permit: ConstrainedProcessPermit, input: string): Promise<ConstrainedProcessOutput>;
  /** Normal and cancelled scopes both prove all owned invocations are gone. */
  terminateAndWait(): Promise<void>;
}

export interface ConstrainedProcessHost {
  capture(resources: readonly ConstrainedReadableResource[]): ConstrainedProcessResources;
  /** Recheck actual resource authority and bytes before publishing an observation. */
  assertResourcesCurrent(resources: ConstrainedProcessResources): void;
  createScope(authority: { signal: AbortSignal; assertAuthorized(): void }): {
    scope: ConstrainedProcessScope;
    /** Trusted Host only; a Hook cannot issue or mutate this capability. */
    issue(spec: {
      command: string;
      timeoutMs: number;
      event: string;
      resources?: ConstrainedProcessResources;
      plugin?: boolean;
    }): ConstrainedProcessPermit;
  };
  dispose(): Promise<void>;
}
