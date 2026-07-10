import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  RoomManager,
  askUserPrompt,
  buildAskUserUpdatedInput,
  isValidRoomId,
  roomTurnText,
  type RoomAgent,
  type RoomMessage,
} from "./room-manager.js";
import type { ResidentAgentEvent } from "./resident-agent.js";
import type { InputAttachmentMeta } from "../attachment-service.js";

describe("askUserPrompt", () => {
  test("parses the first question's prompt/header/options/multiSelect", () => {
    const input = {
      questions: [
        {
          question: "用哪个?",
          header: "方案",
          options: [{ label: "甲", description: "x" }, { label: "乙" }],
          multiSelect: true,
        },
        { question: "第二问", options: [{ label: "丙" }] },
      ],
    };
    expect(askUserPrompt(input)).toEqual({
      question: "用哪个?",
      header: "方案",
      options: ["甲", "乙"],
      multiSelect: true,
    });
  });
  test("undefined for malformed / non-AskUser input", () => {
    expect(askUserPrompt(undefined)).toBeUndefined();
    expect(askUserPrompt({})).toBeUndefined();
    expect(askUserPrompt({ questions: [] })).toBeUndefined();
    expect(askUserPrompt({ questions: [{ options: [{ label: "甲" }] }] })).toBeUndefined(); // no question text
  });
  test("drops non-string option labels", () => {
    expect(
      askUserPrompt({
        questions: [{ question: "q", options: [{ label: "A" }, { x: 1 }, { label: "B" }] }],
      })?.options,
    ).toEqual(["A", "B"]);
  });
});

describe("buildAskUserUpdatedInput", () => {
  test("keys answers by question text, passes the original input through", () => {
    const input = { questions: [{ question: "用哪个?", options: [{ label: "甲" }] }], extra: 1 };
    expect(buildAskUserUpdatedInput(input, { "用哪个?": "甲" })).toEqual({
      questions: input.questions,
      extra: 1,
      answers: { "用哪个?": "甲" },
    });
  });
  test("only includes answers for questions actually present (ignores stray keys)", () => {
    const input = { questions: [{ question: "A" }] };
    expect(buildAskUserUpdatedInput(input, { A: "x", B: "y" })).toEqual({
      questions: input.questions,
      answers: { A: "x" },
    });
  });
});

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

class FakeAgent implements RoomAgent {
  running = false;
  sent: string[] = [];
  constructor(private readonly emit: (e: ResidentAgentEvent) => void) {}
  start() {
    this.running = true;
  }
  send(text: string) {
    this.sent.push(text);
    // simulate claude echoing a reply + turn end
    this.emit({ type: "text", text: "reply to: " + text });
    this.emit({ type: "turn_end", reason: "success" });
    return true;
  }
  isRunning() {
    return this.running;
  }
  stop() {
    this.running = false;
  }
}

function makeManager() {
  dir = mkdtempSync(join(tmpdir(), "rooms-"));
  const pushed: { roomId: string; msg: RoomMessage }[] = [];
  const agents: FakeAgent[] = [];
  let clock = 1000;
  const mgr = new RoomManager({
    rootDir: dir,
    now: () => clock++,
    createAgent: (_room, onEvent) => {
      const a = new FakeAgent(onEvent);
      agents.push(a);
      return a;
    },
    onMessage: (roomId, msg) => pushed.push({ roomId, msg }),
  });
  return { mgr, pushed, agents };
}

