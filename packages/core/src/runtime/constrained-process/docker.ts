import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureResources, sha256 } from "./resources.js";
import type {
  ConstrainedDockerRuntime,
  ConstrainedProcessHost,
  ConstrainedProcessOutput,
  ConstrainedProcessPermit,
  ConstrainedProcessResources,
  ConstrainedProcessScope,
} from "./types.js";

const POLICY_SHA256 = "3876dafd126ec750b38c5c9793884c9d7868d52e0fc2383f939a92c826c77e83";
const MAX_INPUT = 256 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const CLI_TIMEOUT = 10_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;

// This immutable Host bootstrap produces the first line before executing any
// configured code. Hook output cannot supply this runtime identity header.
const BOOTSTRAP = `import {readFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const status=readFileSync('/proc/self/status','utf8');
const field=(name)=>status.match(new RegExp('^'+name+':\\\\s*(.*)$','m'))?.[1]?.trim();
for(const path of ['/scratch/home','/scratch/config','/scratch/data','/scratch/cache','/scratch/state','/scratch/tmp','/scratch/work','/scratch/plugin-data'])mkdirSync(path,{recursive:true,mode:0o700});
const runtime={pid:process.pid,ppid:process.ppid,uid:process.getuid(),executable:process.execPath,sha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),version:process.version,capEff:field('CapEff'),capBnd:field('CapBnd'),noNewPrivs:field('NoNewPrivs'),seccomp:field('Seccomp')};
if(runtime.pid!==1||runtime.ppid!==0||runtime.uid!==65534||runtime.executable!==process.argv[4]||runtime.sha256!==process.argv[3]||runtime.capEff!=='0000000000000000'||runtime.capBnd!=='0000000000000000'||runtime.noNewPrivs!=='1'||runtime.seccomp!=='2')process.exit(125);
process.stdout.write(JSON.stringify(runtime)+'\\n',()=>{
const child=spawn('/bin/sh',['-c',process.argv[2]],{cwd:'/scratch/work',env:process.env,stdio:'inherit'});
child.on('error',()=>process.exit(125));child.on('close',(code)=>process.exit(code??125));
});
`;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Invocation {
  id: string;
  name: string;
  directory: string;
  containerId?: string;
  child?: ChildProcess;
  terminating?: Promise<void>;
  cleanup?: { exitCode: number; containerId: string };
  /** A known client-side parser rejection before any create request, never a transport error. */
  createRejected?: boolean;
}

interface LifecycleEvent {
  stage: "created" | "quiescent" | "removed";
  containerId: string;
  scopeId: string;
  invocationId: string;
  exitCode?: number;
}

/**
 * Explicit local, immutable Linux runtime. No PATH/context discovery, image
 * pulls, daemon install, Host HOME mount, shell runner, or weaker fallback.
 * The local Docker daemon and supplied immutable image are trusted Host TCB.
 */
