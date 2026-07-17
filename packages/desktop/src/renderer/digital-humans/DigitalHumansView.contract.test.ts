import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "DigitalHumansView.tsx"), "utf-8");
const pageRegistry = readFileSync(join(import.meta.dir, "..", "pages", "PageRegistry.ts"), "utf-8");
const settings = readFileSync(join(import.meta.dir, "..", "settings", "SettingsPage.tsx"), "utf-8");
const dhSection = readFileSync(
  join(import.meta.dir, "..", "settings", "DigitalHumansSection.tsx"),
  "utf-8",
);
const editor = readFileSync(join(import.meta.dir, "DigitalHumanEditorDialog.tsx"), "utf-8");
const libraryHook = readFileSync(join(import.meta.dir, "useDigitalHumansLibrary.ts"), "utf-8");
const main = readFileSync(join(import.meta.dir, "..", "..", "main", "index.ts"), "utf-8");
const preload = readFileSync(join(import.meta.dir, "..", "..", "preload", "index.ts"), "utf-8");
const preloadTypes = readFileSync(
  join(import.meta.dir, "..", "..", "preload", "types.d.ts"),
  "utf-8",
);

describe("DigitalHumansView contract", () => {
  test("is a first-class market and library rather than a capabilities toggle", () => {
    expect(pageRegistry).toContain('"sidebar.digitalHumans"');
    expect(source).toContain('value="market"');
    expect(source).toContain('value="mine"');
    expect(source).toContain("window.codeshell.installCatalogProfile");
    // Settings now hosts digital humans through a dedicated dual-scope section:
    // global scope manages the library with the SAME editor dialog as the
    // digital-humans page; project scope reuses ProfileSection for activation.
    expect(settings).toContain("<DigitalHumansSection");
    expect(dhSection).toContain("DigitalHumanEditorDialog");
    expect(dhSection).toContain("<ProfileSection");
  });

  test("creates Pet-led teams with both parallel modes", () => {
    expect(source).toContain('value="divide"');
    expect(source).toContain('value="compare"');
    expect(source).toContain("saveDigitalHumanTeam");
    expect(source).toContain('kind: "team"');
  });

  test("creates and edits a digital human with installed Skill assignment", () => {
    expect(source).toContain("DigitalHumanEditorDialog");
    expect(source).toContain("window.codeshell.saveProfile");
    expect(source).toContain("availableSkills");
    expect(libraryHook).toContain("api.listSkills");
    expect(editor).toContain("profile?.skills");
    expect(editor).toContain("selectedSkills");
    expect(source).toContain('t("digitalHumans.editor.create")');
    expect(source).toContain('t("digitalHumans.editor.edit")');
  });

  test("uses only the product term digital human", () => {
    expect(source).not.toContain("专家");
  });

  test("enforces the persisted profile limits before saving", () => {
    expect(editor).toContain("maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.label}");
    expect(editor).toContain("maxLength={DIGITAL_HUMAN_PROFILE_LIMITS.mainInstruction}");
    expect(editor).toContain("canAddDigitalHumanSkill");
    expect(editor).toContain("digitalHumans.editor.skillLimitReached");
    expect(editor).toContain("digitalHumans.editor.skillLimitExceeded");
  });

  test("reviews local definition JSON before import and exports definitions without memory", () => {
    expect(main).toContain('"profiles:pickDefinitionImport"');
    expect(main).toContain("previewProfileDefinitionImport(filePath)");
    expect(main).toContain('"profiles:importReviewedDefinition"');
    expect(main).toContain('"profiles:exportDefinition"');
    expect(preload).toContain("pickProfileDefinitionImport");
    expect(preload).toContain("importReviewedProfileDefinition");
    expect(preload).toContain("exportProfileDefinition");
    expect(preloadTypes).toContain("DigitalHumanProfileImportPickResult");
    expect(preloadTypes).toContain("DigitalHumanProfileExportResult");

    expect(source).toContain("ProfileDefinitionImportDialog");
    expect(source).toContain("preview.capabilityCounts");
    expect(source).toContain("preview.portableMemory");
    expect(source).toContain("confirmProfileOverwrite");
    expect(source).toContain("digitalHumans.transfer.definitionOnlyNotice");
    expect(source).toContain("digitalHumans.transfer.exportDefinitionHint");
    expect(source).toContain("operations.run(`import-profile:${preview.name}`");
    expect(source).toContain("operations.run(`export-profile:${profile.name}`");
  });
});