describe("RoomManager", () => {
  test("create / list / get a room", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/Users/x/proj", permissionMode: "bypassPermissions" });
    expect(room.name).toBe("proj");
    expect(room.kind).toBe("claude-code");
    expect(mgr.listRooms()).toHaveLength(1);
    expect(mgr.getRoom(room.id)?.permissionMode).toBe("bypassPermissions");
  });

  test("send persists user msg + agent reply with monotonic seq", () => {
    const { mgr, pushed } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "hello");

    const msgs = mgr.getMessages(room.id, 0);
    // createRoom writes a system:room_created audit anchor first.
    expect(msgs.map((m) => `${m.from}:${m.type}`)).toEqual([
      "system:room_created",
      "user:text",
      "agent:text",
      "agent:turn_end",
    ]);
    // seq strictly increasing from 1
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(msgs[2]!.text).toBe("reply to: hello");
    // every persisted message was pushed to the phone (incl. the audit anchor)
    expect(pushed.filter((p) => p.roomId === room.id)).toHaveLength(4);
  });

  test("image-only send stores a safe summary and gives the agent relative paths", () => {
    const { mgr, agents } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    const attachment: InputAttachmentMeta = {
      id: "att-1",
      sessionId: room.id,
      kind: "image",
      origin: "mobile",
      path: ".code-shell/attachments/room/image.png",
      relPath: ".code-shell/attachments/room/image.png",
      absPath: "/repo/.code-shell/attachments/room/image.png",
      mime: "image/png",
      size: 4,
      sha256: "a".repeat(64),
      originalName: "phone.png",
      createdAt: 1,
    };

    expect(mgr.send(room.id, "", [attachment])).toBe(true);
    const user = mgr.getMessages(room.id).find((message) => message.from === "user");
    expect(user).toMatchObject({
      text: "",
      attachments: [
        {
          name: "phone.png",
          mime: "image/png",
          size: 4,
          path: ".code-shell/attachments/room/image.png",
        },
      ],
    });
    expect(agents[0]?.sent[0]).toContain(".code-shell/attachments/room/image.png");
    expect(agents[0]?.sent[0]).not.toContain(attachment.absPath);
    expect(roomTurnText("look", [attachment])).toStartWith("look\n<codeshell-image-attachments>");
  });

  test("transcript-followed rooms use the tail as the single visible output source", () => {
    const { mgr, agents } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.beginTranscriptFollow(room.id);

    // send still reaches the resident process, but its immediate user echo and
    // stdout events are suppressed while the transcript follower owns output.
    expect(mgr.send(room.id, "hello")).toBe(true);
    expect(agents[0]?.sent).toEqual(["hello"]);
    expect(mgr.getMessages(room.id).map((message) => message.type)).toEqual(["room_created"]);

    mgr.ingestTranscriptMessages(room.id, [
      { from: "user", type: "text", text: "hello" },
      { from: "agent", type: "text", text: "reply to: hello" },
      { from: "agent", type: "turn_end", reason: "success" },
    ]);
    expect(mgr.getMessages(room.id).map((message) => `${message.from}:${message.type}`)).toEqual([
      "system:room_created",
      "user:text",
      "agent:text",
      "agent:turn_end",
    ]);
    expect(mgr.latestSeq(room.id)).toBe(4);

    mgr.endTranscriptFollow(room.id);
    mgr.send(room.id, "after unsubscribe");
    expect(mgr.getMessages(room.id).filter((message) => message.type === "text")).toHaveLength(4);
  });

  test("getMessages(sinceSeq) returns only newer", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "a");
    const all = mgr.getMessages(room.id, 0);
    const after = mgr.getMessages(room.id, all[0]!.seq);
    expect(after.every((m) => m.seq > all[0]!.seq)).toBe(true);
    expect(after).toHaveLength(all.length - 1);
  });

  test("open starts agent once; isOpen reflects state; close stops", () => {
    const { mgr, agents } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    expect(mgr.open(room.id).status).toBe("running");
    expect(mgr.open(room.id).status).toBe("running");
    expect(agents).toHaveLength(1); // not started twice
    expect(mgr.isOpen(room.id)).toBe(true);
    mgr.close(room.id);
    expect(mgr.isOpen(room.id)).toBe(false);
  });

  test("open missing room reports missing", () => {
    const { mgr } = makeManager();
    expect(mgr.open("nope").status).toBe("missing");
  });

  test("pruneStaleRooms deletes rooms idle longer than maxAge", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let clock = 0;
    const mgr = new RoomManager({
      rootDir: dir,
      now: () => clock,
      createAgent: (_r, onEvent) => new FakeAgent(onEvent),
      onMessage: () => {},
    });
    clock = 1000;
    const old = mgr.createRoom({ cwd: "/repo/old" }); // lastActiveAt = 1000
    clock = 5000;
    const fresh = mgr.createRoom({ cwd: "/repo/fresh" }); // lastActiveAt = 5000

    clock = 6000;
    // maxAge 2000 → cutoff 4000: `old` (1000) is stale, `fresh` (5000) is not.
    const removed = mgr.pruneStaleRooms(2000);
    expect(removed).toEqual([old.id]);
    expect(mgr.getRoom(old.id)).toBeUndefined();
    expect(mgr.getRoom(fresh.id)).toBeDefined();
    expect(mgr.listRooms().map((r) => r.id)).toEqual([fresh.id]);
  });

  test("pruneStaleRooms never deletes a running room even if stale", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let clock = 0;
    const mgr = new RoomManager({
      rootDir: dir,
      now: () => clock,
      createAgent: (_r, onEvent) => new FakeAgent(onEvent),
      onMessage: () => {},
    });
    clock = 1000;
    const room = mgr.createRoom({ cwd: "/repo" }); // lastActiveAt = 1000
    mgr.open(room.id); // resident agent now running
    clock = 100000;
    const removed = mgr.pruneStaleRooms(1); // everything older than 99999 is stale
    expect(removed).toEqual([]);
    expect(mgr.getRoom(room.id)).toBeDefined();
  });

  test("openForSession creates a room bound to claudeSessionId and reuses it on a second call", () => {
    const { mgr } = makeManager();
    const r1 = mgr.openForSession("cc-sess-A", "/tmp/p", "default");
    const r2 = mgr.openForSession("cc-sess-A", "/tmp/p", "default");
    expect(r1.roomId).toBe(r2.roomId);
    expect(mgr.getRoom(r1.roomId)?.claudeSessionId).toBe("cc-sess-A");
  });

  test("openForSession creates distinct rooms for distinct sessions", () => {
    const { mgr } = makeManager();
    const a = mgr.openForSession("cc-A", "/tmp/p", "default");
    const b = mgr.openForSession("cc-B", "/tmp/p", "default");
    expect(a.roomId).not.toBe(b.roomId);
  });

  test("openForSession passes kind through to the created room (codex)", () => {
    const { mgr } = makeManager();
    const r = mgr.openForSession("thread-1", "/tmp/p", "default", "codex");
    expect(mgr.getRoom(r.roomId)?.kind).toBe("codex");
  });

  test("openForSession defaults kind to claude-code when omitted", () => {
    const { mgr } = makeManager();
    const r = mgr.openForSession("sess-1", "/tmp/p", "default");
    expect(mgr.getRoom(r.roomId)?.kind).toBe("claude-code");
  });

  test("openForSession does NOT reuse a room of a different kind even if the id collides", () => {
    const { mgr } = makeManager();
    // Same id string, but one is a claude session and one is a codex thread.
    const claude = mgr.openForSession("collide-id", "/tmp/p", "default", "claude-code");
    const codex = mgr.openForSession("collide-id", "/tmp/p", "default", "codex");
    expect(codex.roomId).not.toBe(claude.roomId);
    expect(mgr.getRoom(claude.roomId)?.kind).toBe("claude-code");
    expect(mgr.getRoom(codex.roomId)?.kind).toBe("codex");
  });

  test("openForSession reusing a room with a CHANGED mode restarts the agent under the new mode", () => {
    const { mgr, agents } = makeManager();
    const r1 = mgr.openForSession("cc-X", "/tmp/p", "default");
    expect(agents).toHaveLength(1);
    expect(agents[0].running).toBe(true);
    expect(mgr.getRoom(r1.roomId)?.permissionMode).toBe("default");
    // reopen the SAME session but with bypassPermissions — must persist the new
    // mode AND restart the resident process (permissionMode is a spawn-time CLI
    // arg, so the old default-mode process must be killed and respawned).
    const r2 = mgr.openForSession("cc-X", "/tmp/p", "bypassPermissions");
    expect(r2.roomId).toBe(r1.roomId);
    expect(mgr.getRoom(r1.roomId)?.permissionMode).toBe("bypassPermissions");
    expect(agents[0].running).toBe(false); // old agent stopped
    expect(agents).toHaveLength(2); // a fresh agent was spawned
    expect(agents[1].running).toBe(true);
  });

  test("openForSession reusing a room with the SAME mode does NOT restart the agent", () => {
    const { mgr, agents } = makeManager();
    mgr.openForSession("cc-Y", "/tmp/p", "default");
    mgr.openForSession("cc-Y", "/tmp/p", "default");
    expect(agents).toHaveLength(1); // reused, no respawn
  });

  test("openLinkedSession creates a default room and reports its mode", () => {
    const { mgr } = makeManager();
    const linked = mgr.openLinkedSession("thread-new", "/tmp/p", "codex");
    expect(linked.status).toBe("running");
    expect(linked.mode).toBe("default");
    expect(mgr.getRoom(linked.roomId)).toMatchObject({
      cwd: "/tmp/p",
      kind: "codex",
      claudeSessionId: "thread-new",
      permissionMode: "default",
    });
  });

  test("openLinkedSession preserves an existing room mode and live agent", () => {
    const { mgr, agents } = makeManager();
    const existing = mgr.openForSession("cc-linked", "/tmp/p", "bypassPermissions");
    expect(agents).toHaveLength(1);

    const linked = mgr.openLinkedSession("cc-linked", "/tmp/p", "claude-code");
    expect(linked).toMatchObject({ roomId: existing.roomId, mode: "bypassPermissions" });
    expect(mgr.getRoom(existing.roomId)?.permissionMode).toBe("bypassPermissions");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.running).toBe(true);
  });

  test("openLinkedSession rejects a cwd mismatch for an existing external session", () => {
    const { mgr } = makeManager();
    mgr.openForSession("cc-linked", "/tmp/project-a", "default", "claude-code");
    expect(() => mgr.openLinkedSession("cc-linked", "/tmp/project-b", "claude-code")).toThrow(
      /cwd/i,
    );
  });

  test("approval_request event persists an approval message and forwards to onApprovalRequest", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const forwarded: { roomId: string; requestId: string }[] = [];
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return { start() {}, send: () => true, isRunning: () => true, stop() {} };
      },
      onMessage: () => {},
      onApprovalRequest: (roomId, req) => forwarded.push({ roomId, requestId: req.requestId }),
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    emit({
      type: "approval_request",
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "ls" },
      description: "run ls",
    });
    const msgs = mgr.getMessages(room.id, 0).filter((m) => m.type === "approval");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: "agent",
      type: "approval",
      tool: "Bash",
      summary: "run ls",
    });
    expect(forwarded).toEqual([{ roomId: room.id, requestId: "req-1" }]);
  });

  test("Skill auto-allows (no answer to collect), never prompts for approval", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const forwarded: string[] = [];
    const controls: { requestId: string; decision: unknown }[] = [];
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return {
          start() {},
          send: () => true,
          isRunning: () => true,
          stop() {},
          respondControl: (requestId, decision) => controls.push({ requestId, decision }),
        };
      },
      onMessage: () => {},
      onApprovalRequest: (_roomId, req) => forwarded.push(req.requestId),
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    emit({
      type: "approval_request",
      requestId: "skill-1",
      toolName: "Skill",
      input: { name: "x" },
      description: "",
    });
    // NOT forwarded to the approval UI (no allow/deny card)…
    expect(forwarded).toEqual([]);
    // …and auto-allowed via respondControl so claude proceeds. updatedInput
    // echoes the original input.
    expect(controls).toEqual([
      { requestId: "skill-1", decision: { behavior: "allow", updatedInput: { name: "x" } } },
    ]);
  });

  test("AskUserQuestion does NOT auto-allow — it surfaces an approval w/ parsed askUser, then bakes the answer", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const forwarded: { requestId: string; askUser: unknown }[] = [];
    const controls: { requestId: string; decision: unknown }[] = [];
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return {
          start() {},
          send: () => true,
          isRunning: () => true,
          stop() {},
          respondControl: (requestId, decision) => controls.push({ requestId, decision }),
        };
      },
      onMessage: () => {},
      onApprovalRequest: (_roomId, req) =>
        forwarded.push({ requestId: req.requestId, askUser: req.askUser }),
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    const input = {
      questions: [
        {
          question: "选哪个?",
          header: "方案",
          options: [{ label: "甲" }, { label: "乙" }],
          multiSelect: false,
        },
      ],
    };
    emit({
      type: "approval_request",
      requestId: "ask-1",
      toolName: "AskUserQuestion",
      input,
      description: "",
    });
    // Forwarded to the UI WITH parsed askUser options (main does the parsing)…
    expect(forwarded).toEqual([
      {
        requestId: "ask-1",
        askUser: { question: "选哪个?", header: "方案", options: ["甲", "乙"], multiSelect: false },
      },
    ]);
    // …and NOT auto-allowed (the user must answer).
    expect(controls).toEqual([]);

    // Now the user answers "乙" → main bakes it into updatedInput.answers keyed by question text.
    mgr.respondApproval(room.id, "ask-1", { behavior: "allow", answer: "乙" });
    expect(controls).toEqual([
      {
        requestId: "ask-1",
        decision: { behavior: "allow", updatedInput: { ...input, answers: { "选哪个?": "乙" } } },
      },
    ]);
  });

  test("malformed AskUserQuestion (no questions) auto-allows so the turn isn't wedged", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const forwarded: string[] = [];
    const controls: { requestId: string; decision: unknown }[] = [];
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return {
          start() {},
          send: () => true,
          isRunning: () => true,
          stop() {},
          respondControl: (requestId, decision) => controls.push({ requestId, decision }),
        };
      },
      onMessage: () => {},
      onApprovalRequest: (_roomId, req) => forwarded.push(req.requestId),
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    emit({
      type: "approval_request",
      requestId: "ask-bad",
      toolName: "AskUserQuestion",
      input: {},
      description: "",
    });
    expect(forwarded).toEqual([]); // no card (nothing to render)
    expect(controls).toEqual([
      { requestId: "ask-bad", decision: { behavior: "allow", updatedInput: {} } },
    ]);
  });

  test("respondApproval routes the decision to the room's agent.respondControl", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    const calls: { requestId: string; decision: unknown }[] = [];
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: () => ({
        start() {},
        send: () => true,
        isRunning: () => true,
        stop() {},
        respondControl: (requestId, decision) => calls.push({ requestId, decision }),
      }),
      onMessage: () => {},
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    expect(mgr.respondApproval(room.id, "req-1", { behavior: "allow" })).toBe(true);
    expect(calls).toEqual([{ requestId: "req-1", decision: { behavior: "allow" } }]);
    // unopened / unknown room → false
    expect(mgr.respondApproval("nope", "req-x", { behavior: "deny", message: "no" })).toBe(false);
  });

  test("agent text/tool events persist with correct shape", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return { start() {}, send: () => true, isRunning: () => true, stop() {} };
      },
      onMessage: () => {},
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    emit({ type: "tool", tool: "Bash", summary: "ls" });
    emit({ type: "tool_result", summary: "out", isError: false });
    // index 0 is the room_created audit anchor; agent events follow.
    const msgs = mgr.getMessages(room.id, 0).filter((m) => m.type !== "room_created");
    expect(msgs[0]).toMatchObject({ from: "agent", type: "tool", tool: "Bash", summary: "ls" });
    expect(msgs[1]).toMatchObject({
      from: "agent",
      type: "tool_result",
      summary: "out",
      isError: false,
    });
  });

  test("tool 事件持久化完整 args(prompt 等不再只剩 summary)", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return { start() {}, send: () => true, isRunning: () => true, stop() {} };
      },
      onMessage: () => {},
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    const input = {
      description: "build X",
      prompt: "一大段子任务 prompt……",
      subagent_type: "general-purpose",
    };
    emit({ type: "tool", tool: "Agent", summary: "", input, id: "t1" });
    const msgs = mgr.getMessages(room.id, 0).filter((m) => m.type !== "room_created");
    expect(msgs[0]).toMatchObject({
      from: "agent",
      type: "tool",
      tool: "Agent",
      toolId: "t1",
      args: input,
    });
  });
});

