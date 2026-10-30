import { describe, expect, test } from "bun:test";
import { parseMobileClientEvent } from "./mobile-client-event-validator.js";
import { MAX_MOBILE_ATTACHMENTS, MAX_MOBILE_IMAGE_BYTES } from "./mobile-limits.js";

describe("parseMobileClientEvent", () => {
  test("approval replies retain the worker route and reject malformed generations", () => {
    const reply = {
      type: "approval.respond",
      sessionId: "s1",
      approvalId: "a1",
      decision: "approve",
      connectionId: "worker",
      generation: 2,
      answer: "允许本次",
    };
    expect(parseMobileClientEvent(reply)).toEqual(reply);
    for (const generation of [-1, 1.5, "2", Infinity])
      expect(parseMobileClientEvent({ ...reply, generation })).toBeUndefined();
    expect(parseMobileClientEvent({ ...reply, connectionId: "" })).toBeUndefined();
  });
  test("history recovery requires a correlated plan and explicit acceptance without client paths", () => {
    const plan = { type: "session.outputRecovery.plan", sessionId: "s1", requestId: "r1" };
    const apply = {
      ...plan,
      type: "session.outputRecovery.apply",
      planId: "reviewed-plan",
      acceptHistoricalGap: true,
    };
    expect(parseMobileClientEvent(plan)).toEqual(plan);
    expect(parseMobileClientEvent(apply)).toEqual(apply);
    for (const changed of [
      { requestId: "" },
      { sessionId: "x".repeat(129) },
      { cwd: "/somewhere" },
      { epoch: "new" },
    ]) {
      expect(parseMobileClientEvent({ ...plan, ...changed })).toBeUndefined();
      expect(parseMobileClientEvent({ ...apply, ...changed })).toBeUndefined();
    }
    for (const changed of [
      { planId: "" },
      { planId: "x".repeat(129) },
      { acceptHistoricalGap: false },
      { acceptHistoricalGap: undefined },
      { acceptHistoricalGap: "true" },
    ])
      expect(parseMobileClientEvent({ ...apply, ...changed })).toBeUndefined();
  });
  test("accepts bounded correlated session pages and rejects malformed filters", () => {
    expect(
      parseMobileClientEvent({ type: "ccRoom.listSessions", cwd: "/repo", all: true }),
    ).toBeDefined();
    expect(
      parseMobileClientEvent({ type: "ccRoom.listSessions", cwd: "/repo", all: "yes" }),
    ).toBeUndefined();
    const request = {
      type: "session.list",
      requestId: "page-1",
      cursor: "v1:123:s1",
      cwds: ["/repo", "/extra"],
    };
    expect(parseMobileClientEvent(request)).toEqual(request);
    for (const fields of [
      { cursor: "" },
      { requestId: "x".repeat(129) },
      { cwds: [] },
      { cwds: ["/repo\0bad"] },
      { cwds: Array(257).fill("/repo") },
    ])
      expect(parseMobileClientEvent({ type: "session.list", ...fields })).toBeUndefined();
  });
  test("accepts representative authenticated protocol events", () => {
    expect(parseMobileClientEvent({ type: "session.list" })?.type).toBe("session.list");
    expect(
      parseMobileClientEvent({
        type: "chat.send",
        text: "hello",
        attachments: [
          {
            transport: "upload",
            clientId: "c1",
            name: "photo.png",
            mime: "image/png",
            size: 12,
            uploadId: "u1",
          },
        ],
      })?.type,
    ).toBe("chat.send");
    expect(
      parseMobileClientEvent({
        type: "ccRoom.respondApproval",
        roomId: "r1",
        requestId: "q1",
        decision: { behavior: "deny", message: "no" },
      })?.type,
    ).toBe("ccRoom.respondApproval");
    expect(
      parseMobileClientEvent({
        type: "ccRoom.respondApproval",
        roomId: "r1",
        requestId: "q2",
        decision: { behavior: "allow", answers: { "Lang?": "Go", "Tests?": "unit, e2e" } },
      })?.type,
    ).toBe("ccRoom.respondApproval");
    expect(
      parseMobileClientEvent({
        type: "session.create",
        projectId: "project-1",
        rootId: "root-2",
      }),
    ).toEqual({ type: "session.create", projectId: "project-1", rootId: "root-2" });
    expect(parseMobileClientEvent({ type: "session.create", projectId: null })).toEqual({
      type: "session.create",
      projectId: null,
    });
  });

  test("rejects non-objects, unknown types, and malformed privileged events", () => {
    expect(parseMobileClientEvent(null)).toBeUndefined();
    expect(parseMobileClientEvent([])).toBeUndefined();
    expect(parseMobileClientEvent({ type: "admin.root" })).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "permission.setMode",
        mode: "bypassEverything",
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "goal.extend",
        sessionId: "s1",
        addTokenBudget: -1,
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "room.create",
        cwd: { path: "/repo" },
      }),
    ).toBeUndefined();
    expect(parseMobileClientEvent({ type: "session.create", cwd: "" })).toBeUndefined();
    expect(
      parseMobileClientEvent({ type: "session.create", projectId: "project-1", rootId: "" }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({ type: "session.create", projectId: null, rootId: "root-1" }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({ type: "session.create", rootId: "root-without-project" }),
    ).toBeUndefined();
    expect(parseMobileClientEvent({ type: "room.create", cwd: "/repo\0escape" })).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "pair.complete",
        token: "token",
        name: "   ",
        secretHash: "secret",
      }),
    ).toBeUndefined();
    expect(parseMobileClientEvent({ type: "goal.extend", sessionId: "s1" })).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "ccRoom.respondApproval",
        roomId: "r1",
        requestId: "q1",
        decision: { behavior: "allow", updatedInput: "not-an-object" },
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "ccRoom.respondApproval",
        roomId: "r1",
        requestId: "q1",
        decision: { behavior: "allow", answers: { "Which?": 1 } },
      }),
    ).toBeUndefined();
  });

  test("rejects malformed attachment metadata before it reaches storage", () => {
    expect(
      parseMobileClientEvent({
        type: "chat.send",
        text: "hello",
        attachments: [{ transport: "upload", uploadId: "u1", size: -1 }],
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "attachment.upload.begin",
        clientId: "c1",
        name: "x.png",
        mime: "image/png",
        size: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "attachment.upload.begin",
        clientId: "c1",
        name: "x.svg",
        mime: "image/svg+xml",
        size: 100,
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "attachment.upload.begin",
        clientId: "c1",
        name: "x.png",
        mime: "image/png",
        size: MAX_MOBILE_IMAGE_BYTES + 1,
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "chat.send",
        text: "hello",
        attachments: Array.from({ length: MAX_MOBILE_ATTACHMENTS + 1 }, (_, index) => ({
          transport: "upload",
          clientId: `c${index}`,
          name: "x.png",
          mime: "image/png",
          size: 1,
          uploadId: `u${index}`,
        })),
      }),
    ).toBeUndefined();
  });

  test("caps history work and oversized identifiers", () => {
    expect(
      parseMobileClientEvent({
        type: "ccRoom.readHistory",
        cwd: "/repo",
        sessionId: "s1",
        limit: 501,
      }),
    ).toBeUndefined();
    expect(
      parseMobileClientEvent({
        type: "session.history",
        sessionId: "x".repeat(513),
      }),
    ).toBeUndefined();
  });
});

