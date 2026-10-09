/* Actual compiled SDK/Engine/ToolExecutor consumers; synthetic uploads only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import http, { request as namedHttpRequest } from "node:http";
import https, { request as namedHttpsRequest } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { officeZip, textPdf, wordXml } from "../tests/fixtures/upload-documents.mjs";
import { denyDocumentSmokeNetwork } from "./upload-document-smoke-isolation.mjs";

denyDocumentSmokeNetwork();
const probes = [
  () => fetch("https://crossfile.invalid/"),
  () => http.request("http://127.0.0.1:9/"),
  () => namedHttpRequest("http://127.0.0.1:9/"),
  () => https.request("https://crossfile.invalid/"),
  () => namedHttpsRequest("https://crossfile.invalid/"),
  () => net.connect({ host: "127.0.0.1", port: 9 }),
  () => net.createConnection({ host: "127.0.0.1", port: 9 }),
  () => new net.Socket().connect({ host: "127.0.0.1", port: 9 }),
  () => tls.connect({ host: "crossfile.invalid", port: 443 }),
];
for (const probe of probes) assert.throws(probe, /refused a network request/);
assert.ok(process.env.HOME && process.env.CODE_SHELL_HOME);
assert.equal(realpathSync(process.env.HOME), process.env.HOME);
assert.equal(lstatSync(process.env.HOME).isSymbolicLink(), false);

// Observe actual production children without replacing their executable, input,
// parser, or response. This private diagnostic never enters a tool result.
const parserChildren = [];
const actualSpawn = childProcess.spawn;
childProcess.spawn = function (executable, args, options) {
  const child = actualSpawn(executable, args, options);
  if (args.some((arg) => /[/\\]documents[/\\]parser-entry\.js$/.test(arg))) {
    const record = { pid: child.pid, executable, options, closed: false };
    parserChildren.push(record);
    let frame = "";
    child.stdout.on("data", (chunk) => {
      if (record.runtime) return;
      frame += chunk.toString("utf8");
      if (frame.includes("\n")) record.runtime = JSON.parse(frame.split("\n")[0]).runtime;
    });
    child.once("close", (code, signal) => Object.assign(record, { code, signal, closed: true }));
  }
  return child;
};
syncBuiltinESMExports();

// Public SDK and Host internal surface must resolve the same built Core tree.
const publicEntry = fileURLToPath(import.meta.resolve("@cjhyy/code-shell-core"));
const coreDist = dirname(publicEntry);
const internalEntry = fileURLToPath(import.meta.resolve("@cjhyy/code-shell-core/internal"));
assert.equal(dirname(internalEntry), coreDist);
const { Engine, LLMClientBase, registerProvider } = await import("@cjhyy/code-shell-core");
const { ToolRegistry } = await import("../packages/core/dist/tool-system/registry.js");
const { ToolExecutor } = await import("../packages/core/dist/tool-system/executor.js");
const { PermissionClassifier } = await import("../packages/core/dist/tool-system/permission.js");
const { HookRegistry } = await import("../packages/core/dist/hooks/registry.js");
const { parseDocumentIsolated } = await import("../packages/core/dist/sources/documents/worker.js");
assert.equal(
  realpathSync(join(coreDist, "tool-system", "executor.js")),
  realpathSync(
    fileURLToPath(new URL("../packages/core/dist/tool-system/executor.js", import.meta.url)),
  ),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const parserRequire = createRequire(join(coreDist, "sources/documents/parse.js"));
const runtime = {
  pid: process.pid,
  ppid: process.ppid,
  node: process.versions.node,
  executableSha256: hash(readFileSync(process.execPath)),
  homeSha256: hash(process.env.HOME),
  negativeProbesBeforeCore: probes.length,
  compiled: Object.fromEntries(
    [
      "tool-system/context.js",
      "tool-system/executor.js",
      "tool-system/builtin/sources.js",
      "sources/adapters/local-files.js",
      "sources/documents/index-store.js",
      "sources/documents/worker.js",
      "sources/documents/parser-entry.js",
      "sources/documents/parse.js",
      "sources/documents/types.js",
      "sources/truncate-utf8.js",
    ].map((path) => [path, hash(readFileSync(join(coreDist, path)))]),
  ),
  parserDependencies: Object.fromEntries(
    [
      ["yauzl", parserRequire],
      ["pend", createRequire(parserRequire.resolve("yauzl"))],
      ["saxes", parserRequire],
      ["xmlchars", createRequire(parserRequire.resolve("saxes"))],
      ["pdfjs-dist/legacy/build/pdf.mjs", parserRequire],
      ["@napi-rs/canvas", createRequire(parserRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs"))],
    ].map(([entry, requireFromOwner]) => [
      entry,
      hash(readFileSync(requireFromOwner.resolve(entry))),
    ]),
  ),
};
const argsFor = (resources) => ({
  source: "project-uploads",
  scope: "uploads",
  resources,
  query: "项目预算 milestone",
  limit: 10,
});
const parse = (result) => {
  assert.equal(Boolean(result.isError), false, JSON.stringify(result));
  return JSON.parse(
    String(result.result).split("\n<untrusted_input>\n")[1].split("\n</untrusted_input>")[0],
  );
};
function executor(
  cwd,
  hooks = new HookRegistry(),
  rules = [{ tool: "ReadSource", decision: "allow" }],
) {
  const instance = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource", "ListSources"] }),
    new PermissionClassifier(rules),
    hooks,
  );
  instance.setContext({ cwd, settingsScope: "isolated" });
  return instance;
}
const run = (instance, args) =>
  instance.executeSingle({ id: "native-crossfile", toolName: "ReadSource", args });
function childReceipts() {
  assert.ok(parserChildren.length >= 2);
  assert.equal(
    new Set(parserChildren.map((child) => child.options.cwd)).size,
    parserChildren.length,
  );
  return parserChildren.map(
    ({ pid, executable, options, runtime: child, code, signal, closed }) => {
      assert.equal(closed, true);
      assert.equal(existsSync(options.cwd), false);
      assert.notEqual(options.cwd, process.env.HOME);
      assert.equal(child.pid, pid);
      assert.equal(child.ppid, process.pid);
      assert.equal(child.home, options.cwd);
      assert.equal(child.cwd, options.cwd);
      assert.equal(child.networkProbesBeforeImport, 17);
      assert.equal(realpathSync(child.executable), realpathSync(executable));
      assert.deepEqual(
        child.environment,
        Object.fromEntries(
          Object.entries(options.env).filter(
            ([key]) => !["PATH", "SystemRoot", "ELECTRON_RUN_AS_NODE"].includes(key),
          ),
        ),
      );
      if (process.platform !== "win32")
        assert.ok(Object.values(child.directoryModes).every((mode) => mode === 0o700));
      assert.equal(code, 0);
      assert.equal(signal, null);
      return {
        pid,
        ppid: child.ppid,
        node: child.node,
        electron: child.electron,
        executableSha256: hash(readFileSync(child.executable)),
        homeSha256: hash(child.home),
        negativeProbesBeforeParserImport: child.networkProbesBeforeImport,
        privateDirectoryRemoved: true,
      };
    },
  );
}

if (process.argv[2] === "--cold") {
  const cwd = process.argv[3];
  const result = parse(await run(executor(cwd), argsFor(["a.txt", "b.docx"])));
  assert.equal(result.matches.length, 2);
  console.log(JSON.stringify({ role: "cold", runtime, parserChildren: childReceipts(), result }));
} else {
  const cwd = mkdtempSync(join(tmpdir(), "codeshell-crossfile-native-"));
  try {
    const uploads = join(cwd, ".code-shell", "uploads");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, "a.txt"), "项目预算 milestone alpha");
    writeFileSync(
      join(uploads, "b.docx"),
      officeZip({ "word/document.xml": wordXml("项目预算 milestone beta") }),
    );
    const legacy = join(cwd, ".code-shell", "source-index", "legacy.json");
    mkdirSync(dirname(legacy));
    writeFileSync(legacy, "legacy derived data must remain unchanged");
    const legacyHash = hash(readFileSync(legacy));
    const approvals = [];
    let sent = false;
    let observed;
    class CrossfileClient extends LLMClientBase {
      initClient() {}
      async createMessage(options) {
        const definition = options.tools?.find((tool) => tool.name === "ReadSource");
        if (definition && !sent) {
          assert.ok(definition.inputSchema.properties.resources);
          sent = true;
          return {
            text: "",
            toolCalls: [
              {
                id: "engine-crossfile",
                toolName: "ReadSource",
                args: argsFor(["b.docx", "a.txt"]),
              },
            ],
            stopReason: "tool_use",
          };
        }
        for (const message of options.messages) {
          const outputs =
            message.role === "tool"
              ? [message.content]
              : Array.isArray(message.content)
                ? message.content
                    .filter((block) => block.type === "tool_result")
                    .map((block) => block.content)
                : [];
          for (const output of outputs) {
            const text = typeof output === "string" ? output : JSON.stringify(output);
            if (text?.includes('"search":"lexical"')) observed = text;
          }
        }
        return { text: "crossfile engine completed", toolCalls: [], stopReason: "stop" };
      }
    }
    registerProvider("crossfile-fixture", CrossfileClient);
    const engine = new Engine({
      llm: { provider: "crossfile-fixture", model: "fixture", apiKey: "synthetic-fixture" },
      cwd,
      settingsScope: "isolated",
      sessionStorageDir: join(cwd, "sessions"),
      enabledBuiltinTools: ["ReadSource"],
      permissionMode: "default",
      headless: true,
      maxTurns: 3,
      approvalBackend: {
        requestApproval: async (request) => {
          approvals.push(request.args.resource ?? "collection");
          return { approved: true };
        },
      },
      behaviorProfiles: [
        {
          id: "crossfile-smoke",
          disableSessionTitle: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableMcp: true,
          disableHooks: true,
        },
      ],
    });
    try {
      const result = await engine.run("Search these two explicit synthetic documents", {
        sessionId: "crossfile-native",
        behaviorMode: "crossfile-smoke",
        toolAllowlist: ["ReadSource"],
      });
      assert.equal(result.text, "crossfile engine completed");
      assert.ok(
        observed?.includes("milestone alpha") && observed?.includes("milestone beta"),
        observed,
      );
      assert.deepEqual(approvals, ["collection", "a.txt", "b.docx"]);
    } finally {
      engine.dispose();
    }
    const instance = executor(cwd);
    const first = parse(await run(instance, argsFor(["a.txt", "b.docx"])));
    const reverse = parse(await run(instance, argsFor(["b.docx", "a.txt"])));
    assert.deepEqual(reverse, first);
    assert.equal(first.totalMatches, 2);
    assert.deepEqual(
      first.matches.map((item) => item.resourceId),
      ["a.txt", "b.docx"],
    );
    const chunk = first.matches[1];
    const exact = await run(instance, {
      source: "project-uploads",
      scope: "uploads",
      resource: chunk.resourceId,
      chunk: chunk.id,
    });
    assert.equal(Boolean(exact.isError), false);
    assert.ok(exact.result.includes("milestone beta"));
    const denied = executor(cwd, new HookRegistry(), [
      { tool: "ReadSource", argsPattern: { resource: "^b\\.docx$" }, decision: "deny" },
      { tool: "ReadSource", decision: "allow" },
    ]);
    const refusal = await run(denied, argsFor(["a.txt", "b.docx"]));
    assert.equal(refusal.isError, true);
    assert.equal(refusal.result, undefined);
    const hooks = new HookRegistry();
    hooks.register("on_tool_start", ({ data }) => {
      if (data.args?.resource === "b.docx") {
        writeFileSync(join(uploads, "replacement.txt"), readFileSync(join(uploads, "a.txt")));
        renameSync(join(uploads, "replacement.txt"), join(uploads, "a.txt"));
      }
      return {};
    });
    assert.equal((await run(executor(cwd, hooks), argsFor(["a.txt", "b.docx"]))).isError, true);
    const cold = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--cold", cwd], {
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(cold.status, 0, cold.stderr);
    const coldResult = JSON.parse(cold.stdout.trim().split("\n").at(-1));
    assert.equal(coldResult.runtime.ppid, process.pid);
    assert.equal(coldResult.runtime.homeSha256, runtime.homeSha256);
    assert.deepEqual(coldResult.runtime.compiled, runtime.compiled);
    assert.deepEqual(coldResult.runtime.parserDependencies, runtime.parserDependencies);
    assert.deepEqual(coldResult.result, first);
    assert.ok(coldResult.parserChildren.every((child) => child.ppid === coldResult.runtime.pid));
    assert.equal(hash(readFileSync(legacy)), legacyHash);
    assert.deepEqual(
      Object.keys(first.resources[0]).sort(),
      [
        "extractionTruncated",
        "format",
        "inputBytes",
        "parserVersion",
        "resourceId",
        "sourceHash",
      ].sort(),
    );
    assert.equal(existsSync(join(cwd, ".code-shell", "source-index", "manifest.json")), false);
    assert.deepEqual(readdirSync(dirname(legacy)), ["legacy.json"]);
    const pdfExecutableIndex = process.argv.indexOf("--pdf-executable");
    let pdfCollection;
    if (pdfExecutableIndex >= 0) {
      // Private acceptance input, never sourced from tool arguments or settings.
      const pdfExecutable = process.argv[pdfExecutableIndex + 1];
      assert.ok(pdfExecutable);
      writeFileSync(join(uploads, "sample.pdf"), textPdf("Native PDF milestone"));
      const pdfConsumer = executor(cwd);
      pdfConsumer.setContext({
        cwd,
        settingsScope: "isolated",
        documentParserExecutable: async () => pdfExecutable,
      });
      const result = parse(
        await run(pdfConsumer, {
          source: "project-uploads",
          scope: "uploads",
          resources: ["a.txt", "sample.pdf"],
          query: "milestone",
          limit: 10,
        }),
      );
      assert.equal(result.search, "lexical");
      assert.equal(result.matches.length, 2);
      assert.deepEqual(
        result.resources.map(({ format }) => format),
        ["text", "pdf"],
      );
      assert.ok(result.matches.some(({ text }) => text.includes("Native PDF milestone")));
      pdfCollection = {
        resources: result.resources,
        matches: result.matches.length,
        parserExecutableSha256: hash(readFileSync(pdfExecutable)),
      };
    }
    const actualChildren = childReceipts();
    const lifecycle = [];
    const diagnose = (receipt) => {
      assert.equal(receipt.cleanedUp, true);
      assert.equal(existsSync(receipt.home), false);
      assert.equal(receipt.ppid, process.pid);
      lifecycle.push({
        pid: receipt.pid,
        outcome: receipt.outcome,
        code: receipt.code,
        signal: receipt.signal,
        privateDirectoryRemoved: true,
      });
    };
    await assert.rejects(
      parseDocumentIsolated(Buffer.from("fixture"), "timeout.txt", {
        timeoutMs: 0,
        onProcessExit: diagnose,
      }),
      /time limit/,
    );
    const cancel = new AbortController();
    const pending = parseDocumentIsolated(Buffer.from("fixture"), "cancel.txt", {
      signal: cancel.signal,
      onProcessExit: diagnose,
    });
    await new Promise((resolve) => setImmediate(resolve));
    cancel.abort(new Error("native parser cancelled"));
    await assert.rejects(pending, /native parser cancelled/);
    await assert.rejects(
      parseDocumentIsolated(Buffer.from("fixture"), "absent.pdf", {
        resolveExecutable: async () => join(cwd, "absent-parser-executable"),
        onProcessExit: diagnose,
      }),
    );
    assert.deepEqual(
      lifecycle.map(({ outcome }) => outcome),
      ["timeout", "cancelled", "spawn-error"],
    );
    console.log(
      JSON.stringify({
        role: "host",
        runtime,
        approvals,
        first,
        cold: coldResult.runtime,
        parserChildren: actualChildren,
        coldParserChildren: coldResult.parserChildren,
        parserLifecycle: lifecycle,
        pdfCollection,
        originalReplacementRejected: true,
        explicitDenyRejected: true,
        legacyUnchanged: true,
      }),
    );
    console.log("Compiled SDK/Engine cross-file upload query acceptance passed.");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
