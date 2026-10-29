import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawnServiceProcess, type ServiceProcess } from "../background-service-process.js";
import {
  darwinProcessStart,
  identityStatus,
  processIdentity,
  type ServiceIdentityInspector,
} from "../background-service-store.js";

// Desktop runs this boundary in Node. Running the actual guardian/FD3 tests in
// Node also avoids Bun's Linux descriptor-cache interference between suites.
// Darwin's boot probe is a policy seam; native start identity, signals and group
// confirmation stay real. Linux uses the production /proc identity unchanged.
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

const [scenario, root] = process.argv.slice(2);
assert(root);
let actual: ServiceProcess | undefined;
try {
  const cwd = join(root, "data"),
    entry = join(root, "entry.mjs");
  await mkdir(cwd);
  const source =
    scenario === "guardian-loss"
      ? `import{createInterface}from'node:readline';
setInterval(()=>{},1000);createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.t==='hello')console.log(JSON.stringify({t:'ready'}));if(m.t==='poke')process.kill(process.ppid,'SIGKILL')});`
      : `import fs from'node:fs';process.stdin.once('data',()=>{
const frame=Buffer.from(JSON.stringify({t:'member',pid:process.pid})+String.fromCharCode(10));
const attack={attempted:true,lastByte:frame.at(-1),frameBytes:frame.length};
try{attack.written=fs.writeSync(3,frame);}catch(error){attack.error=error.code??error.name;}
console.log(JSON.stringify({t:'ready',attack}));process.exit(0)});`;
  assert(["guardian-loss", "custody-fd"].includes(scenario!));
  await writeFile(entry, source);
  let ready!: () => void;
  const readySignal = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const exits: Array<string | undefined> = [],
    messages: unknown[] = [],
    inspected: number[] = [];
  actual = await spawnServiceProcess(
    {
      executable: process.execPath,
      entry,
      packageRoot: root,
      cwd,
      sha256: createHash("sha256").update(source).digest("hex"),
      maxLineBytes: 4096,
      onLine(message: any) {
        messages.push(message);
        if (message.t === "ready") ready();
      },
      onExit(error) {
        exits.push(error);
      },
    },
    {
      identities: {
        current(pid) {
          inspected.push(pid);
          return identities.current(pid);
        },
        status: identities.status,
      },
    },
  );
  // The actual patched Node is probed, never a substituted security floor.
  // Linux may reuse descriptor number 3 for epoll; compare the kernel object.
  const custodyFd =
    scenario === "custody-fd" && process.platform === "linux"
      ? await stat(`/proc/${actual.identity.pid}/fd/3`)
      : null;
  const member = await actual.prepare();
  assert.equal(identities.status(member), "alive");
  assert.deepEqual(inspected, [actual.identity.pid, member.pid]);
  if (custodyFd) {
    const memberFd = await stat(`/proc/${member.pid}/fd/3`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    assert.notEqual(
      memberFd && `${memberFd.dev}:${memberFd.ino}`,
      `${custodyFd.dev}:${custodyFd.ino}`,
    );
  }
  // Both verified identities exist before the package entry may execute.
  assert.deepEqual(messages, []);
  actual.activate({ t: "hello" });
  if (scenario === "guardian-loss") {
    await readySignal;
    actual.send({ t: "poke" });
  }
  await actual.exited;
  // A close receipt is not member death. Terminate owns the bounded OS-status
  // barrier after sending SIGKILL; an unknown group is a failed safety proof.
  const confirmed = await actual.terminate(0);
  assert.equal(confirmed, true, "native process group death must be confirmed");
  assert.equal(identities.current(member.pid), null);
  if (scenario === "guardian-loss") assert(exits.includes("SERVICE_CUSTODY_LEADER_EXITED"));
  let attack: Record<string, unknown> | undefined;
  if (scenario === "guardian-loss") assert.deepEqual(messages, [{ t: "ready" }]);
  else {
    assert.equal(messages.length, 1);
    const message = messages[0] as { t: string; attack: Record<string, unknown> };
    assert.equal(message.t, "ready");
    attack = message.attack;
    assert.equal(attack.attempted, true);
    assert.equal(attack.lastByte, 10, "the attempted custody frame must end in LF");
    // FD 3 may be a harmless reused runtime descriptor or /dev/null. Whether
    // writing fails or succeeds there, it must never reach the custody reader.
    if (typeof attack.written === "number") assert.equal(attack.written, attack.frameBytes);
    else assert.equal(typeof attack.error, "string");
  }
  assert.equal(inspected.length, 2);
  process.stdout.write(JSON.stringify({ scenario, confirmed, memberDead: true, attack }) + "\n");
} finally {
  await actual?.terminate(0);
}
