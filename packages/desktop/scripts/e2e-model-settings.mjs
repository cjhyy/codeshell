/*
 * Real Electron regression for catalog enum authoring and model connection keys.
 * All catalog/settings writes stay inside main-process IPC fixtures in a fresh
 * HOME. No model is invoked; screenshots mask key inputs and failures never dump
 * form values or IPC payloads. Run with Node after building the desktop app.
 */
/* global document, getComputedStyle, localStorage, requestAnimationFrame, structuredClone, window, Event */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-model-settings-e2e-");
const screenshotDir = process.env.CODESHELL_MODEL_SETTINGS_SCREENSHOT_DIR;
const providerId = "ui-synthetic-provider";
const connectionId = "ui-synthetic-connection";
const secondaryConnectionId = "ui-secondary-connection";
const disposableProviderId = "ui-catalog-delete-target";
let app;
let win;
let stage = "initialization";
const rendererErrors = [];

async function installFixture() {
  await app.evaluate(
    ({ ipcMain }, { providerId, connectionId, secondaryConnectionId, disposableProviderId }) => {
      const catalog = [
        {
          id: providerId,
          displayName: "UI Synthetic Provider",
          description: "Isolated model editor verification",
          tag: "text",
          adapterKind: "openai",
          protocol: "openai-compat",
          defaultBaseUrl: "https://example.invalid/v1",
          defaultModel: "ui-model",
          needsKey: true,
          modelPresets: [
            {
              value: "ui-model",
              label: "UI Model",
              params: [
                {
                  name: "effort",
                  control: "enum",
                  options: [],
                  default: "low",
                  wire: { field: "reasoning_effort" },
                },
              ],
            },
          ],
        },
      ];
      catalog.push({
        ...structuredClone(catalog[0]),
        id: disposableProviderId,
        displayName: "Disposable Model Template",
      });
      const fixture = {
        catalog,
        settings: {
          autoUpdates: false,
          credentials: [],
          modelConnections: [
            {
              id: connectionId,
              catalogId: providerId,
              tag: "text",
              model: "ui-model",
            },
            {
              id: secondaryConnectionId,
              catalogId: providerId,
              tag: "text",
              model: "ui-model",
            },
          ],
          defaults: { text: connectionId },
        },
        catalogSaves: 0,
        catalogSaveAttempts: 0,
        catalogDeleteAttempts: 0,
        catalogDeletes: 0,
        failCatalogRead: false,
        failNextSettingsRead: false,
        failCatalogOrigins: false,
        failNextCatalogWrite: false,
        deferNextCatalogWrite: false,
        releaseCatalogWrite: null,
        settingsAttempts: 0,
        settingsCommits: 0,
        failNextSettingsWrite: false,
        deferNextSettingsWrite: false,
        releaseWrite: null,
      };
      globalThis.__modelSettingsFixture = fixture;
      const handle = (channel, fn) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, fn);
      };
      handle("catalog:list", () => {
        if (fixture.failCatalogRead) throw new Error("Synthetic catalog read failure");
        return structuredClone(fixture.catalog);
      });
      handle("catalog:origins", () => {
        if (fixture.failCatalogOrigins) throw new Error("Synthetic catalog origins failure");
        return { [providerId]: "user", [disposableProviderId]: "user" };
      });
      const catalogWriteOutcome = async () => {
        if (fixture.deferNextCatalogWrite) {
          fixture.deferNextCatalogWrite = false;
          await new Promise((resolve) => {
            fixture.releaseCatalogWrite = resolve;
          });
          fixture.releaseCatalogWrite = null;
        }
        if (fixture.failNextCatalogWrite) {
          fixture.failNextCatalogWrite = false;
          throw new Error("Synthetic catalog write failure");
        }
      };
      handle("catalog:save", async (_event, entry) => {
        if (entry.id !== providerId) throw new Error("Unexpected catalog fixture target");
        fixture.catalogSaveAttempts++;
        await catalogWriteOutcome();
        fixture.catalogSaves++;
        fixture.catalog = fixture.catalog.map((item) =>
          item.id === entry.id ? structuredClone(entry) : item,
        );
        return { ok: true };
      });
      handle("catalog:delete", async (_event, id) => {
        if (id !== disposableProviderId) throw new Error("Unexpected catalog deletion target");
        fixture.catalogDeleteAttempts++;
        await catalogWriteOutcome();
        fixture.catalogDeletes++;
        fixture.catalog = fixture.catalog.filter((entry) => entry.id !== id);
        return { ok: true };
      });
      handle("settings:get", (_event, scope) => {
        if (scope === "user" && fixture.failNextSettingsRead) {
          fixture.failNextSettingsRead = false;
          throw new Error("Synthetic connection settings read failure");
        }
        return scope === "user" ? structuredClone(fixture.settings) : {};
      });
      handle("settings:set", async (_event, scope, patch) => {
        const connectionWrite =
          Array.isArray(patch.modelConnections) &&
          patch.modelConnections.every((entry) =>
            [connectionId, secondaryConnectionId, providerId].includes(entry.id),
          );
        const auxOnlyWrite =
          Object.keys(patch).length === 1 &&
          patch.defaults &&
          [undefined, "", secondaryConnectionId, providerId].includes(patch.defaults.auxText);
        if (scope !== "user" || (!connectionWrite && !auxOnlyWrite)) {
          throw new Error("Unexpected settings fixture mutation");
        }
        fixture.settingsAttempts++;
        if (fixture.deferNextSettingsWrite) {
          fixture.deferNextSettingsWrite = false;
          await new Promise((resolve) => {
            fixture.releaseWrite = resolve;
          });
          fixture.releaseWrite = null;
        }
        if (fixture.failNextSettingsWrite) {
          fixture.failNextSettingsWrite = false;
          throw new Error("Synthetic settings write failure");
        }
        fixture.settingsCommits++;
        fixture.settings = { ...fixture.settings, ...structuredClone(patch) };
      });
      handle("settings:getConfiguration", () => ({}));
      handle("settings:setConfiguration", () => {
        throw new Error("Project configuration writes are outside this test");
      });
      handle("credentials:list", () => []);
      handle("models:list", () => []);
      handle("models:resolve-meta", () => ({}));
      handle("models:reasoning-control", () => null);
    },
    { providerId, connectionId, secondaryConnectionId, disposableProviderId },
  );
}

