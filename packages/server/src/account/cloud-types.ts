/** Public Cloud management contract. All credentials and browser cookies remain in Main. */
export interface CloudProject {
  id: string;
  name: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  generation: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type CloudManagementRequest = {
  accountOrigin: string;
  accountId: string;
  cloudOrigin: string;
} & (
  | { action: "list" }
  | { action: "logout" }
  | { action: "create"; name: string }
  | { action: "start" | "stop" | "open"; projectId: string }
);

export type CloudManagementResult =
  | { action: "list"; available: boolean; error?: string; projects: CloudProject[] }
  | { action: "create" | "start" | "stop"; project: CloudProject }
  | { action: "open"; project: CloudProject; address: string }
  | { action: "logout"; revoked: true };

export interface CloudWorkbenchApi {
  (address: string): Promise<{ address: string }>;
  (input: CloudManagementRequest): Promise<CloudManagementResult>;
}
