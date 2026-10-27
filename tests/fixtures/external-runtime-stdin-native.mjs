import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installFixtureNetworkGuard } from "../helpers/network-fixture.ts";
const guard = installFixtureNetworkGuard();
const { ResidentAgentProcess } =
  await import("../../packages/server/src/mobile-remote/resident-agent.ts");
const { CodexRoomAgent } =
  await import("../../packages/server/src/mobile-remote/codex-room-agent.ts");
const { CodexAppServerClient } =
  await import("../../packages/coding/src/external-runtimes/codex/app-server-client.ts");
const { ClaudeCodeRuntime } =
  await import("../../packages/coding/src/external-runtimes/claude-code/runtime.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Native fixture timed out");
    await sleep(10);
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const root = process.cwd();
const marker = join(root, "healthy");
const pidsPath = join(root, "pids");
const command = join(root, "fake-cli");
const script = `
import { closeSync, existsSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync("pids", process.pid + "\\n");
if (!existsSync("healthy")) {
  process.on("SIGTERM", () => {});
  closeSync(0);
  setInterval(() => {}, 1000);
} else if (process.argv.includes("-p")) {
  process.stdin.resume();
  process.stdin.on("end", () => {
    console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"recovered"}));
  });
} else if (process.argv.includes("exec")) {
  process.stdin.resume();
  process.stdin.on("end", () => {
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"recovered"}}));
    console.log(JSON.stringify({type:"turn.completed"}));
  });
} else {
  createInterface({input:process.stdin}).on("line", line => {
    const input = JSON.parse(line);
    if (input.id !== undefined) console.log(JSON.stringify({id:input.id,result:{pong:true}}));
    else console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"recovered"}]}}));
  });
}
`;
writeFileSync(command, "#!" + process.execPath + "\n" + script, { mode: 0o755 });
const children = () =>
  existsSync(pidsPath)
    ? readFileSync(pidsPath, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : [];
try {
  for (const Agent of [ResidentAgentProcess, CodexRoomAgent]) {
    rmSync(marker, { force: true });
    const events = [];
    const previous = children().length;
    const agent = new Agent({
      command,
      cwd: root,
      permissionMode: "default",
      onEvent: (event) => events.push(event),
    });
    agent.start();
    assert.equal(agent.send("x".repeat(512 * 1024)), true);
    await waitFor(() => events.some((event) => event.type === "error"));
    assert.match(events.find((event) => event.type === "error").error, /input pipe closed/);
    await waitFor(() => children().length > previous);
    const failedPid = children()[previous];
    // Retry before the old process's SIGKILL escalation finishes. Its late
    // close must not clear the replacement's ownership or seal the new turn.
    writeFileSync(marker, "yes");
    agent.start();
    assert.equal(agent.send("retry"), true);
    await waitFor(() =>
      events.some((event) => event.type === "text" && event.text === "recovered"),
    );
    await waitFor(() => !alive(failedPid));
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    if (Agent === ResidentAgentProcess) {
      assert.equal(events.filter((event) => event.type === "exit").length, 1);
      assert.equal(agent.isRunning(), true);
      assert.equal(agent.send("after old close"), true);
      await waitFor(() => events.filter((event) => event.type === "text").length === 2);
    }
    agent.stop();
    await waitFor(() => children().every((pid) => !alive(pid)));
  }
  rmSync(marker, { force: true });
  const previous = children().length;
  const closes = [];
  const client = new CodexAppServerClient({ command, args: [], cwd: root });
  client.onNotification(() => {});
  client.onClose((reason) => closes.push(reason));
  client.start();
  const pending = [
    client.request("large", { text: "x".repeat(512 * 1024) }),
    client.request("other"),
  ];
  const results = await Promise.allSettled(pending);
  assert.ok(
    results.every(
      (result) => result.status === "rejected" && /input pipe closed/.test(result.reason.message),
    ),
  );
  assert.equal(client.isClosed, true);
  assert.equal(closes.length, 1);
  await client.close();
  assert.equal(closes.length, 1);
  assert.equal(alive(children()[previous]), false);
  await assert.rejects(client.request("late"), /input pipe closed/);
  writeFileSync(marker, "yes");
  const replacement = new CodexAppServerClient({ command, args: [], cwd: root });
  replacement.start();
  assert.deepEqual(await replacement.request("ping"), { pong: true });
  await replacement.close();
  rmSync(marker, { force: true });
  const claudePrevious = children().length;
  const claudeEvents = [];
  const claude = new ClaudeCodeRuntime({
    command,
    cwd: root,
    businessSessionId: "native-stdin-review",
    exposedToolNames: [],
    interruptGraceMs: 50,
    developerInstructions: "fixture system prompt",
    bridge: {
      url: "http://127.0.0.1:9/mcp",
      token: "fixture",
      tokenEnvVar: "FIXTURE_TOKEN",
      close: async () => {},
    },
  });
  try {
    const turn = await claude.send({ text: "x".repeat(8 * 1024 * 1024) }, (event) =>
      claudeEvents.push(event),
    );
    await turn.done;
    assert.equal(children().length, claudePrevious + 1);
    assert.equal(alive(children()[claudePrevious]), false, "failed input must reap a stubborn CLI");
    assert.equal(claudeEvents.filter((event) => event.type === "error").length, 1);
    assert.match(claudeEvents.find((event) => event.type === "error").error, /input pipe closed/);
    assert.deepEqual(
      claudeEvents.filter((event) => event.type === "turn_complete").map((event) => event.reason),
      ["model_error"],
    );
    writeFileSync(marker, "yes");
    const retryEvents = [];
    await (
      await claude.send({ text: "retry" }, (event) => retryEvents.push(event))
    ).done;
    assert.equal(
      retryEvents.some((event) => event.type === "error"),
      false,
    );
    assert.equal(retryEvents.filter((event) => event.type === "turn_complete").length, 1);
  } finally {
    await claude.close();
  }
  console.log(
    JSON.stringify({ ok: true, roomRetries: 2, pendingRejected: results.length, claudeRetries: 1 }),
  );
} finally {
  for (const pid of children()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  guard.restore();
}
