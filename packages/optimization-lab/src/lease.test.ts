import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ExperimentLease } from "./lease.js";
import { fixture } from "./test-fixtures/foundation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const f = fixture();
  roots.push(f.root);
  return f;
}

test("live lease cannot be taken; takeover fences late writes and heartbeats", () => {
  const f = setup();
  const other = new ExperimentLease(f.store, { owner: "other", now: f.now });
  expect(() => other.acquire(f.id)).toThrow("live owner");
  const lease = f.lease.heartbeat(f.id, f.fence);
  f.advance(lease.expiresAt - f.now() + 1);
  const fence = other.acquire(f.id);
  expect(fence.generation).toBe(f.fence.generation + 1);
  expect(() => f.lease.heartbeat(f.id, f.fence)).toThrow("lost");
  expect(() => f.store.mutate(f.id, { fence: f.fence, now: f.now() }, () => {})).toThrow("lost");
  expect(() => f.lease.release(f.id, f.fence)).toThrow("lost");
  other.release(f.id, fence);
  expect(f.lease.acquire(f.id).generation).toBe(fence.generation + 1);
});

test("two real processes competing for start yield exactly one live owner", async () => {
  const f = setup();
  f.lease.release(f.id, f.fence);
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const leaseUrl = new URL("./lease.ts", import.meta.url).href;
  const code = `import { ExperimentStore } from ${JSON.stringify(storeUrl)}; import { ExperimentLease } from ${JSON.stringify(leaseUrl)}; const lease=new ExperimentLease(new ExperimentStore(process.argv[1]),{ttlMs:5000}); try { const fence=lease.acquire(process.argv[2]); console.log('owner'); await new Promise(r=>setTimeout(r,400)); lease.release(process.argv[2],fence); } catch(e) { console.log('busy'); }`;
  const processes = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "-e", code, f.root, f.id], { stdout: "pipe", stderr: "pipe" }),
  );
  const outputs = await Promise.all(
    processes.map(async (process) => {
      const output = await new Response(process.stdout).text();
      const code = await process.exited;
      expect(code).toBe(0);
      return output.trim();
    }),
  );
  expect(outputs.filter((value) => value === "owner")).toHaveLength(1);
  expect(outputs.filter((value) => value === "busy")).toHaveLength(3);
}, 10000);
