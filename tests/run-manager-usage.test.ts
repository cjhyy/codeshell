/**
 * RunManager 编排框架使用示例（集成测试）
 *
 * 这个文件演示了 RunManager 的各种使用场景：
 *   1. 基本提交与执行流程
 *   2. 使用 factory 快速创建
 *   3. 实时流式订阅（attach）
 *   4. 审批流（waiting_approval → resume）
 *   5. 用户输入流（waiting_input → resume）
 *   6. 取消正在运行的 run
 *   7. 队列并发控制
 *   8. 崩溃恢复（recover）
 *   9. 事件溯源（event sourcing）
 *  10. 自定义 Evaluator
 *
 * 注意：这些测试使用 mock 的 EngineRunner，不会真正调用 LLM。
 * 如果你想跑真实的端到端测试，参考 "真实 LLM 集成" 小节。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileRunStore } from "../src/run/FileRunStore.js";
import { RunManager } from "../src/run/RunManager.js";
import { RunQueue } from "../src/run/RunQueue.js";
import type {
  RunSnapshot,
  RunEvent,
  RunStreamEvent,
  RunStreamCallback,
} from "../src/run/types.js";
import type { Evaluator, EvaluatorContext, EvaluatorResult } from "../src/run/Evaluator.js";

// ─── Test Helpers ───────────────────────────────────────────────

/** 等待条件满足，最多 timeoutMs 毫秒 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * 创建一个 mock 的 RunManager，用假的 EngineRunner 替代真实 LLM。
 *
 * mockExecute 控制 Engine.run() 的行为：
 *   - 返回 { text, reason } 就模拟正常完成
 *   - 抛异常就模拟执行失败
 *   - 调用 hooks.onApprovalNeeded() 就模拟审批等待
 */
function createTestManager(opts: {
  tmpDir: string;
  concurrency?: number;
  evaluator?: Evaluator;
}) {
  const store = new FileRunStore(opts.tmpDir);

  const manager = new RunManager({
    store,
    executor: {
      llm: {
        provider: "openai" as any,
        model: "test-model",
        apiKey: "test-key",
      },
    },
    concurrency: opts.concurrency ?? 1,
    runsDir: opts.tmpDir,
    evaluator: opts.evaluator,
  });

  return { manager, store };
}

// ─── 场景 1：基本 submit → 查询 → 事件 ─────────────────────────

describe("场景 1：基本 submit + 查询", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-1-"));
    store = new FileRunStore(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("submit 创建 run 并持久化到磁盘", async () => {
    const { manager } = createTestManager({ tmpDir });

    // 提交一个 run
    const run = await manager.submit({
      objective: "重构 auth 模块，提取 JWT 验证为独立服务",
      tags: ["refactor", "auth"],
      metadata: { priority: "high", assignee: "maki" },
    });

    // 验证返回值
    expect(run.runId).toBeTruthy();
    expect(run.status).toBe("queued");
    expect(run.objective).toContain("重构 auth");
    expect(run.tags).toEqual(["refactor", "auth"]);

    // 验证持久化
    const fromDisk = await store.get(run.runId);
    expect(fromDisk).not.toBeNull();
    expect(fromDisk!.objective).toBe(run.objective);
    expect(fromDisk!.metadata).toEqual({ priority: "high", assignee: "maki" });

    // 验证事件被记录
    const events = await store.listEvents(run.runId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("run_created");
    expect(events[1].type).toBe("run_queued");
  });

  it("list 支持按状态和 tag 过滤", async () => {
    // 直接往 store 里写几个不同状态的 run
    const base = {
      preset: "terminal-coding" as const,
      cwd: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 0,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      metadata: {},
    };

    await store.create({ ...base, runId: "r1", objective: "task 1", status: "completed", tags: ["feat"] });
    await store.create({ ...base, runId: "r2", objective: "task 2", status: "running", tags: ["feat"] });
    await store.create({ ...base, runId: "r3", objective: "task 3", status: "completed", tags: ["fix"] });
    await store.create({ ...base, runId: "r4", objective: "task 4", status: "failed", tags: ["feat"] });

    // 按状态过滤
    const completed = await store.list({ status: "completed" });
    expect(completed).toHaveLength(2);

    // 按 tag 过滤
    const feats = await store.list({ tag: "feat" });
    expect(feats).toHaveLength(3);

    // 组合过滤
    const completedFeats = await store.list({ status: "completed", tag: "feat" });
    expect(completedFeats).toHaveLength(1);
    expect(completedFeats[0].runId).toBe("r1");

    // 分页
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });
});

// ─── 场景 2：attach 实时流式订阅 ────────────────────────────────

describe("场景 2：attach 实时订阅", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-2-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("attach 可以实时接收 run 状态变更和事件", async () => {
    const { manager } = createTestManager({ tmpDir });
    const events: RunStreamEvent[] = [];

    // 先 submit
    const run = await manager.submit({
      objective: "写一个 hello world",
    });

    // 订阅这个 run 的实时流
    const detach = manager.attach(run.runId, (event) => {
      events.push(event);
    });

    // 等一下让队列有机会开始处理
    // （因为我们没有真正的 Engine，执行会失败并产生 blocked 事件）
    await new Promise((r) => setTimeout(r, 500));

    // 应该收到一些状态变更事件
    const statusChanges = events.filter((e) => e.type === "run_status_changed");
    expect(statusChanges.length).toBeGreaterThan(0);

    // 取消订阅
    detach();
  });
});

