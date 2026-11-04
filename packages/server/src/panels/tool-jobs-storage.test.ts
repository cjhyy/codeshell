import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanelToolJobService } from "./tool-jobs.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a delayed stale-lock reclaimer cannot remove a new owner or execute its request", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-lock-race-"));
  const retired = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(retired.status).toBe(0);
  await writeFile(
    join(root, "owner.lock"),
    JSON.stringify({ pid: retired.pid, nonce: "retired-owner" }),
  );
  const oldNonce = "00000000-0000-0000-0000-000000000001";
  await mkdir(join(root, "owner.claim"));
  await writeFile(
    join(root, "owner.claim", `${oldNonce}.json`),
    JSON.stringify({ pid: retired.pid, nonce: "retired-owner" }),
  );
  const executions: string[] = [];
  const services = ["a", "b"].map(
    (name) =>
      new PanelToolJobService({
        rootDir: root,
        execute: async () => {
          executions.push(name);
          return { name };
        },
      }),
  );
  const gates = [deferred(), deferred()];
  let snapshotsRead = 0;
  services.forEach((service, i) => {
    const storage = (service as any).storage;
    const read = storage.read.bind(storage);
    storage.read = async (path: string, limit: number) => {
      const value = await read(path, limit);
      if (path.endsWith(`${oldNonce}.json`) && value.nonce === "retired-owner") {
        snapshotsRead++;
        await gates[i]!.promise;
      }
      return value;
    };
  });
  const pending = services.map((s) =>
    s.initialize().then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    ),
  );
  try {
    await until(() => snapshotsRead === 2);
    gates[0]!.resolve();
    expect((await pending[0]).ok).toBe(true);
    const firstOwner = JSON.parse(await readFile(join(root, "owner.lock"), "utf8"));
    gates[1]!.resolve();
    expect((await pending[1]).ok).toBe(false);
    const secondOwner = JSON.parse(await readFile(join(root, "owner.lock"), "utf8"));
    const scope = { appId: "fixture", projectPath: root, revision: "r1" };
    const request = {
      entry: { name: "fixture", sha256: "a".repeat(64) },
      input: {},
      recovery: "retry" as const,
      requestKey: "one-user-intent",
    };
    await services[0]!.start(scope, request);
    await until(() => executions.length === 1);
    expect(firstOwner.nonce).toBe(secondOwner.nonce);
    expect(executions).toEqual(["a"]);
  } finally {
    gates.forEach((g) => g.resolve());
    await Promise.allSettled(pending);
    await Promise.allSettled(services.map((service) => service.shutdown()));
    await rm(root, { recursive: true, force: true });
  }
});
