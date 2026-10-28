import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { verifyProcessEntry } from "./process-entry.js";
import { groupStatus, type ServiceProcessIdentity } from "./background-service-store.js";

// The guardian cannot execute package code until the Host has durably recorded its
// PID/start identity and sends go. An EOF before go cannot leave an unrecorded worker.
const GUARDIAN = String.raw`
const { spawn } = require('node:child_process');
const nonce = require('node:crypto').randomUUID();
process.stdout.write(JSON.stringify({t:'custody',pid:process.pid,nonce})+'\n');
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
  child = spawn(command.executable, command.args, { cwd: command.cwd, env: command.env, stdio: ['pipe','pipe','pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.on('error', () => process.exit(2));
  child.on('exit', (code) => process.exit(code ?? 1));
  const rest = first.slice(end + 1); first = ''; if (rest) child.stdin.write(rest);
});
process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
`;
const permissionFlags = new Map<string, string[]>();
function sandboxFlags(executable: string): string[] {
  let flags = permissionFlags.get(executable);
  if (flags) return flags;
  const help = execFileSync(executable, ["--help"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 512 * 1024,
  });
  const flag = help.includes("--permission ")
    ? "--permission"
    : help.includes("--experimental-permission")
      ? "--experimental-permission"
      : null;
  if (!flag) throw new Error("SERVICE_NODE_PERMISSION_UNAVAILABLE");
  flags = [flag, ...(help.includes("--allow-net") ? ["--allow-net"] : [])];
  // Never enable allow-child-process, worker, addons, WASI or inspector: the
  // reviewed service is a single native Node process, with no escaping descendants.
  permissionFlags.set(executable, flags);
  return flags;
}
export interface ServiceProcess {
  identity: ServiceProcessIdentity;
  send(message: unknown): void;
  activate(hello: unknown): void;
  terminate(timeoutMs: number): Promise<boolean>;
  exited: Promise<void>;
}
export async function spawnServiceProcess(input: {
  executable: string;
  entry: string;
  sha256: string;
  packageRoot: string;
  cwd: string;
  maxLineBytes: number;
  onLine(message: unknown): void;
  onExit(error?: string): void;
}): Promise<ServiceProcess> {
  if (process.platform === "win32") throw new Error("SERVICE_PROCESS_IDENTITY_UNSUPPORTED");
  const flags = sandboxFlags(input.executable);
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
    stdio: ["pipe", "pipe", "pipe"],
  });
  let custodyResolve!: (identity: ServiceProcessIdentity) => void;
  let custodyReject!: (error: Error) => void;
  const custody = new Promise<ServiceProcessIdentity>((resolve, reject) => {
    custodyResolve = resolve;
    custodyReject = reject;
  });
  let failure: string | undefined;
  let pending = Buffer.alloc(0),
    stderr = Buffer.alloc(0);
  let rateAt = Date.now(),
    rateBytes = 0,
    rateLines = 0;
  let activated = false,
    ended = false;
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
        if (
          !activated &&
          message.t === "custody" &&
          message.pid === child.pid &&
          /^[a-f0-9-]{36}$/.test(message.nonce)
        )
          custodyResolve({ pid: message.pid, start: `custody:${message.nonce}`, host: hostname() });
        else input.onLine(message);
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
  child.on("close", (code) => {
    ended = true;
    custodyReject(new Error("SERVICE_CUSTODY_EXITED"));
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
    if (!ended && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await exited;
    throw error;
  } finally {
    if (custodyTimer) clearTimeout(custodyTimer);
  }
  const send = (message: unknown) => {
    if (ended || !child.stdin!.writable) return;
    const bytes = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(bytes) > 5 * 1024 * 1024 || child.stdin!.writableLength > 128 * 1024)
      throw new Error("SERVICE_STDIN_LIMIT");
    child.stdin!.write(bytes);
  };
  return {
    identity,
    exited,
    send,
    activate(hello) {
      if (activated) throw new Error("SERVICE_ALREADY_ACTIVATED");
      activated = true;
      send({
        t: "go",
        executable: input.executable,
        args: [
          ...flags,
          `--allow-fs-read=${input.packageRoot}`,
          `--allow-fs-read=${input.cwd}`,
          `--allow-fs-write=${input.cwd}`,
          input.entry,
        ],
        cwd: input.cwd,
        env,
      });
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
      if (ended || child.pid !== identity.pid) return false;
      try {
        process.kill(-identity.pid, "SIGKILL");
      } catch {
        /* confirm below */
      }
      await exited;
      return groupStatus(identity.pid) === "dead";
    },
  };
}