async function openSettings() {
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await viewOnly
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await viewOnly.click();
  }
  await win
    .getByRole("button", { name: /设置|Settings/i })
    .last()
    .click();
  await win.getByRole("menuitem", { name: /打开设置|Open settings/i }).click();
  await win.getByRole("heading", { name: "常规", exact: true, level: 1 }).waitFor();
}

async function selectModule(label) {
  const navigation = win.getByRole("navigation", { name: "设置导航", exact: true });
  if (await navigation.isVisible()) {
    await navigation.getByRole("button", { name: label, exact: true }).click();
  } else {
    await win.getByRole("combobox", { name: "设置导航", exact: true }).click();
    await win.getByRole("option", { name: label, exact: true }).click();
  }
  await win.getByRole("heading", { name: label, exact: true, level: 1 }).waitFor();
}

async function screenshot(filename) {
  if (!screenshotDir) return;
  await win.locator('input[type="password"]').evaluateAll((inputs) => {
    for (const input of inputs)
      input.toggleAttribute("data-e2e-secret-mask", input.value.length > 0);
  });
  await win.screenshot({
    path: join(screenshotDir, filename),
    fullPage: true,
    animations: "disabled",
    scale: "css",
    // Credential labels also include a key suffix. Mask those, and avoid
    // covering a failure toast just because it overlaps an empty second input.
    mask: [
      win.locator("[data-e2e-secret-mask]"),
      win.getByRole("combobox").filter({ hasText: /key ⋯/ }),
    ],
    maskColor: "#d9d2c9",
  });
}

async function assertPendingPortalsClosed(card, keyInput) {
  const panel = win.locator('fieldset[aria-label="文本模型"]');
  const choices = card.getByRole("combobox");
  const initialChoices = await choices.allTextContents();
  const initialInputCount = await keyInput.count();
  const initialKey = initialInputCount ? await keyInput.inputValue() : null;
  // A raw physical pointer gesture deliberately bypasses Playwright's disabled
  // locator guard. Native fieldset disabling alone does not stop Radix opening
  // its portal from pointerdown before the browser suppresses click.
  for (const trigger of [
    panel.getByRole("button", { name: "添加模型", exact: true }),
    choices.nth(0),
    choices.nth(1),
  ]) {
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox();
    assert(Boolean(box), "Pending control has no physical click target");
    await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert(
      (await win.locator('[role="menu"]:visible, [role="listbox"]:visible').count()) === 0,
      "Pending model control opened an interactive portal",
    );
  }
  assert(
    JSON.stringify(await choices.allTextContents()) === JSON.stringify(initialChoices) &&
      (await keyInput.count()) === initialInputCount &&
      (initialInputCount === 0 || (await keyInput.inputValue()) === initialKey),
    "A pointer gesture changed the pending model draft",
  );
}

async function assertActionReachable(action, label) {
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  const size = win.viewportSize();
  assert(
    Boolean(
      box &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
    ),
    `${label} is clipped outside the viewport`,
  );
  assert(await action.isEnabled(), `${label} is not enabled`);
}

