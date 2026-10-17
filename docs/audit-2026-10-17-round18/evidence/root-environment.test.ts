import { describe, expect, test } from "bun:test";
import { isEnvironmentDescriptor } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/lib/environment.ts";

const id = "11111111-1111-4111-8111-111111111111";
const descriptor = { version: 1, id, name: "Hub 工作台", kind: "hub", entryPath: "/" };

describe("ordinary discovery descriptor shape only; no identity/storage/navigation", () => {
  test("accepts the three statically documented producer shapes", () => {
    expect(isEnvironmentDescriptor({ version: 1, id, name: "我的电脑", kind: "desktop", entryPath: "/mobile" })).toBe(true);
    expect(isEnvironmentDescriptor({ version: 1, id, name: "Hub 工作台", kind: "hub", entryPath: "/" })).toBe(true);
    expect(isEnvironmentDescriptor({ version: 1, id, name: "云端项目", kind: "project-host", entryPath: "/" })).toBe(true);
  });

  test("ordinary localized display names retain their source values", () => {
    for (const name of ["My workbench", "项目 工作台", "工作台 🖥️"]) {
      const input = Object.freeze({ ...descriptor, name });
      expect(isEnvironmentDescriptor(input)).toBe(true);
      expect(input.name).toBe(name);
    }
  });

  test("checking a frozen normal descriptor does not change it", () => {
    const input = Object.freeze({ ...descriptor });
    const before = JSON.stringify(input);
    expect(isEnvironmentDescriptor(input)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("nonempty display-name length contract has ordinary boundary controls", () => {
    expect(isEnvironmentDescriptor({ ...descriptor, name: "n".repeat(128) })).toBe(true);
    expect(isEnvironmentDescriptor({ ...descriptor, name: "n".repeat(129) })).toBe(false);
    expect(isEnvironmentDescriptor({ ...descriptor, name: "" })).toBe(false);
    expect(isEnvironmentDescriptor({ ...descriptor, name: "   " })).toBe(false);
  });

  test("version and kind-to-entryPath shape are checked without any destination use", () => {
    expect(isEnvironmentDescriptor({ ...descriptor, version: 2 })).toBe(false);
    expect(isEnvironmentDescriptor({ ...descriptor, kind: "desktop" })).toBe(false);
    expect(isEnvironmentDescriptor({ ...descriptor, entryPath: "/mobile" })).toBe(false);
  });

  test("plain non-descriptor values are negative structural controls", () => {
    expect(isEnvironmentDescriptor(null)).toBe(false);
    expect(isEnvironmentDescriptor(undefined)).toBe(false);
    expect(isEnvironmentDescriptor("ordinary text")).toBe(false);
    expect(isEnvironmentDescriptor({})).toBe(false);
  });
});
