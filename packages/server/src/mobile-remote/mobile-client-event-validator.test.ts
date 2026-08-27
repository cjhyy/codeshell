import { describe, expect, test } from "bun:test";
import { parseMobileClientEvent } from "./mobile-client-event-validator.js";
import { MAX_MOBILE_ATTACHMENTS, MAX_MOBILE_IMAGE_BYTES } from "./mobile-limits.js";

describe("parseMobileClientEvent", () => {
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
