/* Compiled SDK/Engine acceptance: two projects share explicit original files. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import http, { request as namedHttpRequest } from "node:http";
import https, { request as namedHttpsRequest } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { officeZip, wordXml } from "../tests/fixtures/upload-documents.mjs";
import { denyDocumentSmokeNetwork } from "./upload-document-smoke-isolation.mjs";

denyDocumentSmokeNetwork();
const probes = [
  () => fetch("https://collection-smoke.invalid/"),
  () => http.request("http://127.0.0.1:9/"),
  () => namedHttpRequest("http://127.0.0.1:9/"),
  () => https.request("https://collection-smoke.invalid/"),
  () => namedHttpsRequest("https://collection-smoke.invalid/"),
  () => net.connect({ host: "127.0.0.1", port: 9 }),
  () => net.createConnection({ host: "127.0.0.1", port: 9 }),
  () => new net.Socket().connect({ host: "127.0.0.1", port: 9 }),
  () => tls.connect({ host: "collection-smoke.invalid", port: 443 }),
];
for (const probe of probes) assert.throws(probe, /refused a network request/);
assert.ok(process.env.HOME && process.env.CODE_SHELL_HOME);
assert.equal(realpathSync(process.env.HOME), process.env.HOME);
assert.equal(lstatSync(process.env.HOME).isSymbolicLink(), false);

const parserChildren = [];
const actualSpawn = childProcess.spawn;
childProcess.spawn = function (executable, args, options) {
  const child = actualSpawn(executable, args, options);
  if (args.some((arg) => /[/\\]documents[/\\]parser-entry\.js$/.test(arg))) {
    const receipt = { pid: child.pid, executable, home: options.cwd, closed: false };
    parserChildren.push(receipt);
    let frame = "";
    child.stdout.on("data", (chunk) => {
      if (receipt.runtime) return;
      frame += chunk.toString("utf8");
      if (frame.includes("\n")) receipt.runtime = JSON.parse(frame.split("\n")[0]).runtime;
    });
    child.once("close", (code, signal) => Object.assign(receipt, { closed: true, code, signal }));
  }
  return child;
};
syncBuiltinESMExports();

const coreEntry = fileURLToPath(import.meta.resolve("@cjhyy/code-shell-core"));
const coreDist = dirname(coreEntry);
assert.equal(
  dirname(fileURLToPath(import.meta.resolve("@cjhyy/code-shell-core/internal"))),
  coreDist,
);
const { Engine, LLMClientBase, registerProvider } = await import("@cjhyy/code-shell-core");
const { ToolRegistry } = await import("../packages/core/dist/tool-system/registry.js");
const { ToolExecutor } = await import("../packages/core/dist/tool-system/executor.js");
const { PermissionClassifier } = await import("../packages/core/dist/tool-system/permission.js");
const { HookRegistry } = await import("../packages/core/dist/hooks/registry.js");
const { SettingsManager } = await import("../packages/core/dist/settings/manager.js");
const { saveSourceDefinition } = await import("../packages/core/dist/sources/catalog.js");
const { bindSource } = await import("../packages/core/dist/sources/binding.js");
const { captureCollectionLocalFile } =
  await import("../packages/core/dist/sources/collection-local.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runtime = {
  pid: process.pid,
  ppid: process.ppid,
  node: process.versions.node,
  executableSha256: hash(readFileSync(process.execPath)),
  homeSha256: hash(process.env.HOME),
  negativeProbesBeforeCore: probes.length,
  compiled: Object.fromEntries(
    [
      "index.js",
      "tool-system/builtin/sources.js",
      "sources/adapters/collection.js",
      "sources/collection-local.js",
      "sources/collection-url.js",
      "sources/documents/index-store.js",
      "sources/documents/worker.js",
    ].map((path) => [path, hash(readFileSync(join(coreDist, path)))]),
  ),
};
const selected = [
  { scope: "entry_a", resource: "entry_a" },
  { scope: "entry_b", resource: "entry_b" },
];
const argsFor = (resources = selected) => ({
  source: "shared_library",
  resources,
  query: "项目预算 milestone",
  limit: 10,
});
function parse(result) {
  assert.equal(Boolean(result.isError), false, JSON.stringify(result));
  return JSON.parse(
    String(result.result).split("\n<untrusted_input>\n")[1].split("\n</untrusted_input>")[0],
  );
}
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
  instance.setContext({ cwd, settingsScope: "project" });
  return instance;
}
const run = (instance, args) =>
  instance.executeSingle({ id: randomUUID(), toolName: "ReadSource", args });
function children() {
  assert.ok(parserChildren.length >= 2);
  return parserChildren.map((receipt) => {
    assert.equal(receipt.closed, true);
    assert.equal(receipt.code, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.runtime.pid, receipt.pid);
    assert.equal(receipt.runtime.ppid, process.pid);
    assert.equal(receipt.runtime.home, receipt.home);
    assert.equal(receipt.runtime.cwd, receipt.home);
    assert.equal(receipt.runtime.networkProbesBeforeImport, 17);
    assert.equal(existsSync(receipt.home), false);
    return {
      pid: receipt.pid,
      ppid: process.pid,
      node: receipt.runtime.node,
      homeSha256: hash(receipt.home),
      executableSha256: hash(readFileSync(receipt.executable)),
      negativeProbesBeforeParserImport: 17,
      privateDirectoryRemoved: true,
    };
  });
}

if (process.argv[2] === "--cold") {
  const result = parse(await run(executor(process.argv[3]), argsFor()));
  console.log(JSON.stringify({ role: "cold", runtime, parserChildren: children(), result }));
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-collection-corpus-")));
  try {
    const originals = join(root, "originals");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    for (const path of [originals, projectA, projectB]) mkdirSync(path);
    const text = join(originals, "a.txt");
    const office = join(originals, "b.docx");
    writeFileSync(text, "项目预算 milestone alpha");
    writeFileSync(office, officeZip({ "word/document.xml": wordXml("项目预算 milestone beta") }));
    const originalHashes = [text, office].map((path) => hash(readFileSync(path)));
    saveSourceDefinition({
      id: "shared_library",
      label: "Shared fixture library",
      kind: "collection",
      enabled: true,
      adapterConfig: {
        version: 1,
        revision: randomUUID(),
        entries: [
          captureCollectionLocalFile(text, "entry_a"),
          captureCollectionLocalFile(office, "entry_b"),
        ],
      },
    });
    for (const cwd of [projectA, projectB])
      bindSource(new SettingsManager(cwd, "project"), cwd, {
        sourceId: "shared_library",
        scopes: selected.map((item) => item.scope),
        readPolicy: "ask",
      });

    const approvals = [];
    let observed;
    class CollectionClient extends LLMClientBase {
      sent = false;
      initClient() {}
      async createMessage(options) {
        if (!this.sent) {
          assert.ok(
            options.tools.find((tool) => tool.name === "ReadSource").inputSchema.properties
              .resources,
          );
          this.sent = true;
          return {
            text: "",
            toolCalls: [
              {
                id: "shared-corpus",
                toolName: "ReadSource",
                args: argsFor([...selected].reverse()),
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
            const value = typeof output === "string" ? output : JSON.stringify(output);
            if (value.includes('"search":"lexical"')) observed = value;
          }
        }
        return { text: "shared collection queried", toolCalls: [], stopReason: "stop" };
      }
    }
    registerProvider("collection-corpus-fixture", CollectionClient);
    const engine = new Engine({
      llm: { provider: "collection-corpus-fixture", model: "fixture", apiKey: "synthetic-fixture" },
      cwd: projectA,
      settingsScope: "project",
      sessionStorageDir: join(root, "sessions"),
      enabledBuiltinTools: ["ReadSource"],
      permissionMode: "default",
      headless: true,
      maxTurns: 3,
      approvalBackend: {
        requestApproval: async (request) => {
          approvals.push(request.args.resource ?? "corpus");
          return { approved: true };
        },
      },
      behaviorProfiles: [
        {
          id: "collection-corpus-smoke",
          disableSessionTitle: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableMcp: true,
          disableHooks: true,
        },
      ],
    });
    try {
      const outcome = await engine.run("Query these two explicitly selected shared documents", {
        sessionId: "collection-corpus-native",
        behaviorMode: "collection-corpus-smoke",
        toolAllowlist: ["ReadSource"],
      });
      assert.equal(outcome.text, "shared collection queried");
      assert.ok(
        observed?.includes("milestone alpha") && observed?.includes("milestone beta"),
        observed,
      );
      assert.deepEqual(approvals, ["corpus", "entry_a", "entry_b"]);
    } finally {
      await engine.dispose();
    }

    const first = parse(await run(executor(projectA), argsFor()));
    assert.equal(first.totalMatches, 2);
    assert.deepEqual(parse(await run(executor(projectB), argsFor([...selected].reverse()))), first);
    for (const match of first.matches) {
      assert.ok(
        selected.some((item) => item.scope === match.scopeId && item.resource === match.resourceId),
      );
      const exact = await run(executor(projectB), {
        source: "shared_library",
        scope: match.scopeId,
        resource: match.resourceId,
        chunk: match.id,
      });
      assert.equal(Boolean(exact.isError), false, JSON.stringify(exact));
      assert.ok(exact.result.includes(match.text));
    }
    const denied = executor(projectA, new HookRegistry(), [
      { tool: "ReadSource", argsPattern: { resource: "^entry_b$" }, decision: "deny" },
      { tool: "ReadSource", decision: "allow" },
    ]);
    const refusal = await run(denied, argsFor());
    assert.equal(refusal.isError, true);
    assert.equal(refusal.result, undefined);

    const cold = childProcess.spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--cold", projectB],
      { env: process.env, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(cold.status, 0, cold.stderr);
    const recovered = JSON.parse(cold.stdout.trim().split("\n").at(-1));
    assert.equal(recovered.runtime.ppid, process.pid);
    assert.deepEqual(recovered.runtime.compiled, runtime.compiled);
    assert.deepEqual(recovered.result, first);
    assert.deepEqual(
      [text, office].map((path) => hash(readFileSync(path))),
      originalHashes,
    );
    const hooks = new HookRegistry();
    hooks.register("on_tool_start", ({ data }) => {
      if (data.args?.resource === "entry_b") {
        const replacement = join(originals, "replacement.txt");
        writeFileSync(replacement, readFileSync(text));
        renameSync(replacement, text);
      }
      return {};
    });
    assert.equal((await run(executor(projectA, hooks), argsFor())).isError, true);
    console.log(
      JSON.stringify({
        role: "host",
        runtime,
        parserChildren: children(),
        cold: recovered.runtime,
        coldParserChildren: recovered.parserChildren,
        explicitSharedProjects: 2,
        sameCorpusAcrossProjects: true,
        exactChunkReads: first.matches.length,
        perFileApprovals: approvals,
        knownDenyReturnsNoCorpus: true,
        sameBytesReplacementRefused: true,
        originalHashes,
        result: first,
      }),
    );
    console.log("Compiled SDK/Engine shared-collection corpus acceptance passed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
