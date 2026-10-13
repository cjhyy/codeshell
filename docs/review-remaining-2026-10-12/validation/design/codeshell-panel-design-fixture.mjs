import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, extname, sep } from "node:path";
import net from "node:net"; import http from "node:http"; import https from "node:https"; import tls from "node:tls";
import {syncBuiltinESMExports} from "node:module";
import childProcess from "node:child_process";
assert.notEqual(process.env.HOME,"/Users/admin"); assert.equal(process.env.CODE_SHELL_TEST_HOME,resolve(process.env.HOME,".code-shell"));
const deny=()=>{throw Error("design review denies every Node network origin")};
globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=http.get=https.request=https.get=tls.connect=deny;syncBuiltinESMExports();
assert.throws(()=>fetch("https://example.invalid"),/denies/); console.log(JSON.stringify({case:"network_guard",homeIsolated:true,nodeNetworkDenied:true,isolatedHome:process.env.HOME,browserOrigin:"https://panel.test",browserRoute:"all other origins aborted"}));
const chromeExecutable="/tmp/codeshell-services-runtime-0927.wnUxrv/chromium/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const liveChrome=new Set(),ownedChrome=[];const spawn=childProcess.spawn;childProcess.spawn=function(command,args,options){assert.equal(command,chromeExecutable);assert.equal(options.env.HOME,process.env.HOME);const child=spawn.call(this,command,args,options);ownedChrome.push(child.pid);liveChrome.add(child.pid);child.once("exit",()=>liveChrome.delete(child.pid));return child};syncBuiltinESMExports();process.on("exit",()=>console.log(JSON.stringify({case:"cleanup",ownedChromePids:ownedChrome,liveChromePids:[...liveChrome]})));
const {chromium}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/node_modules/playwright/index.mjs");
const {normalizeDesignDocument,serializeDesignDocument,exportDesignSvg}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/document.mjs");
const {createDesignIndexPersistencePlan}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/document-index.mjs");
const {applyAllAutoLayouts}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/layout.mjs");
const {exportDesignFrontend}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/frontend-export.mjs");
const root = "/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app";
const manifest = JSON.parse(await readFile("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/.codeshell-panel/panel.json"));
const path = "designs/polish.codesign.json";
const hash = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function source(scope, imported = false) {
  const node = (id, type, name, x, y, width, height, extra = {}) => ({
    id, type, name, x, y, width, height, fill: "#333333", stroke: "transparent",
    strokeWidth: 0, opacity: 1, rotation: 0, cornerRadius: 0, visible: true, locked: false, ...extra,
  });
  return serializeDesignDocument(normalizeDesignDocument({ format: "codeshell.design", version: 3,
    name: `${scope} design`, canvas: { width: 800, height: 600, background: "#ffffff" },
    tokens: { colors: [] }, resources: [], activePageId: "page-1", pages: [
      { id: "page-1", name: "Home", children: [node("card", "frame", "Card", 100, 100, 500, 300, {
        fill: "#ffffff", layout: "none", gap: 16, padding: 24, alignItems: "start", justifyContent: "start",
        gridColumns: 2, clipContent: false, children: [
          node("heading", "text", "Heading", 140, 140, 200, 50, { text: `${scope} heading`,
            fontSize: 24, fontWeight: 600, lineHeight: 1.2, textAlign: "left",
            textSource: imported ? `${scope} complete imported heading` : `${scope} heading`,
            ...(imported ? { textOverflow: "ellipsis" } : {}),
            textMeasurement: "browser", textFlowWidth: 200 }),
          node("body", "text", "Body", 140, 220, 180, 40, { text: "Body copy", fontSize: 16,
            fontWeight: 400, lineHeight: 1.2, textAlign: "left" }),
        ],
      })] }, { id: "page-2", name: "Details", children: [node("details-text", "text", "Details text", 0, 0, 200, 30, {text:"Page two payload",fontSize:16,fontWeight:400,lineHeight:1.2,textAlign:"left"})] },
    ],
  }));
}

