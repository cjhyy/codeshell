import { describe, expect, test } from "bun:test";
import type { CodexDiscoveredModel } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { externalRuntimeModelEntries } from "../shared/external-runtime-models.js";
import type { RuntimeAvailability } from "./external-runtime-availability.js";
import { ExternalRuntimeModelService } from "./external-runtime-model-service.js";

const FIVE_MINUTES = 5 * 60 * 1000;
const installed: RuntimeAvailability[] = [
  { kind: "codex", binary: "codex", path: "/runtime/codex" },
  { kind: "claude-code", binary: "claude", path: "/runtime/claude" },
];
const futureModel: CodexDiscoveredModel = {
  model: "future-model",
  displayName: "Future Model",
  isDefault: true,
};

describe("external runtime model discovery cache", () => {
  test("uses discovered IDs without a code update and keeps other runtimes", async () => {
    let command: string | undefined;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => installed,
      discoverCodex: async (options) => {
        command = options?.command;
        return [
          { model: "small-model", displayName: "Small Model", isDefault: false },
          futureModel,
        ];
      },
    });
    const entries = await service.list();
    expect(command).toBe("/runtime/codex");
    expect(entries[0]).toMatchObject({
      key: "codex/future-model",
      label: "Codex · Future Model",
      kind: "codex",
      provider: "codex",
    });
    expect(entries.filter((entry) => entry.kind === "codex").map((entry) => entry.key)).toEqual([
      "codex/future-model",
      "codex/small-model",
    ]);
    expect(entries.filter((entry) => entry.kind === "claude-code")).toEqual(
      externalRuntimeModelEntries(["claude-code"]),
    );
  });

  test("shares concurrent requests across windows and refreshes after five minutes", async () => {
    let now = 0;
    let calls = 0;
    let resolve!: (models: CodexDiscoveredModel[]) => void;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => installed,
      now: () => now,
      discoverCodex: () => {
        calls++;
        return new Promise((done) => (resolve = done));
      },
    });
    const firstWindow = service.list();
    const secondWindow = service.list();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve([futureModel]);
    expect(await firstWindow).toEqual(await secondWindow);
    now = FIVE_MINUTES - 1;
    await service.list();
    expect(calls).toBe(1);
    now = FIVE_MINUTES;
    const refreshed = service.list();
    await Promise.resolve();
    expect(calls).toBe(2);
    resolve([{ ...futureModel, model: "newly-released-model" }]);
    expect((await refreshed)[0]?.key).toBe("codex/newly-released-model");
  });

  test("falls back on first failure, throttles retries, and recovers later", async () => {
    let now = 0;
    let calls = 0;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => installed,
      now: () => now,
      discoverCodex: () => {
        calls++;
        if (calls === 1) throw new Error("unsupported method");
        return Promise.resolve([futureModel]);
      },
    });
    expect(await service.list()).toEqual(externalRuntimeModelEntries(["codex", "claude-code"]));
    await service.list();
    expect(calls).toBe(1);
    now = FIVE_MINUTES;
    expect((await service.list())[0]?.key).toBe("codex/future-model");
    expect(calls).toBe(2);
  });

  test("keeps the last successful catalog on a later failure", async () => {
    let now = 0;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => installed,
      now: () => now,
      discoverCodex: async () => {
        if (now > 0) throw new Error("offline");
        return [futureModel];
      },
    });
    const first = await service.list();
    now = FIVE_MINUTES;
    expect(await service.list()).toEqual(first);
  });

  test("respects a successful empty catalog instead of advertising unavailable models", async () => {
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => installed,
      discoverCodex: async () => [],
    });
    expect(await service.list()).toEqual(externalRuntimeModelEntries(["claude-code"]));
  });

  test("does not probe when disabled or discover Codex when its binary is absent", async () => {
    let enabled = false;
    let probes = 0;
    let discoveries = 0;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => enabled,
      probe: () => {
        probes++;
        return [{ kind: "claude-code", binary: "claude", path: "/runtime/claude" }];
      },
      discoverCodex: async () => {
        discoveries++;
        return [futureModel];
      },
    });
    expect(await service.list()).toEqual([]);
    expect(probes).toBe(0);
    enabled = true;
    expect(await service.list()).toEqual(externalRuntimeModelEntries(["claude-code"]));
    expect(discoveries).toBe(0);
  });

  test("a different executable gets a fresh catalog", async () => {
    let command = "/first/codex";
    const commands: string[] = [];
    const service = new ExternalRuntimeModelService({
      isEnabled: () => true,
      probe: () => [{ kind: "codex", binary: "codex", path: command }],
      discoverCodex: async (options) => {
        commands.push(options!.command!);
        return [futureModel];
      },
    });
    await service.list();
    command = "/second/codex";
    await service.list();
    expect(commands).toEqual(["/first/codex", "/second/codex"]);
  });

  test("disabling during discovery hides its eventual result", async () => {
    let enabled = true;
    let resolve!: (models: CodexDiscoveredModel[]) => void;
    const service = new ExternalRuntimeModelService({
      isEnabled: () => enabled,
      probe: () => installed,
      discoverCodex: () => new Promise((done) => (resolve = done)),
    });
    const listing = service.list();
    await Promise.resolve();
    enabled = false;
    resolve([futureModel]);
    expect(await listing).toEqual([]);
  });
});