test("session creation accepts bounded optional client correlation without changing legacy requests", () => {
  const event = { type: "session.create", projectId: null, clientRequestId: "browser-create-1" };
  expect(parseMobileClientEvent(event)).toEqual(event);
  for (const invalid of ["", "x".repeat(513), 1, null])
    expect(parseMobileClientEvent({ ...event, clientRequestId: invalid })).toBeUndefined();
  expect(parseMobileClientEvent({ type: "session.create" })).toEqual({ type: "session.create" });
});

test("creation and sends carry only valid optional permission intent while preserving legacy requests", () => {
  for (const event of [{ type: "session.create" }, { type: "chat.send", text: "fixture" }]) {
    expect(parseMobileClientEvent(event)).toEqual(event);
    for (const permissionMode of ["default", "acceptEdits", "bypassPermissions"])
      expect(parseMobileClientEvent({ ...event, permissionMode })).toEqual({
        ...event,
        permissionMode,
      });
    for (const permissionMode of ["", "skip", null, true, {}, []])
      expect(parseMobileClientEvent({ ...event, permissionMode })).toBeUndefined();
  }
});

test("session sync accepts optional bounded epochs and rejects malformed lifetime identifiers", () => {
  const legacy = { type: "session.sync", sessionId: "s1", sinceSeq: 100 };
  expect(parseMobileClientEvent(legacy)).toEqual(legacy);
  for (const epoch of ["main-lifetime-1", "x".repeat(512)]) {
    expect(parseMobileClientEvent({ ...legacy, epoch })).toEqual({ ...legacy, epoch });
  }
  for (const epoch of ["", "   ", "x".repeat(513), 1, null, {}, []]) {
    expect(parseMobileClientEvent({ ...legacy, epoch })).toBeUndefined();
  }
});

