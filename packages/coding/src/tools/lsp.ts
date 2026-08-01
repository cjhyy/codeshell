/**
 * LSPTool — language server protocol operations for code intelligence.
 */

import type { ToolContext, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import { getLSPManager } from "../lsp/manager.js";
import { detectLSPServer } from "../lsp/servers.js";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

/**
 * How long to wait for `textDocument/publishDiagnostics` after opening a file.
 *
 * A cold server has to index the project first, so this is a deadline rather
 * than an expected duration — timing out reports "still indexing" instead of
 * silently claiming the file is clean.
 */
const DIAGNOSTICS_TIMEOUT_MS = 10_000;

const DIAGNOSTIC_SEVERITY: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

interface LspDiagnostic {
  message: string;
  severity?: number;
  source?: string;
  range?: { start?: { line: number; character: number } };
}

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
        description:
          "Character offset (0-based). Required for goToDefinition, findReferences, hover.",
      },
    },
    required: ["action", "file_path"],
  },
};

export async function lspTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const action = args.action as string;
  const rawPath = args.file_path as string;
  const line = (args.line as number) ?? 0;
  const character = (args.character as number) ?? 0;

  if (!rawPath) return "Error: file_path is required";
  const cwd = ctx?.cwd ?? process.cwd();
  const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // Lazily create the manager for THIS workspace. Previously this read a
  // process-wide singleton that no host ever initialized, so the tool was
  // advertised to the agent but always answered "LSP is not initialized".
  const manager = getLSPManager(cwd);
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
        const result = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position,
        })) as any;
        if (!result) return "No hover information available.";
        const content =
          typeof result.contents === "string"
            ? result.contents
            : (result.contents?.value ?? JSON.stringify(result.contents));
        return `Hover:\n${content}`;
      }

      case "getDiagnostics": {
        // Collect the ACTUAL diagnostics for this file.
        //
        // This used to open the document, sleep 2s, and return "Diagnostics
        // requested. Check LSP notifications for results." — nobody was
        // subscribed to those notifications, so the agent got a status string
        // and never any findings. Subscribe first, then open, then wait for the
        // matching publishDiagnostics (with a deadline, since a clean file may
        // legitimately produce none).
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(filePath, "utf-8");

        const diagnostics = await new Promise<LspDiagnostic[] | undefined>((resolveWait) => {
          let settled = false;
          const finish = (value: LspDiagnostic[] | undefined): void => {
            if (settled) return;
            settled = true;
            client.off?.("notification", onNotification);
            clearTimeout(timer);
            resolveWait(value);
          };
          const onNotification = (message: { method?: string; params?: unknown }): void => {
            if (message?.method !== "textDocument/publishDiagnostics") return;
            const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] };
            // Servers report per-URI; ignore other files opened in the session.
            if (params?.uri !== uri) return;
            finish(params.diagnostics ?? []);
          };
          const timer = setTimeout(() => finish(undefined), DIAGNOSTICS_TIMEOUT_MS);
          client.on?.("notification", onNotification);
          void client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: serverConfig.language, version: 1, text },
          });
        });

        if (diagnostics === undefined) {
          return `No diagnostics published within ${DIAGNOSTICS_TIMEOUT_MS}ms. The server may still be indexing.`;
        }
        if (diagnostics.length === 0) return "No diagnostics — the file is clean.";
        const lines = diagnostics.slice(0, 100).map((diagnostic) => {
          const severity = DIAGNOSTIC_SEVERITY[diagnostic.severity ?? 1] ?? "info";
          const start = diagnostic.range?.start;
          const at = start ? `${start.line + 1}:${start.character + 1}` : "?";
          const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
          return `  ${severity} ${at}${source} ${diagnostic.message}`;
        });
        const more =
          diagnostics.length > 100 ? `\n  … ${diagnostics.length - 100} more` : "";
        return `Diagnostics (${diagnostics.length}):\n${lines.join("\n")}${more}`;
      }

      case "getSymbols": {
        const result = (await client.request("textDocument/documentSymbol", {
          textDocument: { uri },
        })) as any[];
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
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};
