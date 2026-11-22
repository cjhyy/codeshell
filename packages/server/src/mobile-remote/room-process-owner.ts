import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { setRoomProcessReadiness, stopRoomProcess } from "./room-process-stop.js";

export type RoomProcessLauncher = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
function existsProcess(id: number) {
  if (!Number.isSafeInteger(id) || id < 2) return true;
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function remove(path: string) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function recordedPid(path: string) {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function canReclaim(path: string) {
  const child = recordedPid(path + ".child");
  if (child === undefined) {
    // The child waits on a pipe. Without the published child pid the old
    // launcher could not have given it permission to exec.
    const owner = recordedPid(path);
    return owner !== undefined && !existsProcess(owner);
  }
  if (existsProcess(child)) return false;
  if (process.platform === "win32" && existsSync(path + ".executing")) {
    const physical = recordedPid(path + ".physical");
    return physical !== undefined && !existsProcess(physical);
  }
  return true;
}
function clearClaim(path: string) {
  // Filenames are unique per attempt; concurrent reclaimers cannot touch a successor.
  remove(path);
  for (const suffix of [".child", ".executing", ".physical"]) remove(path + suffix);
}
function executable(command: string, options: SpawnOptions) {
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const paths = command.includes("/")
    ? [resolve(cwd, command)]
    : (options.env?.PATH ?? process.env.PATH ?? "")
        .split(delimiter)
        .map((dir) => resolve(cwd, dir, command));
  for (const path of paths)
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      /* Continue PATH lookup. */
    }
  throw Error(`未找到可执行命令 "${command}"。`);
}
// Fixed program and separate argv. No commands, file paths or user input are
// interpolated into shell source. exec preserves the lease's exact child pid.
const posixGate = 'IFS= read -r permit <&3 && [ "$permit" = go ] || exit 1; exec 3<&-; exec "$@"';
// Windows has no execve. Keep a guard and publish the real CLI pid before
// reporting startup. A lost parent closes IPC; the guard retires its child.
const windowsGate = String.raw`
const {spawn}=require("node:child_process");
const fs=require("node:fs");
const paths=JSON.parse(process.env.CODESHELL_ROOM_OWNER_FILES);
const env={...process.env};
delete env.CODESHELL_ROOM_OWNER_FILES;
delete env.ELECTRON_RUN_AS_NODE;
let cli;
process.on("disconnect",()=>{if(cli)cli.kill();else process.exit(1);});
process.on("message",msg=>{
  if(msg==="stop"){if(cli)cli.kill();else process.exit(0);return;}
  if(cli)return;
  if(msg!=="go")process.exit(1);
  for(const file of paths)fs.writeFileSync(file+".executing","1",{flag:"wx"});
  cli=spawn(process.argv[1],process.argv.slice(2),{env,stdio:"inherit",windowsHide:true});
  if(cli.pid)for(const file of paths)fs.writeFileSync(file+".physical",String(cli.pid),{flag:"wx"});
  cli.once("spawn",()=>{if(process.connected)process.send("started");});
  cli.once("error",error=>{
    if(process.connected)process.send({error:error.message});
    for(const file of paths)fs.rmSync(file+".executing",{force:true});
    process.exitCode=1;if(process.connected)process.disconnect();
  });
  cli.once("exit",code=>{process.exit(code??1);});
});
`;

/** A claim is visible before it competes, so concurrent launches may both
 * back off but never both run. Its pid is durable before the CLI is released. */
export function roomProcessLauncher(directory: string, identities: string[]): RoomProcessLauncher {
  const scopes = [...new Set(identities)].map((key) =>
    join(directory, createHash("sha256").update(key).digest("hex")),
  );
  return (command, args, options) => {
    const windows = process.platform === "win32";
    const path = windows ? command : executable(command, options);
    const token = randomUUID(),
      claims: string[] = [];
    const release = () => {
      for (const path of claims) clearClaim(path);
    };
    let child: ChildProcess;
    try {
      for (const dir of scopes) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const own = join(dir, token + ".owner");
        const temp = join(dir, token + ".tmp");
        writeFileSync(temp, String(process.pid), { flag: "wx", mode: 0o600 });
        try {
          linkSync(temp, own);
          claims.push(own);
        } finally {
          remove(temp);
        }
        for (const entry of readdirSync(dir)) {
          const prior = join(dir, entry);
          if (!entry.endsWith(".owner") || prior === own || !existsSync(prior)) continue;
          if (canReclaim(prior)) {
            clearClaim(prior);
            continue;
          }
          throw Error("此房间的上一个 CLI 进程尚未确认退出，暂时无法重新启动。");
        }
      }
      child = windows
        ? spawn(process.execPath, ["-e", windowsGate, "--", path, ...args], {
            ...options,
            env: {
              ...options.env,
              ELECTRON_RUN_AS_NODE: "1",
              CODESHELL_ROOM_OWNER_FILES: JSON.stringify(claims),
            },
            stdio: ["pipe", "pipe", "pipe", "ipc"],
          })
        : spawn("/bin/sh", ["-c", posixGate, "codeshell-room", path, ...args], {
            ...options,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          });
    } catch (error) {
      release();
      throw error;
    }
    const done = () => {
      for (const path of claims)
        try {
          if (!windows || !existsSync(path + ".executing") || canReclaim(path)) clearClaim(path);
        } catch {
          /* The next owner can reclaim a proven exit. */
        }
    };
    child.once("error", () => {
      if (child.pid === undefined) done();
    });
    child.once("exit", done);
    if (child.pid === undefined) return child;
    try {
      for (const file of claims)
        writeFileSync(file + ".child", String(child.pid), { flag: "wx", mode: 0o600 });
      if (windows) {
        const started = new Promise<void>((resolve, reject) => {
          const message = (msg: unknown) => {
            if (msg === "started") resolve();
            else reject(Error("房间 CLI 未能启动。"));
          };
          child.once("message", message);
          child.once("exit", () => {
            child.off("message", message);
            reject(Error("房间 CLI 启动时已结束。"));
          });
          child.once("error", reject);
        });
        setRoomProcessReadiness(child, started);
        child.send!("go");
      } else {
        const gate = child.stdio[3] as Writable;
        gate.on("error", () => {
          /* The guard already exited. */
        });
        gate.end("go\n");
      }
    } catch (error) {
      stopRoomProcess(child);
      throw error;
    }
    return child;
  };
}
