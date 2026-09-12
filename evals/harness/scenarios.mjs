import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DESKTOP_CASE_IDS = Object.freeze([
  "interrupted-reply-later-restart",
  "mimi-queued-input-reload",
  "approval-reload-write",
  "mimi-file-queue-completed-reload",
  "ordinary-steer-cache-cursor",
]);

export function scenarioFor(caseId, seed, trial = 1) {
  if (!DESKTOP_CASE_IDS.includes(caseId)) throw new Error(`Unknown desktop case: ${caseId}`);
  const nonce = createHash("sha256")
    .update(`${caseId}:${seed}:${trial}`)
    .digest("hex")
    .slice(0, 12);
  const catalog = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
  const definition = catalog.cases.find((entry) => entry.id === caseId);
  if (!definition || definition.adapter !== "desktop")
    throw new Error(`No desktop definition: ${caseId}`);
  const input = JSON.parse(JSON.stringify(definition.input).replaceAll("{{caseNonce}}", nonce));
  return {
    id: caseId,
    version: definition.version,
    nonce,
    input,
    hardAssertions: definition.hardAssertions,
    semanticRubric: definition.semanticRubric,
    surface: caseId.startsWith("mimi-") ? "mimi" : "ordinary",
    first: input.prompts[0],
    second: input.prompts[1],
    third: input.prompts[2],
    writeContent: `${caseId === "approval-reload-write" ? "approved" : "orchid"}-${nonce}\n`,
  };
}

export class DesktopEvalFailure extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "DesktopEvalFailure";
    this.code = code;
    this.details = details;
  }
}

