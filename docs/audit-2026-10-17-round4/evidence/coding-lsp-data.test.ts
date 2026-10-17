import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLSPManager, shutdownAllLSPManagers } from "../../../packages/coding/src/lsp/manager.ts";
import { rootUriToPath } from "../../../packages/coding/src/lsp/root-path.ts";
import { lspTool } from "../../../packages/coding/src/tools/lsp.ts";

// Audit proof: direct imports of the frozen source, with a memory-only client.
// getClient is replaced on the real per-workspace manager before any operation.
// No LSP process, socket, network request, operator state, or product edit.
const roots: string[] = [];
const observations: Record<string, unknown> = {};

class FakeClient extends EventEmitter {
  requests: Array<{ method: string; params: any }> = [];
  notifications: Array<{ method: string; params: any }> = [];
  response: unknown;
  onNotify?: (method: string, params: any) => void;

  async request(method: string, params: any): Promise<unknown> {
    this.requests.push({ method, params });
    return this.response;
  }

  async notify(method: string, params: any): Promise<void> {
    this.notifications.push({ method, params });
    this.onNotify?.(method, params);
  }
}

function fixture(name = "source.ts", text = "export const answer = 42;\n") {
  const root = mkdtempSync(join(tmpdir(), "codeshell-coding-r4-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(file, text);
  const client = new FakeClient();
  const manager = getLSPManager(root)!;
  manager.getClient = async () => client as any;
  const run = (action: string, extra: Record<string, unknown> = {}) =>
    lspTool({ action, file_path: file, ...extra }, { cwd: root } as any);
  return { root, file, client, run };
}

afterEach(async () => {
  await shutdownAllLSPManagers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coding round4 ordinary LSP data", () => {
  test("root URI conversion already round-trips encoded filesystem names", () => {
    const { root } = fixture();
    const path = join(root, "a b-中文-100%#file.ts");
    const uri = pathToFileURL(path).href;
    expect(uri).toContain("%20");
    expect(uri).toContain("%25");
    expect(uri).toContain("%23");
    expect(rootUriToPath(uri)).toBe(path);
  });

  test("ordinary ASCII definition output and relative request paths are correct", async () => {
    const { root, file, client } = fixture();
    const uri = pathToFileURL(file).href;
    client.response = { uri, range: { start: { line: 4, character: 2 } } };
    const output = await lspTool(
      { action: "goToDefinition", file_path: "source.ts", line: 3, character: 5 },
      { cwd: root } as any,
    );
    expect(client.requests).toEqual([
      {
        method: "textDocument/definition",
        params: { textDocument: { uri }, position: { line: 3, character: 5 } },
      },
    ]);
    expect(output).toBe(`Definition (1):\n  ${file}:5`);
  });

  test("definition output leaves the returned file URI percent encoded", async () => {
    const { file, client, run } = fixture("a b-中文-100%#file.ts");
    const uri = pathToFileURL(file).href;
    client.response = { uri, range: { start: { line: 6, character: 0 } } };
    const output = await run("goToDefinition");
    const returnedPath = output.split("\n")[1]!.trim().replace(/:7$/, "");
    expect(existsSync(file)).toBe(true);
    expect(returnedPath).toBe(uri.replace("file://", ""));
    expect(returnedPath).not.toBe(file);
    expect(existsSync(returnedPath)).toBe(false);
    observations.definition = { uri, file, returnedPath, output };
  });

  test("reference output has the same encoding defect while ASCII references work", async () => {
    const { file, client, run } = fixture("reference space.ts");
    const ascii = join(file, "..", "other.ts");
    client.response = [
      { uri: pathToFileURL(file).href, range: { start: { line: 1, character: 0 } } },
      { uri: pathToFileURL(ascii).href, range: { start: { line: 2, character: 0 } } },
    ];
    const output = await run("findReferences");
    expect(client.requests[0]!.params.context).toEqual({ includeDeclaration: true });
    expect(output).toContain("reference%20space.ts:2");
    expect(output).toContain("other.ts:3");
    expect(output).not.toContain(`${file}:2`);
    observations.references = output;
  });

  test("flat SymbolInformation and empty symbol responses are handled", async () => {
    const { file, client, run } = fixture();
    client.response = [
      { name: "answer", kind: 14, location: { uri: pathToFileURL(file).href, range: { start: { line: 0 } } } },
    ];
    expect(await run("getSymbols")).toBe(`Symbols in ${file}:\n  Constant answer:1`);
    client.response = [];
    expect(await run("getSymbols")).toBe("No symbols found.");
  });

  test("diagnostics preserve severity, 1-based position, source and clean response", async () => {
    const { client, run } = fixture();
    client.onNotify = (_method, params) => {
      client.emit("notification", {
        method: "textDocument/publishDiagnostics",
        params: {
          uri: params.textDocument.uri,
          diagnostics: [{ message: "Mismatch", severity: 2, source: "fake", range: { start: { line: 3, character: 4 } } }],
        },
      });
    };
    expect(await run("getDiagnostics")).toBe("Diagnostics (1):\n  warning 4:5 [fake] Mismatch");
    expect(client.listenerCount("notification")).toBe(0);
    client.onNotify = (_method, params) => {
      client.emit("notification", {
        method: "textDocument/publishDiagnostics",
        params: { uri: params.textDocument.uri, diagnostics: [] },
      });
    };
    expect(await run("getDiagnostics")).toBe("No diagnostics — the file is clean.");
    expect(client.listenerCount("notification")).toBe(0);
  });

  test("diagnostic display cap reports omitted records without losing total", async () => {
    const { client, run } = fixture();
    client.onNotify = (_method, params) => {
      client.emit("notification", {
        method: "textDocument/publishDiagnostics",
        params: {
          uri: params.textDocument.uri,
          diagnostics: Array.from({ length: 101 }, (_, n) => ({ message: `Issue-${n}` })),
        },
      });
    };
    const output = await run("getDiagnostics");
    expect(output).toStartWith("Diagnostics (101):\n");
    expect(output).toContain("error ? Issue-99");
    expect(output).not.toContain("Issue-100");
    expect(output).toEndWith("… 1 more");
  });

  test("second diagnostic read reopens version 1 instead of updating an open document", async () => {
    const { file, client, run } = fixture("source.ts", "BROKEN\n");
    const openDocuments = new Map<string, { text: string; version: number }>();
    client.onNotify = (method, params) => {
      const document = params.textDocument;
      // An already-open document is retained by this strict fake adapter.
      // Duplicate didOpen is invalid LSP input; it is not an update operation.
      if (method === "textDocument/didOpen" && !openDocuments.has(document.uri)) {
        openDocuments.set(document.uri, { text: document.text, version: document.version });
      }
      const open = openDocuments.get(document.uri)!;
      client.emit("notification", {
        method: "textDocument/publishDiagnostics",
        params: {
          uri: document.uri,
          version: open.version,
          diagnostics: open.text.includes("BROKEN") ? [{ message: "Old text is broken" }] : [],
        },
      });
    };
    const first = await run("getDiagnostics");
    writeFileSync(file, "export const fixed = true;\n");
    const second = await run("getDiagnostics");
    expect(first).toContain("Old text is broken");
    expect(readFileSync(file, "utf8")).not.toContain("BROKEN");
    expect(second).toContain("Old text is broken");
    expect(client.notifications.map((n) => n.method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didOpen",
    ]);
    expect(client.notifications.map((n) => n.params.textDocument.version)).toEqual([1, 1]);
    expect(client.notifications[0]!.params.textDocument.text).toBe("BROKEN\n");
    expect(client.notifications[1]!.params.textDocument.text).toBe("export const fixed = true;\n");
    expect(client.listenerCount("notification")).toBe(0);
    observations.repeatedDiagnostics = { first, second, notifications: client.notifications };
  });
});

// Raw observed values are retained by the first-run combined log.
process.on("beforeExit", () => console.log("CODING_R4_OBSERVATIONS", JSON.stringify(observations)));
