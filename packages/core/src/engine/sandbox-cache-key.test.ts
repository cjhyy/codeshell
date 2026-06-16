/**
 * sandboxCacheKey — cache key for a resolved sandbox backend. Must include
 * EVERY field that changes the backend (mode, network, writableRoots,
 * deniedReads) + cwd. Previously the key was only `mode:cwd`, so editing
 * network (or roots/reads) in 设置页 hit the stale cached backend and didn't
 * take effect until app restart. This locks the full-fingerprint key.
 */
import { describe, test, expect } from "bun:test";
import { sandboxCacheKey } from "./sandbox-cache-key.js";
import type { SandboxConfig } from "../tool-system/sandbox/index.js";

const base: SandboxConfig = {
  mode: "auto",
  network: "allow",
  writableRoots: ["${workspace}"],
  deniedReads: ["~/.ssh"],
};

describe("sandboxCacheKey", () => {
  test("same config + cwd → same key", () => {
    expect(sandboxCacheKey(base, "/p")).toBe(sandboxCacheKey({ ...base }, "/p"));
  });

  test("changing network changes the key (the restart bug)", () => {
    expect(sandboxCacheKey(base, "/p")).not.toBe(
      sandboxCacheKey({ ...base, network: "deny" }, "/p"),
    );
  });

  test("changing mode changes the key", () => {
    expect(sandboxCacheKey(base, "/p")).not.toBe(
      sandboxCacheKey({ ...base, mode: "seatbelt" }, "/p"),
    );
  });

  test("changing writableRoots changes the key", () => {
    expect(sandboxCacheKey(base, "/p")).not.toBe(
      sandboxCacheKey({ ...base, writableRoots: ["/x"] }, "/p"),
    );
  });

  test("changing deniedReads changes the key", () => {
    expect(sandboxCacheKey(base, "/p")).not.toBe(
      sandboxCacheKey({ ...base, deniedReads: ["~/.aws"] }, "/p"),
    );
  });

  test("changing cwd changes the key", () => {
    expect(sandboxCacheKey(base, "/p")).not.toBe(sandboxCacheKey(base, "/q"));
  });
});
