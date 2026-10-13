import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import net from "node:net";
import tls from "node:tls";
import React, { act } from "react";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round16"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const { default: ts } = await import(`${repo}/node_modules/typescript/lib/typescript.js`);
const { writeSettings, readSettings, resolveSettingsPath } = await import(`${repo}/packages/desktop/src/main/settings-service.ts`);
const { createRoot } = await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`);
const { SettingsPage } = await import(`${repo}/packages/desktop/src/renderer/settings/SettingsPage.tsx`);
const { useTargetedDebouncedSave } = await import(`${repo}/packages/desktop/src/renderer/settings/useTargetedDebouncedSave.ts`);
ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
const source = ts.createSourceFile("index.ts", readFileSync(`${repo}/packages/desktop/src/main/index.ts`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function extracted(channel: string) {
  let callback: any;
  function visit(node: any) { if (ts.isCallExpression(node) && node.arguments[0]?.getText(source) === JSON.stringify(channel)) callback = node.arguments.find((x: any) => ts.isArrowFunction(x)); ts.forEachChild(node, visit); }
  visit(source); assert.ok(callback);
  const validator = source.statements.find((node: any) => ts.isFunctionDeclaration(node) && node.name?.text === "validateRendererSettingsPatch")!;
  const js = ts.transpileModule(`${validator.getText(source)}\nconst handler=${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  // Side effects do not apply to the agent-only patches exercised here.
  return runInNewContext(`${js}\nhandler`, { readSettings, writeSettings, Buffer, applyRendererSettingsSideEffects: async () => {} });
}
const get = extracted("settings:get"), set = extracted("settings:set");
const attempts: any[] = [], rejections: any[] = [];
process.on("unhandledRejection", (error) => { rejections.push(error); });
let changeEvents = 0;
window.addEventListener("codeshell:settings-changed", () => changeEvents++);
Object.defineProperty(window, "codeshell", { configurable: true, value: { getSettings: (scope: string) => get({}, scope), updateSettings: (scope: string, patch: any) => { attempts.push(structuredClone(patch)); return set({}, scope, patch); } } });
let assertions = 0;
const check = (value: unknown, label?: string) => { assertions++; assert.ok(value, label); };
const equal = (value: unknown, expected: unknown) => { assertions++; assert.deepEqual(value, expected); };
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
const props = (node: any) => { const key = Object.keys(node).find(k => k.startsWith("__reactProps$")); return key ? node[key] : {}; };
const text = (node: any): string => node.nodeType === 3 ? node.nodeValue ?? node.textContent ?? "" : Array.from(node.childNodes ?? []).map(text).join("") || node.textContent || "";
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 5)); await flushMicrotasks(); };
const container = document.createElement("div"); document.body.appendChild(container);
let root: any;
const renderPage = async () => { const expected = ((await readSettings("user"))?.agent as any)?.appendSystemPrompt ?? ""; root = createRoot(container); await act(async () => { root.render(<SettingsPage initialModule="personalization" activeProjectPath={null} projects={[]} sessionIndices={{}} onRestoreArchivedSession={() => {}} onDeleteArchivedSession={() => {}} isMac={false} isFullscreen={false} onBack={() => root.unmount()} />); await settle(); }); const deadline = Date.now() + 2500; while (props(instructions()).value !== expected) { if (Date.now() > deadline) throw Error("initial settings load did not finish"); await act(settle); } };
const instructions = () => nodes(container).filter(n => n.tagName === "TEXTAREA")[1];
const changeInstructions = async (value: string) => { await act(async () => { props(instructions()).onChange({ target: { value } }); await settle(); }); };
const unmount = async () => { if (root) { await act(async () => { root.unmount(); await settle(); }); root = undefined; } };
try {
  await writeSettings("user", { agent: { appendSystemPrompt: "stored instructions", responseLanguage: "zh", userProfile: "keep profile" } });
  await renderPage();
  equal(props(instructions()).value, "stored instructions");
  await changeInstructions("latest on leave");
  equal(attempts.length, 0);
  const back = nodes(container).find(n => n.tagName === "BUTTON" && text(n).includes("返回应用"));
  check(back, "actual SettingsPage Back entry");
  await act(async () => { props(back).onClick(); await settle(); }); root = undefined;
  equal(attempts.length, 1);
  equal((await readSettings("user"))?.agent, { appendSystemPrompt: "latest on leave", responseLanguage: "zh", userProfile: "keep profile" });
  equal(changeEvents, 1);
  await renderPage(); equal(props(instructions()).value, "latest on leave"); await unmount();

  // Real filesystem failure: settings.json becomes an owned directory.
  const file = resolveSettingsPath("user"), prior = readFileSync(file, "utf8");
  await renderPage();
  rmSync(file); mkdirSync(file);
  await changeInstructions("unique failed leave draft");
  equal(props(instructions()).value, "unique failed leave draft");
  const before = changeEvents;
  const attemptBeforeFailure = attempts.length;
  await act(async () => { props(instructions()).onBlur(); await settle(); });
  for (let i = 0; i < 20 && !rejections.length; i++) await settle();
  equal(rejections.length, 1);
  check(["EISDIR", "EPERM", "EACCES"].some(code => String(rejections[0]).includes(code)), "actual storage rejection");
  equal(attempts.length, attemptBeforeFailure + 1);
  equal(props(instructions()).value, "unique failed leave draft");
  equal(nodes(container).filter(n => props(n).role === "alert").length, 0);
  check(!text(container).includes("EISDIR") && !text(container).includes("保存失败"));
  // Storage is repaired while the failed draft is still visible. Merely
  // refocusing/blurring or leaving does not re-enqueue this unchanged value.
  rmSync(file, { recursive: true }); writeFileSync(file, prior);
  await act(async () => { props(instructions()).onBlur(); await settle(); });
  equal(attempts.length, attemptBeforeFailure + 1);
  equal(((await readSettings("user"))?.agent as any).appendSystemPrompt, "latest on leave");
  equal(changeEvents, before);
  const failedBack = nodes(container).find(n => n.tagName === "BUTTON" && text(n).includes("返回应用"));
  check(failedBack);
  await act(async () => { props(failedBack).onClick(); await settle(); }); root = undefined;
  equal(attempts.length, attemptBeforeFailure + 1);
  check(!text(container).includes("unique failed leave draft"));
  await renderPage();
  equal(props(instructions()).value, "latest on leave");
  check(!text(container).includes("unique failed leave draft"));
  await changeInstructions("retyped recovery");
  await act(async () => { props(instructions()).onBlur(); await settle(); });
  equal((await readSettings("user"))?.agent && ((await readSettings("user"))?.agent as any).appendSystemPrompt, "retyped recovery");
  equal(changeEvents, before + 1);
  await unmount();

  // Actual hook target capture/cancel; actual store IO, not an invented writer.
  const projectA = join(process.env.HOME!, "owned-a"), projectB = join(process.env.HOME!, "owned-b");
  let target = projectA;
  const hook = await renderHook(() => { const captured = target; return useTargetedDebouncedSave(captured, (value: string) => writeSettings("project", { fixtureDraft: value }, captured), 1000); });
  act(() => { hook.result.current.schedule("A old"); hook.result.current.schedule("A latest"); });
  target = projectB; await hook.rerender(); await settle();
  equal((await readSettings("project", projectA))?.fixtureDraft, "A latest");
  equal(await readSettings("project", projectB), null);
  act(() => { hook.result.current.schedule("cancelled B"); hook.result.current.cancel(); });
  await hook.unmount(); await settle();
  equal(await readSettings("project", projectB), null);
  console.log(JSON.stringify({ normalLeavePersistsAndReopens: true, actualSettingsPage: true, mainCallbacksAST: true, actualFilesystemRejection: true, failedUnmountDraftRecoveredOnReopen: false, retypingAfterStorageRepairWorks: true, originalTargetFlushAndCancelWork: true, unhandledRejections: rejections.length, assertions, nativeCLI: false, model: false }));
  console.log(`PASS settings lifecycle; ${assertions} assertions`);
} finally { await unmount(); document.body.removeChild(container); }
