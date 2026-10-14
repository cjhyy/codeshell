import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { RELAY_PROTOCOL_VERSION } from "@cjhyy/code-shell-server/remote-relay";
import { PANEL_APP_API_VERSION } from "../shared/panel-apps.js";
import { DESKTOP_CONTROL_PROTOCOL_VERSION } from "./im-gateway-control-server.js";

// Some contract versions must stay literal: renderer-shared code may only
// import browser-safe entries, the chat package does not depend on core, and
// the remote-relay capability entry deliberately depends on Node builtins only.
// This test is the guard that keeps those literals equal to CONTRACTS.
describe("contract version literals", () => {
  test("renderer-shared Panel API version matches CONTRACTS", () => {
    expect(PANEL_APP_API_VERSION).toBe(CONTRACTS.panelApi);
  });

  test("Desktop control protocol version matches CONTRACTS", () => {
    expect(DESKTOP_CONTROL_PROTOCOL_VERSION).toBe(CONTRACTS.desktopControl);
  });

  test("device relay protocol version matches CONTRACTS", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(CONTRACTS.relayProtocol);
  });

  test("chat package control protocol literal matches CONTRACTS", async () => {
    const source = await readFile(
      new URL("../../../chat/src/protocol.ts", import.meta.url),
      "utf8",
    );
    const match = source.match(/export const DESKTOP_CONTROL_PROTOCOL_VERSION\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(CONTRACTS.desktopControl);
  });
});
