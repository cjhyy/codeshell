import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

// Exercise the real Desktop recorder, owner lease and operation ledger with a
// fake provider. Neither the provider binary nor a network connection is needed.
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
] as const;
const originals = surfaces.map(([target, key]) => ({
  target: target as unknown as Record<string, unknown>,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
let deniedNetwork = 0;
for (const { target, key } of originals)
  target[key] = () => {
    deniedNetwork++;
    throw new Error("external service operations fixture denied outbound network");
  };
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/probe")).toThrow("denied outbound");
expect(() => https.get("https://outside.invalid/probe")).toThrow("denied outbound");

const { SessionManager, UsageLedger, sessionsRoot } = await import("@cjhyy/code-shell-core");
const runtimeExports = {
  ...(await import("@cjhyy/code-shell-capability-coding/external-runtimes")),
};
type StartArgs = Parameters<typeof runtimeExports.startExternalRuntimeSession>[0];
type RunContext = NonNullable<ReturnType<NonNullable<StartArgs["captureRunContext"]>>>;
let providerBody: ((args: StartArgs) => Promise<void>) | undefined;
let turns = 0;
let lastStart: StartArgs;
mock.module("@cjhyy/code-shell-capability-coding/external-runtimes", () => ({
  ...runtimeExports,
  startExternalRuntimeSession: async (args: StartArgs) => {
    lastStart = args;
    return {
      kind: args.kind,
      businessSessionId: args.businessSessionId,
      runtimeSessionId: "fixture-provider-session",
      listTools: () => [],
      close: async () => {},
      interrupt: async () => {},
      send: async (_input: unknown, onEvent: (event: any) => void) => {
        turns++;
        await providerBody?.(args);
        onEvent({ type: "turn_complete", reason: "completed" });
        return { done: Promise.resolve() };
      },
    };
  },
}));
const { ExternalRuntimeService } = await import("./external-runtime-service.js");
let home: string, previousHome: string | undefined, cwd: string;
let svc: InstanceType<typeof ExternalRuntimeService>;
const events: any[] = [];
const sessionId = "external-operation-service";
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeshell-external-service-ops-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(home, "home");
  cwd = join(home, "workspace");
  mkdirSync(cwd);
  turns = 0;
  events.length = 0;
  providerBody = undefined;
  svc = new ExternalRuntimeService({
    featureFlags: () => ({ external_agent_runtime: true, external_host_tools: true }),
    registerSession: () => {},
    releaseSession: () => {},
    resolveProjectBinding: () => undefined,
    emit: (_sessionId, event) => events.push(event),
    projectTrust: () => "untrusted",
    prepareCodexLaunch: async () => ({ command: "/fixture/codex", env: { PATH: "/fixture" } }),
  });
  await svc.start({ kind: "codex", sessionId, cwd });
});
afterEach(async () => {
  await svc.stopAll();
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => {
  mock.module("@cjhyy/code-shell-capability-coding/external-runtimes", () => runtimeExports);
  try {
    expect(deniedNetwork).toBe(2);
  } finally {
    for (const { target, key, descriptor } of originals) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    syncBuiltinESMExports();
  }
});

function capture(args: StartArgs): RunContext {
  const context = args.captureRunContext?.();
  if (!context) throw new Error("Fixture has no current Host submission");
  return context;
}
function plan(context: RunContext) {
  return {
    sessionId,
    intentId: `${context.originClientMessageId}:github.create_issue`,
    service: "github",
    action: "create_issue",
    channel: "remote-link",
    account: null,
    target: null,
    parameters: null,
    postcondition: null,
  };
}
async function unknownWrite(args: StartArgs) {
  const context = capture(args);
  const ledger = context.operations!.controller.ledger;
  const receipt = ledger.prepare(plan(context));
  const claim = ledger.claim(receipt.id);
  expect(claim.claimed).toBe(true);
  ledger.settle(receipt.id, claim.receipt.attemptId, "unknown", { error: "transient" });
  await context.operations!.onToolFailure?.();
}
function lastTerminal() {
  return events.filter((event) => event.type === "turn_complete").at(-1);
}

test("an unknown Host write stops Goal continuation and agrees with the returned terminal", async () => {
  providerBody = unknownWrite;
  const outcome = await svc.send(sessionId, {
    text: "perform this user action",
    clientMessageId: "original-user",
    goal: { objective: "perform and verify", maxTurns: 2 },
  });
  expect(outcome.reason).toBe("unverified_write");
  expect(outcome.ok).toBe(false);
  expect(turns).toBe(1);
  expect(lastTerminal().reason).toBe(outcome.reason);
  expect(new SessionManager().readSessionState(sessionId)?.status).toBe("unverified_write");
});

test("rejected accounting custody remains retryable without replacing a healthy CLI", async () => {
  expect((await svc.send(sessionId, { text: "initial", disableGoal: true })).reason).toBe(
    "completed",
  );
  const sessions = new SessionManager();
  const costState = sessions.readSessionState(sessionId)!.costState!;
  const ledgerPath = join(sessionsRoot(), ".usage-ledger");
  const usage = new UsageLedger({ storageDir: ledgerPath });
  usage.adoptSession(sessionId, costState, sessionsRoot());
  usage.begin(usage.owner(sessionId, "paid-history", [], "main", sessionsRoot()), {
    provider: "fixture",
    model: "fixture",
  });
  sessions.updateSessionState(sessionId, {
    costState: { ...costState, sessionScopeId: "0".repeat(64) },
  });
  const ledgerSnapshot = () =>
    readdirSync(ledgerPath, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => readFileSync(join(file.parentPath, file.name)).toString());
  const ledger = ledgerSnapshot();
  const originalStart = lastStart;
  for (let retry = 0; retry < 2; retry++) {
    const outcome = await svc.send(sessionId, { text: "retry", disableGoal: true });
    expect(outcome.reason).toBe("model_error");
    expect(events.filter((event) => event.type === "error").at(-1)?.error).toContain("Native");
    expect(sessions.readSessionState(sessionId)?.costState).toEqual({
      ...costState,
      sessionScopeId: "0".repeat(64),
    });
    expect(ledgerSnapshot()).toEqual(ledger);
    expect(turns).toBe(1);
  }
  sessions.updateSessionState(sessionId, { costState });
  expect((await svc.send(sessionId, { text: "repaired", disableGoal: true })).reason).toBe(
    "completed",
  );
  expect(lastStart).toBe(originalStart);
  expect(turns).toBe(2);
});

test("a later Goal cannot declare completion while its Session has an unresolved write", async () => {
  providerBody = unknownWrite;
  expect(
    (
      await svc.send(sessionId, {
        text: "first write",
        clientMessageId: "first",
        disableGoal: true,
      })
    ).reason,
  ).toBe("unverified_write");
  let completed: any;
  providerBody = async (args) => {
    const goal = svc.getGoal(sessionId);
    const result = await args.registry.executeTool("complete_goal", {
      goalId: goal.goalId,
      revision: goal.revision,
      summary: "claimed complete",
    });
    completed = JSON.parse(String(result.result));
  };
  const outcome = await svc.send(sessionId, {
    text: "finish the saved work",
    clientMessageId: "followup",
    goal: { objective: "verify before completing", maxTurns: 2 },
  });
  expect(completed.ok).toBe(false);
  expect(outcome.reason).toBe("unverified_write");
  expect(turns).toBe(2);
  expect(lastTerminal().reason).toBe(outcome.reason);
  expect(events.filter((event) => event.type === "goal_completed")).toEqual([]);
});

test("injected wakeups reuse the durable real-user intent across sends and runtime restart", async () => {
  let physicalWrites = 0;
  const origins: string[] = [];
  providerBody = async (args) => {
    const context = capture(args);
    origins.push(context.originClientMessageId);
    const receipt = await context.operations!.controller.run(plan(context), {
      assertAuthorized: context.assertCurrent,
      preflight: async () => {},
      validate: async () => {},
      authorize: async () => true,
      execute: async () => {
        physicalWrites++;
        return { id: "created-once" };
      },
      verify: async () => true,
    });
    expect(receipt.state).toBe("verified");
  };
  const send = (input: any) => svc.send(sessionId, { ...input, disableGoal: true });
  expect((await send({ text: "create once", clientMessageId: "real-user" })).reason).toBe(
    "completed",
  );
  expect(
    (await send({ text: "background task completed", injected: true, clientMessageId: "forged" }))
      .reason,
  ).toBe("completed");
  await svc.stop(sessionId);
  await svc.start({ kind: "codex", sessionId, cwd });
  expect((await send({ text: "continue saved goal", injected: true })).reason).toBe("completed");
  expect(origins).toEqual(["real-user", "real-user", "real-user"]);
  expect(physicalWrites).toBe(1);
  expect(lastStart.settingsScope).toBe("full");
  expect(lastStart.projectTrusted).toBe(false);
});

test("a first injected reminder has a live read context but no write authority", async () => {
  providerBody = async (args) => {
    const context = capture(args);
    expect(context.originClientMessageId).toBe("");
    expect(context.operations).toBeUndefined();
    context.assertCurrent();
  };
  expect(
    (
      await svc.send(sessionId, {
        text: "background reminder",
        injected: true,
        clientMessageId: "cannot-mint-user-intent",
        disableGoal: true,
      })
    ).reason,
  ).toBe("completed");
});

test("new lease initialization failure never reuses the previous run's uncertain terminal", async () => {
  providerBody = unknownWrite;
  expect(
    (
      await svc.send(sessionId, {
        text: "first write",
        clientMessageId: "first",
        disableGoal: true,
      })
    ).reason,
  ).toBe("unverified_write");
  const noticesBefore = events.filter((event) => event.type === "error").length;
  const manager = new SessionManager();
  manager.updateSessionState(sessionId, {
    costState: {
      ...manager.readSessionState(sessionId)!.costState,
      accountingSessionId: "invalid",
    },
  });
  const outcome = await svc.send(sessionId, {
    text: "second submission",
    clientMessageId: "second",
    disableGoal: true,
  });
  expect(outcome.reason).toBe("model_error");
  expect(lastTerminal().reason).toBe("model_error");
  expect(turns).toBe(1);
  expect(events.filter((event) => event.type === "error").length).toBe(noticesBefore + 1);
});
