import { describe, it, expect } from "bun:test";
import {
  PermissionClassifier,
  HeadlessApprovalBackend,
  AutoApprovalBackend,
  InteractiveApprovalBackend,
} from "../src/tool-system/permission.js";

describe("PermissionClassifier", () => {
  it("allows tools matching explicit rules", () => {
    const c = new PermissionClassifier(
      [{ tool: "Read", decision: "allow" }],
      "default",
    );
    expect(c.classify("Read", {})).toBe("allow");
  });

  it("denies in dontAsk mode by default", () => {
    const c = new PermissionClassifier([], "dontAsk");
    expect(c.classify("Write", {})).toBe("deny");
  });

  it("allows everything in bypassPermissions", () => {
    const c = new PermissionClassifier([], "bypassPermissions");
    expect(c.classify("Bash", { command: "rm -rf /" })).toBe("allow");
  });

  it("detects dangerous bash commands", () => {
    const c = new PermissionClassifier([], "acceptEdits");
    expect(c.classify("Bash", { command: "rm -rf /" })).toBe("ask");
    expect(c.classify("Bash", { command: "chmod -R 777 /" })).toBe("ask");
  });

  it("matches args patterns in rules", () => {
    const c = new PermissionClassifier(
      [{ tool: "Bash", argsPattern: { command: "git" }, decision: "allow" }],
      "default",
    );
    expect(c.classify("Bash", { command: "git status" })).toBe("allow");
    expect(c.classify("Bash", { command: "rm file" })).toBe("ask");
  });
});

describe("HeadlessApprovalBackend", () => {
  it("approves all in approve-all mode", async () => {
    const b = new HeadlessApprovalBackend("approve-all");
    const r = await b.requestApproval({
      toolName: "Bash",
      args: {},
      description: "test",
      riskLevel: "high",
    });
    expect(r.approved).toBe(true);
  });

  it("denies all in deny-all mode", async () => {
    const b = new HeadlessApprovalBackend("deny-all");
    const r = await b.requestApproval({
      toolName: "Read",
      args: {},
      description: "test",
      riskLevel: "low",
    });
    expect(r.approved).toBe(false);
  });

  it("allows read-only tools in approve-read-only mode", async () => {
    const b = new HeadlessApprovalBackend("approve-read-only");
    expect((await b.requestApproval({ toolName: "Read", args: {}, description: "", riskLevel: "low" })).approved).toBe(true);
    expect((await b.requestApproval({ toolName: "Glob", args: {}, description: "", riskLevel: "low" })).approved).toBe(true);
    expect((await b.requestApproval({ toolName: "Write", args: {}, description: "", riskLevel: "medium" })).approved).toBe(false);
  });
});

describe("AutoApprovalBackend", () => {
  it("auto-approves low risk", async () => {
    const b = new AutoApprovalBackend();
    const r = await b.requestApproval({
      toolName: "Read",
      args: {},
      description: "test",
      riskLevel: "low",
    });
    expect(r.approved).toBe(true);
  });

  it("auto-approves safe bash commands", async () => {
    const b = new AutoApprovalBackend();
    const r = await b.requestApproval({
      toolName: "Bash",
      args: { command: "git status" },
      description: "Run git status",
      riskLevel: "medium",
    });
    expect(r.approved).toBe(true);
  });

  it("auto-approves writes to source files", async () => {
    const b = new AutoApprovalBackend();
    const r = await b.requestApproval({
      toolName: "Write",
      args: { file_path: "src/main.ts" },
      description: "Write to src/main.ts",
      riskLevel: "medium",
    });
    expect(r.approved).toBe(true);
  });

  it("delegates high risk to delegate backend", async () => {
    const delegate = new HeadlessApprovalBackend("deny-all");
    const b = new AutoApprovalBackend(delegate);
    const r = await b.requestApproval({
      toolName: "Bash",
      args: { command: "rm -rf /" },
      description: "Dangerous",
      riskLevel: "high",
    });
    expect(r.approved).toBe(false);
  });
});

describe("InteractiveApprovalBackend", () => {
  it("fails closed when no prompt function is configured", async () => {
    const b = new InteractiveApprovalBackend();
    const r = await b.requestApproval({
      toolName: "Bash",
      args: { command: "rm -rf /" },
      description: "Dangerous",
      riskLevel: "high",
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toContain("no prompt function");
  });
});
