import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const isolatedRunner = fileURLToPath(
  new URL("../../../scripts/run-isolated-node-smoke.mjs", import.meta.url),
);
const fixtures = [
  "components/ui/overlay.browser.fixture.mjs",
  "settings/SettingsMenu.browser.fixture.mjs",
  "account/AccountSidebarEntry.browser.fixture.mjs",
  "chat/anchored-popovers.browser.fixture.mjs",
  "ChatView.autocomplete.browser.fixture.mjs",
  "ui/specialized-overlays.browser.fixture.mjs",
  "ui/page-surfaces.browser.fixture.mjs",
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
