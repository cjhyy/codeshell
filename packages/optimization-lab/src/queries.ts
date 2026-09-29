import type { ExtensionQueryHandler } from "@cjhyy/code-shell-core/extension";
import { freezeDataset, validateDataset } from "./contracts/dataset.js";
import { labRoot } from "./store-paths.js";

function requireString(params: Readonly<Record<string, unknown>>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`optimization_lab: ${key} is required`);
  }
  return value;
}

export const OPTIMIZATION_LAB_QUERIES: Readonly<Record<string, ExtensionQueryHandler>> = {
  optimization_lab_validate_dataset: (params) => validateDataset(params.dataset),
  optimization_lab_freeze_dataset: (params) =>
    freezeDataset(params.dataset, labRoot(requireString(params, "cwd"))),
};
