import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaJobService } from "./media-jobs.js";
import { mediaScopeKey } from "./media-storage.js";
import type { MediaJob, MediaJobContext } from "./media-types.js";

const scope = { appId: "video-studio", projectPath: "/workspace/project-a" };
let directory: string;
const services: MediaJobService[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codeshell-media-jobs-"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await rm(directory, { recursive: true, force: true });
});
function service(
  extra: ConstructorParameters<typeof MediaJobService>[0] = { rootDirectory: directory },
): MediaJobService {
  const value = new MediaJobService({ ...extra, rootDirectory: directory });
  services.push(value);
  return value;
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for media job");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function terminal(jobs: MediaJobService, id: string): Promise<MediaJob> {
  await eventually(async () =>
    ["succeeded", "failed", "cancelled"].includes((await jobs.get(scope, id)).status),
  );
  return jobs.get(scope, id);
}
async function untilAbort(context: MediaJobContext): Promise<void> {
  if (context.signal.aborted) return;
  await new Promise<void>((resolve) =>
    context.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

describe("persistent media job service", () => {
  test("app revocation cancels running and queued work across projects without a live guest", async () => {
    const jobs = service({ rootDirectory: directory, concurrency: 1 });
    jobs.registerProcessor("long", {
      run: async (_input, context) => {
        await untilAbort(context);
        return {};
      },
    });
    const secondScope = { ...scope, projectPath: "/workspace/project-b" };
    const otherScope = { ...scope, appId: "other-app" };
    const first = await jobs.start(scope, { type: "long", input: {} });
    const second = await jobs.start(secondScope, { type: "long", input: {} });
    const other = await jobs.start(otherScope, { type: "long", input: {} });
    await eventually(async () => (await jobs.get(scope, first.id)).status === "running");
    await jobs.cancelApp(scope.appId);
    expect((await jobs.get(scope, first.id)).status).toBe("cancelled");
    expect((await jobs.get(secondScope, second.id)).status).toBe("cancelled");
    expect((await jobs.get(otherScope, other.id)).status).not.toBe("cancelled");
    await jobs.cancel(otherScope, other.id);
  });

  test("persists progress/result, detaches inputs and survives observer teardown", async () => {
    const jobs = service({
      rootDirectory: directory,
      onChanged: () => {
        throw new Error("guest destroyed");
      },
    });
    jobs.registerProcessor("inspect", {
      run: async (input, context) => {
        await context.reportProgress({ fraction: 0.4, stage: "probe", message: "Reading source" });
        await writeFile(join(context.outputDir, "proof.txt"), "artifact");
        return { input, artifact: "asset-reference" };
      },
    });
    const input = { id: "source" };
    const job = await jobs.start(scope, { type: "inspect", input });
    input.id = "changed";
    const done = await terminal(jobs, job.id);
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(1);
    expect(done.result).toEqual({ input: { id: "source" }, artifact: "asset-reference" });
    expect(done.progress).toEqual({ fraction: 1, stage: "probe", message: "Reading source" });
    expect(Object.keys(done)).not.toContain("scope");
    expect(Object.keys(done)).not.toContain("input");
    await jobs.shutdown();
    const restored = service();
    await restored.initialize();
    expect(await restored.get(scope, job.id)).toEqual(done);
  });

  test("deduplicates concurrent start keys and forbids scope/key confusion", async () => {
    const jobs = service();
    jobs.registerProcessor("inspect", { run: async () => ({ ok: true }) });
    const [left, right] = await Promise.all([
      jobs.start(scope, { type: "inspect", input: { asset: "a" }, idempotencyKey: "same" }),
      jobs.start(scope, { type: "inspect", input: { asset: "a" }, idempotencyKey: "same" }),
    ]);
    expect(left.id).toBe(right.id);
    await expect(
      jobs.start(scope, { type: "inspect", input: { asset: "b" }, idempotencyKey: "same" }),
    ).rejects.toThrow("different");
    await expect(jobs.get({ ...scope, appId: "another-app" }, left.id)).rejects.toThrow(
      "not found",
    );
    await expect(
      jobs.cancel({ ...scope, projectPath: "/workspace/project-b" }, left.id),
    ).rejects.toThrow("not found");
    expect(await jobs.list({ ...scope, projectPath: "/workspace/project-b" })).toEqual([]);
  });

  test("active idempotency deduplicates pending work but re-enters processors after completion", async () => {
    const jobs = service();
    const release = deferred();
    let processorVersion = 1;
    let runs = 0;
    jobs.registerProcessor("prepare", {
      run: async () => {
        runs++;
        await release.promise;
        return { processorVersion };
      },
    });
    const input = {
      type: "prepare",
      input: { asset: "immutable" },
      idempotencyKey: "prepare-asset",
      idempotencyPolicy: "active" as const,
    };
    const [first, duplicate] = await Promise.all([
      jobs.start(scope, input),
      jobs.start(scope, input),
    ]);
    expect(first.id).toBe(duplicate.id);
    release.resolve();
    expect((await terminal(jobs, first.id)).result).toEqual({ processorVersion: 1 });
    processorVersion = 2;
    const refreshed = await jobs.start(scope, input);
    expect(refreshed.id).not.toBe(first.id);
    expect((await terminal(jobs, refreshed.id)).result).toEqual({ processorVersion: 2 });
    expect(runs).toBe(2);
  });

  test("bounds concurrency, cancels queued work without running it and ignores late completed output", async () => {
    const jobs = service({ rootDirectory: directory, concurrency: 1 });
    const release = deferred<unknown>();
    const started = deferred();
    let runs = 0;
    jobs.registerProcessor("render", {
      run: async () => {
        runs++;
        started.resolve();
        return release.promise;
      },
    });
    const first = await jobs.start(scope, { type: "render", input: {} });
    await started.promise;
    const queued = await jobs.start(scope, { type: "render", input: {} });
    expect((await jobs.get(scope, queued.id)).status).toBe("queued");
    expect((await jobs.cancel(scope, queued.id)).status).toBe("cancelled");
    expect((await jobs.cancel(scope, first.id)).status).toBe("cancelled");
    await expect(jobs.retry(scope, first.id)).rejects.toThrow("still stopping");
    release.resolve({ mustNotPublish: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const final = await jobs.get(scope, first.id);
    expect(final.status).toBe("cancelled");
    expect(final.result).toBeUndefined();
    expect(runs).toBe(1);
  });

  test("explicit retry creates a new attempt and keeps prior attempt evidence", async () => {
    const jobs = service();
    const contexts: MediaJobContext[] = [];
    jobs.registerProcessor("render", {
      run: async (_input, context) => {
        contexts.push(context);
        await writeFile(join(context.workDir, "proof.txt"), String(context.attempt));
        if (context.attempt === 1) throw new Error("codec failed");
        return { ok: true };
      },
    });
    const job = await jobs.start(scope, { type: "render", input: {} });
    expect((await terminal(jobs, job.id)).error?.message).toBe("codec failed");
    await eventually(async () => {
      try {
        await jobs.retry(scope, job.id);
        return true;
      } catch (error) {
        if (String(error).includes("still stopping")) return false;
        throw error;
      }
    });
    const done = await terminal(jobs, job.id);
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(2);
    expect(contexts[0].outputDir).not.toBe(contexts[1].outputDir);
    expect(contexts[0].cacheDir).toBe(contexts[1].cacheDir);
    expect(await readFile(join(contexts[0].workDir, "proof.txt"), "utf8")).toBe("1");
  });

  test("bounds progress and result payloads instead of producing oversized job responses", async () => {
    const jobs = service();
    jobs.registerProcessor("inspect", {
      run: async (_input, context) => {
        await context.reportProgress({ fraction: 0.5, message: "x".repeat(1001) });
        return null;
      },
    });
    const progress = await jobs.start(scope, { type: "inspect", input: {} });
    expect((await terminal(jobs, progress.id)).error?.message).toContain("progress message");
    jobs.registerProcessor("render", { run: async () => ({ text: "x".repeat(200 * 1024) }) });
    const output = await jobs.start(scope, { type: "render", input: {} });
    const failed = await terminal(jobs, output.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("budget");
    expect(failed.result).toBeUndefined();
  });

  test("Host restart fails interrupted non-idempotent work but resumes never-started queued jobs", async () => {
    const first = service({ rootDirectory: directory, concurrency: 1 });
    const began = deferred();
    first.registerProcessor("render", {
      run: async (_input, context) => {
        began.resolve();
        await untilAbort(context);
        return null;
      },
    });
    const running = await first.start(scope, { type: "render", input: { which: "running" } });
    await began.promise;
    const queued = await first.start(scope, { type: "render", input: { which: "queued" } });
    await first.shutdown();
    let runs = 0;
    const second = service();
    second.registerProcessor("render", {
      run: async (input) => {
        runs++;
        return input;
      },
    });
    await second.initialize();
    const interrupted = await second.get(scope, running.id);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.error?.code).toBe("INTERRUPTED");
    expect((await terminal(second, queued.id)).status).toBe("succeeded");
    expect(runs).toBe(1);
  });

  test("only an explicit idempotent recovery declaration restarts running work", async () => {
    const first = service();
    const began = deferred();
    first.registerProcessor("proxy", {
      recovery: "restart",
      run: async (_input, context) => {
        began.resolve();
        await untilAbort(context);
        return null;
      },
    });
    const job = await first.start(scope, { type: "proxy", input: { asset: "a" } });
    await began.promise;
    await first.shutdown();
    const second = service();
    second.registerProcessor("proxy", {
      recovery: "restart",
      run: async (_input, context) => ({ attempt: context.attempt }),
    });
    await second.initialize();
    const done = await terminal(second, job.id);
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(2);
    expect(done.result).toEqual({ attempt: 2 });
  });

  test("preserves corrupt job files and reports recovery issues instead of executing them", async () => {
    const first = service();
    first.registerProcessor("inspect", { run: async () => null });
    const job = await first.start(scope, { type: "inspect", input: {} });
    await terminal(first, job.id);
    await first.shutdown();
    const path = join(directory, "scopes", mediaScopeKey(scope), "jobs", job.id, "job.json");
    await writeFile(path, "malformed original");
    const second = service();
    await second.initialize();
    expect(second.getRecoveryIssues()).toHaveLength(1);
    expect(await second.list(scope)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("malformed original");
  });
});
