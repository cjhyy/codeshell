import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { verifyProcessEntry } from "./process-entry.js";
import {
  groupStatus,
  serviceIdentityInspector,
  type ServiceProcessIdentity,
  type ServiceIdentityInspector,
} from "./background-service-store.js";

// The guardian cannot execute package code until the Host has durably recorded its
// PID/start identity and sends go. An EOF before go cannot leave an unrecorded worker.
const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
const nonce = require('node:crypto').randomUUID();
const control = require('node:fs');
control.writeSync(3,JSON.stringify({t:'custody',pid:process.pid,nonce})+'\n');
let child, first = '', started = false, ending = false;
const stop = () => {
  if (ending) return; ending = true;
  if (!child) process.exit(0);
  child.stdin.end();
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 1800);
};
process.stdin.on('data', (chunk) => {
  if (started) {
    if (!ending && child?.stdin.writable && !child.stdin.write(chunk)) { process.stdin.pause(); child.stdin.once('drain', () => process.stdin.resume()); }
    return;
  }
  first += chunk.toString();
  const end = first.indexOf('\n');
  if ((end < 0 && first.length > 131072) || end > 131072) process.exit(2);
  if (end < 0) return;
  const command = JSON.parse(first.slice(0, end));
  if (command.t !== 'go') process.exit(2);
  started = true;
  // FD 3 is custody-only. Explicit ignore prevents any inherited channel even
  // on platforms whose spawn implementation keeps extra descriptors open.
  child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, stdio: ['pipe','pipe','pipe','ignore'] });
  control.writeSync(3,JSON.stringify({t:'member',pid:child.pid})+'\n');
  control.closeSync(3);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('error', () => process.exit(2));
  child.on('exit', (code) => process.exit(code ?? 1));
  const rest = first.slice(end + 1); first = ''; if (rest) child.stdin.write(rest);
});
process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
`;
const execute = promisify(execFile);
const permissionFlags = new Map<string, { until: number; result: Promise<string[]> }>();
// Latest supported security baselines at 2026-10-28. No EOL odd-major or experimental Node20.
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
export function safeServiceNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const minimum = new Map([
    [22, [23, 4]],
    [24, [22, 1]],
    [26, [12, 1]],
  ]).get(major!);
  return !!minimum && (minor! > minimum[0]! || (minor === minimum[0] && patch! >= minimum[1]!));
}
export async function probeServiceRuntime(executable: string): Promise<string[]> {
  const info = await stat(executable);
  const key = `${executable}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  const cached = permissionFlags.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const entry = { until: Infinity, result: Promise.resolve([] as string[]) };
  entry.result = (async () => {
    const { stdout: version } = await execute(executable, ["--version"], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (!safeServiceNodeVersion(version))
      throw new Error("SERVICE_NODE_SECURITY_VERSION_REQUIRED:22.23.4/24.22.1/26.12.1");
    const { stdout: help } = await execute(executable, ["--help"], {
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    if (!help.includes("--permission ")) throw new Error("SERVICE_NODE_PERMISSION_UNAVAILABLE");
    return ["--permission", ...(help.includes("--allow-net") ? ["--allow-net"] : [])];
  })();
  permissionFlags.set(key, entry);
  if (permissionFlags.size > 64) permissionFlags.delete(permissionFlags.keys().next().value!);
  void entry.result.then(
    () => {
      entry.until = Date.now() + 600_000;
    },
    () => {
      entry.until = Date.now() + 300_000;
    },
  );
  return entry.result;
}
// The package cannot run before its second, native member identity is durable.
// Keep hello buffered until the reviewed entry has an actual consumer. Explicit
// pause survives adding a data listener, including one before a top-level await;
// waiting for import() to finish before resuming would deadlock that entry.
const BOOTSTRAP = String.raw`let bytes=Buffer.alloc(0);const begin=chunk=>{
bytes=Buffer.concat([bytes,chunk]);const end=bytes.indexOf(10);
if(end<0){if(bytes.length>4096)process.exit(2);return;}
process.stdin.off('data',begin);process.stdin.pause();
if(JSON.parse(bytes.subarray(0,end)).t!=='start')process.exit(2);
const rest=bytes.subarray(end+1);if(rest.length)process.stdin.unshift(rest);
const resumeForData=event=>{if(event==='data')queueMicrotask(()=>{
if(process.stdin.listenerCount('data')){process.stdin.off('newListener',resumeForData);process.stdin.resume();}
});};
process.stdin.on('newListener',resumeForData);
process.stdin.once('close',()=>process.stdin.off('newListener',resumeForData));
import(require('node:url').pathToFileURL(process.argv[1]).href).catch(error=>{console.error(error);process.exit(2)});
};process.stdin.on('data',begin);`;
export interface ServiceProcess {
  identity: ServiceProcessIdentity;
  send(message: unknown): void;
  prepare(): Promise<ServiceProcessIdentity>;
  activate(hello: unknown): void;
  terminate(timeoutMs: number): Promise<boolean>;
  exited: Promise<void>;
}
/** This private guardian protocol has exactly two messages and one total byte
 * budget, not an ever-growing line buffer. Reject before any identity syscall. */
export function readServiceCustody(
  stream: Readable,
  guardianPid: number,
  identities: ServiceIdentityInspector,
) {
  let custodyResolve!: (identity: ServiceProcessIdentity) => void;
  let custodyReject!: (error: Error) => void;
  let memberResolve!: (identity: ServiceProcessIdentity) => void;
  let memberReject!: (error: Error) => void;
  const custody = new Promise<ServiceProcessIdentity>((resolve, reject) => {
    custodyResolve = resolve;
    custodyReject = reject;
  });
  const member = new Promise<ServiceProcessIdentity>((resolve, reject) => {
    memberResolve = resolve;
    memberReject = reject;
  });
  void custody.catch(() => {});
  void member.catch(() => {});
  let phase: "custody" | "member" | "closed" = "custody";
  let pending = Buffer.alloc(0),
    total = 0;
  let verifiedMember: ServiceProcessIdentity | undefined;
  const close = (error?: Error) => {
    if (phase === "closed") return;
    phase = "closed";
    pending = Buffer.alloc(0);
    stream.off("data", receive);
    stream.off("end", ended);
    stream.off("close", ended);
    // A destroy/error may already be queued by the pipe. Keep its single error
    // consumer until close so rejecting custody cannot become an unhandled event.
    stream.once("close", () => stream.off("error", failed));
    if (error) {
      custodyReject(error);
      memberReject(error);
    }
    stream.destroy();
  };
  const ended = () => close(new Error("SERVICE_CUSTODY_EXITED"));
  const failed = () => close(new Error("SERVICE_CUSTODY_IO"));
  const receive = (chunk: Buffer) => {
    if (phase === "closed") return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length > 8192 - total) {
      close(new Error("SERVICE_CUSTODY_LIMIT"));
      return;
    }
    total += bytes.length;
    pending = Buffer.concat([pending, bytes]);
    while (true) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const value = JSON.parse(line.toString("utf8"));
        if (
          !value ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 0 ||
          (phase === "custody"
            ? value.t !== "custody" ||
              value.pid !== guardianPid ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.nonce) ||
              Object.keys(value).length !== 3
            : value.t !== "member" || value.pid === guardianPid || Object.keys(value).length !== 2)
        )
          throw new Error("SERVICE_CUSTODY_INVALID");
        const identity = identities.current(value.pid);
        if (!identity || identity.pid !== value.pid)
          throw new Error("SERVICE_IDENTITY_UNAVAILABLE");
        if (phase === "custody") {
          phase = "member";
          custodyResolve(identity);
        } else {
          verifiedMember = identity;
          memberResolve(identity);
          close();
          return;
        }
      } catch (error) {
        close(error instanceof Error ? error : new Error("SERVICE_CUSTODY_INVALID"));
        return;
      }
    }
  };
  stream.on("data", receive);
  stream.once("end", ended);
  stream.once("close", ended);
  stream.once("error", failed);
  return {
    custody,
    member,
    close,
    get memberIdentity() {
      return verifiedMember;
    },
    get retainedBytes() {
      return pending.length;
    },
  };
}
export async function spawnServiceProcess(
  input: {
    executable: string;
    entry: string;
    sha256: string;
    packageRoot: string;
    cwd: string;
    maxLineBytes: number;
    onLine(message: unknown): void;
    onExit(error?: string): void;
  },
  adapters: {
    /** Explicit OS/runtime boundaries for owned-process fault tests; never guest supplied. */
    identities?: ServiceIdentityInspector;
    probeRuntime?: typeof probeServiceRuntime;
  } = {},
): Promise<ServiceProcess> {
  const identities = adapters.identities ?? serviceIdentityInspector;
  if (process.platform === "win32") throw new Error("SERVICE_PROCESS_IDENTITY_UNSUPPORTED");
  const flags = await (adapters.probeRuntime ?? probeServiceRuntime)(input.executable);
  await verifyProcessEntry(input.entry, input.sha256);
  const env = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [],
    ),
  );
  // A new group is solely for bounded custody/termination; it is never unref'd.
  const child: ChildProcess = spawn(input.executable, ["-e", GUARDIAN], {
    cwd: input.cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const custodyChannel = readServiceCustody(child.stdio[3] as Readable, child.pid!, identities);
  const { custody, member } = custodyChannel;
  let failure: string | undefined;
  let pending = Buffer.alloc(0),
    stderr = Buffer.alloc(0);
  let rateAt = Date.now(),
    rateBytes = 0,
    rateLines = 0;
  let activated = false,
    ended = false,
    leaderExited = false;
  child.stdin!.on("error", () => {});
  const fail = (reason: string) => {
    failure = reason;
    child.stdin!.end();
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    if (failure) return;
    const now = Date.now();
    if (now - rateAt >= 1000) {
      rateAt = now;
      rateBytes = 0;
      rateLines = 0;
    }
    rateBytes += chunk.length;
    if (rateBytes > 2 * 1024 * 1024) return fail("SERVICE_OUTPUT_RATE");
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > input.maxLineBytes || ++rateLines > 64) return fail("SERVICE_OUTPUT_LIMIT");
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const message = JSON.parse(line.toString("utf8"));
        input.onLine(message);
      } catch {
        return fail("SERVICE_INVALID_LINE");
      }
    }
    if (pending.length > input.maxLineBytes) fail("SERVICE_OUTPUT_LINE_TOO_LARGE");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    if (failure) return;
    const now = Date.now();
    if (now - rateAt >= 1000) {
      rateAt = now;
      rateBytes = 0;
      rateLines = 0;
    }
    rateBytes += chunk.length;
    if (rateBytes > 2 * 1024 * 1024) return fail("SERVICE_OUTPUT_RATE");
    stderr = Buffer.concat([stderr, chunk]).subarray(-64 * 1024);
  });
  let exitResolve!: () => void;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  child.on("error", (error) => {
    failure = error.message;
  });
  child.on("exit", () => {
    leaderExited = true;
    if (child.pid && groupStatus(child.pid) !== "dead")
      input.onExit("SERVICE_CUSTODY_LEADER_EXITED");
    // A killed guardian does not release custody: the separately authenticated
    // native member proves this process group is still ours, even after leader reap.
    if (
      custodyChannel.memberIdentity &&
      identities.status(custodyChannel.memberIdentity) === "alive"
    ) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* recovery remains conservative */
      }
    }
  });
  child.on("close", (code) => {
    ended = true;
    custodyChannel.close(new Error("SERVICE_CUSTODY_EXITED"));
    exitResolve();
    input.onExit(
      failure ?? (code ? `Service exited ${code}: ${stderr.toString().slice(-2048)}` : undefined),
    );
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let custodyTimer: ReturnType<typeof setTimeout> | undefined;
  let identity: ServiceProcessIdentity;
  try {
    identity = await Promise.race([
      custody,
      new Promise<never>((_resolve, reject) => {
        custodyTimer = setTimeout(() => reject(new Error("SERVICE_CUSTODY_TIMEOUT")), 10_000);
      }),
    ]);
  } catch (error) {
    // This exact ChildProcess has not closed, so its PID has not been reaped/reused.
    if (!leaderExited && !ended && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 2000);
      }),
    ]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    throw error;
  } finally {
    if (custodyTimer) clearTimeout(custodyTimer);
  }
  const send = (message: unknown) => {
    if (leaderExited || ended || !child.stdin!.writable) return;
    const bytes = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(bytes) > 5 * 1024 * 1024 || child.stdin!.writableLength > 128 * 1024)
      throw new Error("SERVICE_STDIN_LIMIT");
    child.stdin!.write(bytes);
  };
  return {
    identity,
    exited,
    send,
    async prepare() {
      send({
        t: "go",
        executable: input.executable,
        args: [
          ...flags,
          `--allow-fs-read=${input.packageRoot}`,
          `--allow-fs-read=${input.cwd}`,
          `--allow-fs-write=${input.cwd}`,
          "-e",
          BOOTSTRAP,
          input.entry,
        ],
        cwd: input.cwd,
        env,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          member,
          new Promise<never>((_r, reject) => {
            timer = setTimeout(() => reject(new Error("SERVICE_MEMBER_TIMEOUT")), 10_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    activate(hello) {
      if (activated) throw new Error("SERVICE_ALREADY_ACTIVATED");
      if (!custodyChannel.memberIdentity) throw new Error("SERVICE_MEMBER_UNCONFIRMED");
      activated = true;
      send({ t: "start" });
      send(hello);
    },
    async terminate(timeoutMs) {
      if (!ended) {
        try {
          send({ t: "drain" });
        } catch {
          /* still terminate custody */
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (groupStatus(identity.pid) === "dead") return true;
      // Only this still-live verified leader proves ownership of the group. If its
      // identity cannot be checked, preserve stop-unconfirmed and never guess/kill.
      if (
        (leaderExited || ended || child.pid !== identity.pid) &&
        (!custodyChannel.memberIdentity ||
          identities.status(custodyChannel.memberIdentity) !== "alive")
      )
        return false;
      try {
        process.kill(-identity.pid, "SIGKILL");
      } catch {
        /* confirm below */
      }
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          forceTimer = setTimeout(resolve, 2000);
        }),
      ]);
      if (forceTimer) clearTimeout(forceTimer);
      return groupStatus(identity.pid) === "dead";
    },
  };
}
