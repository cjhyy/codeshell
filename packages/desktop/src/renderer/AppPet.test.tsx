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

  test("contains no Pet approval, direction, Team, or quick-chat cleanup route", () => {
    expect(petSource).not.toContain("codeshell.approve");
    expect(petSource).not.toContain("ApprovalResult");
    expect(petSource).not.toContain("PetSendDirection");
    expect(petSource).not.toContain("send_direction");
    expect(petSource).not.toContain("teamId");
    expect(petSource).not.toContain("cleanupQuickChatSession");
    expect(petSource).not.toContain('type: "evict"');
  });

  test("opens the Pet page only from explicit entry or peek action wiring", () => {
    const openCalls = appSource.match(/viewMode: "pet"/g) ?? [];
    expect(openCalls).toHaveLength(2);
    expect(appSource).toContain("onOpenPetPage");
    expect(appSource).toContain("handlePetPeekAction");
    expect(appSource).not.toContain("set-overview-open");
  });

  test("Pet is a persisted first-class page and never an overlay over chat", () => {
    expect(viewSource).toContain('| "pet"');
    expect(viewSource).toContain('"pet",');
    expect(petSource).toContain('data-pet-page="standalone"');
    expect(appSource).toContain('const isPetView = view.viewMode === "pet"');
    expect(appSource).toContain("{isPetView ? (");
    expect(appSource).toContain("sessionTitle={isPetView ? null : sessionTitleForTop}");
    expect(appSource).toContain("statusAvailable={!isPetView}");
    expect(appSource).not.toContain("overviewOpen");
    expect(appSource).not.toContain("aria-hidden={petState.overviewOpen}");
  });

  test("keeps one Pet input and automatically delegates execution into a normal session", () => {
    expect(petSource).toContain('data-pet-manager-chat="true"');
    expect(petSource).toContain('data-pet-auto-routing="true"');
    expect(petSource).not.toContain("<ChatView");
    expect(petSource).not.toContain('t("pet.chat.delegate")');
    expect(petSource).not.toContain('t("pet.chat.ask")');
    expect(petSource).toContain('event.kind !== "delegation-requested"');
    expect(appSource).toContain("const delegatePetTask");
    expect(appSource).toContain("handleNewConversationForProject(projectId)");
    expect(appSource).toContain("void send(message, { bucket: bucketKey(projectId, null) })");
    expect(appSource).toContain("<PetAutoDelegationHost");
    expect(appSource).toContain("onDelegate={delegatePetTask}");
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
