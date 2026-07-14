import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireGatewayInstanceLock, GatewayAlreadyRunningError } from "./instance-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gateway instance lock", () => {
  test("allows exactly one live CLI/Desktop owner and releases only its own token", () => {
    const path = lockPath();
    const first = acquireGatewayInstanceLock(path, "first");
    expect(() => acquireGatewayInstanceLock(path, "second")).toThrow(GatewayAlreadyRunningError);
    expect(JSON.parse(readFileSync(path, "utf-8")).owner).toBe("first");
    first.release();

    const second = acquireGatewayInstanceLock(path, "second");
    expect(JSON.parse(readFileSync(path, "utf-8")).owner).toBe("second");
    second.release();
  });

  test("reclaims a well-formed stale process lock but fails closed on corrupt state", () => {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        owner: "dead",
        token: "dead-token",
        startedAt: 1,
      }),
    );
    const lease = acquireGatewayInstanceLock(path, "replacement");
    lease.release();

    writeFileSync(path, "not-json");
    expect(() => acquireGatewayInstanceLock(path, "unsafe-replacement")).toThrow(
      GatewayAlreadyRunningError,
    );
  });
});

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-gateway-lock-"));
  roots.push(root);
  return join(root, "state", "gateway.lock");
}
