import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("desktop third-party notices", () => {
  it("packages the desktop notice file as an electron-builder extraResource", () => {
    const pkg = JSON.parse(readFileSync(`${desktopRoot}/package.json`, "utf8")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };

    expect(pkg.build?.extraResources).toContainEqual({
      from: "THIRD_PARTY_NOTICES.md",
      to: "THIRD_PARTY_NOTICES.md",
    });
  });

  it("covers bundled derived projects and license texts", () => {
    const notice = readFileSync(`${desktopRoot}/THIRD_PARTY_NOTICES.md`, "utf8");

    expect(notice).toContain("OpenAI Codex apply-patch");
    expect(notice).toContain("Apache License 2.0");
    expect(notice).toContain("Yoga");
    expect(notice).toContain("browser-use");
    expect(notice).toContain("MIT License");
  });
});
