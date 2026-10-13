/** Browser-safe identities. Connection credentials never belong in these records. */
export interface CloudProjectBinding {
  id: string;
  localProjectId: string;
  origin: string;
  environmentId: string;
  environmentName: string;
  remoteProjectId: string;
  remoteProjectName: string;
  createdAt: number;
  updatedAt: number;
}

/** Main must verify the discovered environment and project before storing a binding. */
export type CloudBindingInput = Pick<
  CloudProjectBinding,
  | "localProjectId"
  | "origin"
  | "environmentId"
  | "environmentName"
  | "remoteProjectId"
  | "remoteProjectName"
>;

export interface ProjectRuntimeSelection {
  localProjectId: string;
  /** null selects this computer; a UUID selects a binding owned by this project. */
  bindingId: string | null;
}
