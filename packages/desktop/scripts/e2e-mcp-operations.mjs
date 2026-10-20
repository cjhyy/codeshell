/* Real MCP settings/IPC/storage and real stdio protocol probes. The only server
 * is an owned, read-only fixture; all remote origins are forbidden before Main. */
/* global window, localStorage, document */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";
import { settingsNetworkGuard } from "./settings-network-guard.mjs";
import { getElectronKeychainPreflightDiagnostic } from "./electron-keychain-preflight.mjs";

const appDirArgument = process.argv.indexOf("--app-dir");
if (appDirArgument >= 0 && !process.argv[appDirArgument + 1])
  throw new Error("Expected --app-dir <built desktop directory>");
const appDir =
  appDirArgument >= 0
    ? resolve(process.argv[appDirArgument + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-mcp-operations-");
const server = join(isolated.home, "owned-mcp-server.cjs");
const ledger = join(isolated.home, "owned-mcp-protocol.jsonl");
const settingsFile = join(isolated.codeShellHome, "settings.json");
let app, win;
let stage = "startup";
const errors = [];
const storedServers = async () => JSON.parse(await readFile(settingsFile, "utf8")).mcpServers ?? {};

async function arm({ fail = false, defer = false } = {}) {
  await app.evaluate(
    (_electron, control) => {
      globalThis.__mcpOperations.fail = control.fail;
      globalThis.__mcpOperations.defer = control.defer;
    },
    { fail, defer },
  );
}
async function waitPending() {
  await app.evaluate(async () => {
    const deadline = Date.now() + 3_000;
    while (!globalThis.__mcpOperations.release && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!globalThis.__mcpOperations.release)
      throw new Error("Deferred settings write was not reached");
  });
}
async function release() {
  await app.evaluate(() => globalThis.__mcpOperations.release?.());
}

try {
  console.log(`MCP acceptance app directory: ${appDir}`);
  await mkdir(isolated.codeShellHome, { recursive: true });
  await writeFile(settingsFile, '{"autoUpdates":false}\n');
  await writeFile(
    server,
    `const fs=require("node:fs"), readline=require("node:readline");
const record = method => fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({pid:process.pid,method})+"\\n",{mode:0o600});
record("start");
process.on("exit",()=>record("exit"));
process.on("SIGTERM",()=>process.exit(0));
readline.createInterface({input:process.stdin}).on("line",line=>{
  const message=JSON.parse(line); record(message.method || "response");
  if(message.id===undefined)return;
  let result;
  if(message.method==="initialize")result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"owned-operation-fixture",version:"1.0.0"}};
  else if(message.method==="tools/list")result={tools:[{name:"owned_read",description:"Read-only owned fixture",inputSchema:{type:"object",properties:{}}}]};
  else throw new Error("Unexpected fixture request");
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n");
});
`,
    { mode: 0o600 },
  );
  const guard = await settingsNetworkGuard(isolated.home);
  const bootstrap = join(isolated.home, "mcp-operation-bootstrap.cjs");
  await writeFile(
    bootstrap,
    `require(${JSON.stringify(guard.mainBootstrap)});
const {ipcMain}=require("electron");
const state=globalThis.__mcpOperations={attempts:0,commits:0,fail:false,defer:false,release:null};
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>handle(channel,async(...args)=>{
  const mutation=["settings:set","settings:setConfiguration"].includes(channel) && Boolean(args[2]?.mcpServers);
  if(mutation){state.attempts++;if(state.defer){state.defer=false;await new Promise(resolve=>{state.release=resolve});state.release=null;}if(state.fail){state.fail=false;throw Error("Synthetic MCP settings write failure");}}
  const result=await listener(...args);if(mutation)state.commits++;return result;
});
`,
    { mode: 0o600 },
  );
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: bootstrap,
    env: guard.env,
  });
  win = await findCodeShellWindow(app);
  win.on("pageerror", (error) => errors.push(error));
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
  await win.setViewportSize({ width: 1280, height: 900 });
  const trust = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await trust
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
  )
    await trust.click();
  stage = "settings navigation";
  await navigateSettingsMenu(win, /^(设置|Settings)$/);
  stage = "MCP settings navigation";
  await win
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "MCP servers", exact: true })
    .click();
  stage = "add owned stdio server";
  await win.getByRole("button", { name: "Add server", exact: true }).click();
  await win.getByPlaceholder("my-server", { exact: true }).fill("owned-operation-server");
  await win.getByPlaceholder("npx", { exact: true }).fill(process.execPath);
  await win.getByPlaceholder("-y @playwright/mcp@latest", { exact: true }).fill(server);
  await win.getByRole("button", { name: "Add", exact: true }).click();
  const row = win
    .getByRole("article")
    .filter({ has: win.getByText("owned-operation-server", { exact: true }) });
  await row.getByRole("button", { name: "1 tools", exact: true }).waitFor();
  assert(
    (await storedServers())["owned-operation-server"]?.command === process.execPath,
    "MCP add did not persist its command through production settings",
  );
  await row.getByRole("button", { name: "1 tools", exact: true }).click();
  await win.getByRole("dialog").getByText("owned_read", { exact: true }).waitFor();
  await win.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  console.log(
    "PASS real MCP add: production settings persist; owned stdio initialize/tools-list succeeds; tool viewer displays the actual list",
  );
  stage = "deferred MCP toggle failure";
  await arm({ fail: true, defer: true });
  const toggle = row.getByRole("switch");
  await toggle.click();
  await waitPending();
  const pendingDisabled = await toggle.isDisabled();
  await release();
  await win
    .getByText("Synthetic MCP settings write failure", { exact: false })
    .waitFor({ timeout: 3_000 });
  assert(pendingDisabled, "A pending MCP toggle remained clickable");
  assert(
    (await toggle.getAttribute("aria-checked")) === "true",
    "Rejected MCP disable changed the visible state",
  );
  assert(
    (await storedServers())["owned-operation-server"].enabled !== false,
    "Rejected MCP disable changed durable settings",
  );
  assert(errors.length === 0, "MCP mutation failure escaped as a renderer error");
  stage = "MCP responsive card actions";
  for (const width of [1280, 820, 390]) {
    await win.setViewportSize({ width, height: 844 });
    const metrics = await win.evaluate(() => ({
      viewport: window.innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    assert(metrics.content <= metrics.viewport + 1, `MCP settings overflowed at ${width}px`);
    for (const name of ["Test", "Edit", "Delete"]) {
      const action = row.getByRole("button", { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox();
      assert(
        box && box.x >= 0 && box.x + box.width <= width + 1,
        `${name} escaped the ${width}px viewport`,
      );
    }
  }
  stage = "MCP disable and enable retry";
  await toggle.click();
  await row.getByText("Disabled", { exact: true }).waitFor();
  assert(
    (await storedServers())["owned-operation-server"].enabled === false,
    "MCP disable retry did not persist",
  );
  await toggle.click();
  await row.getByRole("button", { name: "1 tools", exact: true }).waitFor();
  assert(
    (await storedServers())["owned-operation-server"].enabled === true,
    "MCP enable did not persist",
  );
  console.log(
    "PASS MCP toggle: rejected disable preserves state; retry persists disable; enable opens a new real stdio probe; actions stay reachable at 1280/820/390px",
  );

  stage = "MCP atomic rename failure and retry";
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const nameInput = win.getByPlaceholder("my-server", { exact: true });
  await nameInput.fill("owned-operation-renamed");
  await arm({ fail: true, defer: true });
  const save = win.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await waitPending();
  assert(await save.isDisabled(), "Pending MCP edit save remained clickable");
  await release();
  await win.getByText("Synthetic MCP settings write failure", { exact: false }).waitFor();
  assert(
    (await nameInput.inputValue()) === "owned-operation-renamed",
    "Rejected rename lost its draft",
  );
  assert(
    (await storedServers())["owned-operation-server"] &&
      !(await storedServers())["owned-operation-renamed"],
    "Rejected rename changed durable MCP identity",
  );
  await save.click();
  const renamed = win
    .getByRole("article")
    .filter({ has: win.getByText("owned-operation-renamed", { exact: true }) });
  await renamed.getByRole("button", { name: "1 tools", exact: true }).waitFor();
  assert(
    !(await storedServers())["owned-operation-server"] &&
      (await storedServers())["owned-operation-renamed"],
    "MCP rename did not replace its old key atomically",
  );
  console.log(
    "PASS MCP rename: pending save locks; rejected write keeps draft and old key; retry atomically replaces the name and probes the saved command",
  );

  stage = "real MCP command failure details and recovery";
  await renamed.getByRole("button", { name: "Edit", exact: true }).click();
  await win
    .getByPlaceholder("npx", { exact: true })
    .fill(join(isolated.home, "missing-owned-command"));
  await win.getByRole("button", { name: "Save", exact: true }).click();
  await renamed.getByRole("button", { name: "View details", exact: true }).waitFor();
  await renamed.getByRole("button", { name: "View details", exact: true }).click();
  await win
    .getByRole("dialog")
    .getByText(/ENOENT/)
    .waitFor();
  await win.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await renamed.getByRole("button", { name: "Edit", exact: true }).click();
  await win.getByPlaceholder("npx", { exact: true }).fill(process.execPath);
  await win.getByRole("button", { name: "Save", exact: true }).click();
  await renamed.getByRole("button", { name: "1 tools", exact: true }).waitFor();
  console.log(
    "PASS MCP probe failure: actual missing executable produces error details; correcting the command recovers real initialize/tools-list",
  );

  stage = "MCP deletion cancellation";
  const beforeCancel = await app.evaluate(() => globalThis.__mcpOperations.attempts);
  await renamed.getByRole("button", { name: "Delete", exact: true }).click();
  await win.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await win.getByRole("dialog").waitFor({ state: "hidden" });
  assert(
    (await app.evaluate(() => globalThis.__mcpOperations.attempts)) === beforeCancel,
    "Cancelled MCP deletion wrote settings",
  );
  stage = "MCP deletion pending failure";
  await arm({ fail: true, defer: true });
  await renamed.getByRole("button", { name: "Delete", exact: true }).click();
  await win.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await waitPending();
  assert(
    await renamed.getByRole("button", { name: "Delete", exact: true }).isDisabled(),
    "Pending MCP deletion remained clickable",
  );
  await release();
  await win
    .getByRole("alert")
    .getByText(/Synthetic MCP settings write failure/)
    .waitFor();
  assert(
    (await renamed.isVisible()) && (await storedServers())["owned-operation-renamed"],
    "Rejected MCP deletion removed its card or settings",
  );
  stage = "MCP deletion retry storage";
  await renamed.getByRole("button", { name: "Delete", exact: true }).click();
  await win.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await renamed.waitFor({ state: "hidden" });
  assert(
    Object.keys(await storedServers()).length === 0,
    "MCP deletion retry left a durable server",
  );
  const receipt = await app.evaluate(() => ({
    attempts: globalThis.__mcpOperations.attempts,
    commits: globalThis.__mcpOperations.commits,
    network: globalThis.__staticSettingsNetworkAttempts,
  }));
  stage = "MCP mutation receipt";
  assert(
    receipt.attempts === 10 &&
      receipt.commits === 7 &&
      receipt.network === 0 &&
      errors.length === 0,
    "MCP mutation/network/error receipt changed",
  );
  stage = "MCP application close";
  await app.close();
  stage = "MCP restart";
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainBootstrap: bootstrap,
    env: guard.env,
  });
  win = await findCodeShellWindow(app);
  stage = "MCP restart storage";
  assert(Object.keys(await storedServers()).length === 0, "Restart restored a deleted MCP server");
  stage = "MCP protocol completion receipt";
  const protocol = (await readFile(ledger, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    protocol.some((item) => item.method === "initialize") &&
      protocol.some((item) => item.method === "tools/list") &&
      !protocol.some((item) => item.method === "tools/call"),
    "MCP fixture did not complete protocol probes or executed a tool",
  );
  const probePids = [...new Set(protocol.map((item) => item.pid))];
  stage = "MCP owned-process exit";
  assert(
    probePids.every((pid) => protocol.some((item) => item.pid === pid && item.method === "exit")),
    "An owned MCP probe process did not report its actual exit",
  );
  for (const pid of probePids) {
    const alive = (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    })();
    assert(!alive, "An owned MCP probe process remained alive after closing Electron");
  }
  console.log(
    `MCP operation receipt: ${JSON.stringify({ ...receipt, protocolMethods: protocol.map((item) => item.method), probeProcesses: new Set(protocol.map((item) => item.pid)).size, restartEmpty: true })}`,
  );
  console.log("CodeShell MCP operations E2E: passed");
} catch (error) {
  const keychainPreflight = getElectronKeychainPreflightDiagnostic(error);
  if (keychainPreflight) console.error(JSON.stringify({ keychainPreflight }));
  console.error(
    `MCP operations failed during ${stage}: ${error?.name ?? "Error"}; renderer errors: ${errors.length}`,
  );
  const fixedLabels = new Set([
    "Cancelled MCP deletion wrote settings",
    "Pending MCP deletion remained clickable",
    "Rejected MCP deletion removed its card or settings",
    "MCP deletion retry left a durable server",
    "MCP mutation/network/error receipt changed",
    "Restart restored a deleted MCP server",
    "MCP fixture did not complete protocol probes or executed a tool",
    "An owned MCP probe process did not report its actual exit",
    "An owned MCP probe process remained alive after closing Electron",
    "Deferred settings write was not reached",
  ]);
  console.error(
    `Failure check: ${fixedLabels.has(error?.message) ? error.message : "unclassified"}`,
  );
  console.error(
    `Script locations: ${JSON.stringify(
      String(error?.stack ?? "")
        .match(/e2e-mcp-operations\.mjs:\d+:\d+/g)
        ?.slice(0, 3) ?? [],
    )}`,
  );
  if (app)
    console.error(
      await app
        .evaluate(() => ({
          fixtureState: {
            attempts: globalThis.__mcpOperations?.attempts,
            commits: globalThis.__mcpOperations?.commits,
            defer: globalThis.__mcpOperations?.defer,
            fail: globalThis.__mcpOperations?.fail,
            releasePending: Boolean(globalThis.__mcpOperations?.release),
            network: globalThis.__staticSettingsNetworkAttempts,
          },
        }))
        .catch(() => ({ fixtureState: "main-unavailable" })),
    );
  await win
    ?.screenshot({ path: "/private/tmp/codeshell-mcp-operations-failure.png" })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await release().catch(() => {});
  if (app) await app.close().catch(() => {});
  await isolated.cleanup();
}
