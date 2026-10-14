import { describe, expect, test } from "bun:test";
import {
  isHostAuthorityRequest,
  unsupportedHostRequestResponse,
  unsupportedLoopbackAnswer,
  unsupportedLoopbackCapability,
} from "./host-requests.js";

const headless = { panels: false };
const hub = { panels: true };

describe("unsupportedLoopbackCapability", () => {
  test("maps the three Desktop-only loopbacks to capability names on any serve host", () => {
    for (const host of [headless, hub]) {
      expect(unsupportedLoopbackCapability("__browser_action__", host)).toBe("browser");
      expect(unsupportedLoopbackCapability("__credential_action__", host)).toBe(
        "credential.browserCookie",
      );
      expect(unsupportedLoopbackCapability("__workspace_action__", host)).toBe("workspace.switch");
    }
  });

  test("treats Panel actions as unsupported only when the host has no Panel runtime", () => {
    expect(unsupportedLoopbackCapability("__panel_action__", headless)).toBe("panel");
    expect(unsupportedLoopbackCapability("__panel_action__", hub)).toBeUndefined();
  });

  test("leaves AskUser, ordinary tools and non-strings alone", () => {
    expect(unsupportedLoopbackCapability("__ask_user__", headless)).toBeUndefined();
    expect(unsupportedLoopbackCapability("Bash", headless)).toBeUndefined();
    expect(unsupportedLoopbackCapability("toString", headless)).toBeUndefined();
    expect(unsupportedLoopbackCapability(undefined, headless)).toBeUndefined();
  });
});

describe("unsupportedLoopbackAnswer", () => {
  test("is a JSON result every core loopback parser reads as a typed failure", () => {
    expect(JSON.parse(unsupportedLoopbackAnswer("browser"))).toEqual({
      ok: false,
      failure: "unsupported",
      capability: "browser",
      error: "browser is not supported by this host (headless serve)",
      detail: "browser is not supported by this host (headless serve)",
    });
  });
});

describe("isHostAuthorityRequest", () => {
  test("matches worker requests in the desktop/ namespace", () => {
    expect(isHostAuthorityRequest({ id: "a-1", method: "desktop/automationCreate" })).toBe(true);
    expect(isHostAuthorityRequest({ id: 7, method: "desktop/credentialResolve" })).toBe(true);
  });

  test("ignores notifications, responses and other namespaces", () => {
    expect(isHostAuthorityRequest({ method: "desktop/operationBatch" })).toBe(false);
    expect(isHostAuthorityRequest({ id: null, method: "desktop/automationCreate" })).toBe(false);
    expect(isHostAuthorityRequest({ id: "r-1" })).toBe(false);
    expect(isHostAuthorityRequest({ id: "r-2", method: "agent/streamEvent" })).toBe(false);
  });

  test("requires the desktop/ prefix including the slash", () => {
    expect(isHostAuthorityRequest({ id: "a", method: "desktop" })).toBe(false);
    expect(isHostAuthorityRequest({ id: "a", method: "desktopX/foo" })).toBe(false);
  });

  test("treats an empty-string id as a request, since a JSON-RPC id may be any string", () => {
    expect(isHostAuthorityRequest({ id: "", method: "desktop/x" })).toBe(true);
  });
});

describe("unsupportedHostRequestResponse", () => {
  test("is a JSON-RPC MethodNotFound error tagged unsupported", () => {
    expect(JSON.parse(unsupportedHostRequestResponse("a-1", "desktop/automationCreate"))).toEqual({
      jsonrpc: "2.0",
      id: "a-1",
      error: {
        code: -32601,
        message: "desktop/automationCreate is not supported by this host (headless serve)",
        data: { failure: "unsupported", capability: "desktop/automationCreate" },
      },
    });
  });

  test("round-trips a numeric id", () => {
    expect(JSON.parse(unsupportedHostRequestResponse(7, "desktop/x")).id).toBe(7);
  });
});
