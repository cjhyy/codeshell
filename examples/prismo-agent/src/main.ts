/**
 * Prismo Agent (Phase 0) — fixture-driven `prd_bundle` workflow.
 *
 * Run:
 *   export OPENAI_API_KEY=sk-...     # or OPENROUTER_API_KEY
 *   bun examples/prismo-agent/src/main.ts
 *
 * Outputs to ./output/:
 *   - run-events.json       full RunStreamEvent log (run_status_changed / run_event / engine_stream)
 *   - draft-prd.md          first PRD draft, if any
 *   - draft-flowchart-*.mmd flowchart drafts
 *   - draft-prototype-*.html prototype drafts
 *   - evaluation.json       structured evaluator findings
 *   - drafts.json           raw draft store snapshot
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunStreamEvent } from "../../../src/index.js";
import { createPrismoAgent } from "./product.js";
import { runStore } from "./tools.js";
import { evaluatePrismoBundle } from "./evaluator.js";
import { FIXTURE_BUNDLE } from "./fixtures.js";

const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("请设置 OPENAI_API_KEY 或 OPENROUTER_API_KEY");
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(HERE, "..", "output");
mkdirSync(OUTPUT_DIR, { recursive: true });

const product = createPrismoAgent({
  apiKey,
  model: process.env.MODEL ?? "gpt-4o-mini",
  baseUrl: process.env.OPENROUTER_API_KEY
    ? "https://openrouter.ai/api/v1"
    : undefined,
  // Keep run state local to the example dir so fixtures don't pollute ~/.code-shell.
  runsDir: resolve(HERE, "..", ".runs"),
  cwd: resolve(HERE, ".."),
});

const objective = `
你正在为 Prismo 项目「${FIXTURE_BUNDLE.project.title}」执行 workflow=prd_bundle。

请按系统提示词中的工作流，依次：
1. LoadPrismoContext 加载完整上下文；
2. 基于已有 messages / inputSources，产出：
   - 1 份 PRD draft（必须包含 概述/问题/目标用户/功能/范围/用户流程/成功指标/待确认问题 等章节）
   - 1 张主流程图 draft（Mermaid，graph TD 开头，对应「孩子写作业」核心用户流程）
   - 1 个家长每日进度看板原型（完整 HTML）
3. 调用 RunArtifactEvaluator；
4. 用一段总结回复，列出 produced drafts、变更摘要、待确认问题，并简述 evaluator findings。
`.trim();

console.log("[prismo-agent] submitting run with workflow=prd_bundle");

const snapshot = await product.manager.submit({
  objective,
  tags: ["workflow:prd_bundle"],
  metadata: { workflow: "prd_bundle", projectId: FIXTURE_BUNDLE.project.id },
});

const runId = snapshot.runId;
console.log(`[prismo-agent] runId=${runId}`);

// ─── Subscribe to run stream and capture every event ──────────────

const events: Array<{ at: string; event: RunStreamEvent }> = [];
const detach = product.manager.attach(runId, (event) => {
  events.push({ at: new Date().toISOString(), event });

  if (event.type === "run_status_changed") {
    console.log(`[run] status -> ${event.run.status}`);
  } else if (event.type === "run_event") {
    console.log(`[event] ${event.event.type}`);
  } else if (event.type === "engine_stream") {
    const e = event.event;
    if (e.type === "tool_use_start") {
      console.log(`[tool] ${e.toolCall.toolName}`);
    } else if (e.type === "text_delta") {
      process.stdout.write(e.text);
    }
  }
});

// ─── Wait for terminal state ──────────────────────────────────────

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

async function waitTerminal(): Promise<void> {
  // Light polling on top of the live attach — keeps the demo simple.
  // Real Prismo backend will rely on the attach callback exclusively.
  while (true) {
    const snap = await product.manager.get(runId);
    if (snap && TERMINAL.has(snap.status)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

await waitTerminal();
detach();

console.log("\n[prismo-agent] run terminal — writing outputs");

// ─── Persist run events ───────────────────────────────────────────

writeFileSync(
  join(OUTPUT_DIR, "run-events.json"),
  JSON.stringify(events, null, 2),
  "utf-8",
);

// ─── Persist drafts ───────────────────────────────────────────────

const drafts = runStore.listDrafts();
writeFileSync(
  join(OUTPUT_DIR, "drafts.json"),
  JSON.stringify(drafts, null, 2),
  "utf-8",
);

let prototypeIdx = 0;
let flowchartIdx = 0;
for (const draft of drafts) {
  if (draft.kind === "prd") {
    writeFileSync(join(OUTPUT_DIR, "draft-prd.md"), draft.content, "utf-8");
  } else if (draft.kind === "flowchart") {
    flowchartIdx += 1;
    writeFileSync(
      join(OUTPUT_DIR, `draft-flowchart-${flowchartIdx}.mmd`),
      draft.content,
      "utf-8",
    );
  } else if (draft.kind === "prototype") {
    prototypeIdx += 1;
    writeFileSync(
      join(OUTPUT_DIR, `draft-prototype-${prototypeIdx}.html`),
      draft.content,
      "utf-8",
    );
  }
}

// ─── Final evaluation snapshot ────────────────────────────────────

const evaluation = evaluatePrismoBundle({
  project: FIXTURE_BUNDLE.project,
  drafts,
});

writeFileSync(
  join(OUTPUT_DIR, "evaluation.json"),
  JSON.stringify(evaluation, null, 2),
  "utf-8",
);

const final = await product.manager.get(runId);

console.log("\n[prismo-agent] summary");
console.log("  status     :", final?.status);
console.log("  drafts     :", drafts.map((d) => `${d.kind}:${d.title}`).join(", ") || "(none)");
console.log("  score      :", evaluation.score);
console.log("  passed     :", evaluation.passed);
console.log("  findings   :", evaluation.findings.length);
console.log("  outputs at :", OUTPUT_DIR);

if (final?.status !== "completed") {
  process.exit(1);
}
