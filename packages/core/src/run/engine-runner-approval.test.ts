import { describe, test, expect } from "bun:test";
import { EngineRunner, type EngineRunnerConfig } from "./EngineRunner.js";
import { createRunManager } from "./factory.js";
import { HeadlessApprovalBackend } from "../tool-system/permission.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const llm = {
  provider: "openai",
  model: "test/model",
  apiKey: "k",
  baseUrl: "https://example.test/v1",
};

describe("EngineRunner approvalBackend override (Phase 2 automation plumbing)", () => {
  test("EngineRunnerConfig accepts an approvalBackend override", () => {
    const backend = new HeadlessApprovalBackend("approve-read-only");
    const config: EngineRunnerConfig = { llm, approvalBackend: backend };
    const runner = new EngineRunner(config);
    // The runner is constructed without throwing and holds the config.
    expect(runner).toBeInstanceOf(EngineRunner);
  });

  test("createRunManager threads approvalBackend without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-approval-"));
    try {
      const mgr = createRunManager({
        llm,
        runsDir: dir,
        approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
      });
      expect(mgr).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
