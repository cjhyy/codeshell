import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "DigitalHumansView.tsx"), "utf-8");
const styles = readFileSync(join(import.meta.dir, "..", "styles", "tailwind.css"), "utf-8");
const pageRegistry = readFileSync(join(import.meta.dir, "..", "pages", "PageRegistry.ts"), "utf-8");
const settings = readFileSync(join(import.meta.dir, "..", "settings", "SettingsPage.tsx"), "utf-8");
const dhSection = readFileSync(
  join(import.meta.dir, "..", "settings", "DigitalHumansSection.tsx"),
  "utf-8",
);
const editor = readFileSync(join(import.meta.dir, "DigitalHumanEditorDialog.tsx"), "utf-8");
const memoryDialog = readFileSync(join(import.meta.dir, "DigitalHumanMemoryDialog.tsx"), "utf-8");
const memorySection = readFileSync(
  join(import.meta.dir, "..", "settings", "MemorySection.tsx"),
  "utf-8",
);
const libraryHook = readFileSync(join(import.meta.dir, "useDigitalHumansLibrary.ts"), "utf-8");
const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf-8");
const topBar = readFileSync(join(import.meta.dir, "..", "TopBar.tsx"), "utf-8");
const runController = readFileSync(
  join(import.meta.dir, "..", "app", "useRunController.ts"),
  "utf-8",
);
const main = readFileSync(join(import.meta.dir, "..", "..", "main", "index.ts"), "utf-8");
const profilesService = readFileSync(
  join(import.meta.dir, "..", "..", "main", "profiles-service.ts"),
  "utf-8",
);
const preload = readFileSync(join(import.meta.dir, "..", "..", "preload", "index.ts"), "utf-8");
const preloadTypes = readFileSync(
  join(import.meta.dir, "..", "..", "preload", "types.d.ts"),
  "utf-8",
);