async function checkLayouts(id, action) {
  for (const width of [820, 390]) {
    await win.setViewportSize({ width, height: 820 });
    await win.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const layout = await win.evaluate(() => {
      const heading = [...document.querySelectorAll("h1")].find((el) => el.getClientRects().length);
      const main = heading?.closest("main");
      const overflowing = main
        ? [...main.querySelectorAll("div, section, article")].filter(
            (el) =>
              el.getClientRects().length &&
              el.clientWidth > 0 &&
              el.scrollWidth > el.clientWidth + 1 &&
              getComputedStyle(el).overflowX !== "visible",
          ).length
        : -1;
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        mainFits: Boolean(main && main.scrollWidth <= main.clientWidth + 1),
        overflowing,
      };
    });
    assert(
      layout.pageFits && layout.mainFits && layout.overflowing === 0,
      `${id} has horizontal overflow at ${width}px`,
    );
    await assertActionReachable(action, `${id} primary action at ${width}px`);
    await screenshot(`${id}-${width}.png`);
  }
  console.log(`PASS ${id}: 820/390 layout and primary action reachability`);
}

async function waitForFixtureCounts(attempts, commits) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const counts = await app.evaluate(() => {
      const fixture = globalThis.__modelSettingsFixture;
      return [fixture.settingsAttempts, fixture.settingsCommits];
    });
    if (counts[0] === attempts && counts[1] === commits) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Settings fixture did not receive the expected write outcome");
}

