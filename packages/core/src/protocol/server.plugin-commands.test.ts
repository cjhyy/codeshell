import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../engine/engine.js";
import { invalidatePluginCommandsCache } from "../plugins/pluginCommandsLoader.js";
import { AgentServer } from "./server.js";
import { ErrorCodes, Methods } from "./types.js";

function makeTransport() {
  const sent: any[] = [];
  let onMessage: (message: unknown) => void = () => {};
  return {
    sent,
    deliver: (message: unknown) => onMessage(message),
    transport: {
      send: (message: unknown) => sent.push(message),
      onMessage: (handler: (message: unknown) => void) => {
        onMessage = handler;
      },
      close: () => {},
    } as any,
  };
}

function makeEngine(): Engine {
  return { isHeadless: () => true } as unknown as Engine;
}

function responseFor(sent: any[], id: number): any {
  for (let index = sent.length - 1; index >= 0; index--) {
    if (sent[index]?.id === id) return sent[index];
  }
  return undefined;
}

describe("AgentServer plugin command protocol", () => {
  let home: string;
  let cwd: string;
  let installPath: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "plugin-command-protocol-"));
    cwd = join(home, "project");
    installPath = join(home, "installed", "demo");
    process.env.HOME = home;
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    mkdirSync(join(installPath, "commands"), { recursive: true });
    mkdirSync(join(home, ".code-shell", "plugins"), { recursive: true });
    writeFileSync(
      join(installPath, "commands", "review.md"),
      [
        "---",
        "description: Review one change",
        "argument-hint: <path>",
        "---",
        "Review $1 carefully. Full request: $ARGUMENTS",
      ].join("\n"),
    );
    writeFileSync(
      join(home, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@local": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
            },
          ],
        },
      }),
    );
    invalidatePluginCommandsCache();
  });

  afterEach(() => {
    invalidatePluginCommandsCache();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("lists safe metadata and expands the trusted command body", () => {
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, engine: makeEngine() });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.PluginCommandsList,
      params: { cwd },
    });
    expect(responseFor(transport.sent, 1)?.result).toEqual({
      commands: [
        {
          name: "demo:review",
          pluginName: "demo",
          description: "Review one change",
          argumentHint: "<path>",
        },
      ],
    });
    expect(JSON.stringify(responseFor(transport.sent, 1)?.result)).not.toContain(installPath);
    expect(JSON.stringify(responseFor(transport.sent, 1)?.result)).not.toContain("Full request");

    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.PluginCommandExpand,
      params: { cwd, name: "demo:review", rawArguments: '"src/app.ts" focus=errors' },
    });
    expect(responseFor(transport.sent, 2)?.result).toEqual({
      prompt: 'Review src/app.ts carefully. Full request: "src/app.ts" focus=errors',
    });
  });

  test("honors project plugin disabling for list and expand", () => {
    writeFileSync(
      join(cwd, ".code-shell", "settings.json"),
      JSON.stringify({ capabilityOverrides: { plugins: { demo: "off" } } }),
    );
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, engine: makeEngine() });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.PluginCommandsList,
      params: { cwd },
    });
    expect(responseFor(transport.sent, 1)?.result).toEqual({ commands: [] });

    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.PluginCommandExpand,
      params: { cwd, name: "demo:review", rawArguments: "" },
    });
    expect(responseFor(transport.sent, 2)?.error).toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringContaining("unavailable"),
    });
  });

  test("rejects malformed or unbounded request parameters", () => {
    const transport = makeTransport();
    new AgentServer({ transport: transport.transport, engine: makeEngine() });

    transport.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: Methods.PluginCommandsList,
      params: { cwd: "" },
    });
    expect(responseFor(transport.sent, 1)?.error?.code).toBe(ErrorCodes.InvalidParams);

    transport.deliver({
      jsonrpc: "2.0",
      id: 2,
      method: Methods.PluginCommandExpand,
      params: { cwd, name: "demo:review", rawArguments: "x".repeat(32 * 1024 + 1) },
    });
    expect(responseFor(transport.sent, 2)?.error).toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringContaining("rawArguments"),
    });
  });
});