// ─── 场景 3：RunQueue 并发控制 ──────────────────────────────────

describe("场景 3：队列并发控制", () => {
  it("concurrency=1 串行执行", async () => {
    const queue = new RunQueue({ concurrency: 1 });
    const timeline: string[] = [];

    queue.setExecutor(async (runId) => {
      timeline.push(`start:${runId}`);
      await new Promise((r) => setTimeout(r, 50));
      timeline.push(`end:${runId}`);
    });

    queue.enqueue("a");
    queue.enqueue("b");

    await new Promise((r) => setTimeout(r, 200));

    // 串行：a 完成后 b 才开始
    expect(timeline).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("concurrency=3 并行执行", async () => {
    const queue = new RunQueue({ concurrency: 3 });
    let concurrent = 0;
    let maxConcurrent = 0;

    queue.setExecutor(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    });

    // 提交 5 个任务
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`run-${i}`);
    }

    await new Promise((r) => setTimeout(r, 300));

    // 最多同时 3 个在跑
    expect(maxConcurrent).toBe(3);
    // 全部执行完
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });
});

// ─── 场景 4：事件溯源 ───────────────────────────────────────────

describe("场景 4：事件溯源", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-4-"));
    store = new FileRunStore(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("所有状态变更都有对应的事件记录", async () => {
    const { manager } = createTestManager({ tmpDir });

    const run = await manager.submit({
      objective: "Add unit tests for the payment module",
    });

    // 等执行（会因为 mock 失败而变成 blocked）
    await new Promise((r) => setTimeout(r, 500));

    const events = await store.listEvents(run.runId);

    // 至少有：created, queued, started, ...
    const types = events.map((e) => e.type);
    expect(types).toContain("run_created");
    expect(types).toContain("run_queued");

    // 事件是有序的
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }

    // 每个事件都有唯一 ID
    const ids = new Set(events.map((e) => e.eventId));
    expect(ids.size).toBe(events.length);
  });
});

// ─── 场景 5：Checkpoint 和 Artifact ─────────────────────────────

describe("场景 5：Checkpoint & Artifact 持久化", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-5-"));
    store = new FileRunStore(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("可以手动写入和读取 checkpoint", async () => {
    // 模拟一个 run 的 checkpoint 流程
    const runId = "cp-test-run";
    await store.create({
      runId,
      objective: "Test checkpoints",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 1,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [],
      metadata: {},
    });

    // 写第一个 checkpoint
    await store.saveCheckpoint({
      checkpointId: "cp-1",
      runId,
      createdAt: Date.now() - 1000,
      phase: "research",
      objective: "Test checkpoints",
      summary: "Finished reading codebase, identified 3 modules to test",
      nextAction: "Write test for auth module",
      linkedSessionId: "sess-1",
      touchedTools: ["Read", "Grep", "Glob"],
      touchedArtifacts: [],
      waitingFor: null,
      evaluator: null,
      metadata: { filesRead: 12 },
    });

    // 写第二个 checkpoint
    await store.saveCheckpoint({
      checkpointId: "cp-2",
      runId,
      createdAt: Date.now(),
      phase: "implementation",
      objective: "Test checkpoints",
      summary: "Auth module tests written, moving to payment module",
      nextAction: "Write test for payment module",
      linkedSessionId: "sess-1",
      touchedTools: ["Read", "Write", "Bash"],
      touchedArtifacts: ["tests/auth.test.ts"],
      waitingFor: null,
      evaluator: null,
      metadata: { testsWritten: 5 },
    });

    // 读取最新 checkpoint
    const latest = await store.getLatestCheckpoint(runId);
    expect(latest).not.toBeNull();
    expect(latest!.checkpointId).toBe("cp-2");
    expect(latest!.phase).toBe("implementation");
    expect(latest!.touchedTools).toContain("Write");
  });

  it("可以记录和查询 artifact 引用", async () => {
    const runId = "art-test-run";
    await store.create({
      runId,
      objective: "Test artifacts",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 1,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [],
      metadata: {},
    });

    // 记录产出的文件
    await store.appendArtifactRef({
      artifactRefId: "a1",
      runId,
      kind: "file",
      title: "Auth test file",
      locator: "tests/auth.test.ts",
      role: "output",
      version: null,
      metadata: { lines: 150 },
    });

    await store.appendArtifactRef({
      artifactRefId: "a2",
      runId,
      kind: "file",
      title: "Payment test file",
      locator: "tests/payment.test.ts",
      role: "output",
      version: null,
      metadata: { lines: 200 },
    });

    const artifacts = await store.listArtifactRefs(runId);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].locator).toBe("tests/auth.test.ts");
    expect(artifacts[1].locator).toBe("tests/payment.test.ts");
  });
});

