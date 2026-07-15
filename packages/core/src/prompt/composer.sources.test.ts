import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer } from "./composer.js";

const cwd = mkdtempSync(join(tmpdir(), "cs-composer-src-"));

describe("composer sources context", () => {
  test("provider output rides only the dynamic context message", async () => {
    const summary = "## Bound data sources\n- m1 (mock, ok): alpha";
    const composer = new PromptComposer({
      cwd,
      model: "m",
      sourcesContextProvider: async () => summary,
    });

    expect((await composer.buildDynamicContextMessage())?.content).toContain(summary);
    expect(await composer.buildSystemPrompt([])).not.toContain(summary);
  });

  test("empty or failing provider output is not injected", async () => {
    const empty = new PromptComposer({ cwd, model: "m", sourcesContextProvider: () => "" });
    const failing = new PromptComposer({
      cwd,
      model: "m",
      sourcesContextProvider: () => {
        throw new Error("source context unavailable");
      },
    });

    expect((await empty.buildDynamicContextMessage())?.content ?? "").not.toContain(
      "Bound data sources",
    );
    expect((await failing.buildDynamicContextMessage())?.content ?? "").not.toContain(
      "Bound data sources",
    );
  });
});
