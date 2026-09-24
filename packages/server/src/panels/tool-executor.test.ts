import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  async function fixture(
    source: string,
    dropEvents = false,
    options: { directRead?: boolean } = {},
  ) {
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
      authorizeDirectRead: async () => {
        if (!options.directRead) throw new Error("Tool requires direct read permission");
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

  test("external references materialize only into the job and keep original paths out of tool input", async () => {
    const f = await fixture(
      `${readRequest}console.log(JSON.stringify({type:"result",result:{ok:true}}));`,
    );
    const original = join(f.root, "original.wav");
    await writeFile(original, "original reference content");
    const reference = await f.resources.references.createFromSelectedPath(scope, original);
    const input = await f.executor.prepareInput(
      scope,
      {
        request: { file: "input.wav" },
        resources: [{ assetId: reference.id, path: "input.wav" }],
      },
      f.workDir,
      f.controller.signal,
    );
    expect(await readFile(join(f.workDir, "input.wav"), "utf8")).toBe("original reference content");
    expect(await f.resources.library.list(scope)).toEqual([]);
    expect(JSON.stringify(input)).not.toContain(original);
    await writeFile(original, "changed");
    await expect(
      f.executor.prepareInput(
        scope,
        {
          request: {},
          resources: [{ assetId: reference.id, path: "changed.wav" }],
        },
        f.workDir,
        f.controller.signal,
      ),
    ).rejects.toThrow();
    await expect(
      f.executor.prepareInput(
        scope,
        {
          request: {},
          resources: [{ assetId: original, path: "raw.wav" }],
        },
        f.workDir,
        f.controller.signal,
      ),
    ).rejects.toThrow("Invalid tool resource");
  });

  // Reviewed tools read the Host's sealed manifest; the Guest only names keys.
  const readOriginals =
    'const args=process.argv.slice(2);const originals=JSON.parse(await readFile(args[args.indexOf("--originals")+1],"utf8")).originals;';
  const reportInput = `import{readFile,readdir}from"node:fs/promises";${readRequest}${readOriginals}console.log(JSON.stringify({type:"result",result:{content:await readFile(originals["input.wav"].path,"utf8"),bytes:originals["input.wav"].bytes,job:await readdir(".")}}));`;
  const directInput = (assetId: string) => ({
    request: {},
    resources: [{ assetId, path: "input.wav", access: "read" }],
    originalsArgument: "--originals",
  });
  async function originalReference(f: Awaited<ReturnType<typeof fixture>>, content: string) {
    const original = join(f.root, "original.wav");
    await writeFile(original, content);
    return {
      original,
      reference: await f.resources.references.createFromSelectedPath(scope, original),
    };
  }

  test("direct read hands the verified original to the tool without copying it", async () => {
    const f = await fixture(reportInput, false, { directRead: true });
    const { original, reference } = await originalReference(f, "original reference content");
    f.job.input = await f.executor.prepareInput(
      scope,
      directInput(reference.id),
      f.workDir,
      f.controller.signal,
    );
    expect(await readdir(f.workDir)).toEqual([]);
    expect(JSON.stringify(f.job.input)).not.toContain(original);
    expect(await f.executor.execute(f.job, f.context)).toEqual({
      content: "original reference content",
      bytes: Buffer.byteLength("original reference content"),
      job: [],
    });
    expect(f.owners.size).toBe(0);
    // The sealed manifest is removed with the run.
    await eventually(async () => (await readdir(join(f.root, "sealed"))).length === 0);
    // A retry re-verifies and hands the same original again.
    expect(await f.executor.execute(f.job, f.context)).toMatchObject({
      content: "original reference content",
    });
  });

  test("a Panel cannot steer a tool's writes onto an original", async () => {
    // The tool writes its output to the name the Panel used for the input.
    const f = await fixture(
      `import{writeFile}from"node:fs/promises";${readRequest}await writeFile("input.wav","tool output");console.log(JSON.stringify({type:"result",result:{ok:true}}));`,
      false,
      { directRead: true },
    );
    const { original, reference } = await originalReference(f, "original");
    f.job.input = directInput(reference.id);
    expect(await f.executor.execute(f.job, f.context)).toEqual({ ok: true });
    expect(await readFile(original, "utf8")).toBe("original");
    expect(await readFile(join(f.workDir, "input.wav"), "utf8")).toBe("tool output");
  });

  test("direct read needs its permission, a manifest argument and an external reference", async () => {
    const denied = await fixture(reportInput);
    const { reference } = await originalReference(denied, "content");
    await expect(
      denied.executor.prepareInput(
        scope,
        directInput(reference.id),
        denied.workDir,
        denied.controller.signal,
      ),
    ).rejects.toThrow("direct read permission");
    // Denied at launch too, e.g. for a job admitted before the grant was dropped.
    denied.job.input = directInput(reference.id);
    await expect(denied.executor.execute(denied.job, denied.context)).rejects.toThrow(
      "direct read permission",
    );
    const f = await fixture(reportInput, false, { directRead: true });
    const file = join(f.root, "library.wav");
    await writeFile(file, "library content");
    const asset = await f.resources.library.importFile(scope, file);
    const { reference: external } = await originalReference(f, "content");
    for (const input of [
      directInput(asset.id),
      { ...directInput(external.id), originalsArgument: undefined },
      { ...directInput(external.id), originalsArgument: "originals" },
      { request: {}, originalsArgument: "--originals" },
      {
        ...directInput(external.id),
        directoryArguments: [{ argumentName: "--originals", directory: "job" }],
      },
      {
        ...directInput(external.id),
        resources: [{ assetId: external.id, path: "input.wav", access: "write" }],
      },
    ])
      await expect(
        f.executor.prepareInput(scope, input, f.workDir, f.controller.signal),
      ).rejects.toThrow(/Invalid tool|argument/);
  });

  test("direct read refuses an original that changed or went missing before launch", async () => {
    const f = await fixture(reportInput, false, { directRead: true });
    const { original, reference } = await originalReference(f, "original");
    f.job.input = await f.executor.prepareInput(
      scope,
      directInput(reference.id),
      f.workDir,
      f.controller.signal,
    );
    await writeFile(original, "edited before launch");
    await expect(f.executor.execute(f.job, f.context)).rejects.toMatchObject({
      code: "INPUT_CHANGED",
      retryable: false,
    });
    const gone = await fixture(reportInput, false, { directRead: true });
    const second = await originalReference(gone, "original");
    gone.job.input = directInput(second.reference.id);
    await rm(second.original);
    // Reconnecting the drive can make a retry succeed.
    await expect(gone.executor.execute(gone.job, gone.context)).rejects.toMatchObject({
      code: "INPUT_MISSING",
      retryable: true,
    });
  });

  test("direct read reports a tool that modified its original", async () => {
    const f = await fixture(
      `import{appendFile,readFile}from"node:fs/promises";${readRequest}${readOriginals}await appendFile(originals["input.wav"].path,"!");console.log(JSON.stringify({type:"result",result:{ok:true}}));`,
      false,
      { directRead: true },
    );
    const { reference } = await originalReference(f, "original");
    f.job.input = directInput(reference.id);
    await expect(f.executor.execute(f.job, f.context)).rejects.toMatchObject({
      code: "INPUT_CHANGED",
      retryable: false,
    });
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
