/**
 * NotebookEditTool — read and edit Jupyter notebook (.ipynb) cells.
 */

import type { ToolDefinition } from "../../types.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const notebookEditToolDef: ToolDefinition = {
  name: "NotebookEdit",
  description:
    "Edit a Jupyter notebook (.ipynb) file. Supports actions: " +
    "'read' to view cells, 'insert' to add a cell, 'replace' to update a cell, " +
    "'delete' to remove a cell.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the .ipynb file",
      },
      action: {
        type: "string",
        enum: ["read", "insert", "replace", "delete"],
        description: "Operation to perform",
      },
      cell_index: {
        type: "number",
        description: "Cell index (0-based). Required for replace and delete.",
      },
      cell_type: {
        type: "string",
        enum: ["code", "markdown", "raw"],
        description: "Cell type for insert/replace (default: 'code')",
      },
      source: {
        type: "string",
        description: "Cell content for insert/replace",
      },
    },
    required: ["file_path", "action"],
  },
};

interface NotebookCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export async function notebookEditTool(args: Record<string, unknown>): Promise<string> {
  const filePath = args.file_path as string;
  const action = args.action as string;

  if (!filePath) return "Error: file_path is required";
  if (!filePath.endsWith(".ipynb")) return "Error: file must be a .ipynb file";

  if (action === "read") {
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    const nb = readNotebook(filePath);
    const lines: string[] = [`Notebook: ${filePath} (${nb.cells.length} cells)\n`];
    nb.cells.forEach((cell, i) => {
      const source = cell.source.join("");
      const preview = source.slice(0, 200);
      lines.push(`[${i}] ${cell.cell_type}: ${preview}${source.length > 200 ? "..." : ""}`);
    });
    return lines.join("\n");
  }

  if (action === "insert") {
    const nb = existsSync(filePath) ? readNotebook(filePath) : createEmptyNotebook();
    const cellType = (args.cell_type as string) ?? "code";
    const source = args.source as string ?? "";
    const index = args.cell_index as number ?? nb.cells.length;

    const newCell = createCell(cellType, source);
    nb.cells.splice(index, 0, newCell);
    writeNotebook(filePath, nb);
    return `Inserted ${cellType} cell at index ${index}.`;
  }

  if (action === "replace") {
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    const nb = readNotebook(filePath);
    const index = args.cell_index as number;
    if (index === undefined || index < 0 || index >= nb.cells.length) {
      return `Error: Invalid cell_index ${index}. Notebook has ${nb.cells.length} cells.`;
    }
    const cellType = (args.cell_type as string) ?? nb.cells[index].cell_type;
    const source = args.source as string ?? "";
    nb.cells[index] = createCell(cellType, source);
    writeNotebook(filePath, nb);
    return `Replaced cell ${index} with ${cellType} cell.`;
  }

  if (action === "delete") {
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
    const nb = readNotebook(filePath);
    const index = args.cell_index as number;
    if (index === undefined || index < 0 || index >= nb.cells.length) {
      return `Error: Invalid cell_index ${index}. Notebook has ${nb.cells.length} cells.`;
    }
    nb.cells.splice(index, 1);
    writeNotebook(filePath, nb);
    return `Deleted cell ${index}. Notebook now has ${nb.cells.length} cells.`;
  }

  return `Unknown action: ${action}`;
}

function readNotebook(filePath: string): Notebook {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeNotebook(filePath: string, nb: Notebook): void {
  writeFileSync(filePath, JSON.stringify(nb, null, 1) + "\n", "utf-8");
}

function createEmptyNotebook(): Notebook {
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", version: "3.10.0" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function createCell(type: string, source: string): NotebookCell {
  const cell: NotebookCell = {
    cell_type: type,
    source: source.split("\n").map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line)),
    metadata: {},
  };
  if (type === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }
  return cell;
}
