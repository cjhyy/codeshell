/* Manual native-browser regression: disabled fieldsets still dispatch pointerdown.
 * Run with node; bundles only in memory and uses an isolated Chromium profile. */
/* global document, window */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const settingsDir = fileURLToPath(new URL(".", import.meta.url));
const renderer = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {TextConnectionsPanel} from './TextConnectionsPanel.tsx';
      import {DialogProvider} from '../ui/DialogProvider.tsx';
      import {ToastProvider} from '../ui/ToastProvider.tsx';
      let stored = {
        modelConnections: [{id:'fixture',catalogId:'fixture',tag:'text',model:'one',credentialId:'credential',paramValues:{effort:'low'}}],
        credentials: [{id:'credential',catalogId:'fixture',apiKey:'synthetic-unused'}],
        defaults: {text:'fixture'},
      };
      if(window.fixtureStartUnbound) {
        stored.modelConnections[0].credentialId=undefined;
        stored.modelConnections.push({...stored.modelConnections[0],id:'secondary',model:'two'});
        stored.credentials=[];
      }
      window.fixtureState={writes:0,pointerdowns:0,readFailure:window.fixtureReadFailure,holdRead:false,
        summary:()=>({ids:stored.modelConnections.map(connection=>connection.id),defaultId:stored.defaults.text,auxId:stored.defaults.auxText,credentialCount:stored.credentials.length,boundCount:stored.modelConnections.filter(connection=>connection.credentialId).length}),
        shared:()=>stored.credentials.length===1 && stored.modelConnections.length===2 &&
          stored.modelConnections.every(connection=>connection.credentialId===stored.credentials[0].id),
      };
      document.addEventListener('pointerdown',()=>window.fixtureState.pointerdowns++,true);
      window.codeshell={
        getSettings:async()=>{
          if(window.fixtureState.readFailure==='settings') throw new Error('Synthetic private settings read failure');
          return structuredClone(stored);
        },
        getModelCatalog:async()=>{
          if(window.fixtureState.readFailure==='catalog') throw new Error('Synthetic private catalog read failure');
          if(window.fixtureState.holdRead) await new Promise(resolve=>window.fixtureState.releaseRead=resolve);
          return [{id:'fixture',tag:'text',displayName:'Fixture',needsKey:true,
            modelPresets:[{value:'one',params:[{name:'effort',control:'enum',options:['low','high']}]},{value:'two'}]}];
        },
        updateSettings:(_scope,patch)=>new Promise((resolve,reject)=>{
          window.fixtureState.writes++;
          window.fixtureState.resolve=()=>{stored={...stored,...patch};resolve();};
          window.fixtureState.reject=()=>reject(new Error('Synthetic unavailable storage'));
        }),
      };
      createRoot(document.getElementById('root')).render(<DialogProvider><ToastProvider>
        <button id="before">Before</button><TextConnectionsPanel scope="user" activeProjectPath={null}/><button id="after">After</button>
      </ToastProvider></DialogProvider>);
    `,
    resolveDir: settingsDir,
    loader: "tsx",
  },
  alias: { "@": renderer },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
page.setDefaultTimeout(3000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const mount = async (unbound = false, readFailure = null) => {
  await page.goto("about:blank");
  await page.setContent(
    '<style>button,input{margin:5px} fieldset{max-width:900px} [role=listbox],[role=menu]{background:white;border:1px solid black}</style><div id="root"></div>',
  );
  await page.evaluate(
    ({ unbound, readFailure }) => {
      window.fixtureStartUnbound = unbound;
      window.fixtureReadFailure = readFailure;
    },
    { unbound, readFailure },
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (readFailure) await page.getByText("无法读取模型连接，请重试。", { exact: true }).waitFor();
  else await page.getByRole("button", { name: "保存", exact: true }).first().waitFor();
};
const waitFocus = async (text) =>
  page.waitForFunction((text) => document.activeElement?.textContent?.trim() === text, text, {
    timeout: 3000,
  });
const beginDelete = async () => {
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确定", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
};
try {
  await mount();
  const form = page.locator("fieldset");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  assert.equal(await page.evaluate(() => window.fixtureState.writes), 1);
  const triggers = form.locator("[role=combobox]");
  assert.equal(
    await triggers.count(),
    4,
    "Exercise auxiliary, model, credential, and enum controls",
  );
  for (let i = 0; i < (await triggers.count()); i++) {
    const trigger = triggers.nth(i);
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox();
    assert.ok(box);
    const previous = await page.evaluate(() => window.fixtureState.pointerdowns);
    // A real click, intentionally avoiding locator.click's disabled-action guard.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.ok(
      await page.evaluate((previous) => window.fixtureState.pointerdowns > previous, previous),
    );
    assert.equal(
      await page.getByRole("listbox").count(),
      0,
      `Pending select ${i} must not open its portal`,
    );
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  }
  const add = page.getByRole("button", { name: "添加模型", exact: true });
  const addBox = await add.boundingBox();
  await page.mouse.click(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2);
  assert.equal(await page.getByRole("menu").count(), 0, "Pending add menu stays closed");
  await page.locator("#before").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "after",
    "Keyboard navigation skips the locked form",
  );
  assert.equal(
    await page.evaluate(() => window.fixtureState.writes),
    1,
    "No second write occurs while pending",
  );
  await page.evaluate(() => window.fixtureState.reject());
  await page.waitForFunction(() => !document.querySelector("fieldset")?.disabled);
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "after",
    "Completing a save must not steal external focus",
  );
  await triggers.nth(1).click();
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("Escape");
  await add.click();
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");

  await mount();
  const save = page.getByRole("button", { name: "保存", exact: true });
  await save.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "Native fieldset disabling blurs the active Save button",
  );
  await page.evaluate(() => window.fixtureState.reject());
  await waitFocus("保存");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
  await page.evaluate(() => window.fixtureState.resolve());
  await waitFocus("保存");

  await beginDelete();
  await page.evaluate(() => window.fixtureState.reject());
  await waitFocus("删除");
  await beginDelete();
  await page.evaluate(() => window.fixtureState.resolve());
  await waitFocus("添加模型");
  assert.equal(
    await page.locator("article").filter({ hasText: "#fixture" }).count(),
    0,
    "The deleted source is gone before focus falls back to Add",
  );

  await mount();
  await beginDelete();
  await page.locator("#after").focus();
  await page.evaluate(() => window.fixtureState.resolve());
  await page.waitForFunction(() => !document.querySelector("fieldset")?.disabled);
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "after",
    "Successful delete preserves externally moved focus",
  );

  for (const mode of ["paste", "typing", "save-other-card"]) {
    await mount(true);
    const primary = page.locator("article").filter({ hasText: "#fixture" });
    const secondary = page.locator("article").filter({ hasText: "#secondary" });
    const key = primary.locator('input[type="password"]');
    await key.focus();
    if (mode === "paste") await page.keyboard.insertText("synthetic-new-credential");
    else await key.pressSequentially("synthetic-new-credential");
    assert.equal(await key.count(), 1, "The entire unsaved key stays editable");
    assert.ok(
      await key.evaluate((element) => element === document.activeElement),
      "Entering the key preserves focus",
    );
    const saveCard = mode === "save-other-card" ? secondary : primary;
    await saveCard.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
    await page.evaluate(() => window.fixtureState.reject());
    await waitFocus("保存");
    assert.equal(await key.count(), 1, "A failed save keeps the key editable");
    await key.focus();
    await page.keyboard.press("End");
    await page.keyboard.type("-retry");
    await saveCard.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
    await page.evaluate(() => window.fixtureState.resolve());
    await waitFocus("保存");
    await key.waitFor({ state: "hidden" });
    assert.equal(
      await primary.locator('input[type="password"],input[type="text"]').count(),
      0,
      "A successful shared settings commit protects the original credential",
    );
    await secondary.getByRole("combobox").nth(1).click();
    await page.getByRole("option").filter({ hasText: "#fixture-key" }).click();
    await secondary.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
    await page.evaluate(() => window.fixtureState.resolve());
    await waitFocus("保存");
    assert.ok(
      await page.evaluate(() => window.fixtureState.shared()),
      "Both connections reuse the same saved credential",
    );
    assert.equal(
      await page.locator('article input[type="password"],article input[type="text"]').count(),
      0,
      "Neither sharing card exposes a key editor after save",
    );
  }

  await mount();
  const original = page
    .locator("article")
    .filter({ has: page.locator("header code").getByText("#fixture", { exact: true }) });
  const addModel = page.getByRole("button", { name: "添加模型", exact: true });
  const selectNewModel = async () => {
    await addModel.click();
    await page.getByRole("menuitem", { name: "Fixture", exact: true }).hover();
    await page.getByRole("menuitem", { name: "two", exact: true }).click();
  };
  const checkPending = async () => {
    await page.waitForFunction(() => document.querySelector("fieldset")?.disabled);
    const trigger = page.locator("fieldset [role=combobox]").first();
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(
      await page.getByRole("listbox").count(),
      0,
      "Every pending operation blocks portalled editing",
    );
  };
  await selectNewModel();
  await checkPending();
  assert.equal(
    await page.locator("article").count(),
    1,
    "Pending addition keeps the committed list",
  );
  await page.evaluate(() => window.fixtureState.reject());
  await waitFocus("添加模型");
  assert.equal(await page.locator("article").count(), 1, "Failed addition leaves no phantom card");
  await selectNewModel();
  await checkPending();
  await page.evaluate(() => window.fixtureState.resolve());
  await waitFocus("添加模型");
  const added = page
    .locator("article")
    .filter({ has: page.locator("header code").getByText("#fixture-two", { exact: true }) });
  await added.waitFor();
  await added.getByRole("button", { name: "设为当前", exact: true }).click();
  await checkPending();
  await page.evaluate(() => window.fixtureState.reject());
  await waitFocus("设为当前");
  assert.equal(await page.evaluate(() => window.fixtureState.summary().defaultId), "fixture");
  await page.keyboard.press("Enter");
  await checkPending();
  await page.evaluate(() => window.fixtureState.resolve());
  await waitFocus("添加模型");
  assert.equal(await page.evaluate(() => window.fixtureState.summary().defaultId), "fixture-two");

  const auxiliary = page.locator("fieldset [role=combobox]").first();
  const chooseAux = async () => {
    await auxiliary.click();
    await page.getByRole("option", { name: "Fixture · two", exact: true }).click();
  };
  const waitAuxFocus = () =>
    page.waitForFunction(
      () => document.activeElement === document.querySelector("fieldset [role=combobox]"),
    );
  await chooseAux();
  await checkPending();
  await page.evaluate(() => window.fixtureState.reject());
  await waitAuxFocus();
  await chooseAux();
  await checkPending();
  await page.evaluate(() => window.fixtureState.resolve());
  await waitAuxFocus();
  assert.equal(await page.evaluate(() => window.fixtureState.summary().auxId), "fixture-two");
  assert.equal(await page.evaluate(() => window.fixtureState.summary().defaultId), "fixture-two");

  const removeKey = original.getByRole("button", { name: "删除凭证", exact: true });
  await removeKey.click();
  const writesBeforeCancel = await page.evaluate(() => window.fixtureState.writes);
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await waitFocus("删除凭证");
  assert.equal(await page.evaluate(() => window.fixtureState.writes), writesBeforeCancel);
  const confirmCredential = async () => {
    await removeKey.click();
    await page.getByRole("dialog").getByRole("button", { name: "确定", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await checkPending();
  };
  await confirmCredential();
  await page.evaluate(() => window.fixtureState.reject());
  await waitFocus("删除凭证");
  assert.equal(await page.evaluate(() => window.fixtureState.summary().boundCount), 2);
  await confirmCredential();
  await page.evaluate(() => window.fixtureState.resolve());
  await waitFocus("添加模型");
  assert.deepEqual(await page.evaluate(() => window.fixtureState.summary()), {
    ids: ["fixture", "fixture-two"],
    defaultId: "fixture-two",
    auxId: "fixture-two",
    credentialCount: 0,
    boundCount: 0,
  });

  await mount(false, "catalog");
  assert.equal(
    await page.locator("article").count(),
    0,
    "Incomplete initial reads cannot expose editable cards",
  );
  assert.equal(
    await page.getByRole("button", { name: "添加模型", exact: true }).isDisabled(),
    true,
  );
  const unavailableAdd = await page
    .getByRole("button", { name: "添加模型", exact: true })
    .boundingBox();
  await page.mouse.click(
    unavailableAdd.x + unavailableAdd.width / 2,
    unavailableAdd.y + unavailableAdd.height / 2,
  );
  assert.equal(
    await page.getByRole("menu").count(),
    0,
    "An incomplete snapshot cannot open the Add menu by native pointerdown",
  );
  const retryRead = page.getByRole("button", { name: "重试读取", exact: true });
  await page.evaluate(() => {
    window.fixtureState.readFailure = "settings";
  });
  await retryRead.click();
  await waitFocus("重试读取");
  assert.equal(
    await page.locator("article").count(),
    0,
    "A settings failure cannot apply only the catalog",
  );
  assert.equal(await page.getByText("无法读取模型连接，请重试。", { exact: true }).count(), 1);
  await page.evaluate(() => {
    window.fixtureState.readFailure = null;
    window.fixtureState.holdRead = true;
  });
  await retryRead.click();
  await page.getByText("正在读取模型连接…", { exact: true }).waitFor();
  assert.equal(await retryRead.isDisabled(), true, "Reading locks duplicate retries");
  await page.evaluate(() => window.fixtureState.releaseRead());
  await waitFocus("添加模型");
  assert.equal(await page.locator("article").count(), 1);
  const loadedCard = page.locator("article");
  await loadedCard.getByRole("combobox").nth(1).click();
  await page.getByRole("option", { name: "填新 key…", exact: true }).click();
  const retainedKey = loadedCard.locator('input[type="password"]');
  await retainedKey.fill("synthetic-read-draft");
  await page.evaluate(() => {
    window.fixtureState.readFailure = "catalog";
    window.dispatchEvent(new window.CustomEvent("codeshell:files-changed"));
  });
  await page
    .getByText("刷新模型连接失败，当前连接和编辑内容已保留。请重试。", { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.tagName === "INPUT" &&
      document.activeElement.getAttribute("type") === "password",
  );
  assert.ok(
    await retainedKey.evaluate((element) => element.value === "synthetic-read-draft"),
    "A failed refresh retains the complete draft",
  );
  assert.equal(await page.locator("article").count(), 1);
  assert.equal(
    await page.getByText(/Synthetic private/).count(),
    0,
    "No private error details are shown",
  );
  await page.evaluate(() => {
    window.fixtureState.readFailure = null;
  });
  await retryRead.click();
  await page.getByText("正在读取模型连接…", { exact: true }).waitFor();
  await page.locator("#after").focus();
  await page.evaluate(() => window.fixtureState.releaseRead());
  await page.getByText("正在读取模型连接…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "after",
    "A read retry does not steal external focus",
  );

  await mount(true);
  const autoReadKey = page
    .locator("article")
    .filter({ hasText: "#fixture" })
    .locator('input[type="password"]');
  await autoReadKey.focus();
  await page.evaluate(() => {
    window.fixtureState.holdRead = true;
    window.dispatchEvent(new window.CustomEvent("codeshell:files-changed"));
  });
  await page.getByText("正在读取模型连接…", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "An automatic read temporarily blurs the locked input",
  );
  await page.evaluate(() => window.fixtureState.releaseRead());
  await page.waitForFunction(
    () =>
      document.activeElement?.tagName === "INPUT" &&
      document.activeElement.getAttribute("type") === "password",
  );
  assert.ok(
    await autoReadKey.evaluate((element) => document.activeElement === element),
    "Successful automatic refresh returns to the same surviving input",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: pending protects all controls; save/delete and auxiliary operations recover and restore focus; shared keys stay protected; complete reads recover from catalog/settings errors, retain failed-refresh drafts, and restore retry focus without stealing external focus.",
  );
} finally {
  await browser.close();
}
