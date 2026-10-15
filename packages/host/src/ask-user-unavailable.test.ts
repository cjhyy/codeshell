import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AgentServer,
  ChatSessionManager,
  createInProcessTransport,
  type Engine,
} from "@cjhyy/code-shell-core";
import { unsupportedAskUserDecision } from "./host-requests.js";

const servers: AgentServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Question protocol did not settle");
    await new Promise((done) => setTimeout(done, 2));
  }
}

function fixture(asynchronous: boolean) {
  const sessionId = `host-question-${randomUUID()}`;
  let ask!: (question: string) => Promise<string>;
  let askAsync!: (question: string) => Promise<string>;
  let value: string | undefined;
  let runs = 0;
  let steers = 0;
  const engine = {
    isHeadless: () => false,
    getGoal: () => undefined,
    setAskUser: (callback: typeof ask) => {
      ask = callback;
    },
    setAskUserAsync: (callback: typeof askAsync) => {
      askAsync = callback;
    },
    setBrowserBridge() {},
    setInjectCredential() {},
    setSessionMessageRouter() {},
    enqueueSteer() {
      steers++;
      return { accepted: false, id: "unexpected-answer" };
    },
    async run() {
      runs++;
      value = await (asynchronous ? askAsync : ask)("Choose the next action");
      return {
        text: value,
        reason: "completed",
        sessionId,
        turnCount: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as Engine;
  const manager = new ChatSessionManager({ runtime: {} as never, engineFactory: () => engine });
  const [serverTransport, client] = createInProcessTransport();
  const received: any[] = [];
  client.onMessage((message) => received.push(message));
  servers.push(new AgentServer({ chatManager: manager, transport: serverTransport }));
  client.send({
    jsonrpc: "2.0",
    id: "run",
    method: "agent/run",
    params: {
      sessionId,
      task: "ask once",
      cwd: process.cwd(),
    },
  });
  return {
    manager,
    received,
    sessionId,
    get value() {
      return value;
    },
    get runs() {
      return runs;
    },
    get steers() {
      return steers;
    },
    question: () => received.find((frame) => frame.method === "agent/approvalRequest"),
    reply(id: string, decision: unknown) {
      const question = this.question();
      client.send({
        jsonrpc: "2.0",
        id,
        method: "agent/approve",
        params: {
          ...question.params,
          request: undefined,
          decision,
        },
      });
    },
    response: (id: string) => received.find((frame) => frame.id === id),
  };
}

test("Core synchronous AskUser consumes a host unavailable result as a clear failure, not an empty answer", async () => {
  const f = fixture(false);
  await until(() => !!f.question());
  expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(1);
  f.reply("unavailable", unsupportedAskUserDecision("Panel agent task"));
  await until(() => !!f.response("run") && !!f.response("unavailable"));
  expect(f.response("unavailable").result).toEqual({ ok: true });
  expect(f.value).toBe("user.ask is not supported by this host (Panel agent task)");
  expect(f.value).not.toContain("declined");
  expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(0);
});

test.each([
  [{ approved: true, answer: "Use the existing directory" }, "Use the existing directory"],
  [{ approved: false, reason: "User explicitly declined" }, "User explicitly declined"],
])(
  "normal text answers and explicit user refusal retain their Core behavior (%j)",
  async (decision, expected) => {
    const f = fixture(false);
    await until(() => !!f.question());
    f.reply("answer", decision);
    await until(() => !!f.response("run"));
    expect(f.value).toBe(expected);
    expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(0);
  },
);

test("Core asynchronous AskUser retires an unavailable question without admitting an answer or waking another run", async () => {
  const f = fixture(true);
  await until(() => !!f.question() && !!f.response("run"));
  const requestId = f.question().params.requestId;
  f.reply("unavailable", unsupportedAskUserDecision("Panel agent task"));
  await until(() => !!f.response("unavailable"));
  expect(f.response("unavailable").result).toEqual({ ok: true });
  expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(0);
  expect(f.runs).toBe(1);
  expect(f.steers).toBe(0);
  expect(
    f.received.find((frame) => frame.method === "agent/approvalResolved").params,
  ).toMatchObject({ requestId, approved: false });
  expect(f.received.some((frame) => frame.params?.event?.type === "session_user_message")).toBe(
    false,
  );
  f.reply("late-answer", { approved: true, answer: "must not wake the retired question" });
  await until(() => !!f.response("late-answer"));
  expect(f.response("late-answer").error.code).toBe(-32602);
  expect(f.runs).toBe(1);
});

test("an asynchronous yes without text remains invalid and can be cleaned up by the host failure", async () => {
  const f = fixture(true);
  await until(() => !!f.question());
  f.reply("empty-approval", { approved: true });
  await until(() => !!f.response("empty-approval"));
  expect(f.response("empty-approval").error.code).toBe(-32602);
  expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(1);
  f.reply("unavailable", unsupportedAskUserDecision("Panel agent task"));
  await until(() => !!f.response("unavailable"));
  expect(f.manager.get(f.sessionId)!.pendingApprovals.size).toBe(0);
  expect(f.steers).toBe(0);
});
