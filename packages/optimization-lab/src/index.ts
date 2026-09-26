export { createOptimizationLabModule } from "./module.js";
export { freezeDataset, validateDataset } from "./contracts/dataset.js";
export type {
  DatasetIssue,
  DatasetManifest,
  DatasetSummary,
  DatasetValidation,
  FreezeResult,
} from "./contracts/dataset.js";
export type { DatasetInput, EvalCase, HardAssertion, RubricItem } from "./contracts/eval-case.js";
export { VERDICT_POLICY, VERDICT_POLICY_SUITE_VERSION } from "./contracts/verdict-policy.js";
