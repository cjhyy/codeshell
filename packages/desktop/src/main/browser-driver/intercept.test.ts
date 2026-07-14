import { describe, expect, test } from "bun:test";
import {
  parseBrowserActionLine,
  buildBrowserActionReply,
  parseCredentialActionLine,
  buildCredentialActionReply,
  parseWorkspaceActionLine,
  buildWorkspaceActionReply,
  parsePanelActionLine,
  buildPanelActionReply,
} from "./intercept";

const browserActionLine = (args: Record<string, unknown>, requestId = "rq1", sessionId = "s1") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: { sessionId, requestId, request: { toolName: "__browser_action__", args } },
  });

describe("parseBrowserActionLine", () => {
  test("parses a browser action request", () => {
    const p = parseBrowserActionLine(browserActionLine({ action: "click", ref: "e3" }));
    expect(p).toEqual({
      sessionId: "s1",
      requestId: "rq1",
      request: {
        action: "click",
        ref: "e3",
        text: undefined,
        url: undefined,
        dir: undefined,
        amount: undefined,
      },
    });
  });

  test("forwards value/key/refs/tabId (selectOption/pressKey/fetchImages/switchTab)", () => {
    const sel = parseBrowserActionLine(
      browserActionLine({ action: "select", ref: "e1", value: "opt-2" }),
    );
    expect(sel?.request.value).toBe("opt-2");

    const press = parseBrowserActionLine(
      browserActionLine({ action: "press_key", key: "Control+a" }),
    );
    expect(press?.request.key).toBe("Control+a");

    const imgs = parseBrowserActionLine(
      browserActionLine({ action: "fetch_images", refs: ["img1", "img2"] }),
    );
    expect(imgs?.request.refs).toEqual(["img1", "img2"]);

    const tab = parseBrowserActionLine(browserActionLine({ action: "switch_tab", tabId: "t3" }));
    expect(tab?.request.tabId).toBe("t3");
  });

  test("drops non-string refs entries and mistyped value/key/tabId", () => {
    const p = parseBrowserActionLine(
      browserActionLine({
        action: "fetch_images",
        refs: ["ok", 42, null, "ok2"],
        value: 1,
        key: {},
        tabId: [],
      }),
    );
    expect(p?.request.refs).toEqual(["ok", "ok2"]);
    expect(p?.request.value).toBeUndefined();
    expect(p?.request.key).toBeUndefined();
    expect(p?.request.tabId).toBeUndefined();
  });

  test("returns null for a normal ask-user approval request (not browser)", () => {
    const line = JSON.stringify({
      method: "agent/approvalRequest",
      params: { requestId: "x", request: { toolName: "__ask_user__", args: { question: "?" } } },
    });
    expect(parseBrowserActionLine(line)).toBeNull();
  });

  test("returns null for stream events / other methods / malformed json", () => {
    expect(
      parseBrowserActionLine(JSON.stringify({ method: "agent/streamEvent", params: {} })),
    ).toBeNull();
    expect(parseBrowserActionLine("not json")).toBeNull();
    expect(parseBrowserActionLine(JSON.stringify({ method: "agent/approvalRequest" }))).toBeNull();
  });

  test("returns null when args.action missing", () => {
    const line = JSON.stringify({
      method: "agent/approvalRequest",
      params: { requestId: "x", request: { toolName: "__browser_action__", args: {} } },
    });
    expect(parseBrowserActionLine(line)).toBeNull();
  });

  test("keeps a missing sessionId as undefined so the bridge can fail closed", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/approvalRequest",
      params: {
        requestId: "rq-no-session",
        request: { toolName: "__browser_action__", args: { action: "snapshot" } },
      },
    });
    const parsed = parseBrowserActionLine(line);
    expect(parsed?.sessionId).toBeUndefined();
    expect(parsed?.requestId).toBe("rq-no-session");
  });
});

describe("buildBrowserActionReply", () => {
  test("wraps the result json in an agent/approve resolving the requestId", () => {
    const parsed = { sessionId: "s1", requestId: "rq1", request: { action: "snapshot" as const } };
    const reply = JSON.parse(buildBrowserActionReply(parsed, '{"ok":true}'));
    expect(reply.method).toBe("agent/approve");
    expect(reply.params.sessionId).toBe("s1");
    expect(reply.params.requestId).toBe("rq1");
    expect(reply.params.decision).toEqual({ approved: true, answer: '{"ok":true}' });
    expect(typeof reply.id).toBe("number");
  });
});

const credActionLine = (args: Record<string, unknown>, requestId = "rq2", sessionId = "s2") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: { sessionId, requestId, request: { toolName: "__credential_action__", args } },
  });