async function fixture(t, { mobile = false, agent = true, imported = false, indexed = false, wrapped = false } = {}) {
  const browser = await chromium.launch({ executablePath: "/tmp/codeshell-services-runtime-0927.wnUxrv/chromium/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell", args: ["--disable-background-networking", "--disable-component-update", "--no-pings"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 844 },
    hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage(), calls = [], records = new Map(), errors = [], pauses = new Map();
  page.setDefaultTimeout(4000);
  const files = new Map(["A", "B"].map(scope => {let text=source(scope,imported);if(wrapped){const doc=JSON.parse(text),frame=doc.pages[0].children[0],node=frame.children[0];Object.assign(frame,{layout:"vertical",padding:0,width:200,height:300});Object.assign(node,{x:100,y:100,width:200,fontSize:16,text:"这是没有空格的中文长段落",textSource:"这是没有空格的中文长段落",textFlow:"wrap",textFlowWidth:200,layoutSizingHorizontal:"fill"});text=serializeDesignDocument(normalizeDesignDocument(doc));}return [`${scope}:${path}`,text];}));
  if (indexed) for (const scope of ["A", "B"]) {
    const raw = JSON.parse(source(scope, imported));
    raw.pages.push(...Array.from({ length: 10 }, (_, i) => ({ id: `page-${i + 3}`, name: `Page ${i + 3}`, children: [] })));
    const plan = await createDesignIndexPersistencePlan({ document: normalizeDesignDocument(raw),
      sha256: async value => createHash("sha256").update(value).digest("hex") });
    files.set(`${scope}:${path}`, plan.primarySource);
    for (const part of plan.parts) files.set(`${scope}:${part.path}`, part.content);
  }
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url()), file = resolve(root, `.${url.pathname}`);
    if (url.origin !== "https://panel.test" || !file.startsWith(root + sep)) return route.abort();
    try { await route.fulfill({ body: await readFile(file), contentType: {
      ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css",
    }[extname(file)] }); } catch { await route.fulfill({ status: 404, body: "missing" }); }
  });
  await page.exposeFunction("hostBridge", async (scope, method, params = {}) => {
    calls.push({ scope, method, ...structuredClone(params) });
    const key = `${scope}:${params.key}`;
    const snapshot = () => ({ exists: records.has(key), value: records.get(key) ?? null,
      revision: records.has(key) ? hash(records.get(key)) : null });
    let result;
    if (method === "workspace.info") result = { cwd: "/workspace", name: scope };
    else if (method === "workspace.list") result = { entries: [...files.keys()].filter(key => key.startsWith(scope+":") && key.endsWith(".codesign.json")).map(key=>({kind:"file",path:key.slice(scope.length+1)})), truncated: false };
    else if (method === "workspace.readText") {
      const content = files.get(`${scope}:${params.path}`);
      if (content === undefined) throw Error("file missing");
      result = { content, modifiedAt: 1, revision: hash(content) };
    } else if (method === "workspace.writeText") {
      const file = `${scope}:${params.path}`, previous = files.get(file);
      if (params.expectedModifiedAt === null && previous !== undefined) throw Error("file exists");
      if (params.expectedRevision && params.expectedRevision !== hash(previous)) throw Error("changed since read");
      files.set(file, params.content);
      result = { modifiedAt: 1, revision: hash(params.content) };
    } else if (method === "storage.get") result = params.key.startsWith("lastPath.")
      ? { workspaceRoot: "/workspace", path } : records.get(key) ?? null;
    else if (method === "storage.set") { records.set(key, structuredClone(params.value)); result = null; }
    else if (method === "storage.delete") { records.delete(key); result = null; }
    else if (method === "storage.getSnapshot") result = snapshot();
    else if (method === "storage.compareAndSet") {
      if (params.expectedRevision !== snapshot().revision) result = { updated: false, snapshot: snapshot() };
      else {
        if (params.remove) records.delete(key); else records.set(key, structuredClone(params.value));
        result = { updated: true, snapshot: snapshot() };
      }
    } else if (method === "agent.submitPrompt") result = { accepted: true };
    else throw Error(`Unsupported ${method}`);
    const pauseKey = pauses.has(`${scope}:${method}:${params.path}`) ? `${scope}:${method}:${params.path}` : `${scope}:${method}`;
    const pause = pauses.get(pauseKey);
    if (pause) { pauses.delete(pauseKey); pause.enter(); await pause.gate; }
    return result;
  });
  await page.addInitScript(({ permissions, agent }) => {
    let listener, scope = "A";
    const context = { trusted: true, busy: false,
      ...(permissions.includes("context.workspace") ? { cwd: "/workspace" } : {}),
      ...(permissions.includes("context.session") ? { sessionId: "A" } : {}),
      availableMethods: ["workspace.info", "workspace.list", "workspace.readText", "workspace.writeText",
        "storage.get", "storage.set", "storage.delete", "storage.getSnapshot", "storage.compareAndSet",
        ...(agent ? ["agent.submitPrompt"] : [])],
    };
    window.tools = {};
    window.codeshellPanel = {
      getContext: async () => ({ ...context }),
      on(name, callback) { if (name === "context.changed") listener = callback; },
      registerTool(name, callback) { window.tools[name] = callback; },
      call: (method, params) => window.hostBridge(scope, method, params),
    };
    window.switchProject = target => { scope = target; context.sessionId = target; listener?.({ ...context }); };
  }, { permissions: manifest.permissions, agent });
  await page.goto("https://panel.test/index.html");
  try {
    await page.waitForFunction((wrapped) => !document.querySelector(".workspace").inert &&
      document.querySelector('[data-text-node-id="heading"]')?.textContent === (wrapped?"这是没有空格的中文长段落":"A heading"), wrapped, { timeout: 3000 });
  } catch (error) {
    error.message += `\nErrors: ${JSON.stringify(errors)}; status: ${await page.locator("#toast").textContent()}; calls: ${JSON.stringify(calls.slice(-5))}`;
    throw error;
  }
  const read = () => page.evaluate(() => window.tools.get_design_context({}));
  const select = async id => {
    if (mobile) { await page.locator("#toggle-layers").tap(); await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("layers-open")); }
    await page.locator(`.layer-row[data-id="${id}"]`).click();
    if (mobile) { await page.locator("#toggle-inspector").tap(); await page.waitForFunction(() => document.querySelector(".workspace").classList.contains("inspector-open")); }
  };
  return { page, calls, files, records, errors, read, select, pause(method, scope = "A") {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
    pauses.set(`${scope}:${method}`, { enter, gate }); t.after(release);
    return { entered, release };
  } };
}


