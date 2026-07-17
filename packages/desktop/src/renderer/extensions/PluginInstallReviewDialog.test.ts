import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("local plugin install review UI contract", () => {
  test("reviews authoritative capabilities before passing the token to install", () => {
    const tab = readFileSync(join(import.meta.dir, "PluginsTab.tsx"), "utf-8");
    const dialog = readFileSync(join(import.meta.dir, "PluginInstallReviewDialog.tsx"), "utf-8");

    expect(tab.indexOf("previewLocalPlugin({")).toBeGreaterThan(-1);
    expect(tab.indexOf("installLocalPlugin({")).toBeGreaterThan(
      tab.indexOf("previewLocalPlugin({"),
    );
    expect(tab).toContain("reviewToken: preview.reviewToken");
    expect(tab).toContain("preview.alreadyInstalled");
    expect(tab).toContain("overwriteConfirm");
    for (const field of [
      "preview.skills",
      "preview.commands",
      "preview.agents",
      "preview.hooks",
      "preview.mcpServers",
      "preview.panels",
      "preview.automationTemplates",
      "preview.interface.externalLinks",
      "preview.interface.media",
      "preview.warnings",
    ]) {
      expect(dialog).toContain(field);
    }
  });
});