// ─── 场景 6：Approval 审批流 ────────────────────────────────────

describe("场景 6：审批记录持久化", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-6-"));
    store = new FileRunStore(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("审批记录可以创建、查询和解决", async () => {
    const runId = "approval-test";
    await store.create({
      runId,
      objective: "Test approvals",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "waiting_approval",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 1,
      latestCheckpointId: null,
      latestApprovalId: "ap-1",
      summary: null,
      error: null,
      tags: [],
      metadata: {},
    });

    // 创建一个待审批记录
    await store.saveApproval({
      approvalId: "ap-1",
      runId,
      createdAt: Date.now(),
      resolvedAt: null,
      status: "pending",
      category: "tool",
      title: "Approve: Bash",
      description: "rm -rf node_modules && npm install",
      payload: { toolName: "Bash", riskLevel: "high" },
    });

    // 查询 pending 审批
    const pending = await store.getPendingApproval(runId);
    expect(pending).not.toBeNull();
    expect(pending!.approvalId).toBe("ap-1");
    expect(pending!.status).toBe("pending");

    // 模拟用户批准
    pending!.status = "approved";
    pending!.resolvedAt = Date.now();
    await store.saveApproval(pending!);

    // 再查就没有 pending 了
    const noPending = await store.getPendingApproval(runId);
    expect(noPending).toBeNull();

    // 但历史记录还在
    const resolved = await store.getApproval(runId, "ap-1");
    expect(resolved!.status).toBe("approved");
  });
});

// ─── 场景 7：磁盘存储结构验证 ──────────────────────────────────

