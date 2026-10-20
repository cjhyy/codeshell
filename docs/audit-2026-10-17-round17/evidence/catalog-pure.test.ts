import { describe, expect, test } from "bun:test";
import { buildPanelAgentTaskModelCatalog } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/panels/agent-task-models.ts";
import { buildInstance, catalogModelOptions } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/textConnections.ts";
import { validateEntry } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/catalogEditor.ts";

const entry = {
  id: "local",
  tag: "text" as const,
  adapterKind: "ollama",
  protocol: "openai-compat" as const,
  displayName: "Local models",
  description: "Owned plain catalog record",
  defaultBaseUrl: "http://127.0.0.1:11434/v1",
  needsKey: false,
  defaultModel: "one",
  modelPresets: [{ value: "one", label: "模型 One" }, { value: "two" }],
};

const connection = { id: "first", catalogId: "local", tag: "text", model: "one" };

describe("round17 panel catalog pure projection", () => {
  test("uses the connection id for the explicit default and the matching preset label", () => {
    expect(buildPanelAgentTaskModelCatalog({
      defaults: { text: "first" }, modelConnections: [connection],
    }, [entry])).toEqual({
      defaultModel: "first",
      models: [{ id: "first", providerId: "local", provider: "Local models", model: "one", label: "模型 One" }],
    });
  });

  test("keeps configured order and does not use an auxiliary default as the text default", () => {
    const second = { ...connection, id: "second", model: "two" };
    const result = buildPanelAgentTaskModelCatalog({
      defaults: { text: "second", auxText: "first" }, modelConnections: [connection, second],
    }, [entry]);
    expect(result.defaultModel).toBe("second");
    expect(result.models.map((model) => model.id)).toEqual(["first", "second"]);
    expect(result.models[1]!.label).toBe("two");
  });

  test("custom configured model ids need not be catalog presets", () => {
    const result = buildPanelAgentTaskModelCatalog({
      modelConnections: [{ ...connection, model: "custom-model" }],
    }, [entry]);
    expect(result.models[0]!.model).toBe("custom-model");
    expect(result.models[0]!.label).toBe("custom-model");
  });

  test("non-text and missing catalog connections remain excluded", () => {
    const result = buildPanelAgentTaskModelCatalog({ modelConnections: [
      { ...connection, id: "image", tag: "image" },
      { ...connection, id: "stale", catalogId: "removed" }, connection,
    ] }, [entry]);
    expect(result.models.map((model) => model.id)).toEqual(["first"]);
  });

  test("retains the first repeated exact connection id", () => {
    const result = buildPanelAgentTaskModelCatalog({ modelConnections: [
      connection, { ...connection, model: "two" },
    ] }, [entry]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.model).toBe("one");
  });

  test("candidate default: a configured text connection without defaults.text yields no default", () => {
    const result = buildPanelAgentTaskModelCatalog({ modelConnections: [connection] }, [entry]);
    expect(result.models.map((model) => model.id)).toEqual(["first"]);
    expect(result.defaultModel).toBeUndefined();
    expect(Object.hasOwn(result, "defaultModel")).toBe(false);
  });

  test("candidate default: a stale default yields no default while an exact default is retained", () => {
    const result = buildPanelAgentTaskModelCatalog({
      defaults: { text: "removed" }, modelConnections: [connection],
    }, [entry]);
    const control = buildPanelAgentTaskModelCatalog({
      defaults: { text: "first" }, modelConnections: [connection],
    }, [entry]);
    expect(result.defaultModel).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(control.defaultModel).toBe("first");
  });

  test("candidate identity: the real UI helpers preserve a catalog id with surrounding spaces", () => {
    const custom = { ...entry, id: " local " };
    expect(validateEntry(custom)).toEqual([]);
    const made = buildInstance(custom, "one", new Set(), "text");
    expect(made.id).toBe(" local ");
    expect(made.catalogId).toBe(" local ");
    const picker = catalogModelOptions([made], [custom]);
    expect(picker[0]!.key).toBe(" local ");
    const result = buildPanelAgentTaskModelCatalog({
      defaults: { text: made.id }, modelConnections: [made],
    }, [custom]);
    expect(result.models[0]!.id).toBe("local");
    expect(result.defaultModel).toBe("local");
    expect(result.models[0]!.id).not.toBe(made.id);
  });

  test("candidate identity control: an ordinary unpadded catalog id stays equal to its picker key", () => {
    const made = buildInstance(entry, "one", new Set(), "text");
    const result = buildPanelAgentTaskModelCatalog({
      defaults: { text: made.id }, modelConnections: [made],
    }, [entry]);
    expect(validateEntry(entry)).toEqual([]);
    expect(result.models[0]!.id).toBe(made.id);
    expect(result.models[0]!.id).toBe(catalogModelOptions([made], [entry])[0]!.key);
    expect(result.defaultModel).toBe(made.id);
  });

  test("candidate identity: normalization can collapse two distinct configured ids", () => {
    const padded = { ...entry, id: " local ", displayName: "Padded local" };
    const first = buildInstance(padded, "one", new Set(), "text");
    const second = buildInstance(entry, "two", new Set([first.id]), "text");
    expect(first.id).not.toBe(second.id);
    expect(catalogModelOptions([first, second], [padded, entry])).toHaveLength(2);
    const result = buildPanelAgentTaskModelCatalog({ modelConnections: [first, second] }, [padded, entry]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.id).toBe("local");
  });

  test("candidate identity: a UI-created padded model value is rewritten before preset lookup", () => {
    const custom = { ...entry, modelPresets: [{ value: " one ", label: "Padded preset" }] };
    const made = buildInstance(custom, " one ", new Set(), "text");
    const picker = catalogModelOptions([made], [custom]);
    const result = buildPanelAgentTaskModelCatalog({ modelConnections: [made] }, [custom]);
    expect(made.model).toBe(" one ");
    expect(picker[0]!.label).toBe("Padded preset");
    expect(result.models[0]!.model).toBe("one");
    expect(result.models[0]!.label).toBe("one");
  });

  test("ordinary Unicode labels and frozen inputs survive projection without mutation", () => {
    const catalog = Object.freeze([{ ...entry, modelPresets: [{ value: "one", label: "👩‍💻 模型 é" }] }]);
    const settings = Object.freeze({ defaults: Object.freeze({ text: "first" }), modelConnections: Object.freeze([Object.freeze({ ...connection })]) });
    const before = JSON.stringify({ settings, catalog });
    const result = buildPanelAgentTaskModelCatalog(settings, catalog);
    expect(result.models[0]!.label).toBe("👩‍💻 模型 é");
    expect(JSON.stringify({ settings, catalog })).toBe(before);
  });
});
