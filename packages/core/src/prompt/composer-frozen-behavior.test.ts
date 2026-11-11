import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../types.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import { RunToolSurface } from "../tool-system/run-tool-surface.js";
import { PromptComposer } from "./composer.js";

const discovery: ToolDefinition = {
  name: "ToolSearch",
  description: "Discover eligible tools",
  inputSchema: { type: "object", properties: {} },
};
const browser: ToolDefinition = {
  name: "browser_navigate",
  description: "Navigate the browser",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
};

describe("frozen behavior instructions follow the tool-cache cycle", () => {
  test.each(["call-tool", "tool-reference"] as const)(
    "%s keeps instructions through discovery, eligibility changes and warm resume; cold rebase refreshes them",
    async (toolDiscovery) => {
      const surface = new RunToolSurface(["ToolSearch"], { toolDiscovery });
      surface.updateCatalog([discovery, browser]);
      const composer = new PromptComposer({
        cwd: process.cwd(),
        model: "test-model",
        preset: BUILTIN_AGENT_PRESETS.general,
        toolDiscovery,
        behaviorToolNames: surface.behaviorSnapshot(),
      });
      const eagerBefore = JSON.stringify(surface.snapshot());
      const initial = await composer.buildSystemPrompt(surface.snapshot());
      expect(initial).toContain("## Browser automation");
      expect(initial).toContain("\nToolSearch\n");
      surface.select([browser.name]);
      surface.updateCatalog([discovery]);
      expect(surface.isEligible(browser.name)).toBe(false);
      expect(JSON.stringify(surface.snapshot())).toBe(eagerBefore);
      expect(await composer.buildSystemPrompt(surface.snapshot(), surface.behaviorSnapshot())).toBe(
        initial,
      );

      const resumed = new RunToolSurface(["ToolSearch"], {
        toolDiscovery,
        selection: JSON.parse(JSON.stringify(surface.getSelection())),
      });
      resumed.updateCatalog([discovery]);
      const resumedComposer = new PromptComposer({
        cwd: process.cwd(),
        model: "test-model",
        preset: BUILTIN_AGENT_PRESETS.general,
        toolDiscovery,
        behaviorToolNames: resumed.behaviorSnapshot(),
      });
      expect(await resumedComposer.buildSystemPrompt(resumed.snapshot())).toBe(initial);
      resumed.rebase();
      // The newly unavailable discovered tool has no eager schema to promote.
      // Behavior alone changes, so refresh must not depend only on tools JSON.
      expect(JSON.stringify(resumed.snapshot())).toBe(eagerBefore);
      const cold = await resumedComposer.buildSystemPrompt(
        resumed.snapshot(),
        resumed.behaviorSnapshot(),
      );
      expect(cold).not.toContain("## Browser automation");
      expect(cold).toContain("\nToolSearch\n");
      const restarted = new RunToolSurface(["ToolSearch"], {
        toolDiscovery,
        selection: JSON.parse(JSON.stringify(resumed.getSelection())),
      });
      restarted.updateCatalog([discovery, browser]);
      expect(
        await resumedComposer.buildSystemPrompt(restarted.snapshot(), restarted.behaviorSnapshot()),
      ).toBe(cold);
    },
  );
});
