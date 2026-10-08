/* Production Electron + worker + HTTP adapter acceptance in an isolated home.
 * The only upstream is this local deterministic server; no real model/account
 * or user Skill is used. Native dialogs are controlled by the test harness.
 */
/* global document, localStorage, structuredClone, window */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-optimization-lab-");
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "project");
const projectId = "lab-fixture-project";
const target = { projectId };
const model = "lab-fixture";
const skillName = "lab-citations";
const source =
  "---\nname: lab-citations\ndescription: Summarize provided sources.\n---\nReturn a concise answer.\n";
const candidateBody = "Return a concise answer. Cite each source using [S1].\n";
const requests = [];
const rendererErrors = [];
const upstreamErrors = [];
let app;
let win;
let stage = "initialize";
let blockRequests = false;
let releaseRequest;
const gradingFile = join(isolated.home, "grading.json");
const datasetFile = join(isolated.home, "dataset.json");
const exportedDataset = join(isolated.home, "dataset-export.json");

const dataset = {
  schemaVersion: 1,
  title: "Citation experiment (synthetic local fixture)",
  taskFamily: "report-sourcing",
  cases: [1, 2, 3, 4, 5, 6].map((index) => ({
    id: `${index <= 3 ? "dev" : "holdout"}-${index}`,
    version: 1,
    sourceGroupId: `independent-source-${index}`,
    provenance: "synthetic",
    caseRole: index === 1 ? "regression" : "target_failure",
    split: index <= 3 ? "dev" : "holdout",
    input: `Summarize source [S1]: fixture document ${index} contains value ${index * 17}.`,
    expected: `EVALUATOR_ONLY_EXPECTED_${index}`,
    rubric: [],
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
  })),
};

