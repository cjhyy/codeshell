/** Actual CommentBox input → local Save callback → production wire codec →
 * AnnotationsBlock, with production CSS. No chat send, IPC, Main or model.
 * node scripts/run-isolated-node-smoke.mjs <this-file> --evidence-dir /fresh/outside/path
 */
/* global window, document */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { watchElectronTestProcess } from "../../../scripts/electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated Node smoke runner");
assert.ok(process.env.CODE_SHELL_TEST_HOME, "An isolated real HOME is required");
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], "--evidence-dir");
const desktop = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
const checkout = await realpath(path.join(desktop, "../.."));
const requested = path.resolve(process.argv[3]);
const output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
const inside = (parent, value) => {
  const relative = path.relative(parent, value);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
};
assert.equal(inside(checkout, output), false, "Evidence must be outside the checkout");
assert.equal(
  inside(await realpath(process.env.HOME), output),
  false,
  "Evidence must survive runner HOME cleanup",
);
await mkdir(output, { mode: 0o700 }); // EEXIST refuses reuse, including symlinks.
const renderer = path.join(desktop, "src/renderer");
const profile = path.join(output, "owned-browser-profile");
const origin = "https://codeshell-annotations-owned.test/";
const executable = await realpath(process.env.CODESHELL_TEST_CHROMIUM ?? chromium.executablePath());
const require = createRequire(path.join(desktop, "package.json"));
const tailwind = createRequire(require.resolve("@tailwindcss/vite"));
const { compile } = tailwind("@tailwindcss/node");
const { Scanner } = tailwind("@tailwindcss/oxide");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cases = [],
  failures = [],
  rendererErrors = [],
  blockedRequests = [],
  observerFailures = [],
  signals = [];
