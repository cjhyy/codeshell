import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "../helpers/network-fixture.ts";
const guard = installFixtureNetworkGuard();
const { ResidentAgentProcess } =
  await import("../../packages/server/src/mobile-remote/resident-agent.ts");
const { CodexRoomAgent } =
  await import("../../packages/server/src/mobile-remote/codex-room-agent.ts");
const { execFileNoThrow } = await import("../../packages/core/src/utils/execFileNoThrow.ts");
const { runCliLinkCommand } = await import("../../packages/core/src/links/cli.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Native fixture timed out");
    await sleep(10);
  }
};
const root = process.cwd();
const holdersPath = join(root, "holders");
const command = join(root, "fake-cli");
// The CLI backgrounds a grandchild that inherits stdout/stderr, then exits.
const script = `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const holder = spawn("sleep", ["30"], { stdio: "inherit" });
appendFileSync("holders", holder.pid + "\\n");
holder.unref();
if (process.argv.includes("exec")) {
  process.stdout.write(JSON.stringify({type:"turn.completed"}) + "\\n");
} else {
  process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"bye"}]}}) + "\\n");
}
`;
writeFileSync(command, "#!" + process.execPath + "\n" + script, { mode: 0o755 });
const big = "x".repeat(8 * 1024 * 1024);
const exitsWithoutReading = ["-e", "process.stdout.write('ok')"];
try {
  // Native Node reports EPIPE here; Bun does not, so only this run guards it.
  assert.deepEqual(
    await execFileNoThrow(process.execPath, exitsWithoutReading, { input: big, timeout: 5000 }),
    { code: 0, stdout: "ok", stderr: "" },
  );
  const linked = await runCliLinkCommand("github", process.execPath, exitsWithoutReading, {
    timeoutMs: 5000,
    input: big,
  });
  assert.equal(linked.stdout, "ok");

  const residentEvents = [];
  const resident = new ResidentAgentProcess({
    command,
    cwd: root,
    permissionMode: "default",
    onEvent: (event) => residentEvents.push(event),
  });
  resident.start();
  await waitFor(() => residentEvents.some((event) => event.type === "exit"));
  assert.ok(residentEvents.some((event) => event.type === "text" && event.text === "bye"));
  assert.equal(resident.isRunning(), false);

  const codexEvents = [];
  const codex = new CodexRoomAgent({
    command,
    cwd: root,
    permissionMode: "default",
    onEvent: (event) => codexEvents.push(event),
  });
  codex.start();
  assert.equal(codex.send("first"), true);
  await waitFor(() => codexEvents.some((event) => event.type === "turn_end"));
  // A held pipe would leave the turn's child installed and refuse every send.
  await waitFor(() => codex.send("second"));
  await waitFor(() => codexEvents.filter((event) => event.type === "turn_end").length === 2);
  codex.stop();
  assert.equal(codexEvents.filter((event) => event.type === "error").length, 0);
  console.log(JSON.stringify({ ok: true, residentExited: true, codexTurns: 2 }));
} finally {
  if (existsSync(holdersPath)) {
    for (const pid of readFileSync(holdersPath, "utf8").trim().split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
  }
  guard.restore();
}
