import { describe, expect, test } from "bun:test";
import type { RpcMessage } from "../protocol/types.js";
import { createDesktopAutomationAuthorityClient } from "./desktop-authority-client.js";

describe("Desktop automation authority client", () => {
  test("sends create to Main and resolves only the authoritative job", async () => {
    const sent: RpcMessage[] = [];
    let onMessage: ((message: RpcMessage) => void) | undefined;
    const create = createDesktopAutomationAuthorityClient({
      send(message) {
        sent.push(message);
      },
      onMessage(handler) {
        onMessage = handler;
      },
    });

    const pending = create({
      name: "bound",
      schedule: "1h",
      prompt: "p",
      cwd: "/caller",
      projectId: "project-1",
      rootId: "caller-root",
      resumeSessionId: "session-1",
      authoritySessionId: "session-1",
    });
    expect(sent[0]).toMatchObject({
      method: "desktop/automationCreate",
      params: { resumeSessionId: "session-1", authoritySessionId: "session-1" },
    });
    const requestId = "id" in sent[0]! ? sent[0]!.id : "";
    onMessage?.({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        id: "main-1",
        name: "bound",
        schedule: "1h",
        prompt: "p",
        enabled: true,
        runCount: 0,
        createdAt: 1,
        cwd: "/authority",
        projectId: "project-1",
        rootId: "root-1",
        resumeSessionId: "session-1",
      },
    });

    await expect(pending).resolves.toMatchObject({
      id: "main-1",
      cwd: "/authority",
      rootId: "root-1",
    });
  });
});