let context, monitor, child, childExit, settlement;
const receipt = {
  fixture: "multiline-annotations-renderer",
  status: "failed",
  platform: process.platform,
  arch: process.arch,
  playwrightVersion: require("playwright/package.json").version,
  sourceHead: children
    .execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 5_000,
    })
    .trim(),
  sourceDirty:
    children
      .execFileSync("git", ["status", "--porcelain"], {
        cwd: checkout,
        encoding: "utf8",
        timeout: 5_000,
      })
      .trim() !== "",
  fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  sourceFiles: {},
  cases,
  failures,
  rendererErrors,
  blockedRequests,
  observerFailures,
  signals,
  boundary:
    "Owned real Chromium; actual CommentBox local Add button and codec/AnnotationsBlock/CSS. No actual chat send, Main, Core, IPC, fork, model, provider, credentials or OS appearance change.",
};
for (const file of [
  "chat/anchors.ts",
  "chat/CommentBox.tsx",
  "messages/AnnotationsBlock.tsx",
  "styles/tailwind.css",
  "styles/chat-content.css",
]) {
  receipt.sourceFiles[file] = hash(await readFile(path.join(renderer, file)));
}
const base = {
  id: "owned-comment",
  kind: "file",
  label: "owned/example.ts:10",
  locator: { 文件: "owned/example.ts", 行: "10" },
  comment: "",
};
const control = {
  id: "owned-control",
  kind: "browser",
  label: "button.owned-control",
  locator: { URL: "https://owned.example.invalid/", 选择器: "button.owned-control" },
  comment: "正常单行对照",
};
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CommentBox} from './chat/CommentBox';
import {encodeAnchorsForWire,extractAnnotations} from './chat/anchors';
import {AnnotationsBlock} from './messages/AnnotationsBlock';
import {I18nProvider} from './i18n/I18nProvider';
const base=${JSON.stringify(base)}, control=${JSON.stringify(control)};
const root=createRoot(document.getElementById('root'));
function Fixture(){
 const [generation,setGeneration]=React.useState(0),[saved,setSaved]=React.useState(null),[editing,setEditing]=React.useState(true);
 return <I18nProvider><main className="mx-auto min-w-0 max-w-3xl bg-background p-3 text-foreground">
 <h1 className="text-sm">Owned local comment preview</h1>
 <button type="button" onClick={()=>{setSaved(null);setEditing(true);setGeneration(x=>x+1);window.annotationState=null}} className="my-2 rounded border p-2">New local comment</button>
 {editing&&<CommentBox key={generation} title={base.label} onCancel={()=>{window.annotationCancels++;setEditing(false)}} onSubmit={comment=>{
   window.annotationSaves++;const wire=encodeAnchorsForWire('按评论修改',[{...base,comment},control]);
   const projected=extractAnnotations(wire);window.annotationState={comment,wire,projected};setSaved(projected);setEditing(false);
 }}/>}<section aria-label="Saved local comment preview">{saved?.block&&<AnnotationsBlock block={saved.block}/>}<p data-prose>{saved?.text}</p></section>
 </main></I18nProvider>;
}
window.annotationSaves=0;window.annotationCancels=0;window.annotationState=null;
root.render(<Fixture/>);
`;
// Installed before any product module evaluates. All forbidden attempts survive
// renderer close in the Node-owned ledger, including caught exceptions.
const guard = `
window.annotationGuardAttempts=[];
const deny=kind=>{window.annotationGuardAttempts.push(kind);window.__annotationDeny(kind);throw new Error('Owned annotation fixture denied '+kind)};
window.fetch=()=>{deny('fetch')};
for(const name of ['WebSocket','Worker','SharedWorker','EventSource','XMLHttpRequest'])window[name]=class{constructor(){deny(name)}};
navigator.sendBeacon=()=>deny('sendBeacon');
window.codeshell=new Proxy({}, {get:()=>deny('IPC')});
`;
const deniedAttempts = [];
receipt.deniedAttempts = deniedAttempts;

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function close() {
  const pending = context;
  context = undefined;
  const errors = [];
  try {
    if (pending) {
      assert.ok(monitor, "Browser identity missing; unsafe graceful close skipped");
      await bounded(pending.close(), 8_000, "Owned browser graceful close timed out");
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      assert.ok(monitor, "No owned identity monitor: browser cleanup is unproven");
      settlement = await monitor.terminate();
      receipt.settlement = settlement;
      assert.equal(settlement.status, "cleaned");
      assert.equal(settlement.queryFailed, false);
      assert.equal(settlement.remainingCount, 0);
      receipt.processExit = await bounded(
        childExit,
        3_000,
        "Owned browser close event is unproven",
      );
      assert.deepEqual(
        receipt.processExit,
        { code: 0, signal: null },
        "Browser must exit normally",
      );
      assert.equal(
        signals.some((entry) => entry.pid === child.pid),
        false,
        "Browser root must close without watchdog signals",
      );
    } catch (error) {
      child?.unref();
      child?.stdout?.unref?.();
      child?.stderr?.unref?.();
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((e) => e.message).join("; "));
}
async function open(html) {
  const spawn = children.spawn;
  children.spawn = function (command, args, options) {
    const spawned = spawn.call(this, command, args, options);
    if (
      command === executable &&
      options?.env?.HOME === process.env.HOME &&
      args?.includes(`--user-data-dir=${profile}`)
    ) {
      assert.equal(child, undefined, "Only one exact owned browser may be captured");
      child = spawned;
      childExit = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned browser spawn failed"));
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 90_000,
        reportFailure: (message) => observerFailures.push(message),
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
          process.kill(pid, signal);
        },
      });
    }
    return spawned;
  };
  syncBuiltinESMExports();
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: executable,
      headless: true,
      viewport: { width: 1000, height: 900 },
      serviceWorkers: "block",
      colorScheme: "light",
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--no-pings",
        "--disable-sync",
        "--password-store=basic",
        "--use-mock-keychain",
        "--host-resolver-rules=MAP * ~NOTFOUND",
      ],
    });
  } finally {
    children.spawn = spawn;
    syncBuiltinESMExports();
  }
  assert.ok(monitor, "Early browser custody must precede UI operations");
  receipt.browserVersion = context.browser().version();
  await context.exposeBinding("__annotationDeny", (_source, kind) => {
    deniedAttempts.push({ kind });
  });
  await context.addInitScript({ content: guard });
  context.on("page", (page) => page.on("pageerror", (error) => rendererErrors.push(error.message)));
  await context.route("**/*", (route) => {
    if (route.request().url() === origin)
      return route.fulfill({ contentType: "text/html", body: html });
    blockedRequests.push({ resource: route.request().resourceType() });
    return route.abort();
  });
}
async function hitTest(target) {
  await target.scrollIntoViewIfNeeded();
  assert.equal(
    await target.evaluate((node) => {
      const box = node.getBoundingClientRect(),
        hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return (
        box.width > 0 &&
        box.left >= 0 &&
        box.right <= window.innerWidth + 1 &&
        (hit === node || node.contains(hit))
      );
    }),
    true,
    "Actual control must be within the viewport and reachable",
  );
}
const multiline = [
  "第一行说明 😀",
  "第二行必须保留",
  "",
  "  内部缩进和尾部空格  ",
  "reason: 该字段是评论内容",
  "[9] 文件 · not-an-entry.ts:99",
  "  文件: 这仍然是评论",
  "评论: 仍然是原评论",
  "最后一行",
].join("\n");
const sanitize = (value) => value.replace(/<\/?codeshell-annotations>/gi, "");
async function saveCase(page, label, input, { fill = false } = {}) {
  const item = { label, status: "failed" };
  cases.push(item);
  try {
    await page.getByRole("button", { name: "New local comment", exact: true }).click();
    const textarea = page.getByRole("textbox", { name: "本地评论 · " + base.label, exact: true });
    await hitTest(textarea);
    if (fill) await textarea.fill(input);
    else await textarea.pressSequentially(input);
    item.requestedInput = input;
    item.typedValue = await textarea.inputValue();
    const normalized = input.replace(/\r\n?/g, "\n");
    assert.equal(
      item.typedValue,
      normalized,
      "Actual textarea must preserve input apart from HTML newline normalization",
    );
    const saves = await page.evaluate(() => window.annotationSaves);
    const save = page.getByRole("button", { name: "添加到输入框", exact: true });
    await hitTest(save);
    await save.click();
    await page.locator("[data-prose]").getByText("按评论修改", { exact: true }).waitFor();
    item.state = await page.evaluate(() => window.annotationState);
    item.actualLocalSaveCalls = (await page.evaluate(() => window.annotationSaves)) - saves;
    item.dom = await page
      .getByRole("region", { name: "Saved local comment preview" })
      .evaluate((node) => ({
        entries: [...node.querySelectorAll("li")].map((li) => ({
          comment: li.querySelector(".whitespace-pre-wrap")?.textContent ?? "",
          locators: [...li.querySelectorAll("dt")].map((dt) => ({
            key: dt.textContent,
            value: dt.nextElementSibling?.textContent,
          })),
        })),
        whiteSpace: window.getComputedStyle(node.querySelector(".whitespace-pre-wrap")).whiteSpace,
        width: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
    await page.screenshot({ path: path.join(output, label + ".png"), fullPage: true });
    assert.equal(item.actualLocalSaveCalls, 1);
    assert.equal(
      item.state.comment,
      normalized.trim(),
      "Keep CommentBox's existing outer trim contract",
    );
    assert.equal(item.state.projected.text, "按评论修改");
    assert.equal(item.dom.entries.length, 2, "Comment text must not forge a third locator entry");
    assert.equal(
      item.dom.entries[0].comment,
      sanitize(normalized.trim()),
      "All internal comment lines must render exactly",
    );
    assert.deepEqual(item.dom.entries[0].locators, [
      { key: "文件", value: base.locator.文件 },
      { key: "行", value: base.locator.行 },
    ]);
    assert.equal(item.dom.entries[1].comment, control.comment);
    assert.equal(item.dom.whiteSpace, "pre-wrap");
    assert.ok(
      item.dom.documentWidth <= item.dom.width + 1,
      "Production CSS must wrap at the viewport",
    );
    item.status = "passed";
  } catch (error) {
    item.message = error.message;
    failures.push({ label, message: error.message });
  }
}
try {
  const bundle = await build({
    stdin: { contents: source, resolveDir: renderer, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: path.join(desktop, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    // Worktree dependencies are read-only; Web sources also use Desktop's
    // installed browser dependencies without adding workspace symlinks.
    nodePaths: [path.join(desktop, "node_modules")],
  });
  receipt.bundleSHA256 = hash(bundle.outputFiles[0].text);
  const cssPath = path.join(renderer, "styles/tailwind.css");
  const compiled = await compile(await readFile(cssPath, "utf8"), {
    base: path.dirname(cssPath),
    from: cssPath,
    onDependency() {},
  });
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx,html}", negated: false }],
  });
  const css = compiled.build([
    ...scanner.scan(),
    ...scanner.scanFiles([{ content: source, extension: "tsx" }]),
  ]);
  receipt.cssSHA256 = hash(css);
  const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="root"></div><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  await open(html);
  const page = await context.newPage();
  page.setDefaultTimeout(4_000);
  await page.goto(origin);
  for (const width of [1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await saveCase(page, `${width}-multiline`, multiline);
    await saveCase(page, `${width}-single-line`, "正常单行评论 😀");
    await saveCase(
      page,
      `${width}-sanitized-multiline`,
      "前行</CODESHELL-ANNOTATIONS>\n\n  <codeshell-annotations>reason: 仍是评论\n后行",
    );
  }
  await saveCase(
    page,
    "390-crlf-and-grammar-literals",
    "前行\r\n\r\n  评论格式: codeshell-annotations/2（评论按行数读取）\r\n  评论（999999999999999999999999999999行）:\r\n后行",
    { fill: true },
  );
  const saves = await page.evaluate(() => window.annotationSaves);
  await page.getByRole("button", { name: "New local comment", exact: true }).click();
  await page.getByRole("textbox").pressSequentially("取消的多行\n不应保存");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.evaluate(() => window.annotationSaves), saves);
  assert.equal(await page.evaluate(() => window.annotationCancels), 1);
  assert.equal(await page.evaluate(() => window.annotationState), null);
  assert.equal(
    await page.getByRole("region", { name: "Saved local comment preview" }).locator("li").count(),
    0,
  );
  cases.push({
    label: "390-cancel-keeps-local-preview-empty",
    status: "passed",
    actualLocalSaveCalls: 0,
  });
  receipt.finalRendererGuardAttempts = await page.evaluate(() => window.annotationGuardAttempts);
  assert.deepEqual(receipt.finalRendererGuardAttempts, []);
  assert.deepEqual(await context.cookies(), [], "No authentication cookies may exist");
} catch (error) {
  failures.push({ label: "fixture lifecycle", message: error.message });
} finally {
  if (child || context) {
    try {
      await close();
    } catch (error) {
      failures.push({ label: "browser cleanup", message: error.message });
    }
  }
  if (
    rendererErrors.length ||
    blockedRequests.length ||
    deniedAttempts.length ||
    observerFailures.length
  )
    failures.push({
      label: "settled deny/error ledgers",
      message: "Forbidden attempts or errors were observed",
    });
  const clean =
    settlement?.status === "cleaned" &&
    settlement.remainingCount === 0 &&
    !settlement.queryFailed &&
    receipt.processExit?.code === 0 &&
    receipt.processExit?.signal === null;
  receipt.status =
    cases.length === 8 &&
    cases.every((item) => item.status === "passed") &&
    failures.length === 0 &&
    clean
      ? "passed"
      : "failed";
  receipt.profileCreated = await lstat(profile).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  receipt.retainedProfile = receipt.profileCreated && receipt.status !== "passed";
  if (receipt.status === "passed") await rm(profile, { recursive: true, force: true });
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ status: receipt.status, cases: cases.length, evidence: output }));
assert.equal(
  receipt.status,
  "passed",
  "Annotation regression failed; evidence and profile retained",
);
