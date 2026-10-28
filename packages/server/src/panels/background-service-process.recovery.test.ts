import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { spawnServiceProcess, type ServiceProcess } from "./background-service-process.js";
import {
  darwinProcessStart,
  identityStatus,
  processIdentity,
  groupStatus,
  type ServiceIdentityInspector,
} from "./background-service-store.js";
import { resolvePanelExecutable } from "./process-service.js";

// The boot UUID/probe policy boundaries are injected only for this owned-process
// fault test. Real libproc start identity, guardian IPC, permission flags, signals,
// process-group supervision and exit confirmation remain production code.
const identities: ServiceIdentityInspector = {
  current(pid) {
    if (process.platform !== "darwin") return processIdentity(pid);
    const start = darwinProcessStart(pid);
    return start ? { pid, start, boot: "owned-test-boot", host: hostname() } : null;
  },
  status(value) {
    return identityStatus(value, identities.current);
  },
};
test("guardian kill cannot orphan a native member that ignores EOF", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "service-guardian-loss-")));
  let actual: ServiceProcess | undefined;
  try {
    const cwd = join(root, "data"),
      entry = join(root, "entry.mjs");
    await mkdir(cwd);
    const source = `import{createInterface}from'node:readline';
setInterval(()=>{},1000);createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.t==='hello')console.log(JSON.stringify({t:'ready'}));if(m.t==='poke')process.kill(process.ppid,'SIGKILL')});`;
    await writeFile(entry, source);
    let ready!: () => void;
    const readySignal = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const exits: Array<string | undefined> = [];
    actual = await spawnServiceProcess(
      {
        executable: (await resolvePanelExecutable("node"))!,
        entry,
        packageRoot: root,
        cwd,
        sha256: createHash("sha256").update(source).digest("hex"),
        maxLineBytes: 4096,
        onLine(message: any) {
          if (message.t === "ready") ready();
        },
        onExit(error) {
          exits.push(error);
        },
      },
      { identities, probeRuntime: async () => ["--permission"] },
    );
    const member = await actual.prepare();
    expect(identities.status(member)).toBe("alive");
    actual.activate({ t: "hello" });
    await readySignal;
    actual.send({ t: "poke" });
    await actual.exited;
    expect(exits).toContain("SERVICE_CUSTODY_LEADER_EXITED");
    // Pipes closed and the previously observed kernel member identity disappeared.
    // Restricted hosts may return EPERM rather than ESRCH for a negative PGID;
    // production must preserve unconfirmed state in that case, never assert death.
    expect(identities.current(member.pid)).toBeNull();
    const status = groupStatus(actual.identity.pid);
    expect(status).not.toBe("alive");
    expect(await actual.terminate(0)).toBe(status === "dead");
  } finally {
    await actual?.terminate(0);
    await rm(root, { recursive: true, force: true });
  }
});