test("journal negotiation and pages bound opaque selection/request/cursor fields", () => {
  const selected = { type: "session.select", sessionId: "native", recoveryId: "selection" };
  const page = {
    type: "session.outputJournal",
    sessionId: "native",
    recoveryId: "selection",
    requestId: "page",
    after: "opaque",
    through: "frozen",
  };
  expect(parseMobileClientEvent(selected)).toEqual(selected);
  expect(parseMobileClientEvent(page)).toEqual(page);
  expect(parseMobileClientEvent({ type: "session.recovery.cancel" })).toEqual({
    type: "session.recovery.cancel",
  });
  for (const field of ["recoveryId", "requestId"])
    for (const value of ["", "x".repeat(129), null, 1])
      expect(parseMobileClientEvent({ ...page, [field]: value })).toBeUndefined();
  for (const field of ["after", "through"])
    for (const value of ["", "x".repeat(2049), null, 1])
      expect(parseMobileClientEvent({ ...page, [field]: value })).toBeUndefined();
  expect(parseMobileClientEvent({ ...selected, recoveryId: "x".repeat(129) })).toBeUndefined();
  expect(parseMobileClientEvent({ type: "session.select", sessionId: "native" })).toEqual({
    type: "session.select",
    sessionId: "native",
  });
});

test("Room pages bound view correlation, filter and opaque continuation fields", () => {
  const first = {
    type: "room.history",
    roomId: "room_abc_def",
    sinceSeq: 0,
    page: true,
    limit: 200,
    requestId: "viewer:1",
  };
  expect(parseMobileClientEvent(first)).toEqual(first);
  expect(parseMobileClientEvent({ ...first, sinceSeq: undefined, cursor: "opaque" })).toBeDefined();
  for (const patch of [
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { page: "yes" },
    { cursor: "x".repeat(2049), sinceSeq: undefined },
    { cursor: "opaque" },
    { cursor: "opaque", page: false, sinceSeq: undefined },
    { requestId: "x".repeat(513) },
  ])
    expect(parseMobileClientEvent({ ...first, ...patch })).toBeUndefined();
});

test("Panel source labels are bounded observation metadata on chat.send", () => {
  expect(
    parseMobileClientEvent({
      type: "chat.send",
      text: "hello",
      modelTraceSource: "panel:design-studio",
    }),
  ).toMatchObject({ modelTraceSource: "panel:design-studio" });
  for (const source of [
    "/foreign",
    "panel:",
    "panel:" + "a".repeat(65),
    42,
    { storageDir: "/foreign" },
  ])
    expect(
      parseMobileClientEvent({ type: "chat.send", text: "hello", modelTraceSource: source }),
    ).toBeUndefined();
});