const upstream = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.model, model);
    assert.notEqual(body.stream, true);
    assert.ok(Number.isInteger(body.max_tokens ?? body.max_completion_tokens));
    assert.ok(!body.tools?.length);
    const messages = JSON.stringify(body.messages);
    const optimizing = messages.includes("Optimization Lab reflect_once_v1");
    requests.push({ body, optimizing });
    if (blockRequests) await new Promise((done) => (releaseRequest = done));
    const content = optimizing
      ? JSON.stringify({
          candidates: [
            {
              body: candidateBody,
              explanation: "Make source citations explicit.",
              sourceCaseIds: ["dev-1", "dev-2", "dev-3"],
            },
          ],
        })
      : messages.includes("Cite each source")
        ? "Summary with [S1]."
        : "Summary without citation.";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `fixture-${requests.length}`,
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }),
    );
  } catch (error) {
    upstreamErrors.push(String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;

async function json(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function seed() {
  await mkdir(join(project, ".agents", "skills", skillName), { recursive: true });
  await writeFile(join(project, ".agents", "skills", skillName, "SKILL.md"), source);
  const now = Date.now();
  await json(join(isolated.codeShellHome, "desktop", "projects.json"), {
    version: 2,
    projects: [
      {
        id: projectId,
        name: "Lab fixture",
        primaryRootId: "lab-root",
        revision: 1,
        roots: [
          {
            id: "lab-root",
            path: project,
            canonicalIdentity: project,
            name: "project",
            addedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
      },
    ],
  });
  await json(join(isolated.codeShellHome, "desktop", "trust.json"), { [project]: "trusted" });
  await json(join(isolated.codeShellHome, "model-catalog.user.json"), [
    {
      id: "lab-local",
      tag: "text",
      adapterKind: "openai",
      protocol: "openai-compat",
      displayName: "Local fixture",
      description: "No external service",
      defaultBaseUrl: endpoint,
      defaultModel: model,
      needsKey: true,
      modelPresets: [{ value: model, maxOutputTokens: 4096 }],
    },
  ]);
  await json(join(isolated.codeShellHome, "settings.json"), {
    autoUpdates: false,
    featureFlags: { optimization_lab: true },
    credentials: [{ id: "lab-key", catalogId: "lab-local", apiKey: "LOCAL_FIXTURE_SECRET" }],
    modelConnections: [
      { id: "lab-connection", catalogId: "lab-local", tag: "text", model, credentialId: "lab-key" },
    ],
    defaults: { text: "lab-connection" },
  });
}
async function launch() {
  app = await launchCodeShellElectron({ appDir, ...isolated });
  win = await findCodeShellWindow(app);
  rendererErrors.push(captureRendererErrors(win));
  await win.waitForFunction(() => !!window.codeshell?.optimizationLab);
  await win.evaluate((id) => {
    localStorage.setItem("codeshell.activeRepoId", id);
    localStorage.setItem("codeshell.uiLanguage", "en");
  }, projectId);
  await win.reload();
  await win.getByRole("button", { name: /^(Optimization Lab|优化实验室)$/ }).waitFor();
  await installDialogs();
}
async function installDialogs() {
  await app.evaluate(({ dialog }) => {
    globalThis.__labDialogs = {
      accept: false,
      confirmations: [],
      savePath: undefined,
      openPath: undefined,
    };
    dialog.showSaveDialog = async () => ({
      canceled: !globalThis.__labDialogs.savePath,
      filePath: globalThis.__labDialogs.savePath,
    });
    dialog.showOpenDialog = async () => ({
      canceled: !globalThis.__labDialogs.openPath,
      filePaths: globalThis.__labDialogs.openPath ? [globalThis.__labDialogs.openPath] : [],
    });
    dialog.showMessageBox = async (_parent, options) => {
      const value = options ?? _parent;
      globalThis.__labDialogs.confirmations.push(value);
      return { response: globalThis.__labDialogs.accept ? 1 : 0, checkboxChecked: false };
    };
  });
}
async function query(type, params = {}) {
  return win.evaluate(
    ({ type, params, target }) =>
      window.codeshell.optimizationLab.query(type, { target, ...params }),
    { type, params, target },
  );
}
async function until(read, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(message);
}
async function openPage() {
  await win.getByRole("button", { name: /^(Optimization Lab|优化实验室)$/ }).click();
  await win.getByTestId("optimization-lab-page").waitFor();
}

async function crashOwnedWorker() {
  // Inspect only this Electron instance's direct ChildProcess handles. This
  // test harness never guesses a global PID or signals another app's worker.
  return app.evaluate(() => {
    const workers = process
      ._getActiveHandles()
      .filter((handle) =>
        handle.spawnargs?.some((argument) => argument.includes("agent-server-stdio")),
      );
    if (workers.length !== 1) throw new Error(`Expected one owned worker, found ${workers.length}`);
    const worker = workers[0];
    if (!worker.kill("SIGKILL")) throw new Error("Could not crash the owned worker");
    return worker.pid;
  });
}

async function crashOwnedElectron() {
  const child = app.process();
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned Electron did not exit")), 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (!child.kill("SIGKILL")) {
      clearTimeout(timer);
      reject(new Error("Could not crash the owned Electron process"));
    }
  });
  app = null;
  win = null;
}

async function recoverWithoutReplay(id, requestCount, interruptedPayload) {
  const interrupted = await until(
    async () => {
      const value = await query("get", { id });
      return value.state.status === "interrupted" ? value : null;
    },
    "Lost worker ownership did not recover to interrupted",
    30000,
  );
  assert.equal(requests.length, requestCount, "Worker recovery never automatically sends HTTP");
  assert.ok(interrupted.ledger.totals.unknownTokens > 0);
  assert.equal(interrupted.ledger.totals.requests, 1);
  await openPage();
  await win.getByTestId("optimization-lab-saved").selectOption(id);
  await win.getByTestId("optimization-lab-continue").waitFor();
  await until(
    async () => win.getByTestId("optimization-lab-continue").isEnabled(),
    "Interrupted experiment did not offer explicit continue",
  );
  assert.equal(requests.length, requestCount, "Opening interrupted experiment does not resume it");
  await win.getByTestId("optimization-lab-continue").click();
  const recovered = await until(async () => {
    const value = await query("get", { id });
    return value.state.status === "failed" ? value : null;
  }, "Incomplete baseline evidence should produce a failed report after explicit continuation");
  assert.equal(requests.length, requestCount + 2, "Only the two untouched baseline cases run");
  assert.ok(recovered.ledger.totals.unknownTokens > 0);
  assert.ok(recovered.state.data.reportRef, "Unknown evidence has a durable report");
  for (const request of requests.slice(requestCount))
    assert.notEqual(
      JSON.stringify(request.body.messages),
      interruptedPayload,
      "The uncertain model request is never replayed, even after explicit continue",
    );
}

async function preparePage(cases) {
  await win.getByTestId("optimization-lab-saved").selectOption("");
  if (cases) {
    await win.getByTestId("optimization-lab-dataset-json").click();
    await win.getByTestId("optimization-lab-dataset").fill(JSON.stringify(cases));
  }
  await win.getByTestId("optimization-lab-skill").selectOption(skillName);
  await win.getByTestId("optimization-lab-target-connection").selectOption("lab-connection");
  await win.getByTestId("optimization-lab-optimizer-connection").selectOption("lab-connection");
  await win.getByTestId("optimization-lab-maxRequests").fill("40");
  await win.getByTestId("optimization-lab-maxExecutionMs").fill("300000");
  await win.getByTestId("optimization-lab-maxOutputTokens").fill("2048");
  await win.getByTestId("optimization-lab-timeoutMs").fill("10000");
  await win.getByTestId("optimization-lab-prepare").click();
  await win.getByTestId("optimization-lab-state").waitFor();
  await win.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="optimization-lab-state"]')
        ?.getAttribute("data-status") === "ready",
  );
  const id = await until(
    () => win.getByTestId("optimization-lab-saved").inputValue(),
    "Prepared experiment was not selected after saved experiments refreshed",
  );
  assert.ok(id, "Prepared experiment is selected by its durable ID");
  return query("get", { id });
}
async function editDatasetOffline() {
  await json(datasetFile, dataset);
  await app.evaluate(
    (_electron, paths) => {
      globalThis.__labDialogs.openPath = paths.source;
      globalThis.__labDialogs.savePath = paths.destination;
    },
    { source: datasetFile, destination: exportedDataset },
  );
  await win.getByTestId("optimization-lab-import-dataset").click();
  await until(
    async () =>
      (await win.getByTestId("optimization-lab-dataset-title").inputValue()) === dataset.title,
    "Native dataset import did not populate the form",
  );
  const edited = structuredClone(dataset);
  edited.title = "Form-reviewed citation experiment";
  edited.taskFamily = "form-reviewed-sourcing";
  edited.cases[0].input += " Reviewed through the form.";
  edited.cases[0].expected = "EVALUATOR_ONLY_EXPECTED_FORM_REVIEW";
  await win.getByTestId("optimization-lab-dataset-title").fill(edited.title);
  await win.getByTestId("optimization-lab-dataset-task-family").fill(edited.taskFamily);
  await win.getByTestId("optimization-lab-case-0-input").fill(edited.cases[0].input);
  await win.getByTestId("optimization-lab-case-0-expected").fill(edited.cases[0].expected);
  await win.getByTestId("optimization-lab-case-0-duplicate").click();
  await win.getByTestId("optimization-lab-case-6-id").waitFor();
  assert.notEqual(
    await win.getByTestId("optimization-lab-case-6-id").inputValue(),
    edited.cases[0].id,
  );
  assert.equal(
    await win.getByTestId("optimization-lab-case-6-sourceGroupId").inputValue(),
    edited.cases[0].sourceGroupId,
  );
  await win.getByTestId("optimization-lab-validate").click();
  await until(
    async () =>
      (await win.getByTestId("optimization-lab-validation").innerText()).includes(
        "duplicate_input",
      ),
    "Copied input was not rejected by authoritative validation",
  );
  await win.getByTestId("optimization-lab-case-6-remove").click();
  assert.equal(
    await win.getByTestId("optimization-lab-validation").count(),
    0,
    "Editing invalidates validation",
  );
  await win.getByTestId("optimization-lab-case-add").click();
  await win.getByTestId("optimization-lab-case-6-fixtureRefs-add").click();
  await win.getByTestId("optimization-lab-case-6-fixtureRefs-0").fill("reference line 1\nline 2");
  await win.getByTestId("optimization-lab-case-6-missingEvidence-add").click();
  await win.getByTestId("optimization-lab-case-6-missingEvidence-0").fill("missing line 1\nline 2");
  await win.getByTestId("optimization-lab-case-6-assertion-add").click();
  await win
    .getByTestId("optimization-lab-case-6-assertion-0-kind")
    .selectOption("json_field_equals");
  await win.getByTestId("optimization-lab-case-6-assertion-0-path-0").fill("nested\nfield");
  await win.getByTestId("optimization-lab-case-6-assertion-0-value-type").selectOption("number");
  await win.getByTestId("optimization-lab-case-6-assertion-0-value").fill("1.25");
  await win.getByTestId("optimization-lab-export-dataset").click();
  await until(async () => {
    try {
      return JSON.parse(await readFile(exportedDataset, "utf8")).cases.length === 7;
    } catch {
      return false;
    }
  }, "Advanced form fields were not exported");
  const advanced = JSON.parse(await readFile(exportedDataset, "utf8")).cases[6];
  assert.deepEqual(advanced.fixtureRefs, ["reference line 1\nline 2"]);
  assert.deepEqual(advanced.missingEvidence, ["missing line 1\nline 2"]);
  assert.deepEqual(advanced.hardAssertions[0].path, ["nested\nfield"]);
  assert.equal(advanced.hardAssertions[0].value, 1.25, "Numeric JSON assertion stays numeric");
  await win.getByTestId("optimization-lab-case-6-remove").click();
  await win.getByTestId("optimization-lab-export-dataset").click();
  await until(async () => {
    try {
      const exported = JSON.parse(await readFile(exportedDataset, "utf8"));
      return exported.title === edited.title && exported.cases.length === 6;
    } catch {
      return false;
    }
  }, "Native dataset export did not write reviewed material");
  assert.deepEqual(
    JSON.parse(await readFile(exportedDataset, "utf8")),
    edited,
    "Form and native export preserve all other fields",
  );
  await win.getByRole("button", { name: /^(Task center|任务中心)$/ }).click();
  await openPage();
  assert.equal(
    await win.getByTestId("optimization-lab-dataset-title").inputValue(),
    edited.title,
    "Same-window draft survives leaving the page",
  );
  await win.getByTestId("optimization-lab-dataset-json").click();
  await win.getByTestId("optimization-lab-dataset").fill("{invalid JSON");
  await win.getByTestId("optimization-lab-dataset-form").click();
  assert.equal(
    await win.getByTestId("optimization-lab-dataset").inputValue(),
    "{invalid JSON",
    "Invalid JSON is preserved for repair",
  );
  await win.getByTestId("optimization-lab-dataset").fill(JSON.stringify(edited));
  await win.getByTestId("optimization-lab-dataset-form").click();
  await win.getByTestId("optimization-lab-validate").click();
  await until(
    async () =>
      (await win.getByTestId("optimization-lab-validation").innerText()).includes('"frozen"'),
    "Edited form did not freeze through the real worker",
  );
  const frozen = JSON.parse(await win.getByTestId("optimization-lab-validation").innerText());
  assert.equal(frozen.frozen.manifest.title, edited.title);
  assert.equal(requests.length, 0, "Editing, files, validation and freeze send no HTTP");
  const screenshotDir = process.env.CODESHELL_LAB_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await win.getByTestId("optimization-lab-page").evaluate((element) => {
      element.scrollTop = 0;
    });
    await win.screenshot({ path: join(screenshotDir, "optimization-lab-editor.png") });
  }
  return edited;
}
async function authorizePage() {
  await win.getByTestId("optimization-lab-authorize").click();
  await until(
    async () => await win.getByTestId("optimization-lab-authorize").isEnabled(),
    "Native authorization did not settle",
  );
}
async function completed(id) {
  return until(async () => {
    const value = await query("get", { id });
    if (["failed", "budget_exhausted", "cancelled"].includes(value.state.status))
      throw new Error(`Unexpected experiment terminal: ${JSON.stringify(value.state)}`);
    return value.state.status === "report_ready" ? value : null;
  }, "The real worker did not produce a final report");
}
async function gradePage(id, phase) {
  const snapshot = await until(async () => {
    const value = await query("get", { id });
    if (["failed", "budget_exhausted", "cancelled"].includes(value.state.status))
      throw new Error(`Unexpected grading terminal: ${JSON.stringify(value.state)}`);
    return value.state.status === phase ? value : null;
  }, `Worker did not reach ${phase}`);
  await win.waitForFunction(
    (phase) =>
      document
        .querySelector('[data-testid="optimization-lab-state"]')
        ?.getAttribute("data-status") === phase,
    phase,
  );
  const before = requests.length;
  await app.evaluate((_electron, file) => {
    globalThis.__labDialogs.savePath = file;
    globalThis.__labDialogs.openPath = file;
  }, gradingFile);
  await win.getByTestId("optimization-lab-export-grading").click();
  const template = await until(async () => {
    try {
      const value = JSON.parse(await readFile(gradingFile, "utf8"));
      return value.phase ===
        (phase === "awaiting_baseline_grading"
          ? "baseline"
          : phase === "awaiting_screening_grading"
            ? "screening"
            : "holdout")
        ? value
        : null;
    } catch {
      return null;
    }
  }, "Native grading export did not create the current template");
  assert.ok(template.items.length >= 3);
  template.reviewer = "Local synthetic fixture reviewer";
  for (const item of template.items)
    for (const grade of item.grades) {
      grade.verdict = "passed";
      grade.evidence = "Reviewed local synthetic output against the frozen rubric.";
    }
  await json(gradingFile, template);
  await win.getByTestId("optimization-lab-import-grading").click();
  await until(
    async () => (await query("get", { id })).state.revision > snapshot.state.revision,
    "Native grading import did not advance revision",
  );
  assert.equal(
    requests.length,
    before,
    "Export/import grading never sends HTTP or automatically continues",
  );
}

