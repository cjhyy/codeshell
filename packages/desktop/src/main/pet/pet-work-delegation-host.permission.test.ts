import { describe, expect, test } from "bun:test";
import type { PetDelegatedEnginePermissionMode } from "../../shared/pet-settings";
import { PetWorkDelegationHost } from "./pet-work-delegation-host";

function acceptingBridge() {
  const lines: string[] = [];
  const listeners = new Set<(line: string) => void>();
  return {
    lines,
    bridge: {
      subscribeOutbound: (listener: (line: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      injectWorkerMessage: (line: string) => {
        lines.push(line);
        const { id } = JSON.parse(line) as { id: string };
        queueMicrotask(() => {
          const accepted = {
            jsonrpc: "2.0",
            method: "agent/runAccepted",
            params: { requestId: id },
          };
          for (const listener of listeners) listener(JSON.stringify(accepted));
        });
      },
      hasKnownSession: () => false,
      reserveHostSession: () => undefined,
      forgetSession: () => undefined,
      broadcastPetDelegationSession: () => undefined,
    },
  };
}

const request = (id: string) => ({
  clientMessageId: `im:wechat:${id}`,
  task: "整理 README",
  workspacePath: "/work/repo",
});

describe("PetWorkDelegationHost permission mode", () => {
  test("defaults to ask (engine default) when no setting resolver is wired", async () => {
    const fake = acceptingBridge();
    const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/unused" });
    await host.start(request("none"));
    expect(JSON.parse(fake.lines[0]!).params.permissionMode).toBe("default");
  });

  test.each<PetDelegatedEnginePermissionMode>([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "auto",
  ])("passes the resolved native mode %s to agent/run", async (mode) => {
    const fake = acceptingBridge();
    const asked: unknown[] = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      permissionMode: async (input) => {
        asked.push(input);
        return mode;
      },
    });
    await host.start(request(mode));
    expect(asked).toEqual([{ cwd: "/work/repo" }]);
    expect(JSON.parse(fake.lines[0]!).params.permissionMode).toBe(mode);
  });

  test.each([
    ["auto", "dontAsk"],
    ["default", "default"],
    ["acceptEdits", "acceptEdits"],
    ["bypassPermissions", "bypassPermissions"],
  ] as const)("maps %s to %s for an external runtime", async (mode, expected) => {
    const fake = acceptingBridge();
    const runs: Array<Record<string, unknown>> = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      permissionMode: async () => mode,
      external: {
        modelKey: async () => "codex/gpt-6.1-sol",
        run: async (params) => {
          runs.push(params);
          return { ok: true };
        },
      },
    });
    await host.start(request(`external-${mode}`));
    expect(fake.lines).toEqual([]);
    expect(runs[0]?.permissionMode).toBe(expected);
  });

  test("reads the setting on every launch so a change applies without restart", async () => {
    const fake = acceptingBridge();
    let current: PetDelegatedEnginePermissionMode = "default";
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      permissionMode: async () => current,
    });
    await host.start(request("first"));
    current = "auto";
    await host.start(request("second"));
    expect(fake.lines.map((line) => JSON.parse(line).params.permissionMode)).toEqual([
      "default",
      "auto",
    ]);
  });
});