describe("DigitalHumansView contract", () => {
  test("opens as a personal studio with clear navigation and project context", () => {
    // The bundled market can legitimately be empty, so it must not be the
    // default landing surface. The page starts from the user's own roster and
    // keeps market/team management one deliberate navigation step away.
    expect(source).toContain('useState<DigitalHumanTab>("mine")');
    expect(source).toContain("digital-human-hero");
    expect(source).toContain("digital-human-nav");
    expect(source).toContain("digitalHumans.workspace.default");
    expect(source).toContain("<LibraryEmptyState");
    expect(styles).toContain('.digital-human-nav-item[data-state="active"]');
  });

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
    expect(source).not.toContain("digitalHumans.team.mode.");
    expect(source).toContain("digitalHumans.team.leadLabel");
    expect(source).toContain("digitalHumans.team.playbookLabel");
    expect(source).toContain("digitalHumans.team.leadConfigured");
    // Repo teams are live catalog entries. Saving customizes them locally and
    // the action is described as restoring the source, not deleting the team.
    expect(source).toContain("team.sourceRepo");
    expect(source).toContain("team.localOverride");
    expect(source).toContain("digitalHumans.team.customize");
    expect(source).toContain("digitalHumans.team.manageSource");
    expect(source).toContain("digitalHumans.team.restoreSource");
    expect(source).toContain("saveDigitalHumanTeam");
    expect(source).toContain('kind: "team"');
  });

  test("summoning a team briefs every member with the roster it can reach", () => {
    // Members used to be created in mutual ignorance: no teammate Session ids
    // meant SendMessageToSession was unusable and a "team" saved only clicks.
    expect(app).toContain("buildTeamBriefings");
    // The brief goes to the prompt (SessionState.sessionBrief), not the composer:
    // pre-filling the input box read as if the user had typed a spec, and one
    // stray edit or Enter destroyed it.
    expect(app).toContain("sessionBrief: brief");
    expect(app).not.toContain("text: briefing.text");
    expect(app).toContain("teamRole: profileName === team.lead");
    // The lead is the Session the user talks to, so it gets activated.
    expect(app).toContain("activate: index === leadIndex");
  });

  test("supports a discover-download-configure-start journey", () => {
    expect(source).toContain("CuratedTeamCard");
    expect(source).toContain("DigitalHumanDetailDialog");
    expect(source).toContain("digitalHumans.detail.configuredCapabilities");
    expect(source).toContain("availableSkillByName");
    expect(source).toContain("digitalHumans.detail.skillState");
    expect(source).toContain("samplePrompts");
    expect(source).toContain("downloadCatalogEntry");
    expect(source).toContain("downloadCuratedTeam");
    expect(source).toContain("marketplaceMode");
    expect(source).not.toContain("installAndSummon");
    expect(app).toContain("workspaceProfile: profileName");
    expect(app).toContain("setComposerDrafts");
  });

  test("creates and edits a digital human with installed Skill assignment", () => {
    expect(source).toContain("DigitalHumanEditorDialog");
    expect(source).toContain("window.codeshell.saveProfile");
    expect(source).toContain("activeProjectPath ?? undefined");
    expect(source).toContain("availableSkills");
    expect(libraryHook).toContain("api.listSkills");
    expect(editor).toContain("profile?.skills");
    expect(editor).toContain("selectedSkills");
    expect(editor).toContain("projectSkillsDescription");
    expect(editor).toContain("digitalHumans.editor.projectSkillsMore");
    expect(editor).toContain(".slice(0, 8)");
    expect(editor).toContain("digital-human-skill-repo");
    expect(editor).toContain("digitalHumans.editor.saveAndInstall");
    expect(editor).toContain("installRequirements");
    expect(source).toContain("options?.installRequirements");
    expect(source).toContain('skill.source !== "project"');
    expect(source).toContain('t("digitalHumans.editor.create")');
    expect(source).toContain('t("digitalHumans.editor.edit")');
  });

  test("organizes editing into identity, System Prompt, Skills, and settings sections", () => {
    expect(editor).toContain('type EditorSection = "identity" | "prompt" | "skills" | "settings"');
    expect(editor).toContain("digitalHumans.editor.navigationLabel");
    expect(editor).toContain("<EditorSectionHeader");
    expect(editor).toContain("<ToggleCard");
    expect(editor).toContain("digitalHumans.editor.systemPromptField");
    expect(editor).toContain('section === "prompt"');
    expect(editor).toContain("digitalHumans.editor.unsavedChanges");
    // The written Cancel action must use the same dirty-state guard as Esc and
    // backdrop close; directly calling onOpenChange used to bypass it.
    expect(editor).toContain("onClick={() => requestClose(false)}");
  });

  test("presents profile memory as a readable workspace instead of raw settings", () => {
    expect(memoryDialog).toContain('presentation="profile"');
    expect(memoryDialog).toContain("digitalHumans.memory.workspaceTitle");
    expect(memoryDialog).toContain("digitalHumans.memory.enable");
    expect(source).toContain("enable-profile-memory:");
    expect(memorySection).toContain('presentation?: "default" | "profile"');
    expect(memorySection).toContain("profilePresentation");
    expect(memorySection).toContain("settingsX.memory.fieldContent");
    expect(memoryDialog).toContain("onDirtyChange={setDirty}");
    expect(memoryDialog).toContain("onSavingChange={setSaving}");
    expect(memoryDialog).toContain("showClose={!saving}");
    expect(memoryDialog).toContain("settingsX.memory.discardTitle");
    expect(memorySection).toContain("confirmDiscardDraft");
    // Saving may outlive a click. Scope/navigation actions stay locked until
    // the write and reload finish, otherwise an old-scope read can win the race.
    expect(memorySection).toContain("if (saving || next === scope");
    expect(memorySection).toContain("disabled={saving || loading || dreaming}");
    expect(memorySection).toContain("<details");
  });

  test("guards unsaved team edits on every close path", () => {
    expect(source).toContain("digitalHumans.team.discardTitle");
    expect(source).toContain("<Dialog open={open} onOpenChange={requestClose}>");
    expect(source).toContain("onClick={() => requestClose(false)}");
    expect(source).toContain("if (!next && busy) return");
    expect(source).toContain("<DialogContent showClose={!busy}>");
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

  test("keeps the CodeShell runtime base out of digital-human authoring", () => {
    expect(editor).not.toContain('id="digital-human-preset"');
    expect(editor).not.toContain('id="digital-human-version"');
    expect(editor).toContain('basePreset: "general"');
    expect(editor).toContain("profile?.version ? { version: profile.version }");
    expect(profilesService).toContain(
      'saveWorkspaceProfile({ ...profile, basePreset: "general" })',
    );
    expect(source).not.toContain('<dd className="mt-1 font-medium">{preview.basePreset}</dd>');
    expect(source).not.toContain('<Badge variant="secondary">{profile.basePreset}</Badge>');
  });

  test("reviews local definition JSON and keeps rare export tools in settings", () => {
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
    expect(source).toContain("activeProjectPath ?? undefined");
    expect(source).toContain("digitalHumans.transfer.definitionOnlyNotice");
    expect(source).not.toContain("window.codeshell.exportProfileDefinition");
    expect(dhSection).toContain("window.codeshell.exportProfileDefinition");
    expect(dhSection).toContain("settingsX.digitalHumans.advancedExportTitle");
    expect(dhSection).toContain("<details");
    expect(source).toContain("operations.run(`import-profile:${preview.name}`");
  });

  test("a profile card has one primary action and folds the rest into a menu", () => {
    // The footer used to line up 7 controls — details/start/memory/edit/export/
    // delete/set-default — four of them same-weight icon buttons, so nothing
    // read as the thing to click.
    expect(source).toContain("<DropdownMenu");
    // Menu actions launch nested dialogs. Keeping the menu non-modal prevents
    // Radix's pointer-event lock from leaving the studio inert afterwards.
    expect(source).toContain("modal={false}");
    expect(source).toContain("open={menuOpen} onOpenChange={setMenuOpen}");
    expect(source).toContain("digitalHumans.localInstalled");
    expect(source).toContain("digitalHumans.skillReadiness.missing");
    expect(source).toContain("digitalHumans.moreActions");
    for (const action of [
      "digitalHumans.market.details",
      "digitalHumans.editor.edit",
      "digitalHumans.memory.button",
    ]) {
      expect(source).toContain(action);
    }
    expect(source).not.toContain("onExport");
  });

  test("shows Skill installation, availability, and profile configuration separately", () => {
    expect(editor).toContain("digitalHumans.editor.skillsInstalled");
    expect(editor).toContain("digitalHumans.editor.skillsEnabled");
    expect(editor).toContain("digitalHumans.editor.skillsConfigured");
    expect(editor).toContain("digitalHumans.editor.skillInstalledDisabled");
    expect(editor).toContain("digitalHumans.editor.skillNotInstalled");
    expect(editor).toContain("digitalHumans.editor.configuredSkillsTitle");
    expect(editor).toContain("digitalHumans.editor.removeSkill");
    expect(editor).toContain('type SkillFilter = "all" | "selected"');
    // Project requirements install project-scoped Skills. Those must count as
    // installed, and a truly missing requirement needs an install action here
    // instead of waiting for the user to discover the summon-time prompt.
    expect(editor).toContain("...skills, ...projectSkills");
    expect(editor).toContain("window.codeshell.previewProfileRequirements");
    expect(editor).toContain("window.codeshell.installProfileRequirements");
    expect(editor).toContain("digitalHumans.editor.installMissingSkills");
    expect(source).toContain("onRequirementsInstalled={refresh}");
    expect(dhSection).toContain("onRequirementsInstalled={refresh}");
    expect(source).toContain("return false;");
    expect(preloadTypes).toContain('requires?: WorkspaceProfile["requires"]');
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
    // Existing multi-source requirements are preserved; each missing Skill can
    // name or change its trusted source without rewriting unrelated rows.
    expect(editor).toContain("digitalHumanSkillSourcesByName");
    expect(editor).toContain("replaceDigitalHumanSkillSources");
    expect(editor).toContain("changedSkillInstallRepos");
    expect(editor).toContain("missingSkillSourceRows.map");
    expect(editor).toContain("const requirementTools = profile?.requires?.tools ?? []");
    expect(editor).toContain("nextRequirements ? { requires: nextRequirements }");
    expect(source).toContain("editorSaveFlowLock.current");
    expect(source).toContain("editorSaveFlowBusy || operations.isBusy");
    expect(editor).toContain("if (!next && operationBusy) return");
    expect(editor).toContain("showClose={!operationBusy}");
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
    expect(app).toContain('setSettingsInitialModule("digital-humans")');
    expect(app).toContain("initialModule={settingsInitialModule}");
    // The repo panel sits ABOVE the profile list in settings; a long library
    // used to push it off-screen entirely.
    const reposAt = dhSection.indexOf("<DigitalHumanReposPanel />");
    const listAt = dhSection.indexOf("profiles.map((profile)", reposAt);
    expect(reposAt).toBeGreaterThan(-1);
    expect(reposAt).toBeLessThan(listAt);
  });

  test("digital humans can come from a repo and be published as one", () => {
    // Add: repos are managed in the settings section, mirroring the plugin
    // marketplace flow rather than inventing a second one.
    expect(dhSection).toContain("window.codeshell.addProfileRepo");
    expect(dhSection).toContain("window.codeshell.listProfileRepos");
    expect(dhSection).toContain("settingsX.digitalHumans.repos.removeTitle");
    expect(dhSection).toContain("settingsX.digitalHumans.repos.viewIssues");
    expect(main).toContain('"profiles:addRepo"');
    expect(main).toContain('"profiles:listRepos"');
    // Show: a catalog card states which repo it came from.
    expect(source).toContain("entry.sourceRepo");
    // Publish: a repo skeleton, not a bare JSON that has to be hand-delivered.
    expect(main).toContain('"profiles:exportRepo"');
    expect(source).not.toContain("window.codeshell.exportProfileRepo");
    expect(dhSection).toContain("window.codeshell.exportProfileRepo");
  });

  test("starting a team downloads members that are missing from the library", () => {
    // The team definition names three members but only the lead was installed.
    // Sessions were still created, and the lead's first SendMessageToSession died
    // with "Workspace profile ... is unavailable" — twice, two hours apart.
    expect(source).toContain("new Set(profiles.map((profile) => profile.name))");
    expect(source).toContain("window.codeshell.installCatalogProfile(name)");
    expect(source).toContain("digitalHumans.team.memberUnavailable");
  });

  test("market downloads definitions without starting Sessions or installing Skills", () => {
    const singleStart = source.indexOf("const downloadCatalogEntry");
    const teamStart = source.indexOf("const downloadCuratedTeam", singleStart);
    const detailStart = source.indexOf("const launchDetail", teamStart);
    expect(singleStart).toBeGreaterThan(-1);
    expect(teamStart).toBeGreaterThan(singleStart);
    expect(detailStart).toBeGreaterThan(teamStart);

    const singleDownload = source.slice(singleStart, teamStart);
    expect(singleDownload).toContain("window.codeshell.installCatalogProfile");
    expect(singleDownload).toContain('setActiveTab("mine")');
    expect(singleDownload).not.toContain("useSelection(");
    expect(singleDownload).not.toContain("ensureProfileRequirements");

    const teamDownload = source.slice(teamStart, detailStart);
    expect(teamDownload).toContain("window.codeshell.saveDigitalHumanTeam");
    expect(teamDownload).toContain('setActiveTab("teams")');
    expect(teamDownload).not.toContain("useSelection(");
    expect(teamDownload).not.toContain("ensureProfileRequirements");
  });

  test("starting work satisfies requirements, not only the project-default toggle", () => {
    // A real session bound to video-director called /hyperframes, got "Skill not
    // found", searched with Glob, then gave up: starting work never ran the
    // dependency gate, even though it is the common entry point.
    expect(source).toContain("const useSelection");
    expect(source).toContain("ensureSelectionRequirements");
    // Every start-using path routes through the gate; only the wrapper calls onUse.
    expect(source.match(/[^e]onUse\(/g) ?? []).toHaveLength(1);
  });

  test("deleting a digital human unbinds the renderer index too", () => {
    // The backend unbinds Sessions it can see on disk, but a Session that never
    // ran has no engine state — its binding lives only in the renderer index.
    // Left behind, opening it sends a profile that no longer exists and the run
    // dies with "Workspace profile ... is unavailable".
    expect(source).toContain("onProfileDeleted?.(profile.name)");
    expect(app).toContain("unbindWorkspaceProfileEverywhere(name, projectIds)");
  });

  test("a blocked deletion offers force delete instead of a dead end", () => {
    // Unbinding is safe (Sessions survive), so making the user do it by hand
    // across every blocking conversation is busywork, not protection.
    expect(source).toContain("window.codeshell.forceDeleteProfile");
    expect(source).toContain("digitalHumans.delete.forceConfirm");
    expect(main).toContain('"profiles:forceDelete"');
    expect(preload).toContain("forceDeleteProfile");
    expect(preloadTypes).toContain("forceDeleteProfile");
  });

  test("a registered repo can be updated in place, not only removed and re-added", () => {
    // addProfileRepo already fetch+resets an existing clone; the capability
    // existed but had no button.
    expect(dhSection).toContain("settingsX.digitalHumans.repos.update");
  });

  test("the market has no taxonomy or tag filter bar, only search", () => {
    // Two dead ends removed: "精选场景" advertised four fixed scenes regardless of
    // content, and the tag bar that replaced it filtered a 3-entry catalog where
    // 6 of 7 tags matched exactly one card — a filter that picks 1 of 3 is just
    // another way to click the card. Tags stay searchable.
    expect(source).not.toContain("function FeaturedScenes");
    expect(source).not.toContain("DIGITAL_HUMAN_CATEGORIES");
    expect(source).not.toContain("availableTags");
    expect(source).not.toContain("marketTag");
    expect(source).toContain("entry.tags.some((tag) => tag.toLocaleLowerCase()");
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