async function checkCatalogEditor() {
  stage = "catalog read recovery";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = true;
  });
  await selectModule("模型模板");
  const panel = win.locator('fieldset[aria-label="模型模板"]');
  const add = panel.getByRole("button", { name: "新建 provider", exact: true });
  const retry = panel.getByRole("button", { name: "重新读取", exact: true });
  await panel.getByText("无法读取模型模板。请重试。", { exact: true }).waitFor();
  assert(
    (await panel.locator("article").count()) === 0 && (await add.isDisabled()),
    "Failed initial read became an editable empty catalog",
  );
  assert(
    !(await panel.getByText(/还没有模板/).count()),
    "Read failure masqueraded as an empty catalog",
  );
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = false;
    globalThis.__modelSettingsFixture.failCatalogOrigins = true;
  });
  await retry.focus();
  await win.keyboard.press("Enter");
  await panel.getByRole("status").waitFor({ state: "hidden" });
  assert(
    await retry.evaluate((el) => document.activeElement === el),
    "Failed retry lost keyboard focus",
  );
  assert(
    (await panel.locator("article").count()) === 0,
    "An incomplete origins read exposed editable templates",
  );
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogOrigins = false;
  });
  await win.keyboard.press("Enter");
  await panel.locator("article").first().waitFor();
  await panel.getByRole("alert").waitFor({ state: "hidden" });
  assert(
    await add.evaluate((el) => document.activeElement === el),
    "Successful retry did not reach a stable action",
  );
  console.log("PASS catalog read: explicit read/origins failures, retry focus and atomic recovery");

  stage = "catalog enum input";
  const card = win.locator("article").filter({ hasText: "UI Synthetic Provider" });
  await card.getByRole("button", { name: /UI Synthetic Provider/ }).click();
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  const options = card.getByLabel("选项（逗号分隔）", { exact: true });
  await options.fill("");
  const originalInput = await options.elementHandle();
  const typed = "low, high";
  for (let index = 0; index < typed.length; index++) {
    await win.keyboard.type(typed[index]);
    assert(
      await originalInput.evaluate((el) => el.isConnected && document.activeElement === el),
      "Enum input lost focus while typing",
    );
    assert(
      (await options.inputValue()) === typed.slice(0, index + 1),
      "Enum input removed punctuation or whitespace during typing",
    );
  }
  const save = card.getByRole("button", { name: "保存", exact: true });
  await checkLayouts("model-catalog-editor", save);
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = true;
  });
  await win.evaluate(() => window.dispatchEvent(new Event("codeshell:settings-changed")));
  await panel.getByText("刷新失败，仍显示上次读取的模板。请重试。", { exact: true }).waitFor();
  assert(
    (await card.isVisible()) && (await options.inputValue()) === typed,
    "Failed refresh discarded the loaded card or active enum draft",
  );
  await screenshot("model-catalog-refresh-failure-390.png");
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = false;
  });
  await retry.focus();
  await win.keyboard.press("Enter");
  await panel.getByRole("alert").waitFor({ state: "hidden" });

  stage = "catalog save failure and retry";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failNextCatalogWrite = true;
    globalThis.__modelSettingsFixture.deferNextCatalogWrite = true;
  });
  await save.focus();
  await win.keyboard.press("Enter");
  await panel.getByRole("status").filter({ hasText: "正在更新模型模板…" }).waitFor();
  assert(
    (await save.isDisabled()) && (await add.isDisabled()),
    "Pending catalog save did not lock all cards",
  );
  const typeSelect = card.getByRole("combobox").first();
  await typeSelect.scrollIntoViewIfNeeded();
  const box = await typeSelect.boundingBox();
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert((await win.getByRole("listbox").count()) === 0, "Pending catalog select opened a portal");
  await app.evaluate(() => globalThis.__modelSettingsFixture.releaseCatalogWrite());
  await card.getByRole("alert").filter({ hasText: "保存失败，编辑内容已保留。请重试。" }).waitFor();
  assert(
    await save.evaluate((el) => document.activeElement === el),
    "Failed catalog save lost its retry action focus",
  );
  assert(
    (await options.inputValue()) === "low,high",
    "Failed catalog save discarded normalized enum draft",
  );
  await assertActionReachable(save, "Catalog save retry at 390px");
  await screenshot("model-catalog-save-failure-390.png");
  await win.keyboard.press("Enter");
  await options.waitFor({ state: "hidden" });
  await panel.getByRole("status").waitFor({ state: "hidden" });
  assert(
    await card
      .getByRole("button", { name: /UI Synthetic Provider/ })
      .evaluate((el) => document.activeElement === el),
    "Catalog save success did not restore the collapsed card focus",
  );
  assert(
    await app.evaluate(() => {
      const fixture = globalThis.__modelSettingsFixture;
      const options = fixture.catalog[0].modelPresets[0].params[0].options;
      return (
        fixture.catalogSaves === 1 &&
        fixture.catalogSaveAttempts === 2 &&
        options.length === 2 &&
        options[0] === "low" &&
        options[1] === "high"
      );
    }),
    "Catalog save did not receive one normalized enum array",
  );
  console.log(
    "PASS catalog save: typed punctuation, retained refresh/save draft, locked portals and normalized retry IPC",
  );

  stage = "catalog deletion failure and retry";
  const disposable = panel.locator("article").filter({ hasText: "Disposable Model Template" });
  await disposable.getByRole("button", { name: /Disposable Model Template/ }).click();
  const displayName = disposable.getByLabel("显示名", { exact: true });
  await displayName.fill("Kept deletion draft");
  const remove = disposable.getByRole("button", { name: "删除", exact: true });
  const confirmDeletion = async () => {
    await remove.focus();
    await win.keyboard.press("Enter");
    const dialog = win.getByRole("dialog", { name: "删除此模板？", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "确定", exact: true }).press("Enter");
    await dialog.waitFor({ state: "hidden" });
  };
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failNextCatalogWrite = true;
    globalThis.__modelSettingsFixture.deferNextCatalogWrite = true;
  });
  await confirmDeletion();
  await panel.getByRole("status").filter({ hasText: "正在更新模型模板…" }).waitFor();
  assert(
    (await disposable.isVisible()) && (await remove.isDisabled()),
    "Pending deletion removed or unlocked the template prematurely",
  );
  await app.evaluate(() => globalThis.__modelSettingsFixture.releaseCatalogWrite());
  await disposable.getByRole("alert").waitFor();
  assert(
    (await displayName.inputValue()) === "Kept deletion draft",
    "Rejected deletion discarded the template draft",
  );
  assert(
    await remove.evaluate((el) => document.activeElement === el),
    "Rejected deletion lost its retry action focus",
  );
  await assertActionReachable(remove, "Catalog deletion retry at 390px");
  await screenshot("model-catalog-delete-failure-390.png");
  await confirmDeletion();
  await disposable.waitFor({ state: "hidden" });
  await panel.getByRole("status").waitFor({ state: "hidden" });
  assert(
    await add.evaluate((el) => document.activeElement === el),
    "Catalog deletion did not restore a surviving action",
  );
  assert(
    await app.evaluate(() => {
      const fixture = globalThis.__modelSettingsFixture;
      return (
        fixture.catalogDeleteAttempts === 2 &&
        fixture.catalogDeletes === 1 &&
        fixture.catalog.length === 1
      );
    }),
    "Catalog deletion retry did not affect exactly the isolated disposable template",
  );
  console.log(
    "PASS catalog deletion: rejected write retains entry/draft/focus and retry removes only the synthetic target",
  );
}

