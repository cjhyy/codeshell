import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const rendererRoot = join(import.meta.dir);
const appSource = readFileSync(join(rendererRoot, "App.tsx"), "utf8");
const mainSource = readFileSync(join(rendererRoot, "main.tsx"), "utf8");
const sidebarSource = readFileSync(join(rendererRoot, "Sidebar.tsx"), "utf8");
const viewSource = readFileSync(join(rendererRoot, "view.ts"), "utf8");
const sessionNavigationSource = readFileSync(
  join(rendererRoot, "app", "useSessionNavigation.ts"),
  "utf8",
);
const hostSubscriptionsSource = readFileSync(
  join(rendererRoot, "app", "useHostSubscriptions.ts"),
  "utf8",
);
const settingsMenuSource = readFileSync(join(rendererRoot, "settings", "SettingsMenu.tsx"), "utf8");
const petSource = readdirSync(join(rendererRoot, "pet"))
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .map((name) => readFileSync(join(rendererRoot, "pet", name), "utf8"))
  .join("\n");

describe("App Pet lifecycle boundaries", () => {
  test("keeps the provider outside App and Settings as a mounted-shell overlay", () => {
    expect(mainSource).toContain("<PetStateProvider>");
    expect(mainSource).toContain("<App />");
    expect(appSource).toContain('className={isSettingsPage ? "hidden"');
    expect(appSource).toContain("{isSettingsPage && (");
    expect(appSource).not.toMatch(/if\s*\(isSettingsPage\)\s*return/);
  });

  test("contains no Pet approval, direction, or quick-chat cleanup route", () => {
    expect(petSource).not.toContain("codeshell.approve");
    expect(petSource).not.toContain("ApprovalResult");
    expect(petSource).not.toContain("PetSendDirection");
    expect(petSource).not.toContain("send_direction");
    expect(petSource).not.toContain("cleanupQuickChatSession");
    expect(petSource).not.toContain('type: "evict"');
  });

  test("starts profile-bound project Sessions directly from the Digital Human Center", () => {
    expect(appSource).toContain("createSession(activeProjectId, title");
    expect(appSource).toContain("workspaceProfile: profileName");
    expect(appSource).not.toContain("petDigitalHumanSelection");
  });

  test("keeps Pet independent from digital-human identity and team routing", () => {
    expect(appSource).not.toContain("loadDigitalHumanSelection()");
    expect(appSource).not.toContain("saveDigitalHumanSelection(");
    expect(petSource).not.toContain("digitalHumanTeamId");
    expect(petSource).not.toContain("digitalHumanId");
  });

  test("opens the Pet page only from explicit entry or peek action wiring", () => {
    const openCalls = appSource.match(/viewMode: "pet"/g) ?? [];
    expect(openCalls).toHaveLength(2);
    expect(appSource).toContain("onOpenPetPage");
    expect(appSource).toContain("handlePetPeekAction");
    expect(appSource).not.toContain("set-overview-open");
  });

  test("Pet is a persisted first-class page and never an overlay over chat", () => {
    expect(viewSource).toContain('"pet",');
    expect(petSource).toContain('data-pet-page="standalone"');
    expect(appSource).toContain('const isPetView = view.viewMode === "pet"');
    expect(appSource).toContain('const isPetSettingsView = view.viewMode === "pet_settings"');
    expect(appSource).toContain("{isPetView ? (");
    expect(appSource).toContain("sessionTitle={isPetSurface ? null : sessionTitleForTop}");
    expect(appSource).toContain("statusAvailable={!isPetSurface}");
    expect(appSource).not.toContain("overviewOpen");
    expect(appSource).not.toContain("aria-hidden={petState.overviewOpen}");
  });

  test("opens a standalone Mimi settings page without leaking its model into work Sessions", () => {
    expect(viewSource).toContain('"pet_settings",');
    expect(petSource).toContain('data-pet-settings-page="standalone"');
    expect(petSource).toContain('t("pet.settings.open")');
    expect(appSource).toContain('onOpenSettings={() => setViewMode("pet_settings")}');
    expect(appSource).toContain("hasModelOverride={petChatModelKey !== null}");
    expect(appSource).not.toContain("model: petChatModelKey");
  });

  test("keeps one Pet input while main owns automatic Work Session execution", () => {
    expect(petSource).toContain('data-pet-manager-chat="true"');
    expect(petSource).toContain('data-pet-auto-routing="true"');
    expect(petSource).not.toContain("<ChatView");
    expect(petSource).not.toContain('t("pet.chat.delegate")');
    expect(petSource).not.toContain('t("pet.chat.ask")');
    expect(appSource).not.toContain("PetAutoDelegationHost");
    expect(appSource).not.toContain("delegatePetTask");
    expect(appSource).not.toContain('event.kind !== "delegation-requested"');
    expect(hostSubscriptionsSource).toContain("onPetDelegationSession");
    expect(hostSubscriptionsSource).toContain('announceHostSession(meta, "pet-delegation")');
    expect(hostSubscriptionsSource).toContain("registerBrowserSessionBucket");
  });

  test("selecting a normal session exits the Pet surface", () => {
    const start = sessionNavigationSource.indexOf("const selectSession");
    const end = sessionNavigationSource.indexOf("const findSessionByEngineId", start);
    const handler = sessionNavigationSource.slice(start, end);
    expect(handler).toContain('viewMode: "chat"');
  });

  test("keeps the floating Pet toggle in the bottom settings menu", () => {
    expect(sidebarSource).not.toContain("onToggleWidget");
    expect(settingsMenuSource).toContain("onTogglePetWidget");
    expect(settingsMenuSource).toContain('"pet.widget.hide"');
    expect(settingsMenuSource).toContain('"pet.widget.show"');
  });

  test("opens language explicitly and keeps the full settings entry last", () => {
    const petToggleIndex = settingsMenuSource.indexOf('"pet.widget.hide"');
    const languageIndex = settingsMenuSource.indexOf('t("settingsX.menu.switchLanguage")');
    const openSettingsIndex = settingsMenuSource.indexOf('t("settingsX.menu.openSettings")');
    expect(settingsMenuSource).not.toContain("onMouseEnter");
    expect(settingsMenuSource).not.toContain("onFocus");
    expect(settingsMenuSource).toContain("toggleSubmenu(event.currentTarget)");
    expect(petToggleIndex).toBeGreaterThan(-1);
    expect(languageIndex).toBeGreaterThan(petToggleIndex);
    expect(openSettingsIndex).toBeGreaterThan(languageIndex);
  });

  test("starts the desktop Pet hidden until the user explicitly toggles it", () => {
    expect(appSource).toContain("const [petWidgetVisible, setPetWidgetVisible] = useState(false)");
    expect(appSource).toContain(".getWidgetVisibility()");
    expect(appSource).not.toContain("loadPetWidgetVisible");
    expect(appSource).not.toContain("savePetWidgetVisible");
  });

  test("mounts the Pet in its own desktop window instead of the App renderer", () => {
    expect(mainSource).toContain('params.get("popout") === "pet"');
    expect(mainSource).toContain("<PetDesktopWindow />");
    expect(appSource).not.toContain("<PetWidget");
    expect(petSource).toContain('data-pet-widget="desktop-window"');
    expect(petSource).toContain("window.codeshell.pet.moveWidget");
    expect(petSource).toContain('data-pet-mini-panel="open"');
    expect(petSource).toContain("onDoubleClick");
    expect(petSource).toContain("api.setWidgetVisible(false)");
    expect(petSource).toContain("api.onProjectionEvent");
    expect(petSource).toContain("api.onAttentionEvent");
  });

  test("keeps the immediate system Dock approval badge separate from the grace-delayed Pet badge", () => {
    expect(appSource).toContain("setBadgeCount(approvalQueue.length)");
    expect(appSource).not.toContain("setBadgeCount(surfaceablePendingCount)");
    expect(appSource).toContain("const petPendingCount = surfaceablePendingCount");
  });
});
