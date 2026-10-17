import { describe, expect, test } from "bun:test";
import {
  compactSidebarSessions,
  sortSidebarSessions,
} from "../../../../packages/desktop/src/renderer/sidebarSessionVisibility";
import { catalogModelOptions } from "../../../../packages/desktop/src/renderer/settings/textConnections";
import { groupModelOptions } from "../../../../packages/desktop/src/renderer/chat/modelPickerPresentation";
import type { CatalogEntry } from "../../../../packages/desktop/src/preload/types";

describe("round 6 Desktop display projections; owned immutable input only", () => {
  test("sidebar pages keep both required rows, the displayed order, and the input snapshot", () => {
    const input = Object.freeze(
      Array.from({ length: 500 }, (_, index) =>
        Object.freeze({ id: `s-${index}`, updatedAt: index, pinned: index < 10 }),
      ),
    );
    const ordered = Object.freeze(sortSidebarSessions(input));
    expect(ordered[0]!.id).toBe("s-9");
    expect(ordered[10]!.id).toBe("s-499");
    const original = ordered.map(({ id }) => id);
    const position = new Map(original.map((id, index) => [id, index]));
    for (const expanded of [false, true]) {
      for (const page of [1, 2, 3]) {
        const expectedCap = expanded ? 60 * page : 5;
        for (const active of [null, "s-0", "s-250", "s-499"]) {
          for (const revealed of [null, "s-1", "s-200", active]) {
            const visible = compactSidebarSessions(ordered, active, expanded, 5, 60 * page, revealed);
            const ids = visible.map(({ id }) => id);
            expect(ids.length).toBe(expectedCap);
            expect(new Set(ids).size).toBe(ids.length);
            if (active) expect(ids).toContain(active);
            if (revealed) expect(ids).toContain(revealed);
            expect(visible.every((row) => input.includes(row))).toBe(true);
            expect(
              ids.every((id, index) => index === 0 || position.get(ids[index - 1]!)! < position.get(id)!),
            ).toBe(true);
          }
        }
      }
    }
    expect(ordered.map(({ id }) => id)).toEqual(original);
    expect(input.map(({ id }) => id)).toEqual(Array.from({ length: 500 }, (_, index) => `s-${index}`));
  });

  test("catalog projection preserves connection identity despite equal labels and custom model ids", () => {
    const catalog: CatalogEntry[] = [
      {
        id: "provider-a", tag: "text", adapterKind: "openai", displayName: "Provider A",
        description: "", defaultBaseUrl: "https://fixture.invalid/v1",
        modelPresets: [{ value: "known-a", label: "Shared label", supportsVision: false }],
      },
      {
        id: "provider-b", tag: "text", adapterKind: "openai", displayName: "Provider B",
        description: "", defaultBaseUrl: "https://fixture.invalid/v1",
        modelPresets: [{ value: "known-b", label: "Shared label", supportsVision: true }],
      },
    ];
    const connections = [
      { id: "a", catalogId: "provider-a", tag: "text" as const, model: "known-a" },
      { id: "b", catalogId: "provider-b", tag: "text" as const, model: "known-b" },
      { id: "custom", catalogId: "provider-a", tag: "text" as const, model: "custom/model-id" },
      { id: "image", catalogId: "provider-a", tag: "image" as const, model: "image" },
      { id: "stale", catalogId: "removed", tag: "text" as const, model: "old" },
    ];
    const before = JSON.stringify({ connections, catalog });
    const options = catalogModelOptions(connections, catalog);
    expect(options.map(({ key }) => key)).toEqual(["a", "b", "custom"]);
    expect(options.map(({ label }) => label)).toEqual(["Shared label", "Shared label", "custom/model-id"]);
    expect(options.map(({ provider }) => provider)).toEqual(["Provider A", "Provider B", "Provider A"]);
    expect(options.map(({ supportsVision }) => supportsVision)).toEqual([false, true, undefined]);
    expect(JSON.stringify({ connections, catalog })).toBe(before);
  });

  test("grouped display is lossless and retains first-seen provider order and original option objects", () => {
    const options = Object.freeze([
      Object.freeze({ key: "a", label: "Shared label", provider: "Provider A" }),
      Object.freeze({ key: "b", label: "Shared label", provider: "Provider B" }),
      Object.freeze({ key: "custom", label: "custom/model-id", provider: "Provider A" }),
      Object.freeze({ key: "local", label: "Local model", provider: "Local" }),
    ]);
    const grouped = groupModelOptions(options);
    expect(grouped.map(({ provider }) => provider)).toEqual(["Provider A", "Provider B", "Local"]);
    expect(grouped.flatMap(({ options }) => options).map(({ key }) => key)).toEqual(["a", "custom", "b", "local"]);
    const displayed = grouped.flatMap(({ options }) => options);
    for (const option of options) {
      expect(displayed.filter((candidate) => candidate === option)).toHaveLength(1);
    }
    expect(options.map(({ key }) => key)).toEqual(["a", "b", "custom", "local"]);
  });
});