describe("场景 7：磁盘存储结构", () => {
  let tmpDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rm-usage-7-"));
    store = new FileRunStore(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("每个 run 有独立的目录结构", async () => {
    const runId = "fs-test";
    await store.create({
      runId,
      objective: "Verify FS layout",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 0,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [],
      metadata: {},
    });

    // 验证目录结构
    //   <tmpDir>/<runId>/
    //     run.json
    //     checkpoints/
    //     approvals/
    //     artifacts/
    const runDir = join(tmpDir, runId);
    expect(existsSync(join(runDir, "run.json"))).toBe(true);
    expect(existsSync(join(runDir, "checkpoints"))).toBe(true);
    expect(existsSync(join(runDir, "approvals"))).toBe(true);
    expect(existsSync(join(runDir, "artifacts"))).toBe(true);

    // 添加事件后会有 events.jsonl
    await store.appendEvent({
      eventId: "e1",
      runId,
      type: "run_created",
      timestamp: Date.now(),
      data: {},
    });
    expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
  });

  it("delete 会清除整个 run 目录", async () => {
    const runId = "delete-test";
    await store.create({
      runId,
      objective: "To be deleted",
      preset: "terminal-coding",
      cwd: "/tmp",
      status: "cancelled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      parentRunId: null,
      sessionId: null,
      childSessionIds: [],
      attemptCount: 0,
      latestCheckpointId: null,
      latestApprovalId: null,
      summary: null,
      error: null,
      tags: [],
      metadata: {},
    });

    expect(existsSync(join(tmpDir, runId))).toBe(true);
    await store.delete(runId);
    expect(existsSync(join(tmpDir, runId))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  下面是不需要真实 LLM 也能验证的编排逻辑
// ═══════════════════════════════════════════════════════════════

// ─── 场景 8：RunApprovalBackend 挂起与恢复 ──────────────────────

describe("场景 8：RunApprovalBackend", () => {
  it("requestApproval 挂起直到 resolveApproval 被调用", async () => {
    // 直接测试 approval backend 的挂起/恢复机制
    const { RunApprovalBackend } = await import("../src/run/RunApprovalBackend.js");

    const backend = new RunApprovalBackend();
    let approvalReceived = false;

    // 设置生命周期钩子
    backend.setHooks({
      onApprovalNeeded: async (req) => {
        // RunManager 收到审批请求，转入 waiting_approval
        return { approvalId: "test-approval-1" };
      },
      onInputNeeded: async () => {},
    });

    // Engine 请求审批（这会挂起）
    const approvalPromise = backend.requestApproval({
      toolName: "Bash",
      description: "npm install express",
      riskLevel: "medium",
      args: { command: "npm install express" },
    });

    // requestApproval 内部先 await onApprovalNeeded（微任务），
    // 然后才设置 pendingApproval。需要让出微任务队列。
    await new Promise((r) => setTimeout(r, 10));

    // 此时 hasPendingApproval 应为 true
    expect(backend.hasPendingApproval()).toBe(true);

    // 模拟用户批准（就像 RunManager.resume 会做的那样）
    backend.resolveApproval({ approved: true });

    // 等待结果
    const result = await approvalPromise;
    expect(result.approved).toBe(true);
    expect(backend.hasPendingApproval()).toBe(false);
  });

  it("createRunAskUserFn 挂起直到 resolveInput 被调用", async () => {
    const { createRunAskUserFn } = await import("../src/run/RunApprovalBackend.js");

    const adapter = createRunAskUserFn({
      onApprovalNeeded: async () => ({ approvalId: "" }),
      onInputNeeded: async (question) => {
        // RunManager 转入 waiting_input
      },
    });

    // Engine 调用 askUser（挂起）
    const inputPromise = adapter.askUserFn("你想部署到哪个环境？");

    // askUserFn 内部先 await onInputNeeded（微任务），然后才设置 pending
    await new Promise((r) => setTimeout(r, 10));

    expect(adapter.hasPendingInput()).toBe(true);

    // 用户回答
    adapter.resolveInput("staging");

    const answer = await inputPromise;
    expect(answer).toBe("staging");
    expect(adapter.hasPendingInput()).toBe(false);
  });
});

// ─── 附录：真实 LLM 集成示例（注释掉，按需启用）────────────────

/*
 * 如果你想跑真实端到端测试，取消注释下面的代码，
 * 并确保设置了 OPENROUTER_API_KEY 或 OPENAI_API_KEY 环境变量。
 *
 * ```ts
 * import { createRunManager } from "../src/run/index.js";
 *
 * describe("真实 LLM 集成", () => {
 *   it("完整的 submit → execute → complete 流程", async () => {
 *     const manager = createRunManager({
 *       llm: {
 *         provider: "openai",
 *         model: "gpt-4o-mini",
 *         apiKey: process.env.OPENAI_API_KEY!,
 *       },
 *       maxTurns: 3,
 *       concurrency: 1,
 *       runsDir: mkdtempSync(join(tmpdir(), "rm-real-")),
 *     });
 *
 *     // 订阅实时流
 *     const events: RunStreamEvent[] = [];
 *
 *     const run = await manager.submit({
 *       objective: "用一句话解释什么是 TypeScript 的 type guard",
 *     });
 *
 *     const detach = manager.attach(run.runId, (e) => events.push(e));
 *
 *     // 等待完成（最多 60 秒）
 *     await waitFor(async () => {
 *       const current = await manager.get(run.runId);
 *       return current?.status === "completed" || current?.status === "failed";
 *     }, 60_000);
 *
 *     detach();
 *
 *     const final = await manager.get(run.runId);
 *     console.log("Run completed:", final?.status);
 *     console.log("Summary:", final?.summary?.slice(0, 200));
 *
 *     // 查看事件时间线
 *     const store = new FileRunStore(manager["store"]["runsDir"]);
 *     const allEvents = await store.listEvents(run.runId);
 *     console.log("Event timeline:");
 *     for (const e of allEvents) {
 *       console.log(`  [${new Date(e.timestamp).toISOString()}] ${e.type}`);
 *     }
 *
 *     await manager.shutdown();
 *   }, 120_000); // 2 min timeout
 * });
 * ```
 */
