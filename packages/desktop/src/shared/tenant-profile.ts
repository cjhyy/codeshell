/**
 * Server-side browser identity: one container per tenant, one profile per
 * project inside it.
 *
 * The split is deliberate and matches the desktop's semantics one level down:
 *
 * - Between TENANTS the boundary must be physical. Their cookies live in
 *   separate containers with separate user-data dirs, so isolation does not
 *   depend on in-process bookkeeping that a bug could get wrong.
 * - Inside a tenant, projects behave like the desktop: each project gets its
 *   own profile, so a login done in one Session is available to the next
 *   (shared-auth) without leaking across projects.
 *
 * See docs/todo/browser-profile-workspace-lease-design.md §7.
 */

import { join, resolve } from "node:path";

const MAX_ID_LENGTH = 128;

/**
 * A usable tenant/project id. Strict on purpose: these become path segments,
 * so anything that could traverse out of the root — or collide with another
 * tenant's directory — is refused rather than quietly rewritten.
 */
export function isTenantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertId(kind: "tenant" | "project", value: string): void {
  if (!isTenantId(value)) throw new Error(`invalid ${kind} id`);
}

/** The container holding everything for one tenant. */
export function tenantContainerId(tenantId: string): string {
  assertId("tenant", tenantId);
  return `t:${tenantId}`;
}

/** The profile for one project inside a tenant's container. */
export function tenantProfileId(tenantId: string, projectId: string): string {
  assertId("tenant", tenantId);
  assertId("project", projectId);
  // Tenant first so two tenants sharing a project name never collide.
  return `t:${tenantId}/p:${projectId}`;
}

/**
 * On-disk user-data dir for one tenant's project profile.
 *
 * Validated ids plus a final containment check: a traversal here would let one
 * tenant read another's cookies, which is the exact failure this layering
 * exists to prevent.
 */
export function tenantUserDataDir(root: string, tenantId: string, projectId: string): string {
  assertId("tenant", tenantId);
  assertId("project", projectId);
  const base = resolve(root);
  const dir = resolve(join(base, `t-${tenantId}`, `p-${projectId}`));
  // Defence in depth: even with validated ids, never return a path outside root.
  if (dir !== base && !dir.startsWith(`${base}/`)) {
    throw new Error("resolved browser profile dir escapes its root");
  }
  return dir;
}
