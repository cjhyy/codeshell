/* Real Settings export review; no model/tool execution. The OS picker alone is stubbed. */
/* global localStorage, window */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-plugin-export-e2e-");
const project = join(isolated.home, "static-project");
const screenshotIndex = process.argv.indexOf("--screenshot-dir");
const screenshotDir = screenshotIndex < 0 ? null : process.argv[screenshotIndex + 1];
let app, win;
const body = "REVIEWED_STATIC_SKILL_BODY\n" + "Long reviewed supporting sentence. ".repeat(100);

async function put(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
}
async function capture(name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await win.screenshot({ path: join(screenshotDir, name), animations: "disabled", scale: "css" });
}
async function dismissTrust() {
  const button = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await button.waitFor({ state: "visible", timeout: 2_000 }).then(
      () => true,
      () => false,
    )
  )
    await button.click();
}

try {
  await put(join(isolated.codeShellHome, "settings.json"), '{"autoUpdates":false}\n');
  await put(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    JSON.stringify([{ path: project, name: "Static project", lastOpenedAt: Date.now() }]),
  );
  await put(
    join(project, ".code-shell", "skills", "reviewed", "SKILL.md"),
    "---\nname: reviewed\ndescription: Reviewed static capability\nallowed-tools: []\n---\n" + body,
  );
  await put(
    join(project, ".code-shell", "skills", "reviewed", "reference.txt"),
    "OPTIONAL_REVIEW_TEXT\n",
  );
  await put(
    join(isolated.codeShellHome, "profiles", "reviewed", "profile.json"),
    JSON.stringify({
      name: "reviewed",
      label: "Review fixture",
      basePreset: "general",
      skills: ["reviewed"],
      agents: [],
      mcp: [],
      plugins: [],
      sourceAccess: [],
      portableMemory: true,
      mainInstruction: "OMITTED_REFERENCE_INSTRUCTION",
    }),
  );
  const guard = join(isolated.home, "export-ui-guard.cjs");
  await put(
    guard,
    `
const fixture = globalThis.__profileExportUI = {
  pid: process.pid, homeHash: require("node:crypto").createHash("sha256").update(process.env.HOME).digest("hex"),
  networkRequests: 0, pickerCalls: 0
};
const deny = () => { fixture.networkRequests++; throw new Error("Static export UI fixture forbids network"); };
globalThis.fetch = async () => deny();
for (const name of ["node:http", "node:https"]) {
  require(name).request = deny;
  require(name).get = deny;
}
require("node:module").syncBuiltinESMExports();
`,
  );
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: guard,
    env: { NODE_OPTIONS: `--require ${guard}` },
  });
  win = await findCodeShellWindow(app);
  const errors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1440, height: 960 });
  await dismissTrust();
  await win.locator("aside").getByRole("button", { name: "Static project", exact: true }).click();
  await dismissTrust();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
  await navigateSettingsMenu(win, /^(设置|Settings)$/);
  await win
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Digital humans", exact: true })
    .click();
  await win.getByText("Advanced export", { exact: true }).click();
  const action = win.getByRole("button", { name: "Export static plugin…", exact: true });
  assert(await action.isEnabled(), "Existing project did not supply export authority");
  await capture("advanced-export-entry.png");
  await action.click();
  const review = win.getByRole("dialog", { name: "Export static plugin · reviewed" });
  await review.getByText("Dependencies and downgrade losses", { exact: true }).waitFor();
  const save = review.getByRole("button", { name: "Choose new directory and export", exact: true });
  assert(await save.isDisabled(), "Empty review enabled export");
  await review.getByRole("checkbox", { name: /^skill: reviewed/ }).check();
  await review.getByText(/Complete file review · 4 files/).waitFor();
  await review.getByRole("checkbox", { name: "reference.txt", exact: true }).check();
  await review.getByText(/Complete file review · 5 files/).waitFor();
  assert(await save.isDisabled(), "Component selection bypassed loss acceptance");
  assert(
    !(await review.innerText()).includes("OMITTED_REFERENCE_INSTRUCTION"),
    "Instruction default was not off",
  );
  const skillFile = review
    .locator("details")
    .filter({ has: win.locator("summary", { hasText: /SKILL\.md/ }) });
  await skillFile.locator("summary").click();
  assert(
    (await skillFile.locator("pre").textContent()).includes(body),
    "Full Skill text was truncated",
  );
  const support = review
    .locator("details")
    .filter({ has: win.locator("summary", { hasText: /reference\.txt/ }) });
  await support.locator("summary").click();
  await support.getByText("OPTIONAL_REVIEW_TEXT", { exact: true }).waitFor();
  for (const width of [1440, 820, 390, 320]) {
    await win.setViewportSize({ width, height: 960 });
    await review.evaluate((node) => {
      node.scrollTop = 0;
    });
    const metrics = await review.evaluate((node) => ({
      viewport: window.innerWidth,
      x: node.getBoundingClientRect().x,
      right: node.getBoundingClientRect().right,
      client: node.clientWidth,
      content: node.scrollWidth,
      overflowing: [...node.querySelectorAll("*")]
        .filter(
          (child) => child.getBoundingClientRect().right > node.getBoundingClientRect().right + 1,
        )
        .slice(0, 8)
        .map((child) => ({
          tag: child.tagName,
          className: child.className,
          width: child.getBoundingClientRect().width,
        })),
    }));
    assert(
      metrics.x >= 0 && metrics.right <= metrics.viewport + 1,
      `Review escapes ${width}px viewport`,
    );
    assert(
      metrics.content <= metrics.client + 1,
      `Review overflows horizontally at ${width}px: ${JSON.stringify(metrics)}`,
    );
    await capture(`static-review-${width}.png`);
  }
  await win.setViewportSize({ width: 1440, height: 960 });
  await review.getByRole("checkbox", { name: /^I reviewed all selected text/ }).check();
  assert(await save.isEnabled(), "Accepted loadable review did not enable save");
  await save.scrollIntoViewIfNeeded();
  await capture("static-review-accepted.png");
  const before = (await readdir(isolated.home)).sort();
  await app.evaluate(({ dialog }) => {
    globalThis.__profileExportUI.originalPicker = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      globalThis.__profileExportUI.pickerCalls++;
      return { canceled: true };
    };
  });
  await save.click();
  await review.waitFor({ state: "hidden" });
  assert(
    JSON.stringify((await readdir(isolated.home)).sort()) === JSON.stringify(before),
    "Canceled picker wrote a directory",
  );
  await capture("static-review-native-cancel.png");
  const existing = join(isolated.home, "existing.plugin");
  const exported = join(isolated.home, "reviewed-export.plugin");
  await put(join(existing, "sentinel.txt"), "EXISTING_DIRECTORY_MUST_SURVIVE\n");
  await action.click();
  await review.getByRole("checkbox", { name: /^skill: reviewed/ }).check();
  await review.getByText(/Complete file review · 4 files/).waitFor();
  await review.getByRole("checkbox", { name: "reference.txt", exact: true }).check();
  await review.getByText(/Complete file review · 5 files/).waitFor();
  await review.getByRole("checkbox", { name: /^I reviewed all selected text/ }).check();
  await app.evaluate(({ dialog }, existing) => {
    globalThis.__profileExportUI.destination = existing;
    dialog.showSaveDialog = async () => {
      globalThis.__profileExportUI.pickerCalls++;
      if (globalThis.__profileExportUI.deferPicker) {
        globalThis.__profileExportUI.deferPicker = false;
        await new Promise((resolve) => {
          globalThis.__profileExportUI.releasePicker = resolve;
        });
        globalThis.__profileExportUI.releasePicker = null;
      }
      return { canceled: false, filePath: globalThis.__profileExportUI.destination };
    };
  }, existing);
  await save.click();
  await review
    .getByRole("alert")
    .filter({ hasText: /already exists/ })
    .waitFor();
  assert(
    (await readFile(join(existing, "sentinel.txt"), "utf8")) ===
      "EXISTING_DIRECTORY_MUST_SURVIVE\n",
    "Rejected existing destination changed an existing file",
  );
  assert(
    await review.getByRole("checkbox", { name: /^skill: reviewed/ }).isChecked(),
    "Failed export discarded its reviewed component selection",
  );
  assert(await save.isDisabled(), "Failed commit retained stale export authority");
  await capture("static-review-existing-destination-rejected.png");
  await review.getByRole("button", { name: "Read again and review", exact: true }).click();
  await review.getByText(/Complete file review · 5 files/).waitFor();
  await review.getByRole("alert").waitFor({ state: "hidden" });
  const accept = review.getByRole("checkbox", { name: /^I reviewed all selected text/ });
  assert(!(await accept.isChecked()), "Refreshing export review preserved stale acceptance");
  await accept.check();
  await app.evaluate((_electron, destination) => {
    globalThis.__profileExportUI.destination = destination;
    globalThis.__profileExportUI.deferPicker = true;
  }, exported);
  await win.setViewportSize({ width: 390, height: 420 });
  await save.click();
  await app.evaluate(async () => {
    const deadline = Date.now() + 3_000;
    while (!globalThis.__profileExportUI.releasePicker && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!globalThis.__profileExportUI.releasePicker)
      throw new Error("Owned picker was not reached");
  });
  assert(await save.isDisabled(), "Pending export opened another destination picker");
  const box = await save.boundingBox();
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert(
    (await app.evaluate(() => globalThis.__profileExportUI.pickerCalls)) === 3,
    "A repeated physical click opened a duplicate picker",
  );
  await app.evaluate(() => globalThis.__profileExportUI.releasePicker());
  await review.waitFor({ state: "hidden" });
  const manifest = JSON.parse(
    await readFile(join(exported, ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert(
    typeof manifest.name === "string" && manifest.name.startsWith("profile-"),
    "Export did not publish its reviewed plugin manifest",
  );
  const skillDirectories = await readdir(join(exported, "skills"));
  assert(skillDirectories.length === 1, "Export wrote unexpected skill directories");
  assert(
    (await readFile(join(exported, "skills", skillDirectories[0], "SKILL.md"), "utf8")).includes(
      body,
    ),
    "Successful export truncated the reviewed skill",
  );
  assert(
    (await readFile(join(exported, "skills", skillDirectories[0], "reference.txt"), "utf8")) ===
      "OPTIONAL_REVIEW_TEXT\n",
    "Successful export omitted its selected supporting file",
  );
  assert(
    (
      await readFile(join(project, ".code-shell", "skills", "reviewed", "SKILL.md"), "utf8")
    ).includes(body),
    "Export changed its source skill",
  );
  await capture("static-review-success.png");
  const receipt = await app.evaluate(({ dialog }) => {
    const {
      originalPicker,
      destination: _destination,
      deferPicker: _deferPicker,
      releasePicker: _releasePicker,
      ...receipt
    } = globalThis.__profileExportUI;
    dialog.showSaveDialog = originalPicker;
    return receipt;
  });
  assert(
    receipt.pickerCalls === 3 && receipt.networkRequests === 0,
    "Unexpected picker/network activity",
  );
  assert(errors.length === 0, `Renderer emitted ${errors.length} errors`);
  console.log(
    JSON.stringify({
      fixture: "profile-static-plugin-electron",
      ...receipt,
      advancedSettingsEntry: true,
      fullText: true,
      lossAcceptance: true,
      viewportWidths: [1440, 820, 390, 320],
      osPickerCancelStub: true,
      existingDestinationRejected: true,
      pendingRepeatedClick: true,
      wrotePackage: true,
    }),
  );
} catch (error) {
  if (win) await capture("static-review-failure.png").catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await isolated.cleanup();
}