export function createConstrainedDockerProcessHost(
  config: ConstrainedDockerRuntime,
  diagnostics?: {
    onLifecycle?(event: LifecycleEvent): void;
  },
): ConstrainedProcessHost {
  if (
    !isAbsolute(config.executable) ||
    !SHA256.test(config.executableSha256) ||
    !/^unix:\/\/\//.test(config.endpoint) ||
    config.endpoint.includes("\0") ||
    config.endpoint.length > 4096 ||
    !/^sha256:[a-f0-9]{64}$/.test(config.image) ||
    !["arm64", "amd64"].includes(config.architecture) ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(config.nodeExecutable) ||
    config.nodeExecutable.includes("..") ||
    !SHA256.test(config.nodeExecutableSha256)
  )
    throw new Error("Invalid constrained runtime configuration");
  // Detach the trusted configuration from its caller's mutable object.
  config = Object.freeze({ ...config });
  const executable = realpathSync(config.executable);
  const executableInfo = lstatSync(executable, { bigint: true });
  const executableIdentity = String([
    executableInfo.dev,
    executableInfo.ino,
    executableInfo.size,
    executableInfo.mtimeNs,
    executableInfo.ctimeNs,
  ]);
  const assertRuntime = (verifyBytes = false) => {
    const info = lstatSync(executable, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      String([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs]) !== executableIdentity ||
      (verifyBytes && sha256(readFileSync(executable)) !== config.executableSha256)
    )
      throw new Error("Constrained runtime executable changed");
  };
  assertRuntime(true);
  const resourceTokens = new WeakMap<
    ConstrainedProcessResources,
    ReturnType<typeof captureResources>
  >();
  const scopes = new Set<ConstrainedProcessScope>();
  let disposed = false;

  return {
    capture(grants) {
      if (disposed) throw new Error("Constrained runtime disposed");
      const resources = captureResources(grants);
      const token = Object.freeze({}) as ConstrainedProcessResources;
      resourceTokens.set(token, resources);
      return token;
    },
    assertResourcesCurrent(token) {
      const resources = resourceTokens.get(token);
      if (!resources || disposed) throw new Error("Constrained resources are unavailable");
      resources.assertCurrent();
    },
    createScope(authority) {
      if (disposed) throw new Error("Constrained runtime disposed");
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-constrained-process-")));
      chmodSync(scratch, 0o700);
      const dockerConfig = join(scratch, "docker-config");
      mkdirSync(dockerConfig, { mode: 0o700 });
      const scopeId = randomUUID();
      const permits = new WeakMap<
        ConstrainedProcessPermit,
        {
          command: string;
          timeoutMs: number;
          event: string;
          plugin: boolean;
          resources: ReturnType<typeof captureResources>;
        }
      >();
      const invocations = new Set<Invocation>();
      const active = new Set<Promise<unknown>>();
      const cancellation = new AbortController();
      let failure: Error | undefined;
      let closing: Promise<void> | undefined;
      const signal = AbortSignal.any([authority.signal, cancellation.signal]);
      const fail = (error: unknown) => {
        failure ??= error instanceof Error ? error : new Error("Constrained process unavailable");
        cancellation.abort();
      };
      const emitLifecycle = (event: LifecycleEvent) => {
        try {
          diagnostics?.onLifecycle?.(event);
        } catch (error) {
          // A Host observer can revoke acceptance, but must never interrupt
          // kill/wait/removal or leave a quiescent container behind.
          fail(error);
        }
      };
      const check = () => {
        if (disposed || closing || signal.aborted || failure)
          throw failure ?? new Error("Constrained process cancelled");
        authority.assertAuthorized();
        assertRuntime();
      };
      // Revoke a suspended child when owner/settings/file authority changes,
      // without trusting any mutable HookContext field or child output.
      const authorityTimer = setInterval(() => {
        try {
          check();
          for (const token of issuedResources) token.assertCurrent();
        } catch (error) {
          fail(error);
        }
      }, 100);
      authorityTimer.unref();
      const issuedResources = new Set<ReturnType<typeof captureResources>>();

      const cli = (
        args: string[],
        options: {
          input?: string;
          timeoutMs?: number;
          invocation?: Invocation;
          observeAbort?: boolean;
        } = {},
      ): Promise<CliResult> =>
        new Promise((resolve, reject) => {
          assertRuntime();
          const child = spawn(
            executable,
            ["--host", config.endpoint, "--config", dockerConfig, ...args],
            {
              cwd: scratch,
              env: {
                PATH: "/usr/bin:/bin",
                HOME: scratch,
                USERPROFILE: scratch,
                DOCKER_CONFIG: dockerConfig,
                ...(process.platform === "win32" && process.env.SystemRoot
                  ? { SystemRoot: process.env.SystemRoot }
                  : {}),
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          if (options.invocation) options.invocation.child = child;
          const chunks: Buffer[] = [];
          const errors: Buffer[] = [];
          let bytes = 0;
          let rejected: Error | undefined;
          const terminate = (error: Error) => {
            rejected ??= error;
            child.kill("SIGKILL");
            if (options.invocation) void terminateInvocation(options.invocation).catch(fail);
          };
          const onAbort = () => terminate(new Error("Constrained process cancelled"));
          const timer = setTimeout(
            () => terminate(new Error("Constrained process timeout")),
            options.timeoutMs ?? CLI_TIMEOUT,
          );
          if (options.observeAbort) signal.addEventListener("abort", onAbort, { once: true });
          const receive = (target: Buffer[], chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_OUTPUT) terminate(new Error("Constrained process output limit"));
            else target.push(Buffer.from(chunk));
          };
          child.stdout.on("data", (chunk: Buffer) => receive(chunks, chunk));
          child.stderr.on("data", (chunk: Buffer) => receive(errors, chunk));
          child.stdin.on("error", (error) => terminate(error));
          child.once("error", (error) => {
            rejected ??= error;
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (options.invocation?.child === child) options.invocation.child = undefined;
            if (rejected) reject(rejected);
            else
              resolve({
                code,
                stdout: Buffer.concat(chunks).toString("utf8"),
                stderr: Buffer.concat(errors).toString("utf8"),
              });
          });
          child.stdin.end(options.input ?? "");
          if (options.observeAbort && signal.aborted) onAbort();
        });

      const inspect = async (invocation: Invocation) => {
        const result = await cli([
          "container",
          "inspect",
          invocation.containerId ?? invocation.name,
        ]);
        if (result.code !== 0) throw new Error("Constrained container custody unavailable");
        const values = JSON.parse(result.stdout);
        const value = values?.[0];
        if (
          values.length !== 1 ||
          !CONTAINER_ID.test(value?.Id) ||
          value.Name !== `/${invocation.name}` ||
          value.Config?.Labels?.["codeshell.process.scope"] !== scopeId ||
          value.Config?.Labels?.["codeshell.process.invocation"] !== invocation.id ||
          (invocation.containerId && value.Id !== invocation.containerId)
        )
          throw new Error("Constrained container custody changed");
        invocation.containerId = value.Id;
        return value;
      };

      const terminateInvocation = (invocation: Invocation): Promise<void> => {
        if (invocation.terminating) return invocation.terminating;
        invocation.terminating = (async () => {
          if (!invocation.containerId && invocation.createRejected) {
            const absent = await cli(["container", "inspect", invocation.name]);
            if (
              absent.code !== 0 &&
              absent.stderr.includes(`No such container: ${invocation.name}`)
            )
              return; // A rejected create, exact owned name, and confirmed absence.
          }
          const original = await inspect(invocation);
          if (original.State?.Running || original.State?.Paused || original.State?.Restarting) {
            const killed = await cli([
              "container",
              "kill",
              "--signal",
              "KILL",
              invocation.containerId!,
            ]);
            if (killed.code !== 0) {
              const current = await inspect(invocation);
              if (current.State?.Running) throw new Error("Constrained process kill unproven");
            }
          }
          const waited = await cli(["container", "wait", invocation.containerId!]);
          if (waited.code !== 0 || !/^\d+\s*$/.test(waited.stdout))
            throw new Error("Constrained process wait unproven");
          const final = await inspect(invocation);
          if (
            final.State?.Running !== false ||
            final.State?.Pid !== 0 ||
            final.State?.Paused ||
            final.State?.Restarting
          )
            throw new Error("Constrained process quiescence unproven");
          const top = await cli(["container", "top", invocation.containerId!]);
          if (top.code === 0) throw new Error("Constrained process descendants remain");
          emitLifecycle({
            stage: "quiescent",
            containerId: invocation.containerId!,
            scopeId,
            invocationId: invocation.id,
            exitCode: Number(waited.stdout.trim()),
          });
          const removed = await cli(["container", "rm", invocation.containerId!]);
          if (removed.code !== 0 || removed.stdout.trim() !== invocation.containerId)
            throw new Error("Constrained container removal unproven");
          const absent = await cli(["container", "inspect", invocation.containerId!]);
          if (absent.code === 0 || !absent.stderr.includes("No such container"))
            throw new Error("Constrained container removal unproven");
          invocation.cleanup = {
            containerId: invocation.containerId!,
            exitCode: Number(waited.stdout.trim()),
          };
          emitLifecycle({
            stage: "removed",
            containerId: invocation.containerId!,
            scopeId,
            invocationId: invocation.id,
            exitCode: invocation.cleanup.exitCode,
          });
        })();
        return invocation.terminating;
      };

      const run = async (
        permit: ConstrainedProcessPermit,
        input: string,
      ): Promise<ConstrainedProcessOutput> => {
        check();
        assertRuntime(true);
        const spec = permits.get(permit);
        if (!spec || typeof input !== "string" || Buffer.byteLength(input) > MAX_INPUT)
          throw new Error("Invalid constrained process permit or input");
        spec.resources.assertCurrent();
        const invocation: Invocation = {
          id: randomUUID(),
          name: `codeshell-process-${randomUUID()}`,
          directory: "",
        };
        invocation.directory = join(scratch, invocation.id);
        mkdirSync(invocation.directory, { mode: 0o700 });
        const code = join(invocation.directory, "code");
        const resources = join(invocation.directory, "resources");
        mkdirSync(code, { mode: 0o755 });
        mkdirSync(resources, { mode: 0o755 });
        writeFileSync(join(code, "bootstrap.mjs"), BOOTSTRAP, { mode: 0o444 });
        for (const resource of spec.resources.resources) {
          const target = join(resources, resource.name);
          mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
          writeFileSync(target, resource.bytes, { flag: "wx", mode: 0o444 });
        }
        const policy = readFileSync(
          fileURLToPath(new URL("../../data/constrained-process-seccomp.json", import.meta.url)),
        );
        if (sha256(policy) !== POLICY_SHA256) throw new Error("Constrained process policy changed");
        const policyPath = join(invocation.directory, "seccomp.json");
        writeFileSync(policyPath, policy, { mode: 0o600 });
        check();
        const imageResult = await cli(["image", "inspect", config.image]);
        check();
        const image = JSON.parse(imageResult.stdout)?.[0];
        if (
          imageResult.code !== 0 ||
          image?.Id !== config.image ||
          image?.Os !== "linux" ||
          image?.Architecture !== config.architecture ||
          Object.keys(image?.Config?.Volumes ?? {}).length
        )
          throw new Error("Constrained runtime image unavailable");
        invocations.add(invocation);
        try {
          const environment = [
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "HOME=/scratch/home",
            "USERPROFILE=/scratch/home",
            "XDG_CONFIG_HOME=/scratch/config",
            "XDG_DATA_HOME=/scratch/data",
            "XDG_CACHE_HOME=/scratch/cache",
            "XDG_STATE_HOME=/scratch/state",
            "TMPDIR=/scratch/tmp",
            "TMP=/scratch/tmp",
            "TEMP=/scratch/tmp",
            `CODESHELL_HOOK_EVENT=${spec.event}`,
            "CODESHELL_HOOK_CWD=/scratch/work",
            ...(spec.plugin
              ? [
                  "CODESHELL_PLUGIN_ROOT=/resources",
                  "PLUGIN_ROOT=/resources",
                  "CODESHELL_PLUGIN_DATA=/scratch/plugin-data",
                  "PLUGIN_DATA=/scratch/plugin-data",
                ]
              : []),
          ];
          const created = await cli([
            "create",
            "--interactive",
            "--pull=never",
            "--name",
            invocation.name,
            "--label",
            `codeshell.process.scope=${scopeId}`,
            "--label",
            `codeshell.process.invocation=${invocation.id}`,
            "--read-only",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--security-opt",
            `seccomp=${policyPath}`,
            "--pids-limit",
            "32",
            "--memory",
            "192m",
            "--cpus",
            "1",
            "--user",
            "65534:65534",
            "--tmpfs",
            "/scratch:rw,nosuid,nodev,noexec,size=33554432,uid=65534,gid=65534,mode=0700",
            "--workdir",
            "/scratch",
            "--mount",
            `type=bind,source=${code},target=/code,readonly`,
            "--mount",
            `type=bind,source=${resources},target=/resources,readonly`,
            "--entrypoint",
            "/usr/bin/env",
            config.image,
            "-i",
            ...environment,
            config.nodeExecutable,
            "--max-old-space-size=64",
            "/code/bootstrap.mjs",
            spec.command,
            config.nodeExecutableSha256,
            config.nodeExecutable,
          ]);
          invocation.createRejected =
            created.code === 125 &&
            created.stderr.startsWith("invalid argument ") &&
            created.stderr.includes('for "--mount" flag: invalid field ') &&
            created.stderr.includes("must be a key=value pair");
          if (created.code !== 0 || !CONTAINER_ID.test(created.stdout.trim()))
            throw new Error("Constrained process create failed");
          invocation.containerId = created.stdout.trim();
          emitLifecycle({
            stage: "created",
            containerId: invocation.containerId,
            scopeId,
            invocationId: invocation.id,
          });
          const createdState = await inspect(invocation);
          const host = createdState.HostConfig;
          if (
            createdState.Image !== config.image ||
            createdState.Config?.User !== "65534:65534" ||
            host?.ReadonlyRootfs !== true ||
            host?.NetworkMode !== "none" ||
            host?.Privileged !== false ||
            host?.PidMode ||
            host?.IpcMode !== "private" ||
            host?.CapAdd?.length ||
            JSON.stringify(host?.CapDrop) !== '["ALL"]' ||
            host?.PidsLimit !== 32 ||
            host?.Memory !== 201326592 ||
            host?.NanoCpus !== 1000000000 ||
            !host?.SecurityOpt?.includes("no-new-privileges=true") ||
            !host?.SecurityOpt?.includes(
              `seccomp=${JSON.stringify(JSON.parse(policy.toString("utf8")))}`,
            ) ||
            createdState.Mounts?.length !== 2 ||
            !createdState.Mounts.every(
              (mount: any) =>
                mount.Type === "bind" &&
                mount.RW === false &&
                ((mount.Source === code && mount.Destination === "/code") ||
                  (mount.Source === resources && mount.Destination === "/resources")),
            )
          )
            throw new Error("Constrained container policy not applied");
          check();
          assertRuntime(true);
          spec.resources.assertCurrent();
          const output = await cli(["start", "--attach", "--interactive", invocation.containerId], {
            input,
            timeoutMs: spec.timeoutMs,
            observeAbort: true,
            invocation,
          });
          await terminateInvocation(invocation);
          check();
          spec.resources.assertCurrent();
          const boundary = output.stdout.indexOf("\n");
          if (boundary < 0 || boundary > 4096)
            throw new Error("Constrained runtime identity missing");
          const runtime = JSON.parse(output.stdout.slice(0, boundary));
          if (
            runtime.pid !== 1 ||
            runtime.ppid !== 0 ||
            runtime.uid !== 65534 ||
            runtime.executable !== config.nodeExecutable ||
            runtime.sha256 !== config.nodeExecutableSha256 ||
            runtime.capEff !== "0000000000000000" ||
            runtime.capBnd !== "0000000000000000" ||
            runtime.noNewPrivs !== "1" ||
            runtime.seccomp !== "2" ||
            !invocation.cleanup
          )
            throw new Error("Constrained runtime identity mismatch");
          return {
            stdout: output.stdout.slice(boundary + 1),
            stderr: output.stderr,
            receipt: {
              backend: "docker-linux",
              image: config.image,
              policySha256: POLICY_SHA256,
              invocationId: invocation.id,
              containerId: invocation.cleanup.containerId,
              exitCode: invocation.cleanup.exitCode,
              running: false,
              hostPid: 0,
              removed: true,
              resourcesSha256: spec.resources.sha256,
            },
          };
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          await terminateInvocation(invocation).catch((error) => {
            fail(error);
            throw error;
          });
        }
      };

      const scope: ConstrainedProcessScope = {
        run(permit, input) {
          const promise = run(permit, input);
          active.add(promise);
          void promise.finally(() => active.delete(promise)).catch(() => {});
          return promise;
        },
        terminateAndWait() {
          if (closing) return closing;
          cancellation.abort();
          clearInterval(authorityTimer);
          closing = (async () => {
            await Promise.allSettled([...active]);
            const results = await Promise.allSettled([...invocations].map(terminateInvocation));
            if (results.some((result) => result.status === "rejected"))
              throw new Error("Constrained process cleanup unproven");
            rmSync(scratch, { recursive: true, force: true });
            scopes.delete(scope);
          })();
          return closing;
        },
      };
      scopes.add(scope);
      return {
        scope,
        issue(spec) {
          check();
          if (
            typeof spec.command !== "string" ||
            !spec.command ||
            spec.command.length > 32768 ||
            spec.command.includes("\0") ||
            !Number.isSafeInteger(spec.timeoutMs) ||
            spec.timeoutMs < 1 ||
            spec.timeoutMs > 60000 ||
            !/^[a-z_]+$/.test(spec.event)
          )
            throw new Error("Invalid constrained process specification");
          const resources = spec.resources
            ? resourceTokens.get(spec.resources)
            : captureResources([]);
          if (!resources) throw new Error("Foreign constrained resource capability");
          resources.assertCurrent();
          issuedResources.add(resources);
          const permit = Object.freeze({}) as ConstrainedProcessPermit;
          permits.set(permit, {
            command: spec.command,
            timeoutMs: spec.timeoutMs,
            event: spec.event,
            plugin: spec.plugin === true,
            resources,
          });
          return permit;
        },
      };
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled(
        [...scopes].map((scope) => scope.terminateAndWait()),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Constrained runtime cleanup unproven");
    },
  };
}
