import type { CloudProjectBinding, ProjectRuntimeSelection } from "./project-runtime";

export interface CloudEnvironmentDescriptor {
  version: 1;
  id: string;
  name: string;
  kind: "project-host";
  entryPath: "/";
}

export interface CloudRemoteProject {
  id: string;
  name: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  generation: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface CloudEnvironmentDiscovery {
  origin: string;
  initialized: boolean;
  authenticated: boolean;
  environment?: CloudEnvironmentDescriptor;
  projects?: CloudRemoteProject[];
}

export interface CloudConfiguration {
  workspace: { path: string; settingsScope: "local"; skillDirectories: string[] };
  defaults: { text?: string; auxText?: string };
  connections: Array<{
    id: string;
    catalogId: string;
    tag: string;
    model: string;
    baseUrl: string;
    hasApiKey: boolean;
    needsKey: boolean;
  }>;
  catalog: Array<{
    id: string;
    displayName: string;
    adapterKind: string;
    defaultBaseUrl: string;
    needsKey: boolean;
  }>;
  skills: Array<{ name: string; description: string; enabled: boolean; source: string }>;
  mcpServers: Array<{ name: string; transport: string; enabled: boolean }>;
  restartRequired: boolean;
}

export type CloudRequestMethod = "agent/run" | "agent/cancel" | "agent/approve" | "agent/query";
export type CloudRequestErrorKind = "response" | "transport" | "timeout" | "not-sent";
export interface CloudRequestError {
  message: string;
  kind: CloudRequestErrorKind;
  code?: number;
  status?: number;
  reason?: "auth-required" | "project-stopped" | "identity-mismatch" | "invalid-input";
}
/** IPC preserves error certainty; Electron's default Error serialization does not. */
export type CloudIpcResult<T> = { ok: true; value: T } | { ok: false; error: CloudRequestError };

export interface CloudEnvironmentEvent {
  connectionId: string;
  bindingId: string;
  environmentId: string;
  projectId: string;
  method: string;
  params: Record<string, unknown>;
}

export interface CloudConnectionStatus {
  connectionId: string;
  bindingId: string;
  status: "connecting" | "connected" | "disconnected" | "auth-required" | "closed";
  generation?: number;
  error?: string;
}

export interface CloudConnection {
  connectionId: string;
  binding: CloudProjectBinding;
  configuration: CloudConfiguration;
  generation: number;
}

export interface CloudEnvironmentApi {
  discover(input: { origin: string }): Promise<CloudEnvironmentDiscovery>;
  login(input: {
    origin: string;
    username: string;
    password: string;
  }): Promise<CloudEnvironmentDiscovery>;
  listBindings(localProjectId: string): Promise<CloudProjectBinding[]>;
  bind(input: {
    localProjectId: string;
    origin: string;
    environmentId: string;
    remoteProjectId: string;
  }): Promise<CloudProjectBinding>;
  select(input: {
    localProjectId: string;
    bindingId: string | null;
  }): Promise<ProjectRuntimeSelection>;
  getSelection(localProjectId: string): Promise<ProjectRuntimeSelection>;
  connect(input: { bindingId: string }): Promise<CloudConnection>;
  start(input: { bindingId: string }): Promise<CloudRemoteProject>;
  request(input: {
    connectionId: string;
    method: CloudRequestMethod;
    params: Record<string, unknown>;
  }): Promise<unknown>;
  listSessions(input: { connectionId: string }): Promise<unknown>;
  readConfiguration(input: { connectionId: string }): Promise<CloudConfiguration>;
  upload(input: {
    connectionId: string;
    sessionId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{ id: string; name: string; mimeType: string; size: number }>;
  disconnect(input: { connectionId: string }): Promise<void>;
  onEvent(callback: (event: CloudEnvironmentEvent) => void): () => void;
  onStatus(callback: (status: CloudConnectionStatus) => void): () => void;
}
