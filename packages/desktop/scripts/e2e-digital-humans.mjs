/*
 * Real Electron digital-human library smoke.
 *
 * Seeds two profiles, one installed Skill, and one team under an isolated
 * CodeShell home. Opens the production digital-human studio and verifies the
 * library, capability details, editor, System Prompt, Skills, Memory, teams,
 * empty market, desktop layout, and narrow layout. Optional screenshots are written when
 * CODESHELL_DIGITAL_HUMANS_SCREENSHOT_DIR is set.
 */
/* global document */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const fixtureProjectPath = join(isolated.home, "digital-human-lab");
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
    skills: ["critical-review", "media-use"],
    mcp: [],
    agents: [],
    mainInstruction: "Review work for correctness, risk, and missing evidence.",
    portableMemory: false,
  },
];

async function dismissStartupTrustDialog(win) {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const opened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (opened) await viewOnly.click();
}

async function seedFixture() {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await mkdir(fixtureProjectPath, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    `${JSON.stringify({ autoUpdates: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const desktopStateDirectory = join(isolated.codeShellHome, "desktop");
  await mkdir(desktopStateDirectory, { recursive: true });
  await writeFile(
    join(desktopStateDirectory, "recents.json"),
    `${JSON.stringify(
      [{ path: fixtureProjectPath, name: "Digital Human Lab", lastOpenedAt: Date.now() }],
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  for (const profile of profiles) {
    const directory = join(isolated.codeShellHome, "profiles", profile.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  const skillDirectory = join(isolated.codeShellHome, "skills", "web-research");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    [
      "---",
      "name: web-research",
      "description: Find and compare trustworthy sources.",
      "---",
      "",
      "# Web research",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  // A real workspace can expose dozens of project-owned Skills. Seed enough
  // to cross the editor's preview cap so the E2E catches regressions that
  // expand every inherited Skill into an unwieldy wall of badges.
  for (let index = 1; index <= 12; index += 1) {
    const name = `project-helper-${String(index).padStart(2, "0")}`;
    const directory = join(fixtureProjectPath, ".agents", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        `description: Project helper ${index}.`,
        "---",
        "",
        `# ${name}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
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

async function assertVisibleButtonsNamed(win, label) {
  const unnamed = await win.locator("button:visible").evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const name =
          button.getAttribute("aria-label") ??
          button.getAttribute("title") ??
          button.textContent ??
          "";
        return name.trim().length === 0;
      })
      .map((button) => button.outerHTML.slice(0, 240)),
  );
  assert(unnamed.length === 0, `${label} has unnamed visible buttons: ${unnamed.join(" | ")}`);
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
  await win.waitForTimeout(300);
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
  // A seeded project raises the trust prompt at startup, over a modal overlay
  // that hides the sidebar. The existing handler below only covers the prompt
  // raised by clicking the project, which is one dialog too late.
  await dismissStartupTrustDialog(win);
  const fixtureProject = win
    .locator("aside")
    .getByRole("button", { name: "Digital Human Lab", exact: true });
  await fixtureProject.waitFor({ state: "visible", timeout: 20_000 });
  await fixtureProject.click();
  const trustDialog = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /信任此项目|Trust this project/i }) });
  const trustDialogOpened = await trustDialog
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (trustDialogOpened) {
    await trustDialog.getByRole("button", { name: /信任并继续|Trust and continue/i }).click();
    await trustDialog.waitFor({ state: "hidden" });
  }

  const navButton = win.locator("aside").getByRole("button", { name: /数字人|Digital humans/i });
  await navButton.waitFor({ state: "visible", timeout: 20_000 });
  await navButton.click();
  await win
    .getByRole("heading", { level: 1, name: /数字人|Digital humans/i })
    .waitFor({ state: "visible", timeout: 20_000 });
  await win.getByRole("tab", { name: /我的数字人|My digital humans/i }).waitFor({
    state: "visible",
  });

  await win.getByText("Research Analyst", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Critical Reviewer", { exact: true }).waitFor({ state: "visible" });
  await win.getByText(/Skills 已就绪|Skills ready/i).waitFor({ state: "visible" });
  await win.getByText(/缺少 2 个 Skills|2 Skill.*missing/i).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human profiles");
  await assertVisibleButtonsNamed(win, "digital-human profiles");
  assert(
    (await win.getByText("general", { exact: true }).count()) === 0,
    "the CodeShell runtime preset leaked into the digital-human library",
  );
  await screenshot(win, "digital-humans-mine.png");

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

  await win
    .getByRole("button", { name: /^创建数字人$|^Create digital human$/i })
    .first()
    .click();
  let dialog = win.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: /^创建数字人$|^Create digital human$/i })
    .waitFor({ state: "visible" });
  await dialog.locator("#digital-human-label").fill("Evidence Writer");
  await dialog.locator("#digital-human-summary").fill("Turns research into a traceable brief.");
  await dialog.locator("#digital-human-id").fill("evidence-writer");
  await dialog.getByRole("button", { name: /System Prompt/i }).click();
  await dialog
    .locator("#digital-human-instruction")
    .fill("Write a concise brief. Separate sourced facts from inference.");
  await dialog.getByRole("button", { name: /配置 Skills|Skills/i }).click();
  await dialog
    .getByRole("button", { name: /web-research.*未选择|web-research.*not selected/i })
    .click();
  await dialog.getByRole("button", { name: /保存数字人|Save digital human/i }).click();
  await dialog.waitFor({ state: "hidden" });
  const createdProfileCard = win.locator('[data-digital-human-card="evidence-writer"]');
  await createdProfileCard.waitFor({ state: "visible" });
  await createdProfileCard.getByText(/Skills 已就绪|Skills ready/i).waitFor({ state: "visible" });
  const createdDefinition = JSON.parse(
    await readFile(
      join(isolated.codeShellHome, "profiles", "evidence-writer", "profile.json"),
      "utf8",
    ),
  );
  assert(
    createdDefinition.basePreset === "general",
    "a new digital human did not receive CodeShell's internal runtime base",
  );

  await createdProfileCard
    .getByRole("button", { name: /Evidence Writer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /^删除$|^Delete$/i }).click();
  const deleteProfileReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /删除数字人|Delete digital human/i }) });
  await deleteProfileReview.waitFor({ state: "visible" });
  await deleteProfileReview.getByRole("button", { name: /^删除$|^Delete$/i }).click();
  await deleteProfileReview.waitFor({ state: "hidden" });
  await createdProfileCard.waitFor({ state: "hidden" });

  const researcherCard = win.locator('[data-digital-human-card="researcher"]');
  const openResearcherMenu = async () => {
    await researcherCard
      .getByRole("button", { name: /Research Analyst/ })
      .last()
      .click();
  };

  await openResearcherMenu();
  assert(
    (await win.getByRole("menuitem", { name: /导出定义|Export definition/i }).count()) === 0,
    "rare definition export was still exposed as a digital-human card action",
  );
  await win.getByRole("menuitem", { name: /查看详情|View details/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByText(/已配置的能力|Configured capabilities/i).waitFor({ state: "visible" });
  await dialog.getByText("web-research", { exact: false }).first().waitFor({ state: "visible" });
  await dialog.getByText(/已安装|Installed/i).waitFor({ state: "visible" });
  await screenshot(win, "digital-human-detail.png");
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await openResearcherMenu();
  await win.getByRole("menuitem", { name: /^编辑$|^Edit$/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /System Prompt/i }).click();
  const systemPrompt = dialog.locator("#digital-human-instruction");
  await systemPrompt.waitFor({ state: "visible" });
  assert(
    (await systemPrompt.inputValue()).includes("Research carefully"),
    "System Prompt editor did not load the profile instruction",
  );
  await screenshot(win, "digital-human-editor-prompt.png");
  await dialog.getByRole("button", { name: /运行设置|Settings/i }).click();
  assert(
    await dialog.getByRole("switch", { name: /可移植记忆|Portable memory/i }).isChecked(),
    "portable-memory setting did not round-trip into the editor",
  );
  assert(
    !(await dialog.getByRole("switch", { name: /独占工作面|Exclusive/i }).isChecked()),
    "exclusive-capability setting changed unexpectedly",
  );
  assert(
    (await dialog.locator("#digital-human-preset").count()) === 0 &&
      (await dialog.locator("#digital-human-version").count()) === 0,
    "runtime-only preset/version fields leaked into the digital-human editor",
  );
  await screenshot(win, "digital-human-editor-settings.png");
  await dialog.getByRole("button", { name: /配置 Skills|Skills/i }).click();
  await dialog.getByText("web-research", { exact: false }).first().waitFor({ state: "visible" });
  await dialog.getByText(/另有 4 个|4 more/i).waitFor({ state: "visible" });
  assert(
    (await dialog.getByText(/^project-helper-\d+$/).count()) === 8,
    "the editor expanded more than the inherited-Skill preview limit",
  );
  await screenshot(win, "digital-human-editor-skills.png");
  await assertVisibleButtonsNamed(win, "digital-human editor");
  await win.setViewportSize({ width: 700, height: 900 });
  await assertNoHorizontalOverflow(win, "digital-human editor narrow viewport");
  await screenshot(win, "digital-human-editor-mobile.png");
  await win.setViewportSize({ width: 1_440, height: 960 });
  await dialog.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await dialog.waitFor({ state: "hidden" });

  const reviewerCard = win.locator('[data-digital-human-card="reviewer"]');
  await reviewerCard
    .getByRole("button", { name: /Critical Reviewer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /^编辑$|^Edit$/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByRole("button", { name: /配置 Skills|Skills/i }).click();
  const skillRepo = dialog.locator("#digital-human-skill-repo");
  await skillRepo.waitFor({ state: "visible" });
  const saveAndInstall = dialog.getByRole("button", {
    name: /保存并安装|Save and install/i,
  });
  assert(await saveAndInstall.isDisabled(), "save-and-install was enabled without a trusted repo");
  await skillRepo.fill("heygen-com/hyperframes");
  assert(
    await saveAndInstall.isDisabled(),
    "save-and-install was enabled before every missing Skill had a trusted source",
  );
  const mediaSkillRepo = dialog.locator("#digital-human-skill-repo-1");
  await mediaSkillRepo.fill("openai/media-skills");
  assert(
    await saveAndInstall.isEnabled(),
    "save-and-install stayed disabled after every missing Skill had a trusted source",
  );
  await saveAndInstall.click();
  const installReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /补齐数字人依赖|Install digital-human/i }) });
  await installReview.waitFor({ state: "visible" });
  await installReview.getByText(/npx --yes skills add/i).waitFor({ state: "visible" });
  await installReview.getByText(/heygen-com\/hyperframes/i).waitFor({ state: "visible" });
  await installReview.getByText(/openai\/media-skills/i).waitFor({ state: "visible" });
  assert(
    await win.getByTestId("digital-human-save-install").isDisabled(),
    "save-and-install became actionable again while its install review was still active",
  );
  await screenshot(win, "digital-human-editor-install.png");
  await installReview.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await installReview.waitFor({ state: "hidden" });
  await dialog.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await dialog.waitFor({ state: "hidden" });

  // Saved install sources must stay editable. A bad repository should not
  // leave the user trapped behind a retry-only action.
  await reviewerCard
    .getByRole("button", { name: /Critical Reviewer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /^编辑$|^Edit$/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByRole("button", { name: /配置 Skills|Skills/i }).click();
  await dialog.locator("#digital-human-skill-repo").waitFor({ state: "visible" });
  assert(
    (await dialog.locator("#digital-human-skill-repo").inputValue()) === "heygen-com/hyperframes",
    "the saved Critical Review source was not pre-filled for editing",
  );
  assert(
    (await dialog.locator("#digital-human-skill-repo-1").inputValue()) === "openai/media-skills",
    "the saved media-use source was not pre-filled for editing",
  );
  await dialog.locator("#digital-human-skill-repo").fill("reviewco/reviewer-skills");
  await dialog.getByRole("button", { name: /^保存数字人$|^Save digital human$/i }).click();
  await dialog.waitFor({ state: "hidden" });

  await reviewerCard
    .getByRole("button", { name: /Critical Reviewer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /^编辑$|^Edit$/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByRole("button", { name: /配置 Skills|Skills/i }).click();
  assert(
    (await dialog.locator("#digital-human-skill-repo").inputValue()) === "reviewco/reviewer-skills",
    "changing a saved Skill source did not survive reopening the editor",
  );
  await dialog.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await dialog.waitFor({ state: "hidden" });

  await reviewerCard
    .getByRole("button", { name: /Critical Reviewer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /编辑长期记忆|Edit long-term memory/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByText(/当前未注入|Not currently injected/i).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /启用长期记忆|Enable long-term memory/i }).click();
  await dialog.getByText(/参与工作时生效|Used while working/i).waitFor({ state: "visible" });
  await screenshot(win, "digital-human-memory-enabled.png");
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await reviewerCard
    .getByRole("button", { name: /Critical Reviewer/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /编辑长期记忆|Edit long-term memory/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByText(/参与工作时生效|Used while working/i).waitFor({ state: "visible" });
  assert(
    (await dialog
      .getByRole("button", { name: /启用长期记忆|Enable long-term memory/i })
      .count()) === 0,
    "enabling portable memory did not refresh the digital-human library",
  );
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await win.evaluate(async () => {
    await globalThis.window.codeshell.saveMemory({
      level: "profile",
      scope: "user",
      profileName: "researcher",
      name: "evidence-standard",
      description: "Keep every important claim traceable.",
      type: "user",
      content: "Cite primary sources and clearly label uncertainty.",
    });
  });
  await openResearcherMenu();
  await win.getByRole("menuitem", { name: /编辑长期记忆|Edit long-term memory/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog
    .getByText(/这里保存的是这个数字人的长期经验|digital human's long-term experience/i)
    .waitFor({ state: "visible" });
  assert(
    (await dialog.getByRole("button", { name: /整理区|Workspace/i }).count()) === 0,
    "profile memory exposed the non-functional Dream workspace",
  );
  const evidenceMemory = dialog.getByRole("button", { name: /evidence-standard/i });
  await evidenceMemory.waitFor({ state: "visible" });
  await evidenceMemory.click();
  const originalMemoryContent = "Cite primary sources and clearly label uncertainty.";
  await dialog.getByText(originalMemoryContent, { exact: true }).waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /^编辑$|^Edit$/i }).click();
  const memoryContent = dialog.getByRole("textbox", { name: /记忆内容|Memory content/i });
  await memoryContent.fill(`${originalMemoryContent} Record the publication date.`);
  await dialog.getByRole("button", { name: /^保存$|^Save$/i }).click();
  await dialog
    .getByText(`${originalMemoryContent} Record the publication date.`, { exact: true })
    .waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /新建|New/i }).click();
  await dialog.getByRole("textbox", { name: /记忆名称|Memory name/i }).fill("temporary-note");
  await dialog
    .getByRole("textbox", { name: /记忆内容|Memory content/i })
    .fill("This entry verifies create and delete.");
  await dialog.getByRole("button", { name: /^保存$|^Save$/i }).click();
  const temporaryMemory = dialog.getByRole("button", { name: /temporary-note/i });
  await temporaryMemory.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /^删除$|^Delete$/i }).click();
  const deleteMemoryReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /删除记忆|Delete memory/i }) });
  await deleteMemoryReview.waitFor({ state: "visible" });
  await deleteMemoryReview.getByRole("button", { name: /^删除$|^Delete$/i }).click();
  await deleteMemoryReview.waitFor({ state: "hidden" });
  await temporaryMemory.waitFor({ state: "hidden" });
  await dialog
    .getByText(`${originalMemoryContent} Record the publication date.`, { exact: true })
    .waitFor({ state: "visible" });
  await assertVisibleButtonsNamed(win, "digital-human memory");
  await screenshot(win, "digital-human-memory.png");
  await evidenceMemory.click();
  await dialog.getByRole("button", { name: /^编辑$|^Edit$/i }).click();
  await memoryContent.fill("This draft must not disappear without confirmation.");
  await win.keyboard.press("Escape");
  const discardMemoryReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /放弃记忆修改|Discard memory changes/i }) });
  await discardMemoryReview.waitFor({ state: "visible" });
  await screenshot(win, "digital-human-memory-unsaved-guard.png");
  await discardMemoryReview.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await discardMemoryReview.waitFor({ state: "hidden" });
  assert(
    (await memoryContent.inputValue()) === "This draft must not disappear without confirmation.",
    "cancelling the memory discard prompt lost the draft",
  );
  await win.keyboard.press("Escape");
  await discardMemoryReview.waitFor({ state: "visible" });
  await discardMemoryReview.getByRole("button", { name: /放弃修改|Discard changes/i }).click();
  await dialog.waitFor({ state: "hidden" });

  await win.getByRole("tab", { name: /数字人团队|Teams/i }).click();
  await win.getByText("Research & Review", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Research Analyst", { exact: true }).waitFor({ state: "visible" });
  await win.getByText("Critical Reviewer", { exact: true }).waitFor({ state: "visible" });
  await win.getByText(/成员并行|Members parallel/i).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human teams");
  await screenshot(win, "digital-humans-teams.png");

  const teamCard = win.locator('[data-digital-human-team-card="research-review"]');
  await teamCard
    .getByRole("button", { name: /Research & Review/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /查看详情|View details/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByText(/Session 协作|Session collaboration/i).waitFor({ state: "visible" });
  await screenshot(win, "digital-human-team-detail.png");
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await teamCard
    .getByRole("button", { name: /Research & Review/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /编辑团队|Edit team/i }).click();
  dialog = win.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: /编辑数字人团队|Edit digital-human team/i })
    .waitFor({ state: "visible" });
  const teamPlaybook = dialog.getByRole("textbox", {
    name: /协作规则|Collaboration rules/i,
  });
  assert(await teamPlaybook.isEnabled(), "a leadless team could not author shared rules");
  await teamPlaybook.fill("Every member must state evidence and risks.");
  await dialog.getByRole("combobox", { name: /团长|Lead/i }).click();
  await win.getByRole("option", { name: "Research Analyst", exact: true }).click();
  const playbookText =
    "Research Analyst gathers evidence, then sends the draft to Critical Reviewer for an independent check.";
  await teamPlaybook.fill(playbookText);
  await screenshot(win, "digital-human-team-editor.png");
  await dialog.getByRole("button", { name: /保存团队|Save team/i }).click();
  await dialog.waitFor({ state: "hidden" });
  await teamCard.getByText(/团长协调|Lead coordinates/i).waitFor({ state: "visible" });

  await teamCard
    .getByRole("button", { name: /Research & Review/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /查看详情|View details/i }).click();
  dialog = win.getByRole("dialog");
  await dialog.getByText(/团长 Session|Lead Session/i).waitFor({ state: "visible" });
  await dialog.getByText(playbookText, { exact: true }).waitFor({ state: "visible" });
  await screenshot(win, "digital-human-team-configured.png");
  await win.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await teamCard
    .getByRole("button", { name: /Research & Review/ })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /编辑团队|Edit team/i }).click();
  dialog = win.getByRole("dialog");
  const guardedPlaybook = dialog.getByRole("textbox", {
    name: /协作规则|Collaboration rules/i,
  });
  await guardedPlaybook.fill(`${playbookText} Unsaved guard.`);
  await win.keyboard.press("Escape");
  const discardTeamReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /放弃团队修改|Discard team changes/i }) });
  await discardTeamReview.waitFor({ state: "visible" });
  await discardTeamReview.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await discardTeamReview.waitFor({ state: "hidden" });
  assert(
    (await guardedPlaybook.inputValue()).endsWith("Unsaved guard."),
    "cancelling the team discard prompt lost the draft",
  );
  await win.keyboard.press("Escape");
  await discardTeamReview.waitFor({ state: "visible" });
  await discardTeamReview.getByRole("button", { name: /放弃修改|Discard changes/i }).click();
  await dialog.waitFor({ state: "hidden" });

  await win.getByRole("tab", { name: /数字人广场|Market/i }).click();
  await win
    .getByText(/广场暂无内置数字人|No built-in digital humans/i)
    .waitFor({ state: "visible" });
  const repoInput = win.getByPlaceholder("owner/repo");
  await repoInput.waitFor({ state: "visible" });
  await repoInput.fill("owner/repo;rm -rf /");
  await win.getByText(/不要粘贴命令|not a command/i).waitFor({ state: "visible" });
  assert(
    await win.getByRole("button", { name: /^添加$|^Add$/i }).isDisabled(),
    "an unsafe digital-human repository source was still actionable",
  );
  await screenshot(win, "digital-human-repo-invalid.png");
  await repoInput.fill("");
  await assertNoHorizontalOverflow(win, "digital-human empty market");
  await screenshot(win, "digital-humans-market-empty.png");

  await win.getByRole("button", { name: /管理仓库|Manage repos/i }).click();
  const repoSettingsNavigation = win.getByRole("navigation", {
    name: /设置导航|Settings navigation/i,
  });
  const digitalHumanSettingsNav = repoSettingsNavigation.getByRole("button", {
    name: /^数字人$|^Digital humans$/i,
  });
  await digitalHumanSettingsNav.waitFor({ state: "visible" });
  assert(
    (await digitalHumanSettingsNav.getAttribute("aria-current")) === "page",
    "Manage repos opened Settings without selecting the Digital humans module",
  );
  await win
    .getByRole("heading", { name: /数字人库|Digital human library/i })
    .waitFor({ state: "visible" });
  await win
    .getByText(/^数字人仓库$|^Digital-human repos$/i)
    .first()
    .waitFor({ state: "visible" });
  await screenshot(win, "digital-human-repo-settings-deep-link.png");
  await win.getByRole("button", { name: /返回应用|Back to app/i }).click();
  await navButton.click();

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
  await win.getByRole("tab", { name: /数字人广场|Market/i }).click();
  await win
    .getByText(/广场暂无内置数字人|No built-in digital humans/i)
    .waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human market narrow layout");
  await screenshot(win, "digital-humans-market-mobile.png");
  await win.getByRole("tab", { name: /数字人团队|Teams/i }).click();
  await win.getByText("Research & Review", { exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(win, "digital-human narrow layout");
  await screenshot(win, "digital-humans-mobile.png");

  await win.setViewportSize({ width: 1_440, height: 960 });
  await win.getByRole("tab", { name: /我的数字人|My digital humans/i }).click();
  await openResearcherMenu();
  await win.getByRole("menuitem", { name: /设为项目默认|Set project default/i }).click();
  await researcherCard.getByText(/项目默认|Project default/i).waitFor({ state: "visible" });
  await screenshot(win, "digital-human-project-default.png");
  await openResearcherMenu();
  await win.getByRole("menuitem", { name: /取消项目默认|Clear project default/i }).click();
  await researcherCard.getByText(/项目默认|Project default/i).waitFor({ state: "hidden" });

  await researcherCard.getByRole("button", { name: /^开始使用$|^Start using$/i }).click();
  const sessionProfileSwitch = win.getByRole("combobox", {
    name: /切换 Session 数字人|Switch Session digital human/i,
  });
  await sessionProfileSwitch.waitFor({ state: "visible" });
  await sessionProfileSwitch.getByText("Research Analyst", { exact: true }).waitFor({
    state: "visible",
  });
  await screenshot(win, "digital-human-session-bound.png");

  await sessionProfileSwitch.click();
  await win.getByRole("option", { name: "Critical Reviewer", exact: true }).click();
  const switchInstallReview = win
    .getByRole("dialog")
    .filter({ has: win.getByRole("heading", { name: /补齐数字人依赖|Install digital-human/i }) });
  await switchInstallReview.waitFor({ state: "visible" });
  await switchInstallReview.getByRole("button", { name: /^取消$|^Cancel$/i }).click();
  await switchInstallReview.waitFor({ state: "hidden" });
  await sessionProfileSwitch.getByText("Research Analyst", { exact: true }).waitFor({
    state: "visible",
  });

  await sessionProfileSwitch.click();
  await win.getByRole("option", { name: /取消数字人绑定|Unbind digital human/i }).click();
  await sessionProfileSwitch.getByText(/选择数字人|Choose digital human/i).waitFor({
    state: "visible",
  });
  await screenshot(win, "digital-human-session-unbound.png");

  for (const [name, description] of [
    ["critical-review", "Independently challenge a draft before delivery."],
    ["media-use", "Inspect and use media assets during review."],
  ]) {
    const projectSkillDirectory = join(fixtureProjectPath, ".agents", "skills", name);
    await mkdir(projectSkillDirectory, { recursive: true });
    await writeFile(
      join(projectSkillDirectory, "SKILL.md"),
      ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, ""].join(
        "\n",
      ),
      { mode: 0o600 },
    );
  }
  await navButton.click();
  await win.getByRole("tab", { name: /数字人团队|Teams/i }).click();
  await teamCard.getByRole("button", { name: /^开始使用团队$|^Start using team$/i }).click();
  await sessionProfileSwitch.getByText("Research Analyst", { exact: true }).waitFor({
    state: "visible",
  });
  await fixtureProject.click();
  const projectSessionList = win.locator("aside");
  await projectSessionList
    .getByRole("button", { name: /Research & Review · Research Analyst/ })
    .waitFor({ state: "visible" });
  await projectSessionList
    .getByRole("button", { name: /Research & Review · Critical Reviewer/ })
    .waitFor({ state: "visible" });
  await screenshot(win, "digital-human-team-sessions.png");

  await win.evaluate(async () => {
    await globalThis.window.codeshell.saveMemory({
      level: "user",
      scope: "user",
      name: "delivery-preference",
      description: "Keep final answers concise and actionable.",
      type: "feedback",
      content: "Lead with the outcome, then list only the decisions and next actions.",
    });
  });
  await win
    .locator("aside")
    .getByRole("button", { name: /^设置$|^Settings$/i })
    .click();
  await win.getByRole("menuitem", { name: /打开设置|Open settings/i }).click();
  const settingsNavigation = win.getByRole("navigation", {
    name: /设置导航|Settings navigation/i,
  });
  await settingsNavigation.getByRole("button", { name: /^记忆$|^Memory$/i }).click();
  const globalMemoryStore = win.getByRole("button", { name: /全局记忆|Global memory/i });
  await globalMemoryStore.waitFor({ state: "visible" });
  assert(
    (await win.getByText(/~\/\.code-shell\/memory/).count()) === 0,
    "the memory picker exposed its implementation path",
  );
  await globalMemoryStore.click();
  const globalMemoryEntry = win.getByRole("button", { name: /delivery-preference/i });
  await globalMemoryEntry.waitFor({ state: "visible" });
  await globalMemoryEntry.click();
  await win
    .getByText("Lead with the outcome, then list only the decisions and next actions.", {
      exact: true,
    })
    .waitFor({ state: "visible" });
  await screenshot(win, "memory-settings-workspace.png");
  await win.getByRole("button", { name: /自动整理|Auto-organized/i }).click();
  await globalMemoryEntry.waitFor({ state: "hidden" });
  await win.getByRole("button", { name: /长期记忆|Long-term memory/i }).click();
  await globalMemoryEntry.waitFor({ state: "visible" });

  await settingsNavigation.getByRole("button", { name: /^数字人$|^Digital humans$/i }).click();
  await win
    .getByRole("heading", { name: /数字人库|Digital human library/i })
    .waitFor({ state: "visible" });
  await win
    .locator("main")
    .getByText("Research Analyst", { exact: true })
    .first()
    .waitFor({ state: "visible" });
  await win
    .locator("main")
    .getByText(/本机已安装|Installed locally/i)
    .first()
    .waitFor({ state: "visible" });
  const advancedExport = win.getByText(/高级导出|Advanced export/i, { exact: true });
  await advancedExport.click();
  await win
    .locator("main")
    .getByRole("button", { name: /导出定义|Export definition/i })
    .first()
    .waitFor({ state: "visible" });
  await assertVisibleButtonsNamed(win, "digital-human settings");
  await screenshot(win, "digital-human-settings.png");

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