const log=x=>console.log(JSON.stringify(x));
for (const indexed of [false,true]) test(`undo restored content indexed=${indexed}`,async t=>{
 const f=await fixture(t,{indexed}); await f.select("heading"); const before=await f.read();
 const initial=await f.page.locator("#save-state").getAttribute("data-kind");
 await f.page.locator("#prop-text").fill("Changed heading"); await f.page.locator("#stage").click({position:{x:15,y:15}}); await f.page.keyboard.press("Meta+z");
 const after=await f.read(); assert.deepEqual(after.document,before.document);
 const state=await f.page.locator("#save-state").getAttribute("data-kind"); assert.equal(state,indexed?"dirty":"saved");
 log({case:"undo_baseline",indexed,initial,state,contentExactlyRestored:true,errors:f.errors}); assert.deepEqual(f.errors,[]);
});
for (const delayedPart of [false,true]) test(`open while editing delayedPart=${delayedPart}`,async t=>{
 const f=await fixture(t); const target="designs/other.codesign.json";
 const plan=await createDesignIndexPersistencePlan({document:normalizeDesignDocument(JSON.parse(source("Target"))),sha256:async x=>createHash("sha256").update(x).digest("hex")});
 f.files.set(`A:${target}`,plan.primarySource);for(const part of plan.parts)f.files.set(`A:${part.path}`,part.content);
 await f.page.evaluate(()=>document.querySelector("#refresh-repo-files").click());
 await f.page.waitForFunction(()=>document.querySelector("#repo-files-list").textContent.includes("other"));
 await f.page.locator("#open-files").click();
 const pause=f.pause(`workspace.readText:${delayedPart?plan.parts[0].path:target}`);
 await f.page.locator("#files-list .file-row").filter({hasText:"other"}).click(); await pause.entered;
 await f.select("heading"); await f.page.locator("#prop-text").fill("Edited while opening"); await f.page.locator("#stage").click({position:{x:15,y:15}});
 assert.match(JSON.stringify(await f.read()),/Edited while opening/); pause.release();
 await f.page.waitForFunction(()=>!document.querySelector("#save-state").textContent.includes("打开中"));
 const after=await f.read();const retained=JSON.stringify(after).includes("Edited while opening");assert.equal(retained,!delayedPart);
 log({case:"open_edit",delayedPart,retained,path:after.path,errors:f.errors});assert.deepEqual(f.errors,[]);
});
test("layout first long token and explicit line breaks",()=>{
 const make=sourceText=>[{id:"frame",type:"frame",x:0,y:0,width:50,height:300,layout:"vertical",padding:0,gap:0,alignItems:"start",justifyContent:"start"},{id:"text",type:"text",parentId:"frame",x:0,y:0,width:50,height:20,text:sourceText,textSource:sourceText,textFlow:"wrap",fontSize:16,lineHeight:1.2,layoutSizingHorizontal:"fill"}];
 for(const text of ["ABCDEFGHIJKLMNO","x ABCDEFGHIJKLMNO","one\ntwo","这是没有空格的中文长段落"]){const nodes=make(text);if(text.includes("\n"))nodes[0].width=100;applyAllAutoLayouts(nodes);log({case:"text_layout",source:text,rendered:nodes[1].text,height:nodes[1].height,width:nodes[1].width}); if(text.startsWith("x "))assert(nodes[1].text.split("\n").length>2);else if(text.includes("\n"))assert.equal(nodes[1].text,"one two");else assert.equal(nodes[1].text,text);}
});
test("frontend source text export",()=>{
 const doc=JSON.parse(source("A",true));const text=doc.pages[0].children[0].children[0];text.text="Truncated…";text.textSource="Complete original content that must remain editable";
 const html=exportDesignFrontend(doc);assert(html.includes("Truncated…"));assert(!html.includes(text.textSource)); const plain=JSON.parse(source("A"));assert(exportDesignFrontend(plain).includes("A heading"));log({case:"frontend_text",fullSourcePresent:false,displayTextPresent:true,textOverflowCss:html.includes("text-overflow")});
});

