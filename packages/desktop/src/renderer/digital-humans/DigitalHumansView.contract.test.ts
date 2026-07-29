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

  test("teams are authored with a lead and a written playbook, not a mode enum", () => {
    // auto/divide/compare never reached any runtime logic — all three produced
    // identical Sessions. A lead plus free-text rules is what actually drives
    // collaboration, so the enum left the UI (the field stays persisted).
    expect(source).not.toContain('<SelectItem value="divide">');
    expect(source).not.toContain('<SelectItem value="compare">');
    expect(source).toContain("digitalHumans.team.leadLabel");
    expect(source).toContain("digitalHumans.team.playbookLabel");
    expect(source).toContain("saveDigitalHumanTeam");
    expect(source).toContain('kind: "team"');
  });

  test("summoning a team briefs every member with the roster it can reach", () => {
    // Members used to be created in mutual ignorance: no teammate Session ids
    // meant SendMessageToSession was unusable and a "team" saved only clicks.
    expect(app).toContain("buildTeamBriefings");
    expect(app).toContain("teamRole: profileName === team.lead");
    // The lead is the Session the user talks to, so it gets activated.
    expect(app).toContain("activate: index === leadIndex");
  });

  test("supports the discover-detail-sample-summon journey", () => {
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
    // Names, not a bare count: "still bound to 3 sessions" gives the user no way
    // to find which conversations to unbind.
    expect(source).toContain("session.title ?? session.id");
    expect(preloadTypes).toContain("blockingSessions: Array<{ id: string; title?: string");
    expect(main).toContain('"profiles:previewDeletion"');
    expect(preload).toContain("previewProfileDeletion");
    expect(preloadTypes).toContain("previewProfileDeletion");
  });

  test("a session's digital human can be unbound, and the switcher is chat-only", () => {
    // Binding used to be one-way: swap yes, return to the project default no.
    expect(topBar).toContain("digitalHumans.sessionBinding.clear");
    expect(app).toContain("digitalHumans.sessionBinding.cleared");
    // Non-chat full-screen views (sessions / approvals / runs / settings) reuse
    // this TopBar; session chrome must be absent there, not merely disabled.
    // One flag drives project name, title, status dot and the switcher so they
    // cannot drift apart again.
    // The IPC guard must not reject "" — a bare `!profileName` check made the
    // unbind path throw before the service ever saw it.
    expect(main).toContain('if (typeof profileName !== "string") {');
    expect(main).not.toContain('typeof profileName !== "string" || !profileName');
    expect(app).toContain("const sessionChromeVisible = !isPetSurface && isChatView;");
    expect(app).toContain(
      "workspaceProfiles={sessionChromeVisible ? sessionWorkspaceProfiles : []}",
    );
    expect(app).toContain("statusAvailable={sessionChromeVisible}");
    expect(app).toContain("sessionTitle={sessionChromeVisible ? sessionTitleForTop : null}");
  });

  test("the editor round-trips requires and guards unsaved edits", () => {
    // The editor has no `requires` field. Without an explicit carry-through,
    // saving a repo-installed digital human strips its dependency declaration
    // and silently turns it back into a shell.
    expect(editor).toContain("...(profile?.requires ? { requires: profile.requires } : {})");
    // Radix closes on backdrop click / Esc; a half-written profile must not
    // vanish without asking.
    expect(editor).toContain("const dirty =");
    expect(editor).toContain("onOpenChange={requestClose}");
    expect(editor).toContain("digitalHumans.editor.discardTitle");
  });

  test("a repo can be added from the market page itself, not only from settings", () => {
    // Requiring a trip through the settings tree to get a FIRST digital human
    // made the market a dead end — its empty state could only describe where to
    // go. The add row lives on the page where you notice the market is empty.
    expect(source).toContain("function AddRepoRow");
    expect(source).toContain("<AddRepoRow");
    expect(source).toContain("window.codeshell.addProfileRepo");
    expect(source).toContain('placeholder="owner/repo"');
    // Still reachable from settings for the full manager (list / remove).
    expect(source).toContain("onManage={onOpenSettings}");
    expect(app).toContain('onOpenSettings={() => setViewMode("settings_page")}');
    // The repo panel sits ABOVE the profile list in settings; a long library
    // used to push it off-screen entirely.
    const reposAt = dhSection.indexOf("<DigitalHumanReposPanel />");
    const listAt = dhSection.indexOf("profiles.map((profile)");
    expect(reposAt).toBeGreaterThan(-1);
    expect(reposAt).toBeLessThan(listAt);
  });

  test("digital humans can come from a repo and be published as one", () => {
    // Add: repos are managed in the settings section, mirroring the plugin
    // marketplace flow rather than inventing a second one.
    expect(dhSection).toContain("window.codeshell.addProfileRepo");
    expect(dhSection).toContain("window.codeshell.listProfileRepos");
    expect(main).toContain('"profiles:addRepo"');
    expect(main).toContain('"profiles:listRepos"');
    // Show: a catalog card states which repo it came from.
    expect(source).toContain("entry.sourceRepo");
    // Publish: a repo skeleton, not a bare JSON that has to be hand-delivered.
    expect(main).toContain('"profiles:exportRepo"');
    expect(source).toContain("window.codeshell.exportProfileRepo");
  });

  test("the market filters by repo-supplied tags, not a fixed category taxonomy", () => {
    // A repo cannot know our four-value enum; anything else it wrote was
    // silently rewritten to "product", so a video crew landed under 产品与策略.
    // "精选场景" compounded it by advertising four scenes regardless of content.
    expect(source).not.toContain("function FeaturedScenes");
    expect(source).not.toContain("DIGITAL_HUMAN_CATEGORIES");
    expect(source).toContain("const availableTags");
    expect(source).toContain("entry.tags.includes(marketTag)");
    expect(source).toContain("digitalHumans.market.tagLabel");
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
