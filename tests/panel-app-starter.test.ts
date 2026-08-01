import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installReviewedLocalPanelApp,
  previewInstalledPanelAppUpdate,
  previewLocalPanelApp,
} from "../packages/core/src/panel-apps/index";

const source = join(import.meta.dir, "..", "examples", "panel-apps", "starter");

describe("Panel App starter", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-panel-starter-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("is a minimal installable UI-only package with a reusable repo source", async () => {
    const preview = await previewLocalPanelApp({ kind: "dir", path: source });
    expect(preview).toMatchObject({
      id: "starter-panel",
      version: "0.1.0",
      entry: "app/index.html",
      permissions: ["context.workspace"],
    });
    const installed = await installReviewedLocalPanelApp(
      { kind: "dir", path: source },
      preview.reviewToken,
      "2026-07-28T00:00:00.000Z",
    );
    expect(installed.source).toBe(source);
    expect((await previewInstalledPanelAppUpdate("starter-panel")).reviewToken).toBe(
      preview.reviewToken,
    );
    // Runs the real preview + install + update-preview pipeline. Fast in
    // isolation (~200ms) but can exceed bun's 5s default when the full suite
    // (1100+ files) is contending for disk, and a timeout reads as a failure.
  }, 60_000);

  test("keeps scripts external and uses only the scoped Panel App bridge", () => {
    const html = readFileSync(join(source, "app", "index.html"), "utf-8");
    const script = readFileSync(join(source, "app", "app.js"), "utf-8");
    expect(html).toContain('script src="./app.js"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(script).toContain("window.codeshellPanel.getContext()");
    expect(script).not.toContain("window.codeshell.");
    expect(script).not.toMatch(/\b(?:require|process|Buffer)\b/);
  });
});