async function checkConnectionEditor() {
  stage = "connection read failure and retry";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = true;
  });
  await selectModule("配置");
  const panel = win.locator('fieldset[aria-label="文本模型"]');
  const retryRead = panel.getByRole("button", { name: "重试读取", exact: true });
  const add = panel.getByRole("button", { name: "添加模型", exact: true });
  await panel.getByText("无法读取模型连接，请重试。", { exact: true }).waitFor();
  assert(
    (await panel.locator("article").count()) === 0 && (await add.isDisabled()),
    "An incomplete model connection read exposed editable cards or an add action",
  );
  await add.scrollIntoViewIfNeeded();
  const disabledAddBox = await add.boundingBox();
  assert(Boolean(disabledAddBox), "The disabled add action is missing from the read-error state");
  await win.mouse.click(
    disabledAddBox.x + disabledAddBox.width / 2,
    disabledAddBox.y + disabledAddBox.height / 2,
  );
  assert(
    (await win.locator('[role="menu"]:visible').count()) === 0,
    "An incomplete connection read still allowed the add-model portal to open",
  );
  assert(
    !(await panel.getByText(/还没有文本模型/).count()),
    "Read failure became an empty-state message",
  );
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = false;
    globalThis.__modelSettingsFixture.failNextSettingsRead = true;
  });
  await retryRead.focus();
  await win.keyboard.press("Enter");
  await panel.getByRole("status").waitFor({ state: "hidden" });
  assert(
    await retryRead.evaluate((el) => document.activeElement === el),
    "A rejected settings read lost the retry action focus",
  );
  assert(
    (await panel.locator("article").count()) === 0 && (await add.isDisabled()),
    "A partial catalog result exposed connection editing after settings read failure",
  );
  await win.keyboard.press("Enter");
  await panel.locator("article").first().waitFor();
  await panel.getByRole("alert").waitFor({ state: "hidden" });
  assert(
    await add.evaluate((el) => document.activeElement === el),
    "Successful connection retry did not return to a stable add action",
  );
  console.log(
    "PASS connection reads: atomic catalog/settings recovery, explicit error and keyboard retry",
  );

  stage = "connection key typing";
  const card = win.locator("article").filter({ hasText: `#${connectionId}` });
  await card.waitFor();
  const keyInput = card.getByPlaceholder("粘贴 API key", { exact: true });
  const secondaryCard = win.locator("article").filter({ hasText: `#${secondaryConnectionId}` });
  const secondaryKey = secondaryCard.getByPlaceholder("粘贴 API key", { exact: true });
  await keyInput.focus();
  const originalInput = await keyInput.elementHandle();
  const syntheticKey = "ui-token";
  for (let index = 0; index < syntheticKey.length; index++) {
    await win.keyboard.type(syntheticKey[index]);
    assert(
      await originalInput.evaluate((el) => el.isConnected && document.activeElement === el),
      "New credential input lost its DOM identity or focus",
    );
    assert(
      (await keyInput.inputValue()) === syntheticKey.slice(0, index + 1),
      "New credential input did not retain all typed characters",
    );
  }
  assert((await keyInput.getAttribute("type")) === "password", "Credential input is not masked");
  const save = card.getByRole("button", { name: "保存", exact: true });
  const remove = card.getByRole("button", { name: "删除", exact: true });
  await checkLayouts("model-connection-editor", save);
  await assertActionReachable(remove, "Connection delete at 390px");
  console.log("PASS connection: first-character binding retains the input and keyboard focus");

  stage = "connection refresh failure retains draft";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = true;
  });
  await keyInput.focus();
  await win.evaluate(() => window.dispatchEvent(new Event("codeshell:settings-changed")));
  await panel.getByRole("alert").filter({ hasText: "刷新模型连接失败" }).waitFor();
  assert(
    (await keyInput.inputValue()) === syntheticKey && (await secondaryCard.isVisible()),
    "A failed connection refresh discarded the key draft or last complete collection",
  );
  assert(
    await keyInput.evaluate((el) => document.activeElement === el),
    "A failed automatic connection refresh did not restore the active key input focus",
  );
  assert(await retryRead.isEnabled(), "A failed refresh did not offer an enabled retry");
  await panel.getByRole("alert").scrollIntoViewIfNeeded();
  await screenshot("model-connection-read-failure-390.png");
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failCatalogRead = false;
  });
  console.log(
    "PASS connection refresh: last complete cards and editable key draft survive read failure",
  );

  stage = "connection save failure and retry";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failNextSettingsWrite = true;
    globalThis.__modelSettingsFixture.deferNextSettingsWrite = true;
  });
  await save.focus();
  await win.keyboard.press("Enter");
  await win.getByRole("status").filter({ hasText: "正在更新模型连接…" }).waitFor();
  assert(
    await secondaryKey.evaluate((el) => el.matches(":disabled")),
    "Pending save left another connection editable",
  );
  assert(
    await secondaryCard.getByRole("button", { name: "保存", exact: true }).isDisabled(),
    "Pending save left another connection save enabled",
  );
  await assertPendingPortalsClosed(card, keyInput);
  await app.evaluate(() => globalThis.__modelSettingsFixture.releaseWrite());
  await win.getByText("保存失败，编辑内容已保留。请重试。", { exact: true }).waitFor();
  await waitForFixtureCounts(1, 0);
  assert(
    (await keyInput.inputValue()) === syntheticKey,
    "Failed save discarded the credential draft",
  );
  assert(
    (await keyInput.isEnabled()) && (await secondaryKey.isEnabled()),
    "Failed save did not unlock the model editor",
  );
  assert(
    await app.evaluate(() => globalThis.__modelSettingsFixture.settings.credentials.length === 0),
    "Failed save persisted a credential",
  );
  await screenshot("model-connection-save-failure-390.png");
  // Saving any card commits the same credential collection. Retry through the
  // other card to prove the original key editor closes after that shared write.
  const secondarySave = secondaryCard.getByRole("button", { name: "保存", exact: true });
  await secondarySave.focus();
  await win.keyboard.press("Enter");
  await waitForFixtureCounts(2, 1);
  await win
    .getByRole("status")
    .filter({ hasText: "正在更新模型连接…" })
    .waitFor({ state: "hidden" });
  await keyInput.waitFor({ state: "hidden" });
  assert(
    await app.evaluate(
      (_electron, { connectionId, syntheticKey }) => {
        const settings = globalThis.__modelSettingsFixture.settings;
        const connection = settings.modelConnections.find((entry) => entry.id === connectionId);
        return (
          settings.credentials.length === 1 &&
          connection.id === connectionId &&
          connection.credentialId === settings.credentials[0].id &&
          settings.credentials[0].apiKey === syntheticKey &&
          settings.defaults.text === connectionId
        );
      },
      { connectionId, syntheticKey },
    ),
    "Save retry did not persist exactly one bound credential and preserve the default",
  );
  console.log(
    "PASS connection save: visible failure, retained draft and retry through another card ends key editing",
  );

  stage = "shared saved credential";
  await secondaryCard.getByRole("combobox").nth(1).click();
  await win
    .getByRole("option")
    .filter({ hasText: `#${providerId}-key` })
    .click();
  await secondaryKey.waitFor({ state: "hidden" });
  assert(
    (await keyInput.count()) === 0,
    "Reusing the saved credential reopened its original key editor",
  );
  await secondarySave.focus();
  await win.keyboard.press("Enter");
  await waitForFixtureCounts(3, 2);
  await win
    .getByRole("status")
    .filter({ hasText: "正在更新模型连接…" })
    .waitFor({ state: "hidden" });
  assert(
    (await keyInput.count()) === 0 && (await secondaryKey.count()) === 0,
    "A committed shared credential remained directly editable in a connection card",
  );
  assert(
    await app.evaluate((_electron, syntheticKey) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.credentials.length === 1 &&
        settings.credentials[0].apiKey === syntheticKey &&
        settings.modelConnections.every(
          (connection) => connection.credentialId === settings.credentials[0].id,
        )
      );
    }, syntheticKey),
    "Sharing a saved key changed its value or created a second credential",
  );
  await screenshot("model-shared-credential-390.png");
  console.log(
    "PASS shared credential: both connections reuse one saved key without retaining an editable key input",
  );

  stage = "connection delete failure and retry";
  await app.evaluate(() => {
    globalThis.__modelSettingsFixture.failNextSettingsWrite = true;
    globalThis.__modelSettingsFixture.deferNextSettingsWrite = true;
  });
  const confirmDelete = async () => {
    await remove.focus();
    await win.keyboard.press("Enter");
    const dialog = win.getByRole("dialog", { name: `删除连接 #${connectionId}？`, exact: true });
    await dialog.waitFor();
    const confirm = dialog.getByRole("button", { name: "确定", exact: true });
    await assertActionReachable(confirm, "Connection deletion confirmation at 390px");
    await confirm.focus();
    await win.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
  };
  await confirmDelete();
  await win.getByRole("status").filter({ hasText: "正在更新模型连接…" }).waitFor();
  const secondaryModel = secondaryCard.getByRole("combobox").first();
  assert(
    await secondaryModel.evaluate((el) => el.matches(":disabled")),
    "Pending delete left another connection editable",
  );
  await assertPendingPortalsClosed(card, keyInput);
  assert(await card.isVisible(), "Pending delete optimistically removed its connection");
  await app.evaluate(() => globalThis.__modelSettingsFixture.releaseWrite());
  await win.getByText("删除失败，模型连接已保留。请重试。", { exact: true }).waitFor();
  await waitForFixtureCounts(4, 2);
  assert(await card.isVisible(), "Failed delete removed the connection card");
  assert(
    await app.evaluate((_electron, connectionId) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return settings.modelConnections.length === 2 && settings.defaults.text === connectionId;
    }, connectionId),
    "Failed delete changed the saved connection or default",
  );
  assert(
    (await secondaryModel.isEnabled()) && (await remove.isEnabled()),
    "Failed delete did not unlock the editor",
  );
  await screenshot("model-connection-delete-failure-390.png");
  await confirmDelete();
  await waitForFixtureCounts(5, 3);
  await card.waitFor({ state: "hidden" });
  assert(
    await app.evaluate((_electron, secondaryConnectionId) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.modelConnections.length === 1 &&
        settings.modelConnections[0].id === secondaryConnectionId &&
        settings.defaults.text === secondaryConnectionId &&
        settings.credentials.length === 1
      );
    }, secondaryConnectionId),
    "Delete retry did not preserve the other connection, replacement default and shared credential",
  );
  console.log(
    "PASS connection delete: visible failure, preserved card/default and successful retry",
  );
}