test("legacy base pages require bounded identities and exactly one typed anchor or cursor", () => {
  const event = {
    type: "session.legacyBase",
    sessionId: "s".repeat(128),
    recoveryId: "r".repeat(128),
    requestId: "q".repeat(128),
    throughEventId: "t".repeat(512),
  };
  expect(parseMobileClientEvent(event)).toEqual(event);
  const next = { ...event, throughEventId: undefined, cursor: "c".repeat(2048) };
  expect(parseMobileClientEvent(next)).toEqual(next);
  for (const field of ["sessionId", "recoveryId", "requestId", "throughEventId", "cursor"]) {
    const base = field === "cursor" ? next : event;
    const limit = field === "cursor" ? 2048 : field === "throughEventId" ? 512 : 128;
    for (const value of ["", "x".repeat(limit + 1), null, 1, {}, []])
      expect(parseMobileClientEvent({ ...base, [field]: value })).toBeUndefined();
  }
  expect(parseMobileClientEvent({ ...event, cursor: "both" })).toBeUndefined();
  expect(parseMobileClientEvent({ ...event, throughEventId: undefined })).toBeUndefined();
});

test("external model selection is bounded and never admits native or malformed routing keys", () => {
  expect(parseMobileClientEvent({ type: "runtime.models" })).toEqual({ type: "runtime.models" });
  for (const modelKey of ["codex/fixture", "claude-code/sonnet", "codex/"]) {
    const input = { type: "chat.send", text: "task", modelKey };
    expect(parseMobileClientEvent(input)).toEqual(input);
  }
  for (const modelKey of [
    "openai/model",
    "codex",
    "CODEX/fixture",
    "",
    5,
    null,
    "codex/\nother",
    "codex/" + "a".repeat(512),
  ]) {
    expect(parseMobileClientEvent({ type: "chat.send", text: "task", modelKey })).toBeUndefined();
  }
});

test("output journal frame hint is optional, bounded and integral", () => {
  const event = { type: "session.outputJournal", sessionId: "s", recoveryId: "r", requestId: "p" };
  expect(parseMobileClientEvent(event)).toEqual(event);
  expect(parseMobileClientEvent({ ...event, frozenSnapshot: true })).toEqual({
    ...event,
    frozenSnapshot: true,
  });
  for (const frozenSnapshot of [false, 1, "true", null])
    expect(parseMobileClientEvent({ ...event, frozenSnapshot })).toBeUndefined();
  for (const maxFrames of [1, 512, 2048])
    expect(parseMobileClientEvent({ ...event, maxFrames })).toEqual({ ...event, maxFrames });
  for (const maxFrames of [0, -1, 2049, 1.5, "2048", null, Infinity])
    expect(parseMobileClientEvent({ ...event, maxFrames })).toBeUndefined();
});

test("history display requests carry only bounded selected-view references", () => {
  const view = { type: "session.historyView", sessionId: "s", recoveryId: "r", requestId: "p" };
  const detail = { ...view, type: "session.historyDetail", ref: "opaque" };
  expect(parseMobileClientEvent(view)).toEqual(view);
  expect(parseMobileClientEvent({ ...view, before: "older" })).toBeDefined();
  expect(parseMobileClientEvent(detail)).toEqual(detail);
  expect(parseMobileClientEvent({ ...detail, cursor: "part-2" })).toBeDefined();
  for (const request of [view, detail]) {
    for (const field of ["sessionId", "recoveryId", "requestId"])
      for (const value of ["", null, 42, "x".repeat(129)])
        expect(parseMobileClientEvent({ ...request, [field]: value })).toBeUndefined();
    for (const field of ["cwd", "root", "epoch", "outputCursor"])
      expect(parseMobileClientEvent({ ...request, [field]: "caller" })).toBeUndefined();
  }
  for (const value of ["", null, 42, "x".repeat(2049)]) {
    expect(parseMobileClientEvent({ ...view, before: value })).toBeUndefined();
    expect(parseMobileClientEvent({ ...detail, ref: value })).toBeUndefined();
    expect(parseMobileClientEvent({ ...detail, cursor: value })).toBeUndefined();
  }
});