export function normalizeVisibleText(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function deliveredPrefixMatches(answers, deliveredText) {
  return (
    typeof deliveredText === "string" &&
    deliveredText.length > 0 &&
    answers.length === 1 &&
    answers[0] === normalizeVisibleText(deliveredText)
  );
}

/** Compare what the real model already rendered, without predicting its prose. */
export function sameConversation(before, after) {
  return (
    JSON.stringify(before.users) === JSON.stringify(after.users) &&
    JSON.stringify(before.answers) === JSON.stringify(after.answers)
  );
}

export function deliveryIdentity(envelope, index) {
  if (envelope.sessionId && envelope.epoch && Number.isSafeInteger(envelope.seq))
    return `${envelope.sessionId}:${envelope.epoch}:${envelope.seq}`;
  // No cursor means no proven replay identity: count every observed delivery conservatively.
  return `unsequenced-delivery:${index}`;
}

/** A streamed tool name alone is not evidence that the tool executed. */
export function successfulToolResults(events, toolName, sessionId) {
  const results = new Map();
  for (const [index, envelope] of events.entries()) {
    if (sessionId && envelope.sessionId !== sessionId) continue;
    const event = envelope.event ?? envelope;
    if (event.type !== "tool_result") continue;
    const result = event.result;
    if (result?.toolName !== toolName || result.isError || result.error || !result.id) continue;
    results.set(deliveryIdentity(envelope, index), result);
  }
  return [...results.values()];
}

function executionInventory(ctx) {
  return {
    requests: ctx
      .requests()
      .filter((entry) => entry.stream)
      .map((entry) => entry.id),
    tools: [
      ...new Set(
        ctx.report.streamEvents
          .map((entry, index) => ({ entry, identity: deliveryIdentity(entry, index) }))
          .filter(({ entry }) => ["tool_use_start", "tool_result"].includes(entry.event.type))
          .map(({ identity }) => identity),
      ),
    ].sort(),
  };
}

async function preserveCompleted(ctx, before, name) {
  const executionBefore = executionInventory(ctx);
  await ctx.reload();
  await ctx.until(
    async () => (await ctx.conversation()).answers.length >= before.answers.length,
    "restored conversation",
  );
  await ctx.pause(1200);
  const after = await ctx.conversation();
  ctx.check(sameConversation(before, after), name, { before, after });
  ctx.check(
    JSON.stringify(executionBefore) === JSON.stringify(executionInventory(ctx)),
    `${name}-no-reexecution`,
  );
  await ctx.capture(name);
  return after;
}

async function queuedMimi(ctx, withFile) {
  const s = ctx.scenario;
  const ticket = await ctx.hold({ minTextChars: 1 });
  await ctx.send(s.first);
  await ctx.waitHeld(ticket);
  await ctx.until(
    async () => (await ctx.conversation()).answers.some(Boolean),
    "first visible model text",
  );
  const partial = await ctx.conversation();
  const second = s.second;
  if (withFile) await ctx.attachOwnFile();
  await ctx.send(second);
  const beforeStatus = await ctx.petStatus();
  const accepted = beforeStatus.chatInputs?.find((input) => input.message.includes(second));
  ctx.check(accepted?.pending && !!accepted.clientMessageId, "queued-input-owned-by-main", {
    accepted,
  });
  ctx.report.facts.clientMessageId = accepted.clientMessageId;
  ctx.report.facts.sessionId = beforeStatus.petSessionId;
  if (withFile)
    ctx.check(accepted.message.includes(ctx.fixturePath), "queued-input-has-own-file-path");
  await ctx.capture("queued-before-reload");
  await ctx.reload();
  await ctx.pause(2000); // The real proxy is still holding subsequent model bytes.
  const restoredStatus = await ctx.petStatus();
  const restored = restoredStatus.chatInputs?.filter(
    (input) => input.clientMessageId === accepted.clientMessageId,
  );
  const heldRows = await ctx.conversation();
  ctx.check(
    restored?.length === 1 && restored[0].pending && restored[0].message === accepted.message,
    "queued-identity-survives-reload",
    { restored },
  );
  ctx.check(
    heldRows.users.filter((text) => text.includes(normalizeVisibleText(second))).length === 1,
    "queued-user-displayed-once",
    { heldRows },
  );
  ctx.check(
    partial.answers.every((answer) => heldRows.answers.includes(answer)),
    "held-first-reply-retained",
  );
  ctx.check(await ctx.busy(), "held-stream-still-busy");
  await ctx.capture("queued-reloaded-held");
  await ctx.release(ticket);
  await ctx.idle(2);
  const completed = await ctx.conversation();
  ctx.check(
    completed.users.length === 2 && completed.answers.length >= 2,
    "both-real-turns-rendered",
    { completed },
  );
  const finalStatus = await ctx.petStatus();
  ctx.check(
    !finalStatus.chatInputs?.some((input) => input.clientMessageId === accepted.clientMessageId),
    "completed-input-retired",
  );
  const disk = await ctx.sessionEvidence(beforeStatus.petSessionId, "completed");
  ctx.check(
    disk.transcript.filter(
      (item) => item.kind === "user" && item.clientMessageId === accepted.clientMessageId,
    ).length === 1,
    "durable-original-input-once",
  );
  await ctx.capture("completed-before-reload");
  await preserveCompleted(ctx, completed, "completed-reload-preserves-real-replies");
  ctx.report.answers = completed.answers;
  ctx.check(completed.answers.length === 2, "two-direct-model-answers-once", { completed });
  const users = disk.transcript.filter((item) => item.kind === "user");
  ctx.check(
    users.length === 2 && new Set(users.map((item) => item.clientMessageId)).size === 2,
    "two-durable-distinct-inputs",
    { users },
  );
  ctx.report.facts.clientMessageIds = users.map((item) => item.clientMessageId);
  if (withFile) {
    ctx.canonical("actual-file-path", true);
    ctx.canonical("completed-once", true);
    ctx.check(await ctx.workspaceUnchanged(), "attachment-and-workspace-unchanged");
    ctx.canonical("read-only", true);
  } else {
    ctx.canonical("pending-visible", true);
    ctx.canonical("ordered-once", true);
  }
  ctx.report.facts.fileAttachmentScope = withFile
    ? "desktop path reference; no claim of file-content inspection or IM structured attachment"
    : undefined;
}

async function writeApproval(ctx, steer) {
  const s = ctx.scenario;
  await ctx.send(s.first);
  const pending = await ctx.waitWriteApproval();
  const sessionId = pending.sessionId;
  ctx.report.facts.sessionId = sessionId;
  ctx.report.facts.approvalRequestId = pending.requestId;
  ctx.check(
    resolve(ctx.workspace, pending.request.args.file_path ?? "") === ctx.targetPath,
    "model-selected-correct-write-target",
    { request: pending.request },
  );
  ctx.check(!(await ctx.targetExists()), "no-write-before-approval");
  await ctx.capture("write-pending");
  if (steer) {
    await ctx.send(s.second);
    await ctx.until(
      async () => (await ctx.queuedUi(s.second)).count === 1,
      "real follow-up queue item",
    );
    ctx.report.facts.queuedUi = await ctx.queuedUi(s.second);
    ctx.check(
      ctx.report.facts.queuedUi.count === 1,
      "steered-input-visible-once-in-follow-up-queue",
    );
    await ctx.capture("steered-input-queued");
  } else {
    await ctx.reload();
    const restored = await ctx.waitWriteApproval();
    ctx.check(
      restored.requestId === pending.requestId && restored.sessionId === sessionId,
      "same-pending-approval-restored",
      { restored },
    );
    ctx.check((await ctx.approvalCount()) === 1, "one-operable-approval-card");
    ctx.canonical("approval-once", true);
    ctx.check(!(await ctx.targetExists()), "reload-does-not-authorize-write");
    await ctx.capture("write-approval-restored");
  }
  // This is the real product approval action; the model authored the tool call.
  if (!steer) ctx.canonical("no-early-write", true);
  await ctx.approveWrite();
  await ctx.until(() => ctx.targetExists(), "approved real file write");
  await ctx.idle(1);
  if (steer)
    await ctx.until(async () => {
      const e = await ctx.readSnapshot(sessionId);
      return e.events.some((entry) => entry.event.type === "steer_injected") && !e.topLevelRunning;
    }, "steered execution completed");
  ctx.check((await ctx.readTarget()) === s.writeContent, "actual-file-bytes-correct");
  const evidence = await ctx.sessionEvidence(sessionId, "completed");
  const writes = successfulToolResults(ctx.report.streamEvents, "Write", sessionId);
  ctx.check(writes.length === 1, "one-successful-real-Write-result", { writes });
  ctx.report.facts.writeResults = writes;
  ctx.report.facts.writeDeliveries = ctx.report.streamEvents.filter(
    (entry) =>
      entry.sessionId === sessionId &&
      entry.event.type === "tool_result" &&
      entry.event.result.toolName === "Write",
  );
  if (steer) {
    const reads = successfulToolResults(ctx.report.streamEvents, "Read", sessionId);
    ctx.check(reads.length >= 1, "real-Read-result-observed", { reads });
    ctx.report.facts.readResults = reads;
  }
  ctx.check(await ctx.onlyTargetChanged(), "only-target-file-changed");
  const before = await ctx.conversation();
  ctx.check(before.users.length === (steer ? 2 : 1), "expected-user-turn-count", { before });
  if (steer) {
    ctx.check(
      evidence.snapshot.events.some((entry) => entry.event.type === "steer_injected"),
      "snapshot-has-stable-steer",
    );
    ctx.report.facts.cachedCursor = await ctx.cachedCursor(sessionId);
    const users = evidence.transcript.filter((item) => item.kind === "user");
    const steers = evidence.snapshot.events.filter(
      (entry) => entry.event.type === "steer_injected",
    );
    ctx.report.facts.clientSteerMap = { users, steers };
    ctx.check(
      users.length === 2 &&
        users.every((item) => !!item.clientMessageId) &&
        users[0].clientMessageId !== users[1].clientMessageId &&
        !!users[1].steerId &&
        steers.some((entry) => entry.event.id === users[1].steerId),
      "canonical-steer-client-identity-aligned",
    );
  }
  await ctx.capture("write-complete-before-reload");
  await preserveCompleted(ctx, before, "write-completed-reload-no-duplicate");
  ctx.check((await ctx.readTarget()) === s.writeContent, "file-bytes-stable-after-reload");
  if (steer) {
    await preserveCompleted(ctx, before, "second-reload-no-duplicate");
    await restartPreserved(ctx, before, "full-restart-no-duplicate");
    ctx.canonical(
      "unique-intents-replies",
      true,
      "Stable user IDs and actual model reply arrays preserved across two reloads and a full restart; identical-text intent adversarial inputs remain repository coverage.",
    );
    ctx.check(
      successfulToolResults(ctx.report.streamEvents, "Write", sessionId).length === 1,
      "one-Write-after-all-recoveries",
    );
    ctx.check(await ctx.onlyTargetChanged(), "only-target-changed-after-all-recoveries");
    ctx.canonical("exactly-one-write", true);
    ctx.canonical(
      "cursor-consistency",
      null,
      "This live trial captures the actual cache cursor; missing-tail/empty-canonical prefix sweeps require the separate repository regression.",
    );
  } else ctx.canonical("exact-write-once", true);
  ctx.report.answers = before.answers;
}

async function restartPreserved(ctx, before, name) {
  await ctx.close();
  const executionBefore = executionInventory(ctx);
  await ctx.boot();
  await ctx.openSurface();
  await ctx.until(
    async () => (await ctx.conversation()).answers.length >= before.answers.length,
    "restored history",
  );
  await ctx.pause(1500);
  const after = await ctx.conversation();
  const prefix = ctx.report.facts.held?.deliveredText;
  if (
    !sameConversation(before, after) &&
    prefix &&
    /(?:^|\n)\s*(?:#{1,6} |[-*] |\d+\. )|[*_`\[\]]/u.test(prefix) &&
    JSON.stringify(before.users) === JSON.stringify(after.users) &&
    before.answers.length === after.answers.length &&
    before.answers[0] === normalizeVisibleText(prefix) &&
    after.answers[0] !== before.answers[0]
  ) {
    throw new DesktopEvalFailure(
      "rendering_boundary",
      "Stream/plain and restored Markdown displays differ; exact content recovery is not proven",
      { before, after, deliveredText: prefix },
    );
  }
  ctx.check(sameConversation(before, await ctx.conversation()), name, {
    before,
    after: await ctx.conversation(),
  });
  ctx.check(
    JSON.stringify(executionInventory(ctx)) === JSON.stringify(executionBefore),
    `${name}-no-model-reexecution`,
  );
  await ctx.capture(name);
}

async function interrupted(ctx) {
  const s = ctx.scenario;
  const ticket = await ctx.hold({ minTextChars: 32 });
  await ctx.send(s.first);
  const held = await ctx.waitHeld(ticket);
  ctx.check(
    typeof held?.deliveredText === "string" && held.deliveredText.length > 0,
    "proxy-recorded-real-delivered-prefix",
    { held },
  );
  const sessionId = ctx.report.streamEvents.find(
    (entry) => entry.event.type === "session_started",
  )?.sessionId;
  ctx.check(!!sessionId, "interrupted-session-identity-observed");
  await ctx.until(
    () =>
      ctx.report.streamEvents
        .filter((entry) => entry.sessionId === sessionId && entry.event.type === "text_delta")
        .map((entry) => entry.event.text)
        .join("") === held.deliveredText,
    "real IPC text caught up with held provider bytes",
  );
  await ctx.until(async () => {
    const visible = await ctx.conversation();
    return deliveredPrefixMatches(visible.answers, held.deliveredText);
  }, "typing animation caught up with delivered prefix");
  const partial = await ctx.conversation();
  ctx.check(
    partial.answers.length === 1 && partial.answers[0].length > 0,
    "real-model-partial-observed",
    { partial },
  );
  ctx.report.facts.interruptedPrefix = partial.answers[0];
  ctx.report.facts.held = held;
  ctx.report.facts.sessionId = sessionId;
  await ctx.capture("interrupted-before-close");
  await ctx.close();
  await ctx.release(ticket);
  await ctx.until(
    () =>
      ctx
        .requests()
        .some(
          (request) =>
            request.aborted && (held?.requestId === undefined || request.id === held.requestId),
        ),
    "actual-stream-aborted",
  );
  await restartPreserved(ctx, partial, "first-restart-preserves-partial-once");
  await ctx.send(s.second);
  await ctx.idle(2);
  const later = await ctx.conversation();
  ctx.check(
    later.answers.filter((text) => text === partial.answers[0]).length === 1,
    "later-turn-keeps-interrupted-reply",
  );
  await restartPreserved(ctx, later, "second-restart-preserves-both-turns-once");
  await ctx.send(s.third);
  await ctx.idle(3);
  const final = await ctx.conversation();
  await restartPreserved(ctx, final, "third-restart-preserves-all-turns-once");
  const disk = await ctx.sessionEvidence(sessionId, "third-restart");
  const users = disk.transcript.filter((item) => item.kind === "user");
  ctx.report.facts.clientMessageIds = users.map((item) => item.clientMessageId);
  ctx.check(
    users.length === 3 &&
      users.every((item) => !!item.clientMessageId) &&
      new Set(users.map((item) => item.clientMessageId)).size === 3,
    "three-distinct-durable-inputs",
    { users },
  );
  ctx.check(
    final.users.length === 3 &&
      final.answers.length === 3 &&
      final.answers[0] === partial.answers[0],
    "three-user-answers-in-original-order",
    { final },
  );
  ctx.canonical("received-prefix-preserved", true);
  ctx.canonical("intent-unique", true);
  ctx.canonical(
    "no-reexecution",
    true,
    "No streaming model request was added during any restart observation window; tool events and request logs retained.",
  );
  ctx.report.answers = final.answers;
  ctx.report.facts.mainRestarts = 3;
}

export async function executeDesktopScenario(ctx) {
  switch (ctx.scenario.id) {
    case "interrupted-reply-later-restart":
      return interrupted(ctx);
    case "mimi-queued-input-reload":
      return queuedMimi(ctx, false);
    case "mimi-file-queue-completed-reload":
      return queuedMimi(ctx, true);
    case "approval-reload-write":
      return writeApproval(ctx, false);
    case "ordinary-steer-cache-cursor":
      return writeApproval(ctx, true);
    default:
      throw new Error(`Unsupported case: ${ctx.scenario.id}`);
  }
}
