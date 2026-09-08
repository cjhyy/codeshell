/** Stored only by the trusted control plane; credentials must never reach browser DTOs. */
export interface ProjectRuntimeRecord {
  id: string;
  ownerId: string;
  generation: number;
  runtimeUsername: string;
  runtimePassword: string;
}

export interface ProjectRuntimeConnection {
  /** Always an HTTP URL bound to the Docker host's loopback interface. */
  url: string;
  username: string;
  password: string;
  generation: number;
}

export interface ProjectRuntimeAvailability {
  available: boolean;
  error?: string;
}

export interface ProjectRuntimeStatus {
  state: "running" | "stopped" | "missing";
  url?: string;
}

export interface ProjectRuntimeProvider {
  availability(): Promise<ProjectRuntimeAvailability>;
  ensure(
    project: ProjectRuntimeRecord,
    options: { publicOrigin: string },
  ): Promise<ProjectRuntimeConnection>;
  stop(project: ProjectRuntimeRecord): Promise<void>;
  status(project: ProjectRuntimeRecord): Promise<ProjectRuntimeStatus>;
  /** Cancels control commands; never removes containers or persistent project volumes. */
  close(): Promise<void>;
}

export interface ManagedProjectSecret {
  version: 1;
  projectId: string;
  ownerId: string;
  generation: number;
  username: string;
  password: string;
  publicOrigin: string;
  publicPathPrefix: string;
}
