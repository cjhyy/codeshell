/** Browser-safe discovery contract. A project identifier is only unique inside its host. */
export interface EnvironmentDescriptor {
  version: 1;
  id: string;
  name: string;
  kind: "desktop" | "hub" | "project-host";
  entryPath: "/" | "/mobile";
  /** The account service's computer list, when this computer is registered to an account. */
  accountComputers?: string;
}

export interface ProjectReference {
  environmentId: string;
  projectId: string;
  rootId?: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function isEnvironmentDescriptor(value: unknown): value is EnvironmentDescriptor {
  if (!value || typeof value !== "object") return false;
  const record = value as EnvironmentDescriptor;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    UUID.test(record.id) &&
    typeof record.name === "string" &&
    record.name.trim().length > 0 &&
    record.name.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(record.name) &&
    ["desktop", "hub", "project-host"].includes(record.kind) &&
    record.entryPath === (record.kind === "desktop" ? "/mobile" : "/") &&
    (record.accountComputers === undefined || isAccountComputersUrl(record.accountComputers))
  );
}

/** A bare HTTPS origin page (plain HTTP only on loopback); it never carries a credential. */
export function isAccountComputersUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Tuple encoding avoids collisions without exposing or interpreting filesystem paths. */
export function projectReferenceKey(reference: ProjectReference): string {
  for (const value of [reference.environmentId, reference.projectId, reference.rootId]) {
    if (value !== undefined && (typeof value !== "string" || !UUID.test(value)))
      throw new Error("Invalid project reference");
  }
  if (!reference.environmentId || !reference.projectId)
    throw new Error("Incomplete project reference");
  return JSON.stringify([reference.environmentId, reference.projectId, reference.rootId ?? null]);
}