async function checkConnectionActions() {
  const panel = win.locator('fieldset[aria-label="文本模型"]');
  const add = panel.getByRole("button", { name: "添加模型", exact: true });
  const secondary = panel.locator("article").filter({ hasText: `#${secondaryConnectionId}` });
  const added = panel.locator("article").filter({
    has: win.locator("header code", { hasText: new RegExp(`^#${providerId}$`) }),
  });
  const updating = panel.getByRole("status").filter({ hasText: "正在更新模型连接…" });
  const armFailure = async () =>
    app.evaluate(() => {
      globalThis.__modelSettingsFixture.failNextSettingsWrite = true;
      globalThis.__modelSettingsFixture.deferNextSettingsWrite = true;
    });
  const releaseFailure = async (attempts, commits, message) => {
    await app.evaluate(() => globalThis.__modelSettingsFixture.releaseWrite());
    await waitForFixtureCounts(attempts, commits);
    await updating.waitFor({ state: "hidden" });
    await win.getByText(message, { exact: true }).waitFor();
    assert(await add.isEnabled(), "A failed connection action left the panel locked");
  };
  const assertLocked = async () => {
    await updating.waitFor();
    assert(await add.isDisabled(), "A connection action left the add menu enabled");
    assert(
      await secondary.getByRole("button", { name: "保存", exact: true }).isDisabled(),
      "A connection action left another card editable",
    );
    await assertPendingPortalsClosed(
      secondary,
      secondary.getByPlaceholder("粘贴 API key", { exact: true }),
    );
  };
  const addModel = async () => {
    await add.click();
    const provider = win.getByRole("menuitem", { name: "UI Synthetic Provider", exact: true });
    await provider.focus();
    await win.keyboard.press("ArrowRight");
    await win.getByRole("menuitem", { name: "UI Model", exact: true }).click();
  };

  stage = "connection addition failure and retry";
  await armFailure();
  await addModel();
  await assertLocked();
  assert((await added.count()) === 0, "Pending addition exposed an unsaved connection card");
  await releaseFailure(6, 3, "添加模型失败，现有连接和编辑内容已保留。请重试。");
  assert(
    (await panel.locator("article").count()) === 1 &&
      (await app.evaluate(
        () => globalThis.__modelSettingsFixture.settings.modelConnections.length,
      )) === 1,
    "Failed addition changed the existing connection collection",
  );
  assert(
    await add.evaluate((el) => document.activeElement === el),
    "Failed menu action lost the add-model retry focus",
  );
  await addModel();
  await waitForFixtureCounts(7, 4);
  await updating.waitFor({ state: "hidden" });
  await added.waitFor();
  assert(
    await app.evaluate((_electron, secondaryConnectionId) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.modelConnections.length === 2 &&
        settings.defaults.text === secondaryConnectionId &&
        settings.credentials.length === 1
      );
    }, secondaryConnectionId),
    "Addition retry changed the existing default or duplicated its credential",
  );
  console.log(
    "PASS connection addition: locked pending UI, retained collection on failure and menu retry",
  );

  stage = "current connection failure and retry";
  const current = added.getByRole("button", { name: "设为当前", exact: true });
  await armFailure();
  await current.focus();
  await win.keyboard.press("Enter");
  await assertLocked();
  await releaseFailure(8, 4, "切换当前模型失败，原选择和编辑内容已保留。请重试。");
  assert(
    await secondary.getByRole("button", { name: "当前", exact: true }).isDisabled(),
    "Failed default change removed the previous current connection",
  );
  assert(
    await current.evaluate((el) => document.activeElement === el),
    "Failed default change lost its retry action focus",
  );
  await win.keyboard.press("Enter");
  await waitForFixtureCounts(9, 5);
  await updating.waitFor({ state: "hidden" });
  assert(
    await app.evaluate((_electron, providerId) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return settings.defaults.text === providerId && settings.modelConnections.length === 2;
    }, providerId),
    "Default retry did not preserve both model connections",
  );
  console.log(
    "PASS current model: write lock, failure keeps previous selection and retry changes only default",
  );

  stage = "background model failure and retry";
  const aux = panel.getByRole("combobox").first();
  const selectAux = async () => {
    await aux.click();
    await win
      .getByRole("option", { name: "UI Synthetic Provider · ui-model", exact: true })
      .last()
      .click();
  };
  await armFailure();
  await selectAux();
  await assertLocked();
  await releaseFailure(10, 5, "切换后台任务模型失败，原选择和编辑内容已保留。请重试。");
  assert(
    (await aux.textContent()).includes("跟随当前"),
    "Failed background model choice did not revert",
  );
  assert(
    await aux.evaluate((el) => document.activeElement === el),
    "Failed background model choice lost the selector focus",
  );
  await selectAux();
  await waitForFixtureCounts(11, 6);
  await updating.waitFor({ state: "hidden" });
  assert(
    await app.evaluate((_electron, providerId) => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.defaults.auxText === providerId &&
        settings.defaults.text === providerId &&
        settings.modelConnections.length === 2 &&
        settings.credentials.length === 1
      );
    }, providerId),
    "Background model retry discarded the primary default, connections or credentials",
  );
  console.log(
    "PASS background model: failed selection reverts, focus returns and retry preserves other settings",
  );

  stage = "shared credential deletion cancellation and retry";
  const removeCredential = added.getByRole("button", { name: "删除凭证", exact: true });
  const openCredentialDialog = async () => {
    await removeCredential.focus();
    await win.keyboard.press("Enter");
    const dialog = win.getByRole("dialog", { name: `删除凭证 #${providerId}-key？`, exact: true });
    await dialog.waitFor();
    return dialog;
  };
  let dialog = await openCredentialDialog();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForFixtureCounts(11, 6);
  assert(
    await removeCredential.isEnabled(),
    "Cancelled credential deletion left its action disabled",
  );
  await armFailure();
  dialog = await openCredentialDialog();
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await assertLocked();
  await releaseFailure(12, 6, "删除凭证失败，凭证和连接已保留。请重试。");
  assert(
    await removeCredential.evaluate((el) => document.activeElement === el),
    "Failed credential deletion lost its retry action focus",
  );
  assert(
    await app.evaluate(() => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.credentials.length === 1 &&
        settings.modelConnections.every(
          (entry) => entry.credentialId === settings.credentials[0].id,
        )
      );
    }),
    "Failed credential deletion changed the shared key or its bindings",
  );
  dialog = await openCredentialDialog();
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitForFixtureCounts(13, 7);
  await updating.waitFor({ state: "hidden" });
  assert(
    await app.evaluate(() => {
      const settings = globalThis.__modelSettingsFixture.settings;
      return (
        settings.credentials.length === 0 &&
        settings.modelConnections.length === 2 &&
        settings.modelConnections.every((entry) => !entry.credentialId)
      );
    }),
    "Credential deletion retry did not clear only the shared credential and its references",
  );
  assert(
    (await panel.getByPlaceholder("粘贴 API key", { exact: true }).count()) === 2,
    "Credential deletion did not make both connection key fields available",
  );
  console.log(
    "PASS shared credential deletion: cancel does not write, rejected write keeps bindings, retry clears only references",
  );
}

