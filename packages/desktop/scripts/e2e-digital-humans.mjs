/*
 * Real Electron digital-human library smoke.
 *
 * Seeds two profiles and one team under an isolated CodeShell home, opens the
 * production digital-human view, and verifies its three tabs, search, desktop
 * layout, and narrow layout. Optional screenshots are written when
 * CODESHELL_DIGITAL_HUMANS_SCREENSHOT_DIR is set.
 */
/* global document */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const isolated = await makeIsolatedElectronHome("codeshell-digital-humans-e2e-");
const screenshotDir = process.env.CODESHELL_DIGITAL_HUMANS_SCREENSHOT_DIR;
let app;
let win;

const profiles = [
  {
    name: "researcher",
    label: "Research Analyst",
    description: "Finds evidence, compares sources, and reports uncertainty.",
    basePreset: "general",
    plugins: [],
    skills: ["web-research"],
    mcp: [],
    agents: [],
    mainInstruction: "Research carefully and cite the evidence you use.",
    portableMemory: true,
  },
  {
    name: "reviewer",
    label: "Critical Reviewer",
    description: "Challenges assumptions and checks conclusions before delivery.",
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    mainInstruction: "Review work for correctness, risk, and missing evidence.",
    portableMemory: false,
  },
];

async function seedFixture() {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify({ autoUpdates: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const profile of profiles) {
    const directory = join(isolated.codeShellHome, "profiles", profile.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  const teamDirectory = join(isolated.codeShellHome, "digital-human-teams", "research-review");
  await mkdir(teamDirectory, { recursive: true });
  await writeFile(
    join(teamDirectory, "team.json"),
    `${JSON.stringify(
      {
        id: "research-review",
        name: "Research & Review",
        description: "Research first, then independently review the result.",
        members: profiles.map((profile) => profile.name),
        mode: "divide",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
}

async function assertNoHorizontalOverflow(win, label) {
  const metrics = await win.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert(
    metrics.content <= metrics.viewport + 1,
    `${label} overflowed horizontally: content=${metrics.content}, viewport=${metrics.viewport}`,
  );
}

async function settleRenderer(win) {
  await win.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolveFrame) => {
      const requestFrame = document.defaultView?.requestAnimationFrame;
      if (!requestFrame) {
        resolveFrame();
        return;
      }
      requestFrame(() => requestFrame(resolveFrame));
    });
  });
}

async function screenshot(win, filename) {
  if (!screenshotDir) return;
  await settleRenderer(win);
  const output = join(screenshotDir, filename);
  await win.screenshot({ path: output });
  console.log(`digital-human visual: ${output}`);
}

try {
  await seedFixture();
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await win.setViewportSize({ width: 1_440, height: 960 });
  await win.locator("#root").waitFor({ state: "visible", timeout: 20_000 });

  const navButton = win.locator("aside").getByRole("button", { name: /数字人|Digital humans/i });
  await navButton.waitFor({ state: "visible", timeout: 20_000 });
  await navButton.click();
  await win
    .getByRole("heading", { level: 1, name: /数字人|Digital humans/i })
    .waitFor({ state: "visible", timeout: 20_000 });
  await win.getByRole("tab", { name: /数字人广场|Market/i }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human market");
  await screenshot(win, "digital-humans-market.png");

  await win.getByRole("tab", { name: /我的数字人|My digital humans/i }).click();
  await win.getByText("Research Analyst", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Critical Reviewer", { exact: true }).waitFor({ state: "visible" });

  const search = win.getByRole("textbox", { name: /搜索数字人或团队|Search digital humans/i });
  await search.fill("Critical");
  await win.getByText("Critical Reviewer", { exact: true }).waitFor({ state: "visible" });
  assert(
    (await win.getByText("Research Analyst", { exact: true }).count()) === 0,
    "digital-human search did not filter an unrelated profile",
  );
  await search.fill("");
  await win.getByText("Research Analyst", { exact: true }).waitFor({ state: "visible" });
  await search.blur();
  await assertNoHorizontalOverflow(win, "digital-human profiles");
  await screenshot(win, "digital-humans-mine.png");

  await win.getByRole("tab", { name: /数字人团队|Teams/i }).click();
  await win.getByText("Research & Review", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Research Analyst", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Critical Reviewer", { exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human teams");
  await screenshot(win, "digital-humans-teams.png");

  await win.setViewportSize({ width: 700, height: 900 });
  await win
    .getByRole("heading", { level: 1, name: /数字人|Digital humans/i })
    .waitFor({ state: "visible" });
  await search.waitFor({ state: "visible" });
  for (const tabName of [
    /数字人广场|Market/i,
    /我的数字人|My digital humans/i,
    /数字人团队|Teams/i,
  ]) {
    await win.getByRole("tab", { name: tabName }).waitFor({ state: "visible" });
  }
  await win.getByText("Research & Review", { exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human narrow layout");
  await screenshot(win, "digital-humans-mobile.png");

  assert(rendererErrors.length === 0, `renderer emitted ${rendererErrors.length} page error(s)`);
  console.log("CodeShell Electron digital-human E2E: passed");
} catch (error) {
  if (win) {
    const headings = await win
      .getByRole("heading")
      .allTextContents()
      .catch(() => []);
    const tabs = await win
      .getByRole("tab")
      .allTextContents()
      .catch(() => []);
    console.error("digital-human E2E headings:", JSON.stringify(headings));
    console.error("digital-human E2E tabs:", JSON.stringify(tabs));
    if (screenshotDir) {
      await screenshot(win, "digital-humans-failure.png").catch(() => undefined);
    }
  }
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await isolated.cleanup();
}