for(const indexed of [false,true])test(`failed page transaction indexed=${indexed}`,async t=>{
 const f=await fixture(t,{indexed});const before=await f.read();const meta=await f.page.evaluate(()=>window.tools.get_design_metadata());
 const result=await f.page.evaluate(async revision=>{try{return await window.tools.use_design({expected_state_revision:revision,save:false,operations:[{op:"delete_page",page_id:"page-2"},{op:"rename_page",page_id:"page-missing",name:"Missing"}]})}catch(e){return{error:e.message}}},meta.stateRevision);
 assert(result.error);const after=await f.read(); const hasPage=after.document.pages.some(p=>p.id==="page-2");assert.equal(hasPage,!indexed);
 const dirtyAfterFailure=(await f.page.evaluate(()=>window.tools.get_design_metadata())).dirty;
 const revision=(await f.page.evaluate(()=>window.tools.get_design_metadata())).stateRevision;await f.page.evaluate(rev=>window.tools.save_design({expected_state_revision:rev}),revision);
 const persisted=JSON.parse(f.files.get(`A:${path}`));const storedRetained=persisted.pages.some(p=>p.id==="page-2");assert.equal(storedRetained,!indexed);
 log({case:"failed_transaction",indexed,error:result.error,beforePages:before.document.pages.length,afterPages:after.document.pages.length,deletedPageRetained:hasPage,originalPagePayloadPresent:JSON.stringify(before).includes("Page two payload"),payloadRetained:JSON.stringify(after).includes("Page two payload"),dirtyAfterFailure,persistedPageRetainedAfterSave:storedRetained,errors:f.errors});assert.deepEqual(f.errors,[]);
});
test("frontend packaged font export",async t=>{
 const f=await fixture(t);const font=await readFile("/System/Library/Fonts/Supplemental/Arial.ttf");const doc=JSON.parse(source("A"));const resource={id:"font-review",kind:"font",mime:"font/ttf",bytes:font.length,sha256:createHash("sha256").update(font).digest("hex"),partCount:1,family:"Review Owned Font",weight:400,style:"normal"};doc.resources=[resource];const node=doc.pages[0].children[0].children[0];node.fontRef=resource.id;node.fontFamily=resource.family;node.fontWeight=400;
 const fontData="data:font/ttf;base64,"+font.toString("base64"),urls=new Map([[resource.id,fontData]]);const html=exportDesignFrontend(doc,{resourceDataUrls:urls});assert(!html.includes(fontData));const controlDoc=structuredClone(doc);controlDoc.resources[0]={...resource,bytes:4,sha256:"a".repeat(64)};const smallData="data:font/ttf;base64,QUJDRA==";const svg=exportDesignSvg(normalizeDesignDocument(controlDoc),{resourceDataUrls:new Map([[resource.id,smallData]])});assert(svg.includes(smallData));
 const output=await f.page.context().newPage();await output.setContent(html);const widths=await output.evaluate(async data=>{const measure=()=>{const ctx=document.createElement("canvas").getContext("2d");ctx.font='24px "Review Owned Font"';return ctx.measureText("mmmmmmmmiiiiiiii").width};const before=measure(),fontCountBefore=document.fonts.size;const ff=new FontFace("Review Owned Font",`url(${data})`);await ff.load();document.fonts.add(ff);return{before,after:measure(),fontCountBefore,fontCountAfter:document.fonts.size}},fontData);assert.notEqual(widths.before,widths.after);assert.equal(widths.fontCountBefore,0);
 log({case:"frontend_font",htmlEmbedsFont:false,svgControlEmbedsSmallFont:true,validLocalFontLoaded:true,...widths});assert.deepEqual(f.errors,[]);
});