try {
  await seed();
  await launch();
  await openPage();
  stage = "visual dataset editor and native JSON files";
  await editDatasetOffline();
  stage = "prepare through actual page and real worker";
  const prepared = await preparePage();
  const id = prepared.id;
  assert.equal(requests.length, 0, "Prepare has no HTTP side effects");
  assert.equal(prepared.datasetSummary.dev, 3);
  assert.equal(prepared.datasetSummary.holdout, 3);
  stage = "cancel native confirmation through page";
  await authorizePage();
  assert.equal((await query("get", { id })).grant, null);
  assert.equal(requests.length, 0, "Cancelled native confirmation sends no request");
  stage = "native authorize and explicit page start";
  await app.evaluate(() => {
    globalThis.__labDialogs.accept = true;
  });
  await authorizePage();
  assert.equal(requests.length, 0, "Grant alone does not start the experiment");
  const authorized = await query("get", { id });
  assert.equal(authorized.state.status, "authorized");
  assert.equal(typeof authorized.grant.expiresAt, "string");
  blockRequests = true;
  await win.getByTestId("optimization-lab-start").click();
  await until(async () => requests.length === 1, "First model request did not start");
  await win.getByRole("button", { name: /^(Task center|任务中心)$/ }).click();
  await win.getByTestId("optimization-lab-page").waitFor({ state: "detached" });
  assert.equal(await win.getByTestId("optimization-lab-page").count(), 0);
  blockRequests = false;
  releaseRequest?.();
  releaseRequest = undefined;
  const final = await completed(id);
  assert.equal(requests.length, 13, "3 baseline + 1 proposal + 3 screening + 6 holdout requests");
  for (const { body, optimizing } of requests) {
    const payload = JSON.stringify(body.messages);
    assert.ok(
      !payload.includes("EVALUATOR_ONLY_EXPECTED"),
      "Expected answers never enter model input",
    );
    assert.ok(!payload.includes("LOCAL_FIXTURE_SECRET"), "Credentials never enter prompts");
    if (optimizing)
      assert.ok(!/fixture document [456]/.test(payload), "Optimizer never sees holdout input");
  }
  const report = await query("report", { id });
  assert.ok(
    !JSON.stringify(report).includes("LOCAL_FIXTURE_SECRET"),
    "Reports never contain credentials",
  );
  assert.equal(
    await readFile(join(project, ".agents", "skills", skillName, "SKILL.md"), "utf8"),
    source,
    "Experiment never changes the active Skill",
  );
  stage = "durable reopen and report page";
  await app.close();
  app = null;
  await launch();
  const reopened = await query("get", { id });
  assert.equal(reopened.state.status, "report_ready");
  assert.equal(requests.length, 13, "Reopening a report does not replay model requests");
  assert.equal(reopened.plan.planHash, final.plan.planHash);
  await openPage();
  await win.getByTestId("optimization-lab-saved").selectOption(id);
  await win.getByTestId("optimization-lab-open-report").click();
  await win.getByTestId("optimization-lab-report").waitFor();
  assert.ok((await win.getByTestId("optimization-lab-report").innerText()).length > 100);
  const screenshotDir = process.env.CODESHELL_LAB_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await win.getByTestId("optimization-lab-page").evaluate((element) => {
      element.scrollTop = 0;
    });
    await win.screenshot({ path: join(screenshotDir, "optimization-lab.png") });
  }
  stage = "human grading checkpoints through native files";
  const semantic = structuredClone(dataset);
  semantic.title = "Human grading synthetic fixture";
  for (const item of semantic.cases)
    item.rubric = [
      {
        id: "faithful",
        text: "The answer faithfully summarizes the current provided source.",
        requiresHumanGrading: true,
      },
    ];
  const human = await preparePage(semantic);
  await app.evaluate(() => {
    globalThis.__labDialogs.accept = true;
  });
  await authorizePage();
  await win.getByTestId("optimization-lab-start").click();
  await gradePage(human.id, "awaiting_baseline_grading");
  await win.getByTestId("optimization-lab-continue").click();
  await gradePage(human.id, "awaiting_screening_grading");
  await win.getByTestId("optimization-lab-continue").click();
  await completed(human.id);
  await gradePage(human.id, "report_ready");
  assert.equal(requests.length, 26, "Human grading adds no requests beyond the 13 model calls");
  stage = "native revoke before start and stop in flight";
  const stoppable = await preparePage(dataset);
  await authorizePage();
  await win.getByTestId("optimization-lab-revoke").click();
  await until(
    async () => (await query("get", { id: stoppable.id })).grant.revokedAt,
    "Revoke did not persist",
  );
  assert.equal(requests.length, 26, "Revoking an idle authorization makes no HTTP request");
  await authorizePage();
  blockRequests = true;
  await win.getByTestId("optimization-lab-start").click();
  await until(
    async () => requests.length === 27,
    "Stoppable experiment did not enter its first HTTP request",
  );
  await win.getByTestId("optimization-lab-stop").click();
  const stopped = await until(async () => {
    const value = await query("get", { id: stoppable.id });
    return value.state.status === "cancelled" ? value : null;
  }, "Stop did not cancel the in-flight worker experiment");
  blockRequests = false;
  releaseRequest?.();
  releaseRequest = undefined;
  assert.equal(requests.length, 27, "Stopped experiment admits no further HTTP");
  assert.ok(
    stopped.ledger.totals.unknownTokens > 0,
    "Interrupted HTTP remains conservatively unknown",
  );
  stage = "worker crash, conservative recovery and explicit continue without replay";
  const crashedWorker = await preparePage(dataset);
  await authorizePage();
  blockRequests = true;
  await win.getByTestId("optimization-lab-start").click();
  await until(async () => requests.length === 28, "Worker-crash request did not begin");
  const workerPayload = JSON.stringify(requests.at(-1).body.messages);
  const workerPid = await crashOwnedWorker();
  await until(
    async () =>
      app.evaluate(
        (_electron, pid) => !process._getActiveHandles().some((handle) => handle.pid === pid),
        workerPid,
      ),
    "Owned crashed worker did not exit",
    5000,
  );
  blockRequests = false;
  releaseRequest?.();
  releaseRequest = undefined;
  await recoverWithoutReplay(crashedWorker.id, 28, workerPayload);
  stage = "Electron crash closes worker stdin and restart never replays uncertain HTTP";
  const crashedApp = await preparePage(dataset);
  await authorizePage();
  blockRequests = true;
  await win.getByTestId("optimization-lab-start").click();
  await until(async () => requests.length === 31, "Electron-crash request did not begin");
  const appPayload = JSON.stringify(requests.at(-1).body.messages);
  const orphanPid = await app.evaluate(
    () =>
      process
        ._getActiveHandles()
        .find((handle) =>
          handle.spawnargs?.some((argument) => argument.includes("agent-server-stdio")),
        )?.pid,
  );
  assert.ok(Number.isInteger(orphanPid), "Observe only this app's known direct worker");
  await crashOwnedElectron();
  await until(
    async () => {
      try {
        process.kill(orphanPid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    },
    "The orphaned worker must exit promptly when its controlling stdin closes",
    5000,
  );
  blockRequests = false;
  releaseRequest?.();
  releaseRequest = undefined;
  await launch();
  assert.equal(requests.length, 31, "App restart never starts a saved experiment");
  await recoverWithoutReplay(crashedApp.id, 31, appPayload);
  assert.equal(
    await readFile(join(project, ".agents", "skills", skillName, "SKILL.md"), "utf8"),
    source,
  );
  assert.equal(rendererErrors.flat().length, 0);
  assert.deepEqual(upstreamErrors, []);
  console.log(
    "PASS Optimization Lab: actual UI + worker, native authorization, page-close keepalive, 13-call paired experiment, durable report reopen, native grading files, revoke, in-flight stop, worker/app crash recovery without automatic spending or uncertain replay",
  );
} catch (error) {
  console.error(`Optimization Lab E2E failed at ${stage}:`, error);
  if (upstreamErrors.length) console.error("Local fixture upstream failures:", upstreamErrors);
  if (win && !win.isClosed())
    console.error(
      (
        await win
          .locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "Renderer unavailable")
      ).slice(-5000),
    );
  throw error;
} finally {
  blockRequests = false;
  releaseRequest?.();
  await app?.close().catch(() => undefined);
  upstream.closeAllConnections();
  await new Promise((done) => upstream.close(done));
  await isolated.cleanup();
}
