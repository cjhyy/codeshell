/**
 * LSPTool — language server protocol operations for code intelligence.
 */

import type { ToolDefinition } from "../../types.js";
import { getLSPManager } from "../../lsp/manager.js";
import { detectLSPServer } from "../../lsp/servers.js";
import { pathToFileURL } from "node:url";

export const lspToolDef: ToolDefinition = {
  name: "LSP",
  description:
    "Use Language Server Protocol for code intelligence operations. " +
    "Available actions: goToDefinition, findReferences, hover, getDiagnostics, getSymbols. " +
    "Requires a language server to be installed for the target language.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["goToDefinition", "findReferences", "hover", "getDiagnostics", "getSymbols"],
        description: "The LSP operation to perform",
      },
      file_path: {
        type: "string",
        description: "Absolute path to the file",
      },
      line: {
        type: "number",
        description: "Line number (0-based). Required for goToDefinition, findReferences, hover.",
      },
      character: {
        type: "number",
        description: "Character offset (0-based). Required for goToDefinition, findReferences, hover.",
      },
    },
    required: ["action", "file_path"],
  },
};

export async function lspTool(args: Record<string, unknown>): Promise<string> {
  const action = args.action as string;
  const filePath = args.file_path as string;
  const line = (args.line as number) ?? 0;
  const character = (args.character as number) ?? 0;

  if (!filePath) return "Error: file_path is required";

  const manager = getLSPManager();
  if (!manager) return "Error: LSP is not initialized. Language servers are not available.";

  // Detect the appropriate server
  const serverConfig = detectLSPServer(filePath);
  if (!serverConfig) return `Error: No language server configured for ${filePath}`;

  const client = await manager.getClient(serverConfig.name);
  if (!client) {
    return `Error: Language server "${serverConfig.name}" is not available. Install: ${serverConfig.installHint}`;
  }

  const uri = pathToFileURL(filePath).href;
  const position = { line, character };

  try {
    switch (action) {
      case "goToDefinition": {
        const result = await client.request("textDocument/definition", {
          textDocument: { uri },
          position,
        });
        return formatLocationResult(result, "Definition");
      }

      case "findReferences": {
        const result = await client.request("textDocument/references", {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        });
        return formatLocationResult(result, "References");
      }

      case "hover": {
        const result = await client.request("textDocument/hover", {
          textDocument: { uri },
          position,
        }) as any;
        if (!result) return "No hover information available.";
        const content = typeof result.contents === "string"
          ? result.contents
          : result.contents?.value ?? JSON.stringify(result.contents);
        return `Hover:\n${content}`;
      }

      case "getDiagnostics": {
        // Open the document to trigger diagnostics
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(filePath, "utf-8");
        await client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: serverConfig.language, version: 1, text },
        });
        // Wait briefly for diagnostics
        await new Promise((r) => setTimeout(r, 2000));
        return "Diagnostics requested. Check LSP notifications for results.";
      }

      case "getSymbols": {
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri },
        }) as any[];
        if (!result?.length) return "No symbols found.";
        const lines = result.map((s: any) => {
          const kind = SYMBOL_KINDS[s.kind] ?? `kind:${s.kind}`;
          const range = s.range ?? s.location?.range;
          const loc = range ? `:${range.start.line + 1}` : "";
          return `  ${kind} ${s.name}${loc}`;
        });
        return `Symbols in ${filePath}:\n${lines.join("\n")}`;
      }

      default:
        return `Unknown action: ${action}`;
    }
  } catch (err) {
    return `LSP error: ${(err as Error).message}`;
  }
}

function formatLocationResult(result: unknown, label: string): string {
  if (!result) return `No ${label.toLowerCase()} found.`;

  const locations = Array.isArray(result) ? result : [result];
  if (locations.length === 0) return `No ${label.toLowerCase()} found.`;

  const lines = locations.map((loc: any) => {
    const uri = loc.uri ?? loc.targetUri ?? "";
    const range = loc.range ?? loc.targetRange ?? {};
    const path = uri.replace("file://", "");
    const line = (range.start?.line ?? 0) + 1;
    return `  ${path}:${line}`;
  });

  return `${label} (${locations.length}):\n${lines.join("\n")}`;
}

const SYMBOL_KINDS: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};
