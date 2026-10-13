import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const originalFetch = globalThis.fetch;
let allowedOrigin: string | undefined;
globalThis.fetch = ((input: any, init: any) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!allowedOrigin || url.origin !== allowedOrigin)
    throw Error("Review exact-origin network guard");
  return originalFetch(input, init);
}) as any;

test("review reproduction: failed duplicate Hub startup deletes the first live server upload", async () => {
  const { startHeadlessServer } =
    await import("../../../../packages/server/src/serve/headless-server.ts");
  const root = mkdtempSync(join(tmpdir(), "codeshell-review-double-start-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const dataDir = join(root, "state");
  const workerEntryPath = join(root, "worker.cjs");
  writeFileSync(workerEntryPath, "process.stdin.resume();");
  const options = {
    cwd,
    dataDir,
    workerEntryPath,
    authMode: "hub" as const,
    host: "127.0.0.1",
    port: 0,
  };
  let server: Awaited<ReturnType<typeof startHeadlessServer>> | undefined;
  try {
    server = await startHeadlessServer(options);
    allowedOrigin = server.url;
    const setup = await fetch(server.url + "/api/v1/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({
        token: server.bootstrapToken,
        username: "admin",
        password: "review-test-password",
        deviceName: "fixture",
      }),
    });
    expect(setup.status).toBe(200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const upload = await fetch(server.url + "/api/v1/uploads/review-upload-1", {
      method: "PUT",
      headers: {
        cookie,
        origin: server.url,
        "content-type": "text/plain",
        "x-file-name": "review.txt",
      },
      body: "hello",
    });
    expect(upload.status).toBe(201);
    expect(readdirSync(join(dataDir, "uploads"))).toHaveLength(1);
    await expect(startHeadlessServer({ ...options, port: server.port })).rejects.toThrow();
    expect(readdirSync(join(dataDir, "uploads"))).toHaveLength(0);
    expect((await fetch(server.url + "/health")).status).toBe(200);
    console.info(
      "Confirmed: duplicate launch fails on the occupied port but deletes the healthy original server pending upload.",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
