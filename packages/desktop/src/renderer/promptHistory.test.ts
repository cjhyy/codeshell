import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadHistory, pushHistory } from "./promptHistory";

describe("project prompt-history storage compatibility", () => {
  const originalLocalStorage = globalThis.localStorage;
  const items = new Map<string, string>();

  beforeEach(() => {
    items.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("continues to read and write the legacy project-id key", () => {
    items.set("codeshell.promptHistory.stable-project-id", JSON.stringify(["old prompt"]));

    expect(loadHistory("stable-project-id")).toEqual(["old prompt"]);
    expect(pushHistory("stable-project-id", "new prompt")).toEqual(["new prompt", "old prompt"]);
    expect(items.get("codeshell.promptHistory.stable-project-id")).toBe(
      JSON.stringify(["new prompt", "old prompt"]),
    );
  });

  it("keeps the no-project history under the legacy global segment", () => {
    pushHistory(null, "no project");

    expect(items.get("codeshell.promptHistory.__global__")).toBe(JSON.stringify(["no project"]));
  });
});
