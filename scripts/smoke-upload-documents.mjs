/* Real compiled Core/ToolExecutor/parser child smoke. No model or external service. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createManagedDocumentParserResolver } from "../packages/core/dist/sources/documents/runtime.js";
import { officeZip, textPdf, wordXml } from "../tests/fixtures/upload-documents.mjs";
import { ToolRegistry } from "../packages/core/dist/tool-system/registry.js";
import { ToolExecutor } from "../packages/core/dist/tool-system/executor.js";
import { PermissionClassifier } from "../packages/core/dist/tool-system/permission.js";
import { HookRegistry } from "../packages/core/dist/hooks/registry.js";
import { invalidateUploadedDocumentIndex } from "../packages/core/dist/index.internal.js";

const cwd = mkdtempSync(join(tmpdir(), "codeshell-upload-native-"));
const previousHome = process.env.CODE_SHELL_HOME;
process.env.CODE_SHELL_HOME = cwd;
try {
  const root = join(cwd, ".code-shell", "uploads");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "brief.docx"),
    officeZip({ "word/document.xml": wordXml("项目预算 milestone") }),
  );
  writeFileSync(join(root, "sample.pdf"), textPdf("Native PDF milestone"));
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource", "ListSources"] }),
    new PermissionClassifier([
      // Explicit synthetic fixture authorization. Production defaults still ask.
      { tool: "ReadSource", decision: "allow" },
      { tool: "ListSources", decision: "allow" },
    ]),
    new HookRegistry(),
  );
  const managedIndex = process.argv.indexOf("--managed-runtime-root");
  const managedRoot = managedIndex >= 0 ? resolve(process.argv[managedIndex + 1]) : undefined;
  executor.setContext({
    cwd,
    settingsScope: "full",
    ...(managedRoot
      ? { documentParserExecutable: createManagedDocumentParserResolver(managedRoot) }
      : {}),
  });
  const run = async (resource, extra = {}, expectError = false) => {
    const result = await executor.executeSingle({
      id: "native-read",
      toolName: "ReadSource",
      args: { source: "project-uploads", scope: "uploads", resource, ...extra },
    });
    assert.equal(Boolean(result.isError), expectError, JSON.stringify(result));
    return expectError ? `Error: ${result.error}` : String(result.result);
  };
  const metadata = await executor.executeSingle({
    id: "native-list",
    toolName: "ListSources",
    args: {},
  });
  assert.ok(String(metadata.result).includes("brief.docx"));
  assert.equal(existsSync(join(cwd, ".code-shell", "source-index")), false);
  assert.ok((await run("brief.docx", { query: "项目预算" })).includes("项目预算 milestone"));
  assert.ok(
    (await run("brief.docx")).includes("source=project-uploads scope=uploads resource=brief.docx"),
  );
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supportsPdf = Boolean(managedRoot) || major > 22 || (major === 22 && minor >= 13);
  const missingPdf = process.argv.includes("--expect-missing-pdf");
  const pdf = await run("sample.pdf", { query: "milestone" }, !supportsPdf || missingPdf);
  assert.ok(
    missingPdf
      ? pdf.includes("optional PDF parser is unavailable")
      : supportsPdf
        ? pdf.includes("Native PDF milestone")
        : pdf.includes("requires Node.js 22.13"),
    pdf,
  );
  if (supportsPdf && !missingPdf) {
    const { Engine, LLMClientBase, registerProvider } = await import("@cjhyy/code-shell-core");
    let sent = false;
    let toolResult = "";
    class DocumentClient extends LLMClientBase {
      initClient() {}
      async createMessage(options) {
        const main = options.tools?.some((tool) => tool.name === "ReadSource");
        if (main && !sent) {
          sent = true;
          return {
            text: "",
            toolCalls: [
              {
                id: "engine-pdf-read",
                toolName: "ReadSource",
                args: {
                  source: "project-uploads",
                  scope: "uploads",
                  resource: "sample.pdf",
                  query: "milestone",
                },
              },
            ],
            stopReason: "tool_use",
          };
        }
        if (main) toolResult = JSON.stringify(options.messages);
        return { text: "document engine completed", toolCalls: [], stopReason: "stop" };
      }
    }
    registerProvider("uploaded-document-fixture", DocumentClient);
    const engine = new Engine({
      llm: { provider: "uploaded-document-fixture", model: "fixture", apiKey: "test" },
      cwd,
      settingsScope: "isolated",
      sessionStorageDir: join(cwd, "sessions"),
      enabledBuiltinTools: ["ReadSource"],
      permissionMode: "bypassPermissions",
      headless: true,
      maxTurns: 3,
      ...(managedRoot
        ? { documentParserExecutable: createManagedDocumentParserResolver(managedRoot) }
        : {}),
      behaviorProfiles: [
        {
          id: "document-smoke",
          disableSessionTitle: true,
          disableInstructions: true,
          disableMemoryContext: true,
          disableMcp: true,
          disableHooks: true,
        },
      ],
    });
    try {
      const result = await engine.run("Read the exact fixture PDF", {
        sessionId: "document-engine",
        behaviorMode: "document-smoke",
      });
      assert.equal(result.text, "document engine completed");
      assert.ok(toolResult.includes("Native PDF milestone"), toolResult);
    } finally {
      await engine.dispose();
    }
  }
  // A workspace can edit a well-shaped disk index and its claimed source hash.
  // Neither a warm process nor a cold process may return that forged text.
  const indexRoot = join(cwd, ".code-shell", "source-index");
  const docxIndexPath = readdirSync(indexRoot)
    .map((name) => join(indexRoot, name))
    .find((path) => JSON.parse(readFileSync(path, "utf8")).resourceId === "brief.docx");
  const forged = JSON.parse(readFileSync(docxIndexPath, "utf8"));
  forged.chunks.forEach((chunk) => {
    chunk.text = "FORGED milestone";
    chunk.end = chunk.start + chunk.text.length;
  });
  writeFileSync(docxIndexPath, JSON.stringify(forged));
  assert.ok(!(await run("brief.docx", { query: "FORGED" })).includes("FORGED milestone"));
  const coreUrl = import.meta.resolve("@cjhyy/code-shell-core");
  const cold = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { ToolRegistry, ToolExecutor, PermissionClassifier, HookRegistry } from ${JSON.stringify(coreUrl)};
    const executor = new ToolExecutor(new ToolRegistry({ builtinTools: ["ReadSource"] }),
      new PermissionClassifier([{tool:"ReadSource",decision:"allow"}]), new HookRegistry());
    executor.setContext({ cwd: ${JSON.stringify(cwd)}, settingsScope: "full" });
    const result = await executor.executeSingle({ id:"cold-read", toolName:"ReadSource", args:{
      source:"project-uploads", scope:"uploads", resource:"brief.docx", query:"milestone"
    }});
    assert.equal(Boolean(result.isError), false, JSON.stringify(result));
    assert.ok(result.result.includes("项目预算 milestone"), result.result);
    assert.ok(!result.result.includes("FORGED"), result.result);
    console.log("cold cache rebuilt from original bytes");
  `,
    ],
    { env: process.env, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(cold.status, 0, cold.stderr + cold.stdout);
  writeFileSync(
    join(root, "brief.docx"),
    officeZip({ "word/document.xml": wordXml("Replacement milestone") }),
  );
  assert.ok((await run("brief.docx", { query: "Replacement" })).includes("Replacement milestone"));
  assert.ok(!(await run("brief.docx", { query: "项目预算" })).includes("项目预算 milestone"));
  invalidateUploadedDocumentIndex(cwd, "brief.docx");
  rmSync(join(root, "brief.docx"));
  assert.ok((await run("brief.docx", { query: "milestone" }, true)).startsWith("Error:"));
  console.log(
    JSON.stringify({
      node: process.versions.node,
      parserRuntime: managedRoot ? "verified-host-managed-node" : "host-runtime",
      docx: "actual-parser",
      pdf: missingPdf
        ? "actionable-missing-dependency"
        : supportsPdf
          ? "actual-parser"
          : "actionable-version-gate",
      index: "query/replace/delete-authorized+forged-cold-cache-rejected",
      remainingIndexes: readdirSync(join(cwd, ".code-shell", "source-index")).length,
    }),
  );
} finally {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(cwd, { recursive: true, force: true });
}
