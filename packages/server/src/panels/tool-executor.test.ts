import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelAppProcessService,
  resolvePanelExecutable,
  type PanelProcessOwner,
} from "./process-service.js";
import { PanelResourceService } from "./resources/service.js";
import { createPanelToolExecutor } from "./tool-executor.js";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const scope = { appId: "fixture", projectPath: "/fixture-workspace", revision: "r1" };
const readRequest =
  'let text="";process.stdin.setEncoding("utf8");for await(const c of process.stdin)text+=c;const request=JSON.parse(text);';
async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= until) throw new Error("native executor fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("reviewed native tool executor", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function fixture(source: string, dropEvents = false) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "panel-tool-executor-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workDir = join(root, "work"),
      appData = join(root, "app-data"),
      bin = join(root, "bin");
    await Promise.all([workDir, appData, bin].map((path) => mkdir(path)));
    const entryPath = join(root, "entry.mjs");
    await writeFile(entryPath, source);
    const node = await resolvePanelExecutable("node", {
      extraPathDirectories: [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"],
    });
    if (!node) throw new Error("Node fixture runtime is unavailable");
    await symlink(node, join(bin, "node"));
    let authorized = true;
    const owners = new Map<number, PanelProcessOwner>();
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const processes = new PanelAppProcessService({
      env: { PATH: bin },
      confirmExecution: async () => true,
      isOwnerAuthorized: (owner) => authorized && owners.has(owner.guestId),
      resolvePackageEntry: async () => ({ path: entryPath, sha256: hash(source) }),
    });
    const resources = new PanelResourceService({
      rootDirectory: join(root, "assets"),
      isScopeAuthorized: () => authorized,
    });
    cleanups.push(async () => {
      processes.close();
      await resources.shutdown();
    });
    let nextOwner = 1;
    const executor = createPanelToolExecutor({
      processes,
      resources,
      sealedRoot: join(root, "sealed"),
      owner: (_job, send) => {
        const owner: PanelProcessOwner = {
          guestId: nextOwner++,
          ...scope,
          appTitle: "Fixture",
          send: (event, payload) => {
            events.push({ event, payload });
            if (!dropEvents) send(event, payload);
          },
        };
        owners.set(owner.guestId, owner);
        return owner;
      },
      releaseOwner: (owner) => {
        owners.delete(owner.guestId);
      },
      appDataDirectory: async () => appData,
      authorize: async () => {
        if (!authorized) throw new Error("revoked");
      },
      authorizeConnections: async () => {
        throw new Error("No test connections");
      },
    });
    const controller = new AbortController();
    cleanups.push(async () => {
      controller.abort();
    });
    const progress: unknown[] = [];
    const context = {
      workDir,
      signal: controller.signal,
      reportProgress: async (value: unknown) => {
        progress.push(value);
      },
    };
    const job = {
      id: "fixture-job",
      scope,
      entry: { name: "fixture", sha256: hash(source) },
      input: { request: { text: "你好" } } as unknown,
    };
    return {
      root,
      workDir,
      appData,
      processes,
      resources,
      owners,
      events,
      executor,
      controller,
      context,
      job,
      progress,
      revoke() {
        authorized = false;
      },
    };
  }

  test("real Node receives sealed directories and frozen resources, then captures a verified artifact", async () => {
    const source = `import {readFile,writeFile} from "node:fs/promises";import {createHash} from "node:crypto";import {join} from "node:path";
${readRequest}
const args=process.argv.slice(2), jobDir=args[args.indexOf("--job-dir")+1], dataDir=args[args.indexOf("--data-dir")+1];
const content=await readFile(join(jobDir,"source.txt"),"utf8");
const output=Buffer.from(content+request.text);await writeFile(join(jobDir,"result.txt"),output);await writeFile(join(dataDir,"marker"),"ran");
console.log(JSON.stringify({type:"progress",progress:{fraction:0.5,message:"处理中"}}));
const sha256=createHash("sha256").update(output).digest("hex");console.log(JSON.stringify({type:"result",result:{jobId:request.jobId,artifacts:[{assetId:"asset-"+sha256,sha256,bytes:output.length,file:"result.txt",mimeType:"text/plain"}]}}));`;
    const f = await fixture(source);
    const inputFile = join(f.root, "source.txt");
    await writeFile(inputFile, "原文");
    const asset = await f.resources.library.importFile(scope, inputFile);
    f.job.input = await f.executor.prepareInput(
      scope,
      {
        request: { text: "你好" },
        resources: [{ assetId: asset.id, path: "source.txt" }],
        directoryArguments: [
          { argumentName: "--job-dir", directory: "job" },
          { argumentName: "--data-dir", directory: "app-data", path: "runtime" },
        ],
      },
      f.workDir,
      f.controller.signal,
    );
    await writeFile(inputFile, "原文件已改变");
    const result = (await f.executor.execute(f.job, f.context)) as any;
    expect(result.jobId).toBe("fixture-job");
    expect(result.artifacts[0].asset).toMatchObject({
      id: `asset-${hash("原文你好")}`,
      bytes: Buffer.byteLength("原文你好"),
    });
    expect(
      await readFile(
        await f.resources.library.resolvePath(scope, result.artifacts[0].asset.id),
        "utf8",
      ),
    ).toBe("原文你好");
    expect(await readFile(join(f.appData, "runtime", "marker"), "utf8")).toBe("ran");
    expect(f.owners.size).toBe(0);
    expect(f.progress).toContainEqual({ fraction: 0.5, message: "处理中" });
  });

  test("recovers all dropped transport events from bounded process receipts", async () => {
    const f = await fixture(
      `${readRequest}console.log(JSON.stringify({type:"progress",progress:{fraction:0.5}}));console.log(JSON.stringify({type:"result",result:{received:request.text}}));`,
      true,
    );
    expect(await f.executor.execute(f.job, f.context)).toEqual({ received: "你好" });
    expect(f.progress).toContainEqual({ fraction: 0.5 });
    expect(f.owners.size).toBe(0);
  });

  test("cancellation waits for native cleanup, including when exit events are dropped", async () => {
    const f = await fixture(
      `import{writeFile}from"node:fs/promises";${readRequest}process.on("SIGTERM",()=>setTimeout(async()=>{await writeFile("cleaned","yes");process.exit(0)},150));console.log(JSON.stringify({type:"progress",progress:{stage:"ready"}}));setInterval(()=>{},1000);`,
      true,
    );
    let settled = false;
    const pending = f.executor.execute(f.job, f.context).then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    await eventually(() =>
      f.events.some((event) => String(event.payload.text).includes('"ready"')),
    );
    f.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    await expect(pending).rejects.toThrow();
    expect(await readFile(join(f.workDir, "cleaned"), "utf8")).toBe("yes");
    expect(f.owners.size).toBe(0);
  });

  test("authorization loss terminates the child and releases its owner", async () => {
    const f = await fixture(
      `${readRequest}console.log(JSON.stringify({type:"progress",progress:{stage:"ready"}}));setInterval(()=>{},1000);`,
    );
    const pending = f.executor.execute(f.job, f.context);
    await eventually(() =>
      f.events.some((event) => String(event.payload.text).includes('"ready"')),
    );
    f.revoke();
    await expect(pending).rejects.toThrow(/authorized|revoked/);
    expect(f.owners.size).toBe(0);
  });

  test("preserves non-retryable protocol errors and rejects incorrect artifact hashes", async () => {
    const f = await fixture(
      `${readRequest}console.log(JSON.stringify({type:"error",code:"PAYMENT_REQUIRED",message:"额度不足",retryable:false}));`,
    );
    try {
      await f.executor.execute(f.job, f.context);
      throw new Error("expected protocol failure");
    } catch (error) {
      expect(error).toMatchObject({
        message: "额度不足",
        code: "PAYMENT_REQUIRED",
        retryable: false,
      });
    }
    const other = await fixture(
      `import{writeFile}from"node:fs/promises";${readRequest}await writeFile("output.txt","actual");const sha256="a".repeat(64);console.log(JSON.stringify({type:"result",result:{artifacts:[{file:"output.txt",assetId:"asset-"+sha256,sha256,bytes:6}]}}));`,
    );
    await expect(other.executor.execute(other.job, other.context)).rejects.toThrow();
    expect(await other.resources.library.list(scope)).toEqual([]);
  });

  test("flushes a final progress line without newline before returning the result", async () => {
    const f = await fixture(
      `${readRequest}console.log(JSON.stringify({type:"result",result:{ok:true}}));process.stdout.write(JSON.stringify({type:"progress",progress:{fraction:1}}));`,
    );
    let lastProgressFinished = false;
    expect(
      await f.executor.execute(f.job, {
        ...f.context,
        reportProgress: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          lastProgressFinished = true;
        },
      }),
    ).toEqual({ ok: true });
    expect(lastProgressFinished).toBe(true);
  });
});
