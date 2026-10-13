import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PanelToolJobService } from "../../../../packages/server/src/panels/tool-jobs.ts";

test("completed executor remains running after a real final-record EACCES", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-review-final-write-")));
  const scope = { appId: "fixture", projectPath: root, revision: "r1" };
  let finish!: (value: unknown) => void;
  let began!: () => void;
  const begun = new Promise<void>((resolve) => {
    began = resolve;
  });
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const events: unknown[] = [];
  const service = new PanelToolJobService({
    rootDir: root,
    execute: async () => {
      began();
      return done;
    },
    onEvent: (job) => events.push({ status: job.status, error: job.error, result: job.result }),
  });
  const writeErrors: string[] = [];
  const storage = (service as any).storage;
  const originalWrite = storage.write.bind(storage);
  storage.write = async (...args: unknown[]) => {
    try {
      return await originalWrite(...args);
    } catch (error) {
      writeErrors.push((error as NodeJS.ErrnoException).code ?? String(error));
      throw error;
    }
  };
  let jobDir = "";
  try {
    const job = await service.start(scope, {
      entry: { name: "fixture", sha256: "a".repeat(64) },
      input: { text: "fixture" },
      recovery: "retry",
    });
    await begun;
    jobDir = join(root, job.id);
    await chmod(jobDir, 0o500);
    finish({ output: "executor completed" });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (service as any).active.has(job.id)) await Bun.sleep(5);
    expect((service as any).active.has(job.id)).toBe(false);
    const visible = await service.get(scope, job.id);
    const disk = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    console.log(
      JSON.stringify({
        visible,
        diskStatus: disk.status,
        activeExecutors: (service as any).active.size,
        activeCount: service.activeCount(),
        writeErrors,
        events,
      }),
    );
    expect(writeErrors).toEqual(["EACCES"]);
    expect(visible.status).toBe("running");
    expect(visible.result).toBeUndefined();
    expect(visible.error).toBeUndefined();
    expect(disk.status).toBe("running");
    expect(service.activeCount()).toBe(1);
    await expect(service.retry(scope, job.id)).rejects.toThrow(
      "tool job must finish stopping before retry",
    );
    await chmod(jobDir, 0o700);
    const afterDiskRepair = await service.get(scope, job.id);
    expect(afterDiskRepair.status).toBe("running");
    const cancelled = await service.cancel(scope, job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(service.activeCount()).toBe(0);
    await service.retry(scope, job.id);
    const retryDeadline = Date.now() + 3000;
    while (Date.now() < retryDeadline && (await service.get(scope, job.id)).status !== "succeeded")
      await Bun.sleep(5);
    expect((await service.get(scope, job.id)).status).toBe("succeeded");
    console.log(
      JSON.stringify({
        recovery: {
          afterDiskRepair: afterDiskRepair.status,
          cancelled: cancelled.status,
          retry: (await service.get(scope, job.id)).status,
        },
      }),
    );
  } finally {
    if (jobDir) await chmod(jobDir, 0o700);
    finish(null);
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new Host reconciles the stale running checkpoint as interrupted", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-review-job-restart-")));
  const scope = { appId: "fixture", projectPath: root, revision: "r1" };
  let service: PanelToolJobService | undefined;
  let jobDir = "";
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./tool-job-write-crash-child.ts", import.meta.url)), root],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const checkpoint = JSON.parse(stdout.trim());
    expect(checkpoint.status).toBe("running");
    jobDir = join(root, checkpoint.id);
    await chmod(jobDir, 0o700);
    service = new PanelToolJobService({
      rootDir: root,
      execute: async () => {
        throw new Error("must not auto-reexecute");
      },
    });
    const recovered = await service.get(scope, checkpoint.id);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.error?.code).toBe("HOST_INTERRUPTED");
    expect(service.activeCount()).toBe(0);
    console.log(
      JSON.stringify({
        restartRecovery: {
          before: checkpoint.status,
          after: recovered.status,
          error: recovered.error,
          activeCount: service.activeCount(),
        },
      }),
    );
  } finally {
    if (jobDir) await chmod(jobDir, 0o700);
    await service?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
