import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "DigitalHumansView.tsx"), "utf-8");
const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf-8");
const settings = readFileSync(
  join(import.meta.dir, "..", "settings", "SettingsPage.tsx"),
  "utf-8",
);

describe("DigitalHumansView contract", () => {
  test("is a first-class market and library rather than a capabilities toggle", () => {
    expect(sidebar).toContain('t("sidebar.digitalHumans")');
    expect(source).toContain('value="market"');
    expect(source).toContain('value="mine"');
    expect(source).toContain('window.codeshell.installCatalogProfile');
    expect(settings).not.toContain("<ProfileSection");
  });

  test("creates Pet-led teams with both parallel modes", () => {
    expect(source).toContain('value="divide"');
    expect(source).toContain('value="compare"');
    expect(source).toContain("saveDigitalHumanTeam");
    expect(source).toContain('kind: "team"');
  });

  test("uses only the product term digital human", () => {
    expect(source).not.toContain("专家");
  });
});
