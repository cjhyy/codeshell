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
const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf-8");
const topBar = readFileSync(join(import.meta.dir, "..", "TopBar.tsx"), "utf-8");
const runController = readFileSync(
  join(import.meta.dir, "..", "app", "useRunController.ts"),
  "utf-8",
);
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

  test("creates Session-based teams with both collaboration modes", () => {
    expect(source).toContain('value="divide"');
    expect(source).toContain('value="compare"');
    expect(source).toContain("saveDigitalHumanTeam");
    expect(source).toContain('kind: "team"');
  });

  test("supports the discover-detail-sample-summon journey", () => {
    expect(source).toContain("FeaturedScenes");
    expect(source).toContain("CuratedTeamCard");
    expect(source).toContain("DigitalHumanDetailDialog");
    expect(source).toContain("samplePrompts");
    expect(source).toContain("installAndSummon");
    expect(app).toContain("workspaceProfile: profileName");
    expect(app).toContain("setComposerDrafts");
  });

  test("creates and edits a digital human with installed Skill assignment", () => {
    expect(source).toContain("DigitalHumanEditorDialog");
    expect(source).toContain("window.codeshell.saveProfile");
    expect(source).toContain("availableSkills");
    expect(libraryHook).toContain("api.listSkills");
    expect(editor).toContain("profile?.skills");
    expect(editor).toContain("selectedSkills");
    expect(editor).toContain("projectSkillsDescription");
    expect(source).toContain('skill.source !== "project"');
    expect(source).toContain('t("digitalHumans.editor.create")');
    expect(source).toContain('t("digitalHumans.editor.edit")');
  });

  test("owns long-term memory and model-driven Session messaging outside Pet", () => {
    expect(source).toContain("DigitalHumanMemoryDialog");
    expect(runController).toContain("sessionMessageTargets");
    expect(app).not.toContain("petDigitalHumanSelection");
  });

  test("keeps cross-Session messaging as a tool instead of exposing product UI", () => {
    expect(app).not.toContain("SessionHandoffDialog");
    expect(topBar).not.toContain("data-handoff-action");
    expect(topBar).not.toContain("onOpenHandoff");
  });

  test("lets an existing project Session switch its digital human", () => {
    expect(app).toContain("setSessionWorkspaceProfileLocal");
    expect(app).toContain("window.codeshell.setSessionWorkspaceProfile");
    expect(main).toContain('"profiles:setSession"');
    expect(preload).toContain("setSessionWorkspaceProfile");
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
    // Export moved from an icon button (tooltip-only label) into the card's
    // overflow menu, where it carries a written label instead of a hint.
    expect(source).toContain("digitalHumans.transfer.exportDefinition");
    expect(source).toContain("operations.run(`import-profile:${preview.name}`");
    expect(source).toContain("operations.run(`export-profile:${profile.name}`");
  });

  test("a profile card has one primary action and folds the rest into a menu", () => {
    // The footer used to line up 7 controls — details/summon/memory/edit/export/
    // delete/set-default — four of them same-weight icon buttons, so nothing
    // read as the thing to click.
    expect(source).toContain("<DropdownMenu>");
    expect(source).toContain("digitalHumans.moreActions");
    for (const action of [
      "digitalHumans.market.details",
      "digitalHumans.editor.edit",
      "digitalHumans.memory.button",
      "digitalHumans.transfer.exportDefinition",
    ]) {
      expect(source).toContain(action);
    }
  });

  test("deletion is preflighted so blockers surface before the confirm", () => {
    // deleteProfile throws when a team or Session still binds the profile, but
    // that lands after the user already confirmed, as raw English listing
    // session ids. The preview must run first.
    expect(source).toContain("window.codeshell.previewProfileDeletion");
    expect(source).toContain("preview.canDelete");
    expect(source).toContain("digitalHumans.delete.blockedByTeams");
    expect(source).toContain("digitalHumans.delete.blockedBySessions");
    expect(main).toContain('"profiles:previewDeletion"');
    expect(preload).toContain("previewProfileDeletion");
    expect(preloadTypes).toContain("previewProfileDeletion");
  });

  test("an empty market shows only a way forward, not chrome over a void", () => {
    // Both bundled sources ship empty now. Without this guard the tab renders
    // four scene cards with no entries, a "browse (0)" heading and five
    // category filters that filter nothing.
    expect(source).toContain("const marketIsEmpty =");
    expect(source).toContain("catalog.length === 0 && CURATED_DIGITAL_HUMAN_TEAMS.length === 0");
    expect(source).toContain("{marketIsEmpty ? (");

    // The dead end must offer the two real ways to get a digital human.
    expect(source).toContain("<CatalogEmptyState");
    expect(source).toContain("onImport={() => void pickProfileDefinitionImport()}");
    expect(source).toContain("onCreate={() => setEditor({})}");
    expect(source).toContain("digitalHumans.emptyCatalogDescription");
  });
});
