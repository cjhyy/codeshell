import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DesktopEvalFailure,
  executeDesktopScenario,
  normalizeVisibleText,
  scenarioFor,
} from "./scenarios.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireDesktop = createRequire(join(repo, "packages/desktop/package.json"));
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function isolatedEnvironment(source, home) {
  const safe = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/(TOKEN|SECRET|PASSWORD|API_KEY|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|BASH_ENV|ZDOTDIR|DYLD_|LD_PRELOAD)/iu.test(
          key,
        ),
    ),
  );
  return {
    ...safe,
    HOME: home,
    USERPROFILE: home,
    CODE_SHELL_HOME: join(home, ".code-shell"),
    CODE_SHELL_NO_DEVTOOLS: "1",
    CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
    CODE_SHELL_DEV: "0",
    CODE_SHELL_VERBOSE_LOG: "0",
  };
}

export async function workspaceManifest(folder) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const item = join(path, name),
        relative = prefix + name,
        stat = await lstat(item);
      if (stat.isSymbolicLink()) files[relative] = "symlink";
      else if (stat.isDirectory()) await walk(item, `${relative}/`);
      else files[relative] = hash(await readFile(item));
    }
  }
  await walk(folder);
  return files;
}

export function modelSettings(model, proxy) {
  return {
    catalog: [
      {
        id: "eval-real-proxy",
        tag: "text",
        adapterKind: model.adapterKind,
        protocol: "openai-compat",
        displayName: "真实模型评测",
        description: "Isolated transparent proxy to the selected real model",
        defaultBaseUrl: proxy.baseUrl,
        defaultModel: model.model,
        needsKey: true,
        modelPresets: [
          {
            ...model.preset,
            value: model.model,
            label: "真实模型评测",
            params: model.preset?.params ?? model.params,
            maxContextTokens: model.maxContextTokens ?? model.preset?.maxContextTokens ?? 200000,
            maxOutputTokens: model.maxOutputTokens ?? 4096,
          },
        ],
      },
    ],
    settings: {
      autoUpdates: false,
      memories: { autoExtract: false },
      permissions: {
        defaultMode: "default",
        rules: [
          { tool: "Write", decision: "ask" },
          { tool: "Edit", decision: "ask" },
          { tool: "Bash", decision: "ask" },
        ],
      },
      credentials: [
        {
          id: "eval-proxy-key",
          catalogId: "eval-real-proxy",
          apiKey: proxy.apiKey,
          baseUrl: proxy.baseUrl,
        },
      ],
      modelConnections: [
        {
          id: "eval-model",
          catalogId: "eval-real-proxy",
          tag: "text",
          model: model.model,
          credentialId: "eval-proxy-key",
          paramValues: { ...model.paramValues },
        },
      ],
      defaults: { text: "eval-model" },
    },
  };
}

async function configure(home, model, proxy) {
  const base = join(home, ".code-shell");
  await mkdir(join(base, "plugins"), { recursive: true });
  // These isolated stamps prevent first-run marketplace downloads, not model/tool substitution.
  await writeFile(
    join(base, "plugins/known_marketplaces.json"),
    JSON.stringify({
      official: {
        source: { source: "github", repo: "obra/superpowers-marketplace" },
        installLocation: join(base, "plugins/marketplaces/official"),
        format: "claude-code",
      },
      "mimi-plugins": {
        source: { source: "github", repo: "cjhyy/mimi-plugins" },
        installLocation: join(base, "plugins/marketplaces/mimi-plugins"),
        format: "claude-code",
      },
    }),
  );
  await writeFile(
    join(base, "plugins/core_plugins_installed.json"),
    JSON.stringify({
      "skill-creator@mimi-plugins": "eval-skip-bootstrap",
      "model-fact-finder@mimi-plugins": "eval-skip-bootstrap",
    }),
  );
  const config = modelSettings(model, proxy);
  await writeFile(join(base, "model-catalog.user.json"), JSON.stringify(config.catalog));
  await writeFile(join(base, "settings.json"), JSON.stringify(config.settings), { mode: 0o600 });
}

