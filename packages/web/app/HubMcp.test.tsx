import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../src/test-utils/renderHook.js";
import { HubMcp } from "./HubMcp.js";
import type { HubMcpServer } from "./mcp-configuration.js";

// The minimal DOM has no event bubbling; invoke the rendered React handlers.
function nodes(node: unknown): any[] {
  const current = node as { childNodes?: unknown[] };
  return [node, ...Array.from(current.childNodes ?? []).flatMap(nodes)];
}
function props(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}

let root: Root | null = null;
let container: HTMLElement;
let savedFetch: typeof fetch;
let command = "old-command";
let releaseProbe: (() => void) | undefined;

function server(): HubMcpServer {
  return {
    name: "tools",
    source: "settings",
    scope: "local",
    editable: true,
    deletable: true,
    hasLocalOverride: false,
    pluginDisabled: false,
    enabled: true,
    transport: "stdio",
    command,
    argsCount: 0,
    envKeys: [],
    headerKeys: [],
    envVars: [],
    envHeaders: {},
    disabledTools: [],
  };
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  ensureMiniDom();
  savedFetch = globalThis.fetch;
  command = "old-command";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/probe")) {
      // The Hub tested the old command; its response is delayed in transit.
      const checkedAt = new Date().toISOString();
      await new Promise<void>((resolve) => (releaseProbe = resolve));
      return json({
        name: "tools",
        status: "ok",
        checkedAt,
        durationMs: 5,
        toolCount: 1,
        tools: [{ name: "old_command_tool", allowed: true }],
      });
    }
    if (url.includes("/api/v1/mcp")) {
      return json({ workspacePath: "/workspace", servers: [server()], removed: [] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  releaseProbe?.();
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
  globalThis.fetch = savedFetch;
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function render(configurationVersion: number): Promise<void> {
  await act(async () => {
    root?.render(<HubMcp onAuthLost={() => {}} configurationVersion={configurationVersion} />);
  });
  await settle();
}

test("a probe answered after the configuration changed is not shown for the new configuration", async () => {
  await render(0);
  const probeButton = nodes(container).find(
    (node) => node.tagName === "BUTTON" && textOf(node).trim() === "测试连接",
  );
  expect(probeButton).toBeDefined();
  await act(async () => {
    props(probeButton).onClick({ currentTarget: probeButton });
  });
  await settle();

  // Another device changes the command; this page refreshes to it.
  command = "new-command";
  await render(1);
  expect(textOf(container)).toContain("new-command");

  releaseProbe?.();
  await settle();

  expect(textOf(container)).not.toContain("测试连接成功");
  expect(textOf(container)).not.toContain("old_command_tool");
});
