import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelToolJobService,
  type PanelToolJobServiceOptions,
  type ToolJob,
  type ToolJobContext,
  type ToolJobScope,
} from "./tool-jobs.js";

const scope: ToolJobScope = { appId: "fixture", projectPath: "/fixture-workspace", revision: "r1" };
const request = {
  entry: { name: "fixture", sha256: "a".repeat(64) },
  input: { text: "中文" },
  recovery: "retry" as const,
};
async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("tool job fixture timed out");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("durable native tool jobs", () => {
  const roots: string[] = [];
  const services: PanelToolJobService[] = [];
  const gates: Array<ReturnType<typeof deferred<unknown>>> = [];
  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.resolve(null);
    for (const service of services.splice(0)) await service.shutdown();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  function service(rootDir: string, options: Partial<PanelToolJobServiceOptions> = {}) {
    const instance = new PanelToolJobService({
      rootDir,
      execute: async (job) => ({ received: job.input }),
      ...options,
    });
    services.push(instance);
    return instance;
  }
  async function fixture(options: Partial<PanelToolJobServiceOptions> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-tool-jobs-")));
    roots.push(root);
    const instance = service(root, options);
    await instance.initialize();
    return { root, service: instance };
  }
  const finished = (service: PanelToolJobService, id: string) =>
    eventually(async () => {
      const job = await service.get(scope, id);
      return ["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)
        ? job
        : undefined;
    });
  function controlled() {
    const calls: Array<{
      job: ToolJob;
      context: ToolJobContext;
      gate: ReturnType<typeof deferred<unknown>>;
    }> = [];
    const execute = async (job: ToolJob, context: ToolJobContext) => {
      const gate = deferred<unknown>();
      gates.push(gate);
      calls.push({ job, context, gate });
      return gate.promise;
    };
    return { calls, execute };
  }

  test("persists input snapshots, progress and results, and never returns a work directory", async () => {
    const events: ToolJob[] = [];
    const f = await fixture({
      prepareInput: async (_scope, input, workDir) => {
        await writeFile(join(workDir, "input.json"), JSON.stringify(input));
        return { snapshot: "input.json" };
      },
      execute: async (job, context) => {
        await context.reportProgress({ fraction: 0.5, stage: "working", message: "正在生成" });
        return {
          data: JSON.parse(
            await readFile(
              join(context.workDir, (job.input as { snapshot: string }).snapshot),
              "utf8",
            ),
          ),
        };
      },
      onEvent: (job) => {
        events.push(job);
      },
    });
    const started = await f.service.start(scope, request);
    const complete = await finished(f.service, started.id);
    expect(complete).toMatchObject({
      status: "succeeded",
      attempt: 1,
      result: { data: request.input },
      progress: { fraction: 1 },
    });
    expect(events.some((job) => job.progress?.fraction === 0.5)).toBe(true);
    expect(JSON.stringify(complete)).not.toContain(f.root);
    expect(complete).not.toHaveProperty("workDir");
    await f.service.shutdown();
    const reopened = service(f.root);
    expect(await reopened.get(scope, started.id)).toEqual(complete);
    expect((await reopened.list(scope)).map((job) => job.id)).toEqual([started.id]);
  });

  test("queues at most two executors and cancellation waits for the actual executor exit", async () => {
    const c = controlled();
    const f = await fixture({ execute: c.execute });
    const jobs = await Promise.all(
      [0, 1, 2].map((index) => f.service.start(scope, { ...request, input: { index } })),
    );
    await eventually(async () => (c.calls.length === 2 ? true : undefined));
    const queued = (await f.service.list(scope)).find((job) => job.status === "queued")!;
    expect((await f.service.cancel(scope, queued.id)).status).toBe("cancelled");
    expect(c.calls).toHaveLength(2);
    const active = c.calls[0]!;
    let returned = false;
    const cancel = f.service.cancel(scope, active.job.id).then((job) => {
      returned = true;
      return job;
    });
    await eventually(async () => (active.context.signal.aborted ? true : undefined));
    expect((await f.service.get(scope, active.job.id)).status).toBe("cancelling");
    expect(returned).toBe(false);
    active.gate.resolve({ ignoredAfterCancel: true });
    expect((await cancel).status).toBe("cancelled");
    expect(await f.service.get(scope, active.job.id)).not.toHaveProperty("result");
    c.calls[1]!.gate.resolve(null);
    await finished(f.service, c.calls[1]!.job.id);
    expect(jobs).toHaveLength(3);
  });

  test("shutdown awaits executors and reopens as interrupted without rerunning", async () => {
    const c = controlled();
    const f = await fixture({ execute: c.execute });
    const started = await f.service.start(scope, request);
    await eventually(async () => (c.calls.length ? true : undefined));
    let closed = false;
    const shutdown = f.service.shutdown().then(() => {
      closed = true;
    });
    await eventually(async () => (c.calls[0]!.context.signal.aborted ? true : undefined));
    expect(closed).toBe(false);
    c.calls[0]!.gate.resolve(null);
    await shutdown;
    let reruns = 0;
    const reopened = service(f.root, {
      execute: async () => {
        reruns++;
        return null;
      },
    });
    const interrupted = await reopened.get(scope, started.id);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      error: { code: "HOST_INTERRUPTED", retryable: true },
    });
    expect(reruns).toBe(0);
    await reopened.retry(scope, started.id);
    expect(await finished(reopened, started.id)).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(reruns).toBe(1);
  });

  test("abandoned running records become interrupted; old revisions are read-only", async () => {
    const f = await fixture();
    const started = await f.service.start(scope, request);
    await finished(f.service, started.id);
    await f.service.shutdown();
    const file = join(f.root, started.id, "job.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.status = "running";
    delete record.result;
    delete record.completedAt;
    await writeFile(file, JSON.stringify(record));
    let calls = 0;
    const reopened = service(f.root, {
      execute: async () => {
        calls++;
        return null;
      },
    });
    const nextScope = { ...scope, revision: "r2" };
    expect(await reopened.get(nextScope, started.id)).toMatchObject({
      status: "interrupted",
      readOnly: true,
    });
    expect((await reopened.list(nextScope))[0]!.readOnly).toBe(true);
    await expect(reopened.retry(nextScope, started.id)).rejects.toThrow(/read-only/);
    await expect(reopened.cancel(nextScope, started.id)).rejects.toThrow(/read-only/);
    await expect(reopened.get({ ...scope, projectPath: "/other" }, started.id)).rejects.toThrow(
      /does not belong/,
    );
    expect(calls).toBe(0);
  });

  test("manual and explicitly non-retryable failures require a new request", async () => {
    const f = await fixture({
      execute: async () => {
        throw Object.assign(new Error("do not repeat"), {
          code: "BILLING_FAILED",
          retryable: false,
        });
      },
    });
    const first = await f.service.start(scope, request);
    expect(await finished(f.service, first.id)).toMatchObject({
      status: "failed",
      error: { code: "BILLING_FAILED", retryable: false },
    });
    await expect(f.service.retry(scope, first.id)).rejects.toThrow(/manually reviewed/);
    const second = await f.service.start(scope, { ...request, recovery: "manual" });
    await finished(f.service, second.id);
    await expect(f.service.retry(scope, second.id)).rejects.toThrow(/manually reviewed/);
  });

  test("request keys deduplicate committed tasks and reject changed inputs", async () => {
    let calls = 0;
    const f = await fixture({
      execute: async () => {
        calls++;
        return null;
      },
    });
    const first = await f.service.start(scope, { ...request, requestKey: "once" });
    await finished(f.service, first.id);
    expect((await f.service.start(scope, { ...request, requestKey: "once" })).id).toBe(first.id);
    await expect(
      f.service.start(scope, { ...request, input: { changed: true }, requestKey: "once" }),
    ).rejects.toThrow(/different input/);
    expect(calls).toBe(1);
  });

  test("revocation stops native work, denies new reads, and disables retry", async () => {
    let allowed = true;
    const c = controlled();
    const f = await fixture({ execute: c.execute, isAuthorized: () => allowed });
    const job = await f.service.start(scope, request);
    await eventually(async () => (c.calls.length ? true : undefined));
    allowed = false;
    const revoke = f.service.cancelApp(scope.appId);
    await eventually(async () => (c.calls[0]!.context.signal.aborted ? true : undefined));
    await expect(f.service.get(scope, job.id)).rejects.toThrow(/no longer authorized/);
    c.calls[0]!.gate.resolve(null);
    await revoke;
    allowed = true;
    expect(await f.service.get(scope, job.id)).toMatchObject({
      status: "cancelled",
      error: { code: "APP_REVOKED", retryable: false },
    });
    await expect(f.service.retry(scope, job.id)).rejects.toThrow(/manually reviewed/);
  });

  test("one Host owns a store, and interrupted input preparation cannot enter the queue", async () => {
    const preparing = deferred<void>();
    let signal: AbortSignal | undefined;
    let executions = 0;
    const f = await fixture({
      prepareInput: async (_scope, input, _directory, suppliedSignal) => {
        signal = suppliedSignal;
        await preparing.promise;
        return input;
      },
      execute: async () => {
        executions++;
        return null;
      },
    });
    const second = new PanelToolJobService({ rootDir: f.root, execute: async () => null });
    await expect(second.initialize()).rejects.toThrow(/already owned/);
    const pending = f.service.start(scope, request);
    await eventually(async () => (signal ? true : undefined));
    const shutdown = f.service.shutdown();
    await eventually(async () => (signal!.aborted ? true : undefined));
    preparing.resolve();
    await expect(pending).rejects.toThrow(/interrupted/);
    await shutdown;
    expect(executions).toBe(0);
    const reopened = service(f.root);
    expect(await reopened.list(scope)).toEqual([]);
  });
});