describe("parseCredentialActionLine", () => {
  test("parses an injectCookie credential action", () => {
    const p = parseCredentialActionLine(
      credActionLine({ action: "injectCookie", credentialId: "xiaohongshu__account" }),
    );
    expect(p).toEqual({
      sessionId: "s2",
      requestId: "rq2",
      action: "injectCookie",
      credentialId: "xiaohongshu__account",
      credentialScope: "full",
    });
  });

  test("parses credentialScope for project-scoped injection", () => {
    const p = parseCredentialActionLine(
      credActionLine({
        action: "injectCookie",
        credentialId: "xiaohongshu__account",
        credentialScope: "project",
      }),
    );
    expect(p?.credentialScope).toBe("project");
  });

  test("returns null for a browser action (not credential)", () => {
    const line = JSON.stringify({
      method: "agent/approvalRequest",
      params: {
        requestId: "x",
        request: { toolName: "__browser_action__", args: { action: "click" } },
      },
    });
    expect(parseCredentialActionLine(line)).toBeNull();
  });

  test("returns null when credentialId or action missing, or malformed", () => {
    expect(parseCredentialActionLine(credActionLine({ action: "injectCookie" }))).toBeNull();
    expect(parseCredentialActionLine(credActionLine({ credentialId: "id" }))).toBeNull();
    expect(parseCredentialActionLine("not json")).toBeNull();
  });

  test("keeps a missing sessionId as undefined so inject can fail closed", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/approvalRequest",
      params: {
        requestId: "rq-no-session",
        request: {
          toolName: "__credential_action__",
          args: { action: "injectCookie", credentialId: "cookie" },
        },
      },
    });
    const parsed = parseCredentialActionLine(line);
    expect(parsed?.sessionId).toBeUndefined();
    expect(parsed?.credentialId).toBe("cookie");
  });
});

describe("buildCredentialActionReply", () => {
  test("wraps the result json in an agent/approve resolving the requestId", () => {
    const parsed = {
      sessionId: "s2",
      requestId: "rq2",
      action: "injectCookie",
      credentialId: "id",
      credentialScope: "full" as const,
    };
    const reply = JSON.parse(buildCredentialActionReply(parsed, '{"ok":true,"count":3}'));
    expect(reply.method).toBe("agent/approve");
    expect(reply.params.requestId).toBe("rq2");
    expect(reply.params.decision).toEqual({ approved: true, answer: '{"ok":true,"count":3}' });
  });
});

const workspaceActionLine = (args: Record<string, unknown>, requestId = "rq3", sessionId = "s3") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: { sessionId, requestId, request: { toolName: "__workspace_action__", args } },
  });

describe("parseWorkspaceActionLine", () => {
  test("parses a workspace switch action", () => {
    const p = parseWorkspaceActionLine(workspaceActionLine({ action: "switch", target: "main" }));
    expect(p).toEqual({
      sessionId: "s3",
      requestId: "rq3",
      action: "switch",
      target: "main",
    });
  });

  test("returns null for other hidden actions or malformed payloads", () => {
    expect(parseWorkspaceActionLine(browserActionLine({ action: "click" }))).toBeNull();
    expect(parseWorkspaceActionLine(workspaceActionLine({ action: "switch" }))).toBeNull();
    expect(parseWorkspaceActionLine(workspaceActionLine({ target: "main" }))).toBeNull();
    expect(parseWorkspaceActionLine("not json")).toBeNull();
  });
});

describe("buildWorkspaceActionReply", () => {
  test("wraps the workspace json in an agent/approve resolving the requestId", () => {
    const parsed = { sessionId: "s3", requestId: "rq3", action: "switch", target: "feature" };
    const reply = JSON.parse(buildWorkspaceActionReply(parsed, '{"root":"/repo","kind":"main"}'));
    expect(reply.method).toBe("agent/approve");
    expect(reply.params.sessionId).toBe("s3");
    expect(reply.params.requestId).toBe("rq3");
    expect(reply.params.decision).toEqual({
      approved: true,
      answer: '{"root":"/repo","kind":"main"}',
    });
  });
});

const panelActionLine = (args: Record<string, unknown>, requestId = "rq4", sessionId = "s4") =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "agent/approvalRequest",
    params: { sessionId, requestId, request: { toolName: "__panel_action__", args } },
  });

describe("panel action interception", () => {
  test("parses list/open and rejects malformed panel ids", () => {
    expect(parsePanelActionLine(panelActionLine({ action: "list" }))).toEqual({
      sessionId: "s4",
      requestId: "rq4",
      action: "list",
      panelId: undefined,
    });
    expect(parsePanelActionLine(panelActionLine({ action: "open", panelId: "quickChat" }))).toEqual(
      {
        sessionId: "s4",
        requestId: "rq4",
        action: "open",
        panelId: "quickChat",
      },
    );
    expect(parsePanelActionLine(panelActionLine({ action: "open" }))).toBeNull();
    expect(parsePanelActionLine(panelActionLine({ action: "close" }))).toBeNull();
  });

  test("builds the hidden approval reply", () => {
    const parsed = parsePanelActionLine(panelActionLine({ action: "open", panelId: "files" }))!;
    const reply = JSON.parse(buildPanelActionReply(parsed, '{"ok":true,"panelId":"files"}'));
    expect(reply.params.sessionId).toBe("s4");
    expect(reply.params.requestId).toBe("rq4");
    expect(reply.params.decision.answer).toContain('"panelId":"files"');
  });
});