/** Real packaged UI adapter. The proxy owns credentials and real upstream calls. */
export async function runDesktopCase({
  caseId,
  trial = 1,
  seed = "0",
  executable,
  output,
  model,
  proxy,
  timeoutMs = 180000,
}) {
  if (!executable || !output || !proxy?.baseUrl || !Array.isArray(proxy.requests))
    throw new Error("Missing desktop eval configuration");
  if (
    ![
      "openai",
      "openrouter",
      "deepseek",
      "groq",
      "xai",
      "zhipu",
      "moonshot",
      "minimax",
      "qwen",
      "custom",
    ].includes(model?.adapterKind)
  )
    throw new Error("Unsupported native adapterKind");
  const scenario = scenarioFor(caseId, seed, trial);
  const out = resolve(output);
  await mkdir(out, { recursive: true });
  const home = await realpath(await mkdtemp(join(tmpdir(), "codeshell-live-eval-")));
  if (home === repo || home.startsWith(repo + "/")) {
    await rm(home, { recursive: true, force: true });
    throw new Error("Temporary profile must be outside the repository");
  }
  const codeShellHome = join(home, ".code-shell");
  const userData = join(home, "electron-user-data");
  const workspace = join(home, "eval-workspace");
  const requestOffset = proxy.requests.length;
  const report = {
    schemaVersion: 1,
    caseId,
    caseVersion: scenario.version,
    trial,
    seed,
    startedAt: new Date().toISOString(),
    executionStatus: "inconclusive",
    hardAssertions: scenario.hardAssertions.map(({ id }) => ({ id, passed: null })),
    semantic: { status: "not_evaluated" },
    evidenceLevel: "packaged_live_llm",
    fixtureSeed: seed,
    effectiveInput: scenario.input,
    inputSha256: hash(JSON.stringify(scenario.input)),
    assertions: [],
    answers: [],
    facts: {},
    streamEvents: [],
    identities: [],
    rendererErrors: [],
    mainErrors: [],
    faultInjections: [],
    scope:
      "Real packaged Electron UI/preload/Main/Core and real upstream LLM; synthetic private project. Only proxy timing, picker source, and file-drag source are controlled.",
  };
  const tickets = new Set();
  let app,
    win,
    firstBoot = true,
    stopped = false,
    beforeFiles,
    closingPromise;
  const deadline = Date.now() + timeoutMs;
  const guard = () => {
    if (stopped || Date.now() >= deadline)
      throw new DesktopEvalFailure("case_timeout", "Overall desktop case deadline reached");
  };
  let watchdog;
  const ctx = {
    scenario,
    report,
    output: out,
    home,
    workspace,
    pause,
    targetPath: join(workspace, "eval-note.txt"),
    fixturePath: scenario.input.files[0]
      ? resolve(workspace, scenario.input.files[0].path)
      : undefined,
    canonical(id, passed, detail) {
      const assertion = report.hardAssertions.find((entry) => entry.id === id);
      if (!assertion) throw new Error(`Unregistered canonical assertion: ${id}`);
      Object.assign(assertion, { passed, ...(detail ? { detail } : {}) });
    },
    requests: () => proxy.requests.slice(requestOffset),
    check(condition, name, details) {
      report.assertions.push({ name, passed: !!condition, ...(details ? { details } : {}) });
      if (!condition) throw new DesktopEvalFailure("harness_assertion", name, details);
    },
    async until(predicate, description, limit = timeoutMs) {
      guard();
      const untilDeadline = Math.min(deadline, Date.now() + limit);
      while (Date.now() < untilDeadline) {
        guard();
        if (await predicate()) return;
        await pause(100);
      }
      throw new DesktopEvalFailure("scenario_timeout", `Timed out: ${description}`);
    },
    async boot() {
      guard();
      const { _electron: electron } = requireDesktop("playwright");
      const { findCodeShellWindow } =
        await import("../../packages/desktop/scripts/electron-harness.mjs");
      app = await electron.launch({
        executablePath: resolve(executable),
        args: [`--user-data-dir=${userData}`],
        cwd: home,
        timeout: 45000,
        env: isolatedEnvironment(process.env, home),
      });
      if (stopped || Date.now() >= deadline) {
        await ctx.close();
        guard();
      }
      win = await findCodeShellWindow(app, { timeout: 35000 });
      win.setDefaultTimeout(10000);
      win.on("pageerror", (error) => report.rendererErrors.push(error.message));
      const identity = await app.evaluate(({ app: electronApp }) => {
        globalThis.__evalMainErrors = [];
        process.on("uncaughtExceptionMonitor", (error) =>
          globalThis.__evalMainErrors.push(String(error.stack ?? error)),
        );
        return {
          version: electronApp.getVersion(),
          packaged: electronApp.isPackaged,
          appPath: electronApp.getAppPath(),
          userData: electronApp.getPath("userData"),
          pid: process.pid,
        };
      });
      identity.asarSha256 = hash(await readFile(identity.appPath));
      report.identities.push(identity);
      guard();
      ctx.check(identity.packaged && identity.userData === userData, "isolated-packaged-app");
      await win.exposeFunction("__evalObserveStream", (envelope) =>
        report.streamEvents.push(envelope),
      );
      const observe = () => {
        const register = () => {
          if (window.codeshell?.onStreamEvent && !window.__evalStreamObserved) {
            window.__evalStreamObserved = true;
            window.codeshell.onStreamEvent((envelope) => {
              void window.__evalObserveStream(envelope);
            });
          }
        };
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", register, { once: true });
        else register();
      };
      await win.addInitScript(observe);
      await win.evaluate(observe);
      if (firstBoot) {
        const trust = win.getByRole("button", { name: "信任并继续", exact: true });
        await trust
          .waitFor({ state: "visible", timeout: 3000 })
          .then(() => trust.click())
          .catch(() => {});
        if (scenario.surface === "ordinary") {
          // Seed only this process's native picker choice; restore it before trust or tool execution.
          await app.evaluate(({ dialog }, path) => {
            globalThis.__evalOriginalPicker = dialog.showOpenDialog;
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
          }, workspace);
          try {
            const project = await win.evaluate(() =>
              window.codeshell.projectRegistry.createFromPicker(),
            );
            report.facts.project = project;
            ctx.check(
              project?.roots?.length === 1 && project.roots[0].path === workspace,
              "project-root-is-exact-isolated-workspace",
              { project, workspace },
            );
          } finally {
            await app.evaluate(({ dialog }) => {
              dialog.showOpenDialog = globalThis.__evalOriginalPicker;
              delete globalThis.__evalOriginalPicker;
            });
          }
          await win.getByText("eval-workspace", { exact: true }).first().click();
          await trust
            .waitFor({ state: "visible", timeout: 3000 })
            .then(() => trust.click())
            .catch(() => {});
        }
        firstBoot = false;
      }
    },
    async openSurface() {
      guard();
      if (scenario.surface === "mimi") await win.getByRole("button", { name: /^Mimi：/ }).click();
      await ctx.input().waitFor({ state: "visible", timeout: 20000 });
    },
    input: () =>
      scenario.surface === "mimi"
        ? win.locator("[data-pet-manager-chat] textarea")
        : win.locator("textarea:visible").last(),
    async send(text) {
      guard();
      await ctx.input().fill(text);
      guard();
      await ctx.input().press("Enter");
    },
    async busy() {
      return (
        (await win
          .getByRole("button", {
            name: scenario.surface === "mimi" ? "停止回复" : "停止",
            exact: true,
          })
          .count()) > 0
      );
    },
    async idle(minimumAnswers) {
      await ctx.until(
        async () =>
          (await ctx.conversation()).answers.length >= minimumAnswers && !(await ctx.busy()),
        "model turn settled",
      );
    },
    async conversation() {
      return win.evaluate(
        ({ surface, prompts }) => {
          const norm = (text) =>
            String(text ?? "")
              .replace(/\s+/gu, " ")
              .trim();
          if (surface === "mimi") {
            const box = document.querySelector("[data-pet-manager-chat]");
            return {
              users: [
                ...(box?.querySelectorAll("div.flex.justify-end.pl-10 .whitespace-pre-wrap") ?? []),
              ].map((node) => norm(node.textContent)),
              answers: [...(box?.querySelectorAll("div.flex.items-start.pr-6 > div") ?? [])]
                .map((node) => norm(node.textContent))
                .filter(Boolean),
            };
          }
          return {
            users: [
              ...document.querySelectorAll(".cs-chat-transcript .whitespace-pre-wrap.break-words"),
            ]
              .map((node) => norm(node.textContent))
              .filter((text) => prompts.includes(text)),
            answers: [...document.querySelectorAll('[data-message-kind="assistant"]')]
              .map((node) => {
                const copy = node.cloneNode(true);
                copy.querySelectorAll(".cs-message-actions").forEach((footer) => footer.remove());
                return norm(copy.textContent);
              })
              .filter(Boolean),
          };
        },
        { surface: scenario.surface, prompts: scenario.input.prompts.map(normalizeVisibleText) },
      );
    },
    async queuedUi(text) {
      return win.evaluate((wanted) => {
        const normalize = (value) =>
          String(value ?? "")
            .replace(/\s+/gu, " ")
            .trim();
        const nodes = [
          ...document.querySelectorAll(".line-clamp-2.whitespace-pre-wrap.break-words"),
        ];
        return {
          count: nodes.filter(
            (node) =>
              normalize(node.textContent) === wanted &&
              node.parentElement?.querySelector('[aria-label="删除第 1 条后续变更"]'),
          ).length,
          text: wanted,
          source: "actual follow-up queue UI; Engine acceptance checked at canonical consumption",
        };
      }, normalizeVisibleText(text));
    },
    async reload() {
      guard();
      await win.reload({ waitUntil: "domcontentloaded" });
      await ctx.input().waitFor({ state: "visible", timeout: 20000 });
    },
    async capture(name) {
      await win.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
      await writeFile(join(out, `${name}.txt`), await win.locator("body").innerText());
    },
    async hold(options) {
      const ticket = await proxy.holdNextText(options);
      tickets.add(ticket);
      report.faultInjections.push({
        type: "hold-after-real-text",
        options,
        at: new Date().toISOString(),
      });
      return ticket;
    },
    async waitHeld(ticket) {
      guard();
      return proxy.waitForHold(ticket, { timeoutMs: Math.max(1, deadline - Date.now()) });
    },
    async release(ticket) {
      await proxy.release(ticket);
      tickets.delete(ticket);
    },
    petStatus: () =>
      win.evaluate(() => window.codeshell.pet.dispatch({ type: "get_global_status" })),
    readSnapshot: (id) =>
      win.evaluate((sessionId) => window.codeshell.subscribeSession(sessionId, 0), id),
    async sessionEvidence(id, name) {
      const snapshot = await ctx.readSnapshot(id);
      const transcript = await win.evaluate(
        (sessionId) => window.codeshell.getSessionTranscript(sessionId),
        id,
      );
      await writeFile(join(out, `${name}-snapshot.json`), JSON.stringify(snapshot, null, 2));
      await writeFile(join(out, `${name}-transcript.json`), JSON.stringify(transcript, null, 2));
      return { snapshot, transcript };
    },
    async cachedCursor(id) {
      const folder = join(codeShellHome, "desktop/transcript-cache");
      for (const file of await readdir(folder).catch(() => [])) {
        const cache = await readFile(join(folder, file), "utf8")
          .then(JSON.parse)
          .catch(() => undefined);
        if (cache?.state?.sessionId === id)
          return { snapshotSeq: cache.state.snapshotSeq, snapshotEpoch: cache.state.snapshotEpoch };
      }
      return null;
    },
    async waitWriteApproval() {
      let pending;
      try {
        await ctx.until(async () => {
          const list = await win.evaluate(() => window.codeshell.getPendingApprovals());
          pending = list[0];
          return !!pending;
        }, "model-authored Write approval");
      } catch (error) {
        throw new DesktopEvalFailure(
          "model_no_required_tool",
          "Model did not reach the required real Write approval",
          { cause: String(error) },
        );
      }
      if (pending.request?.toolName !== "Write")
        throw new DesktopEvalFailure(
          "model_no_required_tool",
          "Model selected a different approval tool",
          { toolName: pending.request?.toolName },
        );
      await win
        .getByRole("button", { name: "仅本次批准", exact: true })
        .waitFor({ state: "visible" });
      return pending;
    },
    approvalCount: () => win.getByRole("button", { name: "仅本次批准", exact: true }).count(),
    async approveWrite() {
      guard();
      await win.getByRole("button", { name: "仅本次批准", exact: true }).click();
    },
    async workspaceUnchanged() {
      const after = await workspaceManifest(workspace);
      report.facts.filesystem = { before: beforeFiles, after };
      return JSON.stringify(beforeFiles) === JSON.stringify(after);
    },
    async onlyTargetChanged() {
      const after = await workspaceManifest(workspace);
      report.facts.filesystem = { before: beforeFiles, after };
      const withoutTarget = { ...after };
      delete withoutTarget["eval-note.txt"];
      return (
        JSON.stringify(beforeFiles) === JSON.stringify(withoutTarget) &&
        after["eval-note.txt"] === hash(scenario.writeContent)
      );
    },
    targetExists: () => exists(ctx.targetPath),
    readTarget: () => readFile(ctx.targetPath, "utf8"),
    async attachOwnFile() {
      await win.evaluate(() => {
        const source = document.createElement("input");
        source.type = "file";
        source.id = "eval-file-source";
        source.hidden = true;
        document.body.appendChild(source);
      });
      await win.locator("#eval-file-source").setInputFiles(ctx.fixturePath);
      const selected = await win.evaluate(() => {
        const file = document.querySelector("#eval-file-source").files[0];
        return { name: file.name, size: file.size, path: window.codeshell.getPathForFile(file) };
      });
      ctx.check(selected.path === ctx.fixturePath, "real-File-resolves-original-path", {
        selected,
      });
      await win.evaluate(() => {
        const source = document.querySelector("#eval-file-source");
        const transfer = new DataTransfer();
        transfer.items.add(source.files[0]);
        const box = document.querySelector("[data-pet-manager-chat]");
        for (const type of ["dragenter", "dragover", "drop"])
          box.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
        source.remove();
      });
      await ctx.until(
        async () =>
          (await win.locator("[data-pet-path-attachments]").innerText()).includes(ctx.fixturePath),
        "real path attachment chip",
      );
      await ctx.capture("own-file-path-chip");
    },
    async close() {
      if (!app) return closingPromise;
      const closing = app;
      app = undefined;
      closingPromise = (async () => {
        const child = closing.process();
        let closeTimer;
        const graceful = (async () => {
          report.mainErrors.push(
            ...(await closing.evaluate(() => globalThis.__evalMainErrors ?? []).catch(() => [])),
          );
          await closing.close();
        })();
        await Promise.race([
          graceful.catch((error) => {
            report.cleanupRpcError = String(error);
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
              report.cleanupForced = true;
            }
          }),
          new Promise((resolveClose) => {
            closeTimer = setTimeout(() => {
              // The timeout covers every RPC, including error collection. Only this owned handle is killed.
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              report.cleanupForced = true;
              resolveClose();
            }, 12000);
          }),
        ]).finally(() => clearTimeout(closeTimer));
        const exitDeadline = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline)
          await pause(50);
        report.facts.closedMainPids ??= [];
        report.facts.closedMainPids.push({
          pid: child.pid,
          exited: child.exitCode !== null || child.signalCode !== null,
        });
      })();
      return closingPromise;
    },
  };
  watchdog = setTimeout(() => {
    stopped = true;
    void ctx.close().catch(() => {});
  }, timeoutMs);
  try {
    await mkdir(workspace, { recursive: true });
    for (const fixture of scenario.input.files) {
      const path = resolve(workspace, fixture.path);
      if (!path.startsWith(workspace + "/"))
        throw new Error("Fixture path escapes isolated workspace");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, fixture.content);
    }
    await configure(home, model, proxy);
    await ctx.boot();
    await ctx.openSurface();
    beforeFiles = await workspaceManifest(workspace);
    await executeDesktopScenario(ctx);
    guard();
    ctx.check(
      report.rendererErrors.length === 0 && report.mainErrors.length === 0,
      "no-renderer-or-main-errors",
    );
    ctx.check(
      ctx.requests().some((request) => request.stream ?? request.streamed),
      "actual-provider-stream-request-observed",
    );
    report.executionStatus = "passed";
  } catch (error) {
    const noModelRequest = !ctx.requests().some((request) => request.stream);
    report.executionStatus =
      ["case_timeout", "scenario_timeout", "rendering_boundary"].includes(error.code) ||
      noModelRequest
        ? "inconclusive"
        : "failed";
    report.failureCategory =
      error.code === "model_no_required_tool"
        ? "model_task"
        : noModelRequest
          ? "environment_setup"
          : ["case_timeout", "scenario_timeout", "rendering_boundary"].includes(error.code)
            ? error.code === "rendering_boundary"
              ? "rendering_boundary"
              : "time_budget"
            : error.code === "harness_assertion"
              ? "harness_assertion"
              : "adapter_error";
    report.reason = error.message;
    report.failure = {
      code: error.code ?? "desktop_error",
      message: error.message,
      details: error.details,
    };
    if (win) await ctx.capture("failure").catch(() => {});
  } finally {
    stopped = true;
    clearTimeout(watchdog);
    // Closing first prevents releasing a held network stream from executing more tools.
    await ctx.close().catch((error) => {
      report.cleanupError = String(error);
      report.executionStatus = "failed";
    });
    if (report.cleanupForced || report.facts.closedMainPids?.some((entry) => !entry.exited)) {
      report.executionStatus = "failed";
      report.cleanupError ??=
        "Packaged app required forced shutdown or its Main process did not exit";
    }
    if (report.rendererErrors.length || report.mainErrors.length) report.executionStatus = "failed";
    for (const ticket of tickets) {
      try {
        await proxy.release(ticket);
      } catch {}
    }
    for (const folder of ["logs", "sessions", "desktop/transcript-cache", "pet"])
      await cp(join(codeShellHome, folder), join(out, "retained", folder), {
        recursive: true,
      }).catch(() => {});
    await cp(workspace, join(out, "artifacts"), { recursive: true }).catch(() => {});
    report.requests = ctx.requests();
    report.artifacts = {
      directory: out,
      result: join(out, "result.json"),
      retained: join(out, "retained"),
    };
    report.finishedAt = new Date().toISOString();
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(
      (error) => {
        report.cleanupError = String(error);
        report.executionStatus = "failed";
      },
    );
    report.profileRemoved = !(await exists(home));
    await writeFile(join(out, "result.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
