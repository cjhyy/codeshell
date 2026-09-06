import { describe, expect, test } from "bun:test";
import {
  isTenantId,
  tenantContainerId,
  tenantProfileId,
  tenantUserDataDir,
} from "./tenant-profile";

describe("tenant isolation", () => {
  test("different tenants never share a container", () => {
    // The hard boundary: one tenant's cookies must be physically unreachable
    // from another's, so isolation cannot depend on in-process bookkeeping.
    expect(tenantContainerId("acme")).not.toBe(tenantContainerId("globex"));
  });

  test("a tenant's projects share one container but not one profile", () => {
    // The decision: per-tenant container (security), per-project profile inside
    // it (matches the desktop's shared-auth semantics).
    expect(tenantContainerId("acme")).toBe(tenantContainerId("acme"));
    expect(tenantProfileId("acme", "proj-1")).not.toBe(tenantProfileId("acme", "proj-2"));
  });

  test("the same project in the same tenant is stable across calls", () => {
    expect(tenantProfileId("acme", "proj-1")).toBe(tenantProfileId("acme", "proj-1"));
  });

  test("a project id cannot collide across tenants", () => {
    // Two tenants using the same project name must stay apart.
    expect(tenantProfileId("acme", "shared-name")).not.toBe(
      tenantProfileId("globex", "shared-name"),
    );
  });
});

describe("user-data directory", () => {
  test("lives under a per-tenant directory inside the root", () => {
    // The id uses ":" for readability but a path segment cannot, so the
    // directory carries the tenant separately rather than embedding the id.
    const dir = tenantUserDataDir("/srv/browsers", "acme", "proj-1");
    expect(dir.startsWith("/srv/browsers/")).toBe(true);
    expect(dir).toContain("acme");
    expect(dir).toContain("proj-1");
  });

  test("two tenants never resolve to the same directory", () => {
    expect(tenantUserDataDir("/srv/browsers", "acme", "p")).not.toBe(
      tenantUserDataDir("/srv/browsers", "globex", "p"),
    );
  });

  test("a crafted tenant or project id cannot escape the root", () => {
    // Path traversal here would let one tenant read another's cookies, so ids
    // are validated rather than sanitized into something surprising.
    expect(() => tenantUserDataDir("/srv/browsers", "../../etc", "p")).toThrow();
    expect(() => tenantUserDataDir("/srv/browsers", "acme", "../../../etc")).toThrow();
    expect(() => tenantUserDataDir("/srv/browsers", "acme/x", "p")).toThrow();
  });
});

describe("tenant id validation", () => {
  test("accepts ordinary ids and rejects unusable ones", () => {
    expect(isTenantId("acme")).toBe(true);
    expect(isTenantId("acme-corp_1")).toBe(true);
    expect(isTenantId("")).toBe(false);
    expect(isTenantId("..")).toBe(false);
    expect(isTenantId("a/b")).toBe(false);
    expect(isTenantId(" acme")).toBe(false);
    expect(isTenantId("a".repeat(200))).toBe(false);
    expect(isTenantId(42)).toBe(false);
  });
});