test("actual inspector narrows wrapped Chinese paragraph",async t=>{
 const f=await fixture(t,{wrapped:true});await f.select("card");await f.page.locator("#prop-width").fill("50");await f.page.locator("#stage").click({position:{x:15,y:15}});
 const state=await f.read();const frame=state.document.pages[0].children[0],text=frame.children.find(n=>n.id==="heading");assert.equal(frame.width,50);assert.equal(text.text,text.textSource);assert.equal(text.height,19.2);
 log({case:"ui_chinese_wrap",frameWidth:frame.width,textWidth:text.width,rendered:text.text,height:text.height,lines:text.text.split("\n").length,errors:f.errors});assert.deepEqual(f.errors,[]);
});

test("product brief non-goals stay out of goals",async()=>{
 const {parseProductBrief,productBriefPrompt}=await import("/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/apps/design-studio/app/product-brief.mjs");
 for(const heading of ["非目标","Non-goals","Out of scope","约束"]){const brief=parseProductBrief(`# Review PRD\n## 需求\n- 支持内容编辑\n## ${heading}\n- 不支持支付`,{path:"PRD.md"});assert.equal(brief.constraints.length,heading==="约束"?1:0);if(heading==="约束")assert.equal(brief.requirements.length,1);if(heading!=="约束")assert(brief.goals.includes("不支持支付")||brief.requirements.some(r=>r.statement==="不支持支付"));const prompt=productBriefPrompt(brief,{designPath:"designs/test.codesign.json"});log({case:"prd_section",heading,goals:brief.goals,requirements:brief.requirements.map(r=>r.statement),constraints:brief.constraints,promptContainsStatement:prompt.includes("不支持支付")});}
});