try {
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false }),
    { mode: 0o600 },
  );
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  stage = "Electron launch";
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
  });
  stage = "renderer readiness";
  win = await findCodeShellWindow(app);
  // Wait for the production main module to finish registering its IPC handlers
  // before replacing them. electron.launch() alone can resolve before startup.
  stage = "fixture installation";
  await installFixture();
  win.on("pageerror", () => rendererErrors.push(true));
  await win.route(/^https?:\/\//, (route) => route.abort());
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "zh");
  });
  stage = "settings navigation";
  await win.reload();
  await win.setViewportSize({ width: 1280, height: 900 });
  await win.locator("#root").waitFor({ state: "visible" });
  await openSettings();
  await checkCatalogEditor();
  await checkConnectionEditor();
  await checkConnectionActions();
  assert(rendererErrors.length === 0, "Model settings emitted a renderer error");
  console.log("CodeShell Electron model settings E2E: passed (zero renderer errors)");
} catch (error) {
  // Do not print Playwright errors: input-action call logs can contain key text.
  console.error(`CodeShell Electron model settings E2E failed during ${stage}`);
  const message = typeof error?.message === "string" ? error.message : "";
  const errorType = ["Error", "ReferenceError", "TypeError", "TimeoutError"].includes(error?.name)
    ? error.name
    : "UnknownError";
  // Only emit fixed labels, never the matched text or a serialized error.
  const failureKind = [
    [/structuredClone is not defined|structuredClone is not a function/i, "clone-unavailable"],
    [/Attempted to register a second handler/i, "duplicate-ipc-handler"],
    [/No handler registered/i, "ipc-handler-unavailable"],
    [/Execution context was destroyed|Cannot find context with specified id/i, "context-unavailable"],
    [/Target.*(?:has been closed|closed)|browser has been closed/i, "electron-target-closed"],
    [/timeout|timed out/i, "timeout"],
  ].find(([pattern]) => pattern.test(message))?.[1] ?? "unclassified";
  console.error(`Failure category: ${failureKind} (${errorType})`);
  console.error(
    error.stack?.match(/e2e-model-settings\.mjs:\d+:\d+/)?.[0] ?? "No script location available",
  );
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => undefined);
  await isolated.cleanup();
}
