import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelAppProcessService,
  processLimits,
  type PanelProcessOwner,
} from "./process-service.js";

async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("process protocol fixture timed out");
}

describe("Panel process protocol", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture(
    source = 'console.log("你好");',
    options: Partial<ConstructorParameters<typeof PanelAppProcessService>[0]> = {},
  ) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-process-protocol-")));
    const path = join(root, "entry.mjs");
    await writeFile(path, source);
    await symlink(process.execPath, join(root, "runtime"));
    const sha256 = createHash("sha256").update(source).digest("hex");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const owner: PanelProcessOwner = {
      guestId: 1,
      appId: "fixture",
      appTitle: "Fixture",
      revision: "r1",
      send: (event, payload) => {
        events.push({ event, payload });
      },
    };
    const service = new PanelAppProcessService({
      env: { PATH: root },
      confirmExecution: async () => true,
      resolvePackageEntry: async (_owner, name) => {
        if (name !== "fixture") throw new Error("undeclared entry");
        return { path, sha256 };
      },
      ...options,
    });
    cleanups.push(async () => {
      service.close();
      await rm(root, { recursive: true, force: true });
    });
    const executable = await service.findExecutable(owner, { name: "runtime" });
    const directory = await service.grantDirectory(owner, root);
    const entry = await service.resolveEntry(owner, {
      name: "fixture",
      executableHandle: executable.handle,
    });
    const params = {
      executableHandle: executable.handle,
      directoryHandle: directory.handle,
      entryHandle: entry.handle,
      args: [] as string[],
    };
    const exit = async (processId: string) =>
      eventually(async () => {
        const status = await service.get(owner, { processId });
        return status.found && status.status === "exited" ? status : undefined;
      });
    return { root, path, service, owner, events, params, entry, exit };
  }

  test("recovers missed output and exit with paginated sequence cursors and TTL", async () => {
    let now = 1_000;
    const f = await fixture('console.log("你好"); setTimeout(()=>console.error("done"), 20);', {
      now: () => now,
    });
    f.owner.send = () => {
      throw new Error("transport disconnected");
    };
    const { processId } = await f.service.start(f.owner, f.params);
    const status = await f.exit(processId);
    expect(status.code).toBe(0);
    expect(status.cancelRequested).toBe(false);
    expect(status.expiresAt).toBe(now + processLimits.receiptTtlMs);
    const first = await f.service.get(f.owner, { processId, limit: 1 });
    expect(first.found && first.events[0]!.payload.text).toBe("你好\n");
    if (!first.found) throw new Error("receipt missing");
    expect(first.hasMore).toBe(true);
    const rest = await f.service.get(f.owner, { processId, afterSequence: first.nextSequence });
    expect(rest.found && rest.events.at(-1)!.event).toBe("process.exit");
    expect(rest.found && rest.truncated).toBe(false);
    now += processLimits.receiptTtlMs;
    expect(await f.service.get(f.owner, { processId })).toEqual({ found: false, processId });
  });

  test("cancel acknowledges a request; terminal state waits for the actual child close", async () => {
    const f = await fixture(
      'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),200)); console.log("ready"); setInterval(()=>{},1000);',
    );
    const { processId } = await f.service.start(f.owner, f.params);
    await eventually(async () =>
      f.events.some((item) => item.payload.text === "ready\n") ? true : undefined,
    );
    expect(f.service.cancel(f.owner, { processId })).toEqual({ cancelled: true });
    const stopping = await f.service.get(f.owner, { processId });
    expect(stopping).toMatchObject({ status: "stopping", cancelRequested: true });
    expect("exitedAt" in stopping).toBe(false);
    const exited = await f.exit(processId);
    expect(exited.cancelRequested).toBe(true);
    expect(exited.events.at(-1)!.event).toBe("process.exit");
    expect(f.service.cancel(f.owner, { processId })).toEqual({ cancelled: false });
  });

  test("receipts, cancellation and entry grants stay with the exact guest/app/revision", async () => {
    const f = await fixture();
    const { processId } = await f.service.start(f.owner, f.params);
    await f.exit(processId);
    for (const other of [{ guestId: 2 }, { appId: "other" }, { revision: "r2" }]) {
      const owner = { ...f.owner, ...other };
      expect(await f.service.get(owner, { processId })).toEqual({ found: false, processId });
      expect(f.service.cancel(owner, { processId })).toEqual({ cancelled: false });
      await expect(f.service.start(owner, f.params)).rejects.toThrow(/invalid or belongs/);
    }
    f.service.revokeGuest(1);
    expect(await f.service.get(f.owner, { processId })).toEqual({ found: false, processId });
    await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/invalid or belongs/);
  });

  test("entry runs before sealed options and positional arguments without exposing its path", async () => {
    const f = await fixture("console.log(JSON.stringify(process.argv.slice(2)));");
    const dataPath = join(f.root, "input.txt");
    await writeFile(dataPath, "input");
    const file = await f.service.grantFileArgument(f.owner, {
      executableHandle: f.params.executableHandle,
      argumentName: "--input",
      path: dataPath,
    });
    expect(Object.keys(f.entry).sort()).toEqual(["handle", "name", "sha256"]);
    const { processId } = await f.service.start(f.owner, {
      ...f.params,
      fileArgumentHandles: [file.handle],
      args: ["中文"],
    });
    const status = await f.exit(processId);
    const output = status.events
      .filter((event) => event.event === "process.output")
      .map((event) => event.payload.text)
      .join("");
    expect(JSON.parse(output)).toEqual(["--input", dataPath, "中文"]);
    const other = await f.service.findExecutable(f.owner, { name: "runtime" });
    await expect(
      f.service.start(f.owner, { ...f.params, executableHandle: other.handle }),
    ).rejects.toThrow(/different executable/);
  });

  test("rejects modified or symlink-replaced entries, including changes during approval", async () => {
    for (const change of ["contents", "link", "approval"] as const) {
      let mutate = async () => {};
      const f = await fixture('console.log("reviewed");', {
        confirmExecution: async () => {
          if (change === "approval") await mutate();
          return true;
        },
      });
      mutate = async () => {
        await writeFile(f.path, 'console.log("unreviewed");');
      };
      if (change === "contents") await mutate();
      if (change === "link") {
        await rename(f.path, join(f.root, "other.mjs"));
        await symlink(join(f.root, "other.mjs"), f.path);
      }
      await expect(f.service.start(f.owner, f.params)).rejects.toThrow(/package entry/);
      expect(f.events).toHaveLength(0);
    }
  });

  test("writes ordered UTF-8 input with bounded chunks and explicit EOF", async () => {
    const f = await fixture(
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(s));',
    );
    const { processId } = await f.service.start(f.owner, { ...f.params, stdin: "pipe" });
    const writes = await Promise.all([
      f.service.write(f.owner, { processId, text: "你好" }),
      f.service.write(f.owner, { processId, text: "世界" }),
    ]);
    expect(writes.map((item) => item.totalBytes)).toEqual([6, 12]);
    await expect(f.service.write(f.owner, { processId, text: "中".repeat(6_000) })).rejects.toThrow(
      /chunk/,
    );
    await expect(
      f.service.write({ ...f.owner, guestId: 2 }, { processId, text: "bad" }),
    ).rejects.toThrow(/unavailable or belongs/);
    expect(await f.service.end(f.owner, { processId })).toEqual({ ended: true, totalBytes: 12 });
    await expect(f.service.write(f.owner, { processId, text: "late" })).rejects.toThrow(
      /ended|unavailable/,
    );
    const status = await f.exit(processId);
    expect(status.events.find((event) => event.event === "process.output")!.payload.text).toBe(
      "你好世界\n",
    );
  });

  test("stdin defaults to ignored and queued writes are bounded before buffering", async () => {
    const f = await fixture("process.stdin.resume(); setTimeout(()=>{},1000);");
    const ignored = await f.service.start(f.owner, f.params);
    await expect(
      f.service.write(f.owner, { processId: ignored.processId, text: "x" }),
    ).rejects.toThrow(/unavailable/);
    f.service.cancel(f.owner, ignored);
    const piped = await f.service.start(f.owner, { ...f.params, stdin: "pipe" });
    const attempts = Array.from({ length: processLimits.maxStdinPendingWrites + 1 }, () =>
      f.service.write(f.owner, { processId: piped.processId, text: "x".repeat(16_384) }),
    );
    const outcomes = await Promise.allSettled(attempts);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(outcomes.at(-1)).toMatchObject({ status: "rejected" });
    f.service.cancel(f.owner, piped);
  });

  test("a granted directory cannot be replaced before a resource read or spawn", async () => {
    const f = await fixture();
    const directory = join(f.root, "working");
    await mkdir(directory);
    const grant = await f.service.grantDirectory(f.owner, directory);
    await rename(directory, join(f.root, "previous"));
    await mkdir(directory);
    expect(() => f.service.directoryPath(f.owner, grant.handle)).toThrow(/directory changed/);
    await expect(
      f.service.start(f.owner, { ...f.params, directoryHandle: grant.handle }),
    ).rejects.toThrow(/directory changed/);
  });

  test("large output reports a cursor gap while preserving the exit receipt", async () => {
    const f = await fixture('process.stdout.write("x".repeat(512_000));');
    const { processId } = await f.service.start(f.owner, f.params);
    const status = await f.exit(processId);
    expect(status.truncated).toBe(true);
    expect(status.events[0]!.sequence).toBeGreaterThan(1);
    expect(status.events.at(-1)!.event).toBe("process.exit");
    expect(
      status.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
    ).toBeLessThanOrEqual(processLimits.maxRetainedOutputBytes);
  });
});
