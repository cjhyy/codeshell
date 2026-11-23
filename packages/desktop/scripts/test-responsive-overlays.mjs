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
  "activity/UsagePage.browser.fixture.mjs",
  "messages/AskUserMessageView.browser.fixture.mjs",
  "messages/AskUserReceipt.browser.fixture.mjs",
  "tool-cards/ToolCardShell.browser.fixture.mjs",
  "settings/AppearanceSection.browser.fixture.mjs",
  "settings/ContextSettingsSection.browser.fixture.mjs",
  "pet/PetSettingsPage.browser.fixture.mjs",
  "updater/UpdaterBanner.browser.fixture.mjs",
  "Sidebar.browser.fixture.mjs",
  "runtime/CloudProjectWorkspace.browser.fixture.mjs",
  "runtime/AccountDeviceWorkspace.browser.fixture.mjs",
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
  "ChatView.goal-reply.browser.fixture.mjs",
  "cc-room/CCConversationView.settings.browser.fixture.mjs",
  "MessageStream.context-selection.browser.fixture.mjs",
  "messages/TurnProcessGroupCard.steer.browser.fixture.mjs",
  "panels/QuickChatPanel.browser.fixture.mjs",
  "task-inbox/TaskInboxPage.browser.fixture.mjs",
  "panels/FilesPanel.browser.fixture.mjs",
  "ui/specialized-overlays.browser.fixture.mjs",
  "ui/page-surfaces.browser.fixture.mjs",
  "ui/NotificationHistory.browser.fixture.mjs",
];

// `--part 2/3` runs every third fixture starting at the second. Parts are assigned by
// list position, so the parts of one total cover each fixture exactly once and stay
// close in size when fixtures are added. Without it every fixture runs.
function selectPart(argv) {
  if (!argv.length) return fixtures;
  const match = argv.length === 2 && argv[0] === "--part" && /^([1-9])\/([1-9])$/.exec(argv[1]);
  const [index, total] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || index > total)
    throw new Error("usage: test-responsive-overlays.mjs [--part <n>/<total>]");
  return fixtures.filter((_, position) => position % total === index - 1);
}
if (new Set(fixtures).size !== fixtures.length) throw new Error("duplicate overlay fixture");
const selected = selectPart(process.argv.slice(2));
console.log(`overlay fixtures: ${selected.length} of ${fixtures.length}`);

const timings = [];
for (const fixture of selected) {
  const started = Date.now();
  const entry = fileURLToPath(new URL(`../src/renderer/${fixture}`, import.meta.url));
  const child = spawn(process.execPath, [isolatedRunner, entry], { stdio: "inherit" });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (code !== 0 || signal) throw new Error(`${fixture} failed (${signal ?? code})`);
  timings.push([Math.round((Date.now() - started) / 1000), fixture]);
}
// Seconds per fixture, slowest first: the evidence for rebalancing parts.
for (const [seconds, fixture] of timings.sort((a, b) => b[0] - a[0]))
  console.log(`${String(seconds).padStart(5)}s  ${fixture}`);
