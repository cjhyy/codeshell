/**
 * Product module — build domain-specific agents on CodeShell.
 */

export type {
  ProductDefinition,
  ProductPreset,
  ProductAdapter,
  ProductContract,
  CustomTool,
} from "./types.js";

export {
  defineProduct,
  type ProductRuntimeOptions,
  type ProductInstance,
} from "./define.js";
