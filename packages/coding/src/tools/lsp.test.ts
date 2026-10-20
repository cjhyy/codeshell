import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLSPManager, shutdownAllLSPManagers } from "../lsp/manager.js";
import { lspTool } from "./lsp.js";

/** In-memory LSP client; the real per-workspace manager hands it to the tool. */
class FakeClient extends EventEmitter {
  response: unknown;
  notifications: Array<{ method: string; params: any }> = [];
  /** Text the fake server currently holds for each open document. */
  documents = new Map<string, string>();

  async request(_method: string, _params: unknown): Promise<unknown> {
    return this.response;
  }

  async notify(method: string, params: any): Promise<void> {
    this.notifications.push({ method, params });
    const uri = params.textDocument.uri as string;
    if (method === "textDocument/didOpen") {
      if (this.documents.has(uri)) throw new Error(`duplicate didOpen for ${uri}`);
      this.documents.set(uri, params.textDocument.text);
    } else if (method === "textDocument/didChange") {
      if (!this.documents.has(uri)) throw new Error(`didChange before didOpen for ${uri}`);
      this.documents.set(uri, params.contentChanges.at(-1).text);
    } else {
      return;
    }
    const text = this.documents.get(uri)!;
    const diagnostics = text.includes("BROKEN")
      ? [{ message: "broken", severity: 1, range: { start: { line: 0, character: 0 } } }]
      : [];
    queueMicrotask(() =>
      this.emit("notification", {
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics },
      }),
    );
  }
}

const roots: string[] = [];
afterEach(async () => {
  await shutdownAllLSPManagers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, text = "export const answer = 42;\n") {
  const root = mkdtempSync(join(tmpdir(), "cs-lsp-tool-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(file, text);
  const client = new FakeClient();
  getLSPManager(root)!.getClient = async () => client as any;
  const run = (action: string) => lspTool({ action, file_path: file }, { cwd: root } as any);
  return { file, client, run };
}

describe("LSP tool", () => {
  test("reports definition/reference locations as decoded filesystem paths", async () => {
    const { file, client, run } = fixture("a b-中文-100%#file.ts");
    const uri = pathToFileURL(file).href;
    client.response = { uri, range: { start: { line: 6, character: 0 } } };
    expect(await run("goToDefinition")).toBe(`Definition (1):\n  ${file}:7`);

    client.response = [{ uri, range: { start: { line: 1, character: 0 } } }];
    expect(await run("findReferences")).toBe(`References (1):\n  ${file}:2`);
  });

  test("syncs edits to an already open document instead of reopening it", async () => {
    const { file, client, run } = fixture("diag.ts", "BROKEN\n");
    expect(await run("getDiagnostics")).toContain("Diagnostics (1)");

    writeFileSync(file, "export const fixed = true;\n");
    expect(await run("getDiagnostics")).toBe("No diagnostics — the file is clean.");

    const methods = client.notifications.map((n) => n.method);
    expect(methods).toEqual(["textDocument/didOpen", "textDocument/didChange"]);
    expect(client.notifications[1]!.params.textDocument.version).toBe(2);
  });
});
