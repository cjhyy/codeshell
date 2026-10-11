import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PanelProcessOwner } from "./process-service.js";
import type { ToolJobScope } from "./tool-jobs.js";

const childFlag = "CODESHELL_WORKTREE_DIRECTORY_FLOW_CHILD";
const title =
  "real worktree Panel HTTP restores Desktop bookmarks and delivers durable native output";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

// Isolate the process-wide exact-origin guard from other Bun test files.
if (process.env[childFlag] !== "1") {
  test(
    title,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cs-worktree-directory-flow-")));
      const { createBunTestEnvironment, assertBunTestCompletion } =
        await import("../../../../scripts/bun-test-completion.mjs");
      const report = join(root, "junit.xml");
      const child = spawn(
        process.execPath,
        ["test", import.meta.path, "--reporter", "junit", "--reporter-outfile", report],
        {
          env: {
            ...createBunTestEnvironment(process.env, root),
            [childFlag]: "1",
            CODESHELL_WORKTREE_DIRECTORY_FLOW_ROOT: root,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "",
        forced = false;
      const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (stream === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024)
          child.kill("SIGTERM");
      };
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      const timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
      }, 28_000);
      let passed = false;
      try {
        const terminal = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
          },
        );
        writeFileSync(join(root, "stdout.log"), stdout);
        writeFileSync(join(root, "stderr.log"), stderr);
        writeFileSync(
          join(root, "terminal.json"),
          JSON.stringify({ pid: child.pid, ...terminal, forced, closeObserved: true }),
        );
        expect({ ...terminal, forced }, stderr).toEqual({ code: 0, signal: null, forced: false });
        expect(assertBunTestCompletion(report)).toEqual({ tests: 1, skipped: 0 });
        passed = true;
      } finally {
        clearTimeout(timer);
        if (passed) {
          const retained = new Set([
            "junit.xml",
            "stdout.log",
            "stderr.log",
            "terminal.json",
            "flow.json",
          ]);
          for (const item of readdirSync(root))
            if (!retained.has(item)) rmSync(join(root, item), { recursive: true, force: true });
          console.info(`Worktree directory acceptance evidence: ${root}`);
        } else console.error(`Worktree directory failure evidence: ${root}`);
      }
    },
    30_000,
  );
} else {
  test(
    title,
    async () => {
      const root = process.env.CODESHELL_WORKTREE_DIRECTORY_FLOW_ROOT!;
      let route: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> = async () =>
        false;
      const server = createServer((req, res) => {
        void route(req, res)
          .then((handled) => {
            if (!handled) res.writeHead(404).end();
          })
          .catch((cause) => {
            if (!res.writableEnded) res.writeHead(500).end(String(cause));
          });
      });
      const cleanups: Array<() => Promise<void>> = [];
      const failures: unknown[] = [];
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const { installLocalNetworkGuard } =
          await import("../../../../scripts/runtime-cost-smoke-isolation.mjs");
        installLocalNetworkGuard(origin);
        expect(() => fetch("https://worktree-guard.invalid/denied")).toThrow();
        const https = (await import("node:https")).default;
        expect(() => https.get("https://worktree-guard.invalid/denied")).toThrow();
        // Every production module is imported after the guard and its negative probes.
        const core = await import("@cjhyy/code-shell-core");
        const { createPanelHttp } = await import("./http.js");
        const { createHubAuth } = await import("../hub/auth-http.js");
        const { createHubPanelBinding } = await import("./hub-binding.js");
        const { desktopPanelDirectoryBookmarks, PanelAppDirectoryBookmarks } =
          await import("./directory-bookmarks.js");
        const { PanelAppProcessService, resolvePanelExecutable } =
          await import("./process-service.js");
        const { PanelResourceService } = await import("./resources/service.js");
        const { createPanelToolExecutor } = await import("./tool-executor.js");
        const { PanelToolJobService } = await import("./tool-jobs.js");
        const { createSharedPanelToolHost } = await import("./shared-tool-jobs.js");

        const project = join(root, "project"),
          worktree = join(root, "linked-worktree"),
          other = join(root, "other-project"),
          forged = join(root, "forged-worktree"),
          dataDir = join(root, "desktop"),
          source = join(root, "panel-source");
        for (const path of [project, other, forged, dataDir]) mkdirSync(path, { recursive: true });
        const git = (cwd: string, ...args: string[]) =>
          execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
            env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 3_000,
          });
        for (const path of [project, other]) {
          git(path, "init", "-q");
          writeFileSync(join(path, "tracked.txt"), "private Git fixture\n");
          git(path, "add", "tracked.txt");
          git(
            path,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "commit",
            "-qm",
            "seed",
          );
        }
        git(project, "worktree", "add", "-q", "-b", "directory-flow", worktree);
        const pointer = readFileSync(join(worktree, ".git"), "utf8");
        writeFileSync(join(forged, ".git"), pointer);
        const binding = createHubPanelBinding(worktree);
        binding.assertBinding();
        expect(binding.bindingCwd).toBe(project);
        expect(() => createHubPanelBinding(forged).assertBinding()).toThrow();

        const script = `import{writeFile}from"node:fs/promises";import{join}from"node:path";
let text="";process.stdin.setEncoding("utf8");for await(const c of process.stdin)text+=c;
const request=JSON.parse(text);const output=process.argv[process.argv.indexOf("--output-dir")+1];
const bytes=Buffer.from(request.payload,"base64");await writeFile(join(output,request.name),bytes,{flag:"wx"});
console.log(JSON.stringify({type:"result",result:{name:request.name,size:bytes.length}}));`;
        const scriptHash = hash(script);
        async function install(id: string) {
          mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
          mkdirSync(join(source, "app", "tools"), { recursive: true });
          writeFileSync(join(source, "app", "tools", "deliver.mjs"), script);
          writeFileSync(
            join(source, "app", "index.html"),
            "<!doctype html><title>Directory flow</title>",
          );
          writeFileSync(
            join(source, ".codeshell-panel", "panel.json"),
            JSON.stringify({
              schemaVersion: 1,
              id,
              title: { default: "Directory flow" },
              version: "1.0.0",
              entry: "app/index.html",
              icon: "panel",
              placement: "right-dock",
              singleton: true,
              permissions: ["context.workspace", "storage", "process", "resources"],
              nativeEntries: { deliver: { entry: "app/tools/deliver.mjs", sha256: scriptHash } },
            }),
          );
          const input = { kind: "dir" as const, path: source };
          const preview = await core.previewLocalPanelApp(input);
          await core.installReviewedLocalPanelApp(
            input,
            preview.reviewToken,
            new Date().toISOString(),
          );
        }
        await install("directory-flow");
        await install("other-app");

        const outputDirs = ["modern", "current-legacy", "web-legacy"].map((name) =>
          join(root, name),
        );
        outputDirs.forEach((path) => mkdirSync(path));
        const factory = desktopPanelDirectoryBookmarks(dataDir);
        const bookmarks = [
          factory.remember("directory-flow", project, outputDirs[0]!),
          new PanelAppDirectoryBookmarks(
            join(dataDir, "panel-app-directory-bookmarks.json"),
          ).remember("directory-flow", worktree, outputDirs[1]!),
          new PanelAppDirectoryBookmarks(
            join(dataDir, "panel-web-directory-bookmarks.json"),
          ).remember("directory-flow", worktree, outputDirs[2]!),
        ];
        expect(() => factory.restore("other-app", project, bookmarks[0])).toThrow();
        expect(() => factory.restore("directory-flow", other, bookmarks[0])).toThrow();
        for (const bookmark of bookmarks)
          expect(factory.restore("directory-flow", project, bookmark)).toContain(root);

        const auth = await createHubAuth({ dataDir: join(root, "auth"), publicOrigin: origin });
        let cookie = "";
        let active: Awaited<ReturnType<typeof openHost>> | undefined;
        route = async (req, res) =>
          (await auth.handle(req, res)) ||
          !!(await active?.api.handleAssets(req, res)) ||
          !!(await active?.api.handle(req, res));
        async function request(
          path: string,
          method = "POST",
          body?: unknown,
          authenticated = true,
        ) {
          return fetch(origin + path, {
            method,
            headers: {
              Origin: origin,
              "Content-Type": "application/json",
              ...(authenticated ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        }
        const setup = await request(
          "/api/v1/auth/setup",
          "POST",
          {
            token: auth.bootstrapToken,
            username: "fixture",
            password: "private-fixture-password",
            deviceName: "Web",
          },
          false,
        );
        expect(setup.status).toBe(200);
        cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
        expect(cookie).toMatch(/^cs_hub_session=/);

        let executionStarts = 0;
        const exits: Array<Record<string, unknown>> = [];
        async function openHost(cwd = worktree, bindingCwd = project) {
          const proof = createHubPanelBinding(cwd);
          proof.assertBinding();
          expect(proof.bindingCwd).toBe(bindingCwd);
          const saved = desktopPanelDirectoryBookmarks(dataDir);
          const owners = new Map<number, PanelProcessOwner>();
          let nextOwner = 1;
          const selected = async (scope: ToolJobScope) => {
            proof.assertBinding();
            if (scope.projectPath !== bindingCwd) throw new Error("Wrong project");
            const panel = (await api.service.snapshot(scope.appId)).panels.find(
              (item) => item.id === scope.appId,
            );
            const app = (await core.listProjectPanelApps(bindingCwd, scope.appId)).find(
              (item) => item.id === scope.appId,
            );
            if (
              !panel?.enabled ||
              panel.revision !== scope.revision ||
              !app ||
              app.packageDigest !== panel.packageDigest
            )
              throw new Error("Package authorization changed");
            return app;
          };
          const bin = join(root, "bin");
          await mkdir(bin, { recursive: true });
          const node = await resolvePanelExecutable("node", {
            extraPathDirectories: [
              dirname(process.execPath),
              "/opt/homebrew/bin",
              "/usr/local/bin",
            ],
          });
          if (!node) throw new Error("Actual Node executable unavailable");
          try {
            await symlink(node, join(bin, "node"));
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          }
          const processes = new PanelAppProcessService({
            env: { PATH: bin, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
            confirmExecution: async () => true,
            isOwnerAuthorized: async (owner) =>
              owners.has(owner.guestId) &&
              !!(await selected({
                appId: owner.appId,
                projectPath: bindingCwd,
                revision: owner.revision,
              })),
            resolvePackageEntry: async (owner, name) => {
              const app = await selected({
                appId: owner.appId,
                projectPath: bindingCwd,
                revision: owner.revision,
              });
              const entry = app.nativeEntries?.[name];
              if (!entry) throw new Error("Reviewed native entry missing");
              return { path: join(app.installPath, entry.entry), sha256: entry.sha256 };
            },
          });
          const resources = new PanelResourceService({
            rootDirectory: join(root, "resources"),
            isScopeAuthorized: async (scope) => !!(await selected(scope)),
          });
          const executor = createPanelToolExecutor({
            processes,
            resources,
            sealedRoot: join(root, "sealed"),
            owner: (job, send) => {
              executionStarts++;
              const owner: PanelProcessOwner = {
                guestId: nextOwner++,
                appId: job.scope.appId,
                appTitle: "Directory flow",
                revision: job.scope.revision,
                send(event, payload) {
                  if (event === "process.exit") exits.push(payload);
                  send(event, payload);
                },
              };
              owners.set(owner.guestId, owner);
              return owner;
            },
            releaseOwner: (owner) => {
              owners.delete(owner.guestId);
            },
            appDataDirectory: async () => {
              const path = join(root, "app-data");
              await mkdir(path, { recursive: true });
              return path;
            },
            resolveDirectoryBookmark: async (scope, bookmark) => {
              await selected(scope);
              return saved.restore(scope.appId, scope.projectPath, bookmark);
            },
            authorize: async (scope) => {
              await selected(scope);
            },
            authorizeConnections: async () => {
              throw new Error("No connections in fixture");
            },
            authorizeDirectRead: async () => {
              throw new Error("No direct inputs in fixture");
            },
          });
          const service = new PanelToolJobService({
            rootDir: join(dataDir, "tool-jobs", hash(bindingCwd).slice(0, 16)),
            prepareInput: executor.prepareInput,
            execute: executor.execute,
            isAuthorized: async (scope) => !!(await selected(scope)),
            describePackage: async (scope) => {
              const app = await selected(scope);
              return { version: app.version, packageDigest: app.packageDigest! };
            },
          });
          const sharedToolJobs = createSharedPanelToolHost({
            service: () => service,
            resolveScope: async (app, projectPath) => {
              const panel = (await api.service.snapshot(app.id)).panels.find(
                (item) => item.id === app.id,
              )!;
              const scope = { appId: app.id, projectPath, revision: panel.revision };
              await selected(scope);
              return scope;
            },
          });
          const api = createPanelHttp({
            cwd,
            bindingCwd,
            dataDir,
            host: "desktop",
            projectPackages: true,
            assertBinding: proof.assertBinding,
            sharedToolJobs,
            ownerId: async (req) => (await auth.authenticate(req))?.id,
            isAuthorized: async (req) => !!(await auth.authenticate(req)),
            authorizePanelDirectory: async (_app, expectedProject, workspace) => {
              proof.assertBinding();
              if (expectedProject !== bindingCwd || workspace !== cwd)
                throw new Error("Wrong directory scope");
            },
          });
          let closed = false;
          const close = async () => {
            if (closed) return;
            closed = true;
            await api.close();
            await service.shutdown();
            processes.close();
            await resources.shutdown();
            expect(owners.size).toBe(0);
          };
          cleanups.push(close);
          await service.initialize();
          return { api, service, close };
        }

        async function bind(id: string) {
          const catalog = await (await request("/api/v1/panels", "GET")).json();
          const panel = catalog.panels.find((item: { id: string }) => item.id === id);
          const response = await request(`/api/v1/panels/${id}/binding`, "PATCH", {
            bound: true,
            expectedRevision: panel.revision,
          });
          expect(response.status, await response.clone().text()).toBe(200);
        }
        async function prepare(id = "directory-flow") {
          const catalog = await (await request("/api/v1/panels", "GET")).json();
          const panel = catalog.panels.find((item: { id: string }) => item.id === id);
          const response = await request("/api/v1/panels/runtime/prepare", "POST", {
            appId: id,
            revision: panel.revision,
          });
          expect(response.status, await response.clone().text()).toBe(200);
          return response.json() as Promise<{ instanceId: string }>;
        }
        const call = (grant: { instanceId: string }, method: string, params: unknown) =>
          request(`/api/v1/panels/runtime/${grant.instanceId}/call`, "POST", { method, params });
        const bytes = Buffer.from([0, 1, 127, 128, 255, ...Buffer.from("目录交付\n")]);
        async function start(grant: { instanceId: string }, params: unknown) {
          const route = `/api/v1/panels/runtime/${grant.instanceId}`;
          const before = await (await request(route + "/events?after=0", "GET")).json();
          const pending = call(grant, "tasks.start", params);
          const until = Date.now() + 5_000;
          let confirmed = false;
          while (Date.now() < until) {
            const events = await (
              await request(route + `/events?after=${before.cursor}`, "GET")
            ).json();
            const event = events.events.find((item: any) => item.event === "host.confirm");
            if (event) {
              const response = await request(route + "/confirm", "POST", {
                requestId: event.payload.requestId,
                allowed: true,
              });
              expect(response.status).toBe(200);
              confirmed = true;
              break;
            }
            await pause();
          }
          if (!confirmed) {
            active!.api.cancelOwner(
              (await auth.store.authenticate(cookie.slice(cookie.indexOf("=") + 1)))!.id,
            );
            await pending;
            throw new Error("Missing real HTTP task confirmation");
          }
          return pending;
        }
        async function deliver(grant: { instanceId: string }, bookmark: string, name: string) {
          const response = await start(grant, {
            entry: "deliver",
            input: {
              request: { name, payload: bytes.toString("base64") },
              directoryArguments: [
                { argumentName: "--output-dir", directory: "bookmark", bookmark },
              ],
            },
            recovery: "retry",
            requestKey: name,
          });
          const until = Date.now() + 5_000;
          expect(response.status, await response.clone().text()).toBe(200);
          let job = await response.json();
          while (
            !["succeeded", "failed", "cancelled", "interrupted"].includes(job.status) &&
            Date.now() < until
          ) {
            await pause();
            const status = await call(grant, "tasks.get", { id: job.id });
            expect(status.status).toBe(200);
            job = await status.json();
          }
          expect(job.status, JSON.stringify(job)).toBe("succeeded");
          expect(job.scope.projectPath).toBe(project);
          expect(job.result).toEqual({ name, size: bytes.length });
          return job;
        }

        active = await openHost();
        expect((await request("/api/v1/panels", "GET", undefined, false)).status).toBe(401);
        await bind("directory-flow");
        await bind("other-app");
        let grant = await prepare();
        const otherApp = await prepare("other-app");
        expect(
          (await call(otherApp, "filesystem.restoreDirectory", { bookmark: bookmarks[0] })).status,
        ).toBe(400);
        const jobs = [];
        for (let index = 0; index < bookmarks.length; index++) {
          const restored = await call(grant, "filesystem.restoreDirectory", {
            bookmark: bookmarks[index],
          });
          expect(restored.status, await restored.clone().text()).toBe(200);
          expect(await restored.json()).toMatchObject({
            path: outputDirs[index],
            bookmark: bookmarks[index],
          });
          jobs.push(await deliver(grant, bookmarks[index]!, `result-${index}.bin`));
          expect(await readFile(join(outputDirs[index]!, `result-${index}.bin`))).toEqual(bytes);
        }
        expect(exits).toHaveLength(3);
        for (const exit of exits) expect(exit).toMatchObject({ code: 0, signal: null });
        await active.close();
        active = await openHost();
        grant = await prepare();
        for (let index = 0; index < bookmarks.length; index++) {
          expect(
            (await call(grant, "filesystem.restoreDirectory", { bookmark: bookmarks[index] }))
              .status,
          ).toBe(200);
          const job = await (await call(grant, "tasks.get", { id: jobs[index]!.id })).json();
          expect(job).toMatchObject({
            id: jobs[index]!.id,
            status: "succeeded",
            result: jobs[index]!.result,
          });
          expect(hash(await readFile(join(outputDirs[index]!, `result-${index}.bin`)))).toBe(
            hash(bytes),
          );
        }
        const records = JSON.parse(
          readFileSync(join(dataDir, "panel-app-directory-bookmarks.json"), "utf8"),
        ).bookmarks;
        expect(records.find((item: any) => item.id === bookmarks[0]).projectPath).toBe(project);
        for (const bookmark of bookmarks.slice(1))
          expect(records.find((item: any) => item.id === bookmark).projectPath).toBe(worktree);

        const beforeDenied = executionStarts;
        renameSync(outputDirs[0]!, outputDirs[0] + "-original");
        mkdirSync(outputDirs[0]!);
        expect(
          (await call(grant, "filesystem.restoreDirectory", { bookmark: bookmarks[0] })).status,
        ).toBe(400);
        const wrongJob = await start(grant, {
          entry: "deliver",
          input: {
            request: { name: "forbidden.bin", payload: bytes.toString("base64") },
            directoryArguments: [
              { argumentName: "--output-dir", directory: "bookmark", bookmark: bookmarks[0] },
            ],
          },
          recovery: "retry",
        });
        // Invalid bookmark preparation is refused before process ownership/execution.
        expect(wrongJob.status).toBe(400);
        expect(executionStarts).toBe(beforeDenied);
        expect(() => readFileSync(join(outputDirs[0]!, "forbidden.bin"))).toThrow();

        await active.close();
        active = await openHost(other, other);
        await bind("directory-flow");
        const otherProject = await prepare();
        expect(
          (await call(otherProject, "filesystem.restoreDirectory", { bookmark: bookmarks[1] }))
            .status,
        ).toBe(400);
        expect(executionStarts).toBe(beforeDenied);
        await active.close();
        active = await openHost();
        grant = await prepare();
        writeFileSync(join(worktree, ".git"), "gitdir: /not-the-authorized-project\n");
        expect(
          (await call(grant, "filesystem.restoreDirectory", { bookmark: bookmarks[1] })).status,
        ).not.toBe(200);
        expect(() => factory.restore("directory-flow", project, bookmarks[1])).toThrow();
        expect(executionStarts).toBe(beforeDenied);
        writeFileSync(
          join(root, "flow.json"),
          JSON.stringify({
            guardDenials: 2,
            auth: "production Hub cookie",
            host: "desktop",
            git: "actual linked worktree",
            bookmarks: ["main-project", "worktree-current", "worktree-legacy-web"],
            entrySha256: scriptHash,
            outputSha256: hash(bytes),
            outputBytes: bytes.length,
            actualExecutions: executionStarts,
            processExits: exits,
            restartedJobs: jobs.map((job) => job.id),
            denied: [
              "unauthenticated",
              "other-app",
              "other-project",
              "forged-git",
              "replaced-directory",
              "revoked-git",
            ],
          }),
        );
      } catch (cause) {
        failures.push(cause);
      } finally {
        const outcomes = await Promise.allSettled(cleanups.reverse().map((close) => close()));
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve())).catch((cause) => {
          failures.push(cause);
        });
        failures.push(
          ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
        );
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, "Directory fixture and cleanup failed");
    },
    25_000,
  );
}
