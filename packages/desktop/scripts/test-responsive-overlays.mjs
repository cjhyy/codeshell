import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const isolatedRunner = fileURLToPath(
  new URL("../../../scripts/run-isolated-node-smoke.mjs", import.meta.url),
);
const fixtures = [
  "app/AppShell.browser.fixture.mjs",
  "components/ui/overlay.browser.fixture.mjs",
  "components/ui/dropdown-menu.browser.fixture.mjs",
  "components/ui/dropdown-surfaces.browser.fixture.mjs",
  "settings/SettingsMenu.browser.fixture.mjs",
  "settings/SettingsPage.focus.browser.fixture.mjs",
  "settings/ConnectionsSettings.browser.fixture.mjs",
  "settings/McpDetailDialogs.browser.fixture.mjs",
  "credentials/LinkProviderDialog.browser.fixture.mjs",
  "credentials/CredentialList.browser.fixture.mjs",
  "shell/SearchDialog.browser.fixture.mjs",
  "pages/HistoryPages.browser.fixture.mjs",
  "activity/ActivityPages.browser.fixture.mjs",
  "messages/AskUserMessageView.browser.fixture.mjs",
  "messages/AskUserReceipt.browser.fixture.mjs",
  "tool-cards/ToolCardShell.browser.fixture.mjs",
  "settings/AppearanceSection.browser.fixture.mjs",
  "settings/ContextSettingsSection.browser.fixture.mjs",
  "pet/PetSettingsPage.browser.fixture.mjs",
  "updater/UpdaterBanner.browser.fixture.mjs",
  "Sidebar.browser.fixture.mjs",
  "runtime/CloudProjectWorkspace.browser.fixture.mjs",
  "projects/CloudProjectDialogs.browser.fixture.mjs",
  "workspace-trust/TrustGate.browser.fixture.mjs",
  "digital-humans/ProfileDialogs.browser.fixture.mjs",
  "account/AccountSidebarEntry.browser.fixture.mjs",
  "chat/anchored-popovers.browser.fixture.mjs",
  "chat/ModelPill.browser.fixture.mjs",
  "chat/BranchPicker.browser.fixture.mjs",
  "chat/PermissionPill.browser.fixture.mjs",
  "chat/ProjectPicker.browser.fixture.mjs",
  "topbar/WorkspaceIndicator.browser.fixture.mjs",
  "topbar/SessionDigitalHumanControl.browser.fixture.mjs",
  "ui/ContextMenu.browser.fixture.mjs",
  "ChatView.autocomplete.browser.fixture.mjs",
  "ChatView.submit.browser.fixture.mjs",
  "ChatView.caret.browser.fixture.mjs",
  "ChatView.composer-overflow.browser.fixture.mjs",
  "MessageStream.context-selection.browser.fixture.mjs",
  "messages/TurnProcessGroupCard.steer.browser.fixture.mjs",
  "panels/QuickChatPanel.browser.fixture.mjs",
  "task-inbox/TaskInboxPage.browser.fixture.mjs",
  "panels/FilesPanel.browser.fixture.mjs",
  "ui/specialized-overlays.browser.fixture.mjs",
  "ui/page-surfaces.browser.fixture.mjs",
  "ui/NotificationHistory.browser.fixture.mjs",
];

for (const fixture of fixtures) {
  const entry = fileURLToPath(new URL(`../src/renderer/${fixture}`, import.meta.url));
  const child = spawn(process.execPath, [isolatedRunner, entry], { stdio: "inherit" });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (code !== 0 || signal) throw new Error(`${fixture} failed (${signal ?? code})`);
}