describe("isValidRoomId", () => {
  test("accepts the generated shape only", () => {
    expect(isValidRoomId("room_abc123_def456")).toBe(true);
    expect(isValidRoomId("room_l9x_a1b2c3")).toBe(true);
  });
  test("rejects traversal / malformed / non-string ids", () => {
    for (const bad of [
      "..",
      "../x",
      "../../etc",
      "room_../evil",
      "room/abc",
      "room_abc",
      "",
      "ROOM_abc_def",
      "room_abc_def/..",
      "room_abc_def ",
      42 as unknown as string,
      undefined as unknown as string,
    ]) {
      expect(isValidRoomId(bad)).toBe(false);
    }
  });
});

describe("RoomManager roomId path-traversal guard", () => {
  test("getRoom/getMessages return safe defaults for a traversal id (no throw)", () => {
    const { mgr } = makeManager();
    expect(mgr.getRoom("../../etc")).toBeUndefined();
    expect(mgr.getMessages("../../etc", 0)).toEqual([]);
  });

  test("open/send/close on a traversal id are no-ops and never write outside rootDir", () => {
    const { mgr } = makeManager();
    const evil = "../../../pwned";
    expect(mgr.open(evil)).toEqual({ status: "missing" });
    expect(mgr.send(evil, "x")).toBe(false);
    expect(() => mgr.close(evil)).not.toThrow();
    // No directory/file created outside the rooms rootDir.
    expect(existsSync(join(dir!, "..", "..", "..", "pwned"))).toBe(false);
  });
});
