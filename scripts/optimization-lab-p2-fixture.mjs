/** Pure local compiled-consumer acceptance. No sockets, accounts or model service. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "codeshell-lab-p2-"));
const home = join(root, "home");
const cwd = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AGENT_CWD = cwd;
process.env.CODE_SHELL_HOME = join(home, ".code-shell");
process.env.CODE_SHELL_TEST_HOME = process.env.CODE_SHELL_HOME;
globalThis.fetch = async () => {
  throw new Error("Pure fixture refuses network access");
};
try {
  const core = await import("../packages/core/dist/index.extension.js");
  const { createServer, createClient } =
    await import("../packages/core/dist/protocol/factories.js");
  const { createInProcessTransport } = await import("../packages/core/dist/protocol/transport.js");
  const { readSkillSnapshot } = core;
  const name = "p2-fixture";
  const source = "---\nname: p2-fixture\ndescription: Pure fixture\n---\nORIGINAL_INSTRUCTION\n";
  const skillFile = join(cwd, ".code-shell/skills", name, "SKILL.md");
  mkdirSync(join(cwd, ".code-shell/skills", name), { recursive: true });
  writeFileSync(skillFile, source);
  const sourceRevision = readSkillSnapshot(name, cwd).revision;
  const bindingRoot = join(root, "binding-store");
  const store = new core.InstructionBindingStore(bindingRoot);
  const observations = [];
  const upstream = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.json();
    observations.push(body);
    assert.equal(body.stream, true);
    assert.equal(body.model, "fixture-model");
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 128);
    assert.ok(!body.tools?.length);
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer [S1]" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const llm = {
    provider: "openai",
    model: "fixture-model",
    apiKey: "fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    maxTokens: 128,
  };
  const isolated = await core.runIsolatedInstruction({
    cwd,
    llm,
    clientDefaults: { temperature: 0.3, retryMaxAttempts: 1, fetch: upstream },
    name,
    sourceRevision,
    body: "ADOPTED_INSTRUCTION",
    task: "Produce a fixture response",
    receiptRoot: bindingRoot,
  });
  assert.equal(isolated.reason, "completed");
  assert.equal(isolated.receipt.completed, true);
  assert.ok(JSON.stringify(observations[0]).includes("ADOPTED_INSTRUCTION"));
  assert.equal(
    existsSync(join(process.env.CODE_SHELL_HOME, "sessions", isolated.sessionId)),
    false,
  );
  assert.equal(readFileSync(skillFile, "utf8"), source);
  assert.equal(existsSync(join(process.env.CODE_SHELL_HOME, "memory")), false);
  assert.equal(existsSync(join(process.env.CODE_SHELL_HOME, "dream")), false);
  mkdirSync(join(root, "other"), { recursive: true });
  const { runTrial } = await import("../packages/optimization-lab/dist/runner.js");
  const { planContent } =
    await import("../packages/optimization-lab/dist/test-fixtures/foundation.js");
  const { createExperimentPlan } =
    await import("../packages/optimization-lab/dist/contracts/experiment.js");
  const content = planContent();
  content.runnerVersion = "codeshell_isolated_v1";
  const sourceSnapshot = readSkillSnapshot(name, cwd);
  content.skill = {
    ...content.skill,
    name,
    revision: sourceRevision,
    markdown: sourceSnapshot.markdown,
    body: sourceSnapshot.body,
    frontmatterOriginal: sourceSnapshot.markdown.slice(0, -sourceSnapshot.body.length),
    markdownHash: core.instructionHash(sourceSnapshot.markdown),
    bodyHash: core.instructionHash(sourceSnapshot.body),
  };
  content.connections.target = {
    ...content.connections.target,
    providerKind: "openai",
    modelId: llm.model,
    endpoint: llm.baseUrl,
  };
  content.bounds.trial.maxOutputTokens = 128;
  let admitted = 0;
  const settled = [];
  const trial = await runTrial({
    plan: createExperimentPlan(content),
    case: {
      id: "one",
      input: "Answer a fixture question",
      readiness: "runnable",
      fixtureRefs: [],
      hardAssertions: [{ id: "source", kind: "contains", value: "[S1]" }],
      rubric: [],
    },
    body: "ADOPTED_INSTRUCTION",
    phase: "holdout",
    repeat: 0,
    cwd,
    bindingRoot,
    connection: {
      config: llm,
      identity: content.connections.target,
      temperature: 0.3,
      wireParameters: { temperature: 0.3 },
    },
    accounting: {
      check() {},
      admit() {
        assert.equal(++admitted, 1);
        return { deadlineAt: Date.now() + 30000 };
      },
      dispatch() {},
      finish(observation) {
        settled.push(observation);
      },
    },
    upstream,
  });
  assert.equal(trial.status, "completed", JSON.stringify(trial));
  assert.equal(admitted, 1);
  assert.equal(settled[0].outcome, "settled");
  assert.equal(settled[0].usage.inputTokens, 40);
  assert.ok(trial.instructionReceiptId);
  const anthropicLlm = { ...llm, provider: "anthropic", baseUrl: "http://127.0.0.1:9" };
  const anthropicContent = structuredClone(content);
  anthropicContent.connections.target = {
    ...anthropicContent.connections.target,
    providerKind: "anthropic",
    endpoint: anthropicLlm.baseUrl,
  };
  let anthropicAdmitted = 0;
  const anthropicTrial = await runTrial({
    plan: createExperimentPlan(anthropicContent),
    case: {
      id: "anthropic",
      input: "Answer the current case",
      readiness: "runnable",
      fixtureRefs: [],
      hardAssertions: [{ id: "source", kind: "contains", value: "[S1]" }],
      rubric: [],
    },
    body: "ADOPTED_INSTRUCTION",
    phase: "holdout",
    repeat: 0,
    cwd,
    bindingRoot,
    connection: {
      config: anthropicLlm,
      identity: anthropicContent.connections.target,
      temperature: 0.3,
      wireParameters: { temperature: 0.3 },
    },
    accounting: {
      check() {},
      admit() {
        assert.equal(++anthropicAdmitted, 1);
        return { deadlineAt: Date.now() + 30000 };
      },
      dispatch() {},
      finish(observation) {
        assert.equal(observation.usage?.inputTokens, 40);
      },
    },
    upstream: async (input, init) => {
      const body = await new Request(input, init).json();
      assert.equal(body.stream, true);
      assert.ok(!body.tools?.length);
      assert.ok(JSON.stringify(body.system).includes("ADOPTED_INSTRUCTION"));
      const frames = [
        {
          type: "message_start",
          message: {
            id: "anthropic-fixture",
            type: "message",
            model: llm.model,
            role: "assistant",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 40, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture answer [S1]" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  assert.equal(anthropicTrial.status, "completed", JSON.stringify(anthropicTrial));
  assert.equal(anthropicAdmitted, 1);
  assert.equal(existsSync(join(process.env.CODE_SHELL_HOME, "memory")), false);
  assert.equal(existsSync(join(process.env.CODE_SHELL_HOME, "dream")), false);
  assert.equal(existsSync(join(process.env.CODE_SHELL_HOME, "sessions", ".operations")), false);
  const binding = store.adopt({
    scope: { cwd, provider: "openai", model: "fixture-model" },
    name,
    sourceRevision,
    body: "ADOPTED_INSTRUCTION",
    evidenceHash: "a".repeat(64),
    receiptIds: [isolated.receipt.id],
  });
  assert.equal(store.resolve({ cwd, provider: "openai", model: "other-model" }).length, 0);
  assert.equal(
    store.resolve({ cwd: join(root, "other"), provider: "openai", model: "fixture-model" }).length,
    0,
  );
  assert.equal(
    store.adopt({
      scope: binding.scope,
      name,
      sourceRevision,
      body: "ADOPTED_INSTRUCTION",
      evidenceHash: "a".repeat(64),
      receiptIds: [isolated.receipt.id],
    }).snapshot.bindingId,
    binding.snapshot.bindingId,
  );
  assert.throws(
    () =>
      store.adopt({
        scope: binding.scope,
        name,
        sourceRevision: "b".repeat(64),
        body: "ADOPTED_INSTRUCTION",
        evidenceHash: "a".repeat(64),
        receiptIds: [isolated.receipt.id],
      }),
    /revision changed/,
  );
  const secondName = "p2-second";
  const secondFile = join(cwd, ".code-shell/skills", secondName, "SKILL.md");
  mkdirSync(join(cwd, ".code-shell/skills", secondName), { recursive: true });
  writeFileSync(
    secondFile,
    "---\nname: p2-second\ndescription: Second fixture\n---\nSECOND_ORIGINAL\n",
  );
  const secondRevision = readSkillSnapshot(secondName, cwd).revision;
  const secondTrial = await core.runIsolatedInstruction({
    cwd,
    llm,
    clientDefaults: { retryMaxAttempts: 1, fetch: upstream },
    name: secondName,
    sourceRevision: secondRevision,
    body: "SECOND_ADOPTED",
    task: "Second isolated fixture",
    receiptRoot: bindingRoot,
  });
  const second = store.adopt({
    scope: binding.scope,
    name: secondName,
    sourceRevision: secondRevision,
    body: "SECOND_ADOPTED",
    evidenceHash: "b".repeat(64),
    receiptIds: [secondTrial.receipt.id],
  });
  const sessionTrial = await core.runIsolatedInstruction({
    cwd,
    llm,
    clientDefaults: { retryMaxAttempts: 1, fetch: upstream },
    name,
    sourceRevision,
    body: "SESSION_ADOPTED",
    task: "Session isolated fixture",
    receiptRoot: bindingRoot,
  });
  let unblock;
  let began;
  let block = false;
  let lastSignal;
  const seen = [];
  class FixtureClient extends core.LLMClientBase {
    initClient() {}
    async createMessage(options) {
      seen.push({ prompt: options.systemPrompt, messages: options.messages, tools: options.tools });
      if (block) {
        lastSignal = options.signal;
        began?.();
        await new Promise((resolve) => {
          unblock = resolve;
        });
      }
      const response = {
        text: `DERIVED_RESPONSE_${seen.length}`,
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      };
      this.recordUsage(response.usage, options);
      return response;
    }
  }
  core.registerProvider("openai", FixtureClient);
  const [serverTransport, clientTransport] = createInProcessTransport();
  const handle = createServer({
    transport: serverTransport,
    cwd,
    llm,
    engineOverrides: {
      settingsScope: "isolated",
      enabledBuiltinTools: [],
      sessionStorageDir: join(root, "sessions"),
      modules: [{ id: "fixture-bindings", engine: { instructionBindings: store.provider() } }],
      behaviorProfiles: [
        {
          id: "fixture",
          disableHooks: true,
          disableSessionTitle: true,
          disableMemoryContext: true,
          disableMcp: true,
        },
        {
          id: "no-instructions",
          disableInstructions: true,
          disableHooks: true,
          disableSessionTitle: true,
          disableMemoryContext: true,
          disableMcp: true,
        },
      ],
    },
  });
  const client = createClient({ transport: clientTransport });
  // This ordinary-Session fixture disables the unrelated background memory pipeline.
  // The isolated helper above exercises the production ephemeral no-memory lifecycle.
  handle.engine.runMemoryPipeline = async () => {};
  let ownershipHandle;
  let ownershipClient;
  let ownershipBinding;
  try {
    await client.run("USER_ORIGINAL_TASK", { sessionId: "ordinary", behaviorMode: "fixture" });
    assert.ok(seen.at(-1).prompt.includes("ADOPTED_INSTRUCTION"));
    assert.ok(seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    const initialReply = `DERIVED_RESPONSE_${seen.length}`;
    await client.run("USER_IDLE_TASK", { sessionId: "idle", behaviorMode: "fixture" });
    await client.run("USER_FORMER_OWNER", { sessionId: "ownership", behaviorMode: "fixture" });
    ownershipBinding = store.adopt({
      scope: { ...binding.scope, sessionId: "ownership" },
      name,
      sourceRevision,
      body: "SESSION_ADOPTED",
      evidenceHash: "d".repeat(64),
      receiptIds: [sessionTrial.receipt.id],
    });
    const [ownershipServerTransport, ownershipClientTransport] = createInProcessTransport();
    ownershipHandle = createServer({
      transport: ownershipServerTransport,
      cwd,
      llm,
      engineOverrides: {
        settingsScope: "isolated",
        enabledBuiltinTools: [],
        sessionStorageDir: join(root, "sessions"),
        modules: [{ id: "fixture-bindings", engine: { instructionBindings: store.provider() } }],
        behaviorProfiles: [
          {
            id: "fixture",
            disableHooks: true,
            disableSessionTitle: true,
            disableMemoryContext: true,
            disableMcp: true,
          },
        ],
      },
    });
    ownershipClient = createClient({ transport: ownershipClientTransport });
    ownershipHandle.engine.runMemoryPipeline = async () => {};
    await ownershipClient.run("USER_NEW_OWNER", {
      sessionId: "ownership",
      behaviorMode: "fixture",
    });
    assert.ok(seen.at(-1).prompt.includes("SESSION_ADOPTED"));

    await client.run("USER_RESTRICTED", { sessionId: "ordinary", behaviorMode: "no-instructions" });
    assert.ok(!seen.at(-1).prompt.includes("ADOPTED_INSTRUCTION"));
    assert.ok(!seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    assert.ok(!JSON.stringify(seen.at(-1).messages).includes(initialReply));
    const unrestrictedReply = `DERIVED_RESPONSE_${seen.length}`;
    await client.run("USER_ALLOW_SECOND", {
      sessionId: "ordinary",
      behaviorMode: "fixture",
      skillAllowlist: [secondName],
    });
    assert.ok(!seen.at(-1).prompt.includes("ADOPTED_INSTRUCTION"));
    assert.ok(seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    const allowedReply = `DERIVED_RESPONSE_${seen.length}`;
    await client.run("USER_ALLOW_SECOND_AGAIN", {
      sessionId: "ordinary",
      behaviorMode: "fixture",
      skillAllowlist: [secondName],
    });
    assert.ok(JSON.stringify(seen.at(-1).messages).includes(allowedReply));
    const sessionBinding = store.adopt({
      scope: { ...binding.scope, sessionId: "ordinary" },
      name,
      sourceRevision,
      body: "SESSION_ADOPTED",
      evidenceHash: "c".repeat(64),
      receiptIds: [sessionTrial.receipt.id],
    });
    await client.run("USER_SESSION_OVERRIDE", { sessionId: "ordinary", behaviorMode: "fixture" });
    assert.ok(seen.at(-1).prompt.includes("SESSION_ADOPTED"));
    assert.ok(seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    assert.ok(!seen.at(-1).prompt.includes("ADOPTED_INSTRUCTION"));
    const overrideReply = `DERIVED_RESPONSE_${seen.length}`;
    block = true;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const pending = client.run("USER_IN_FLIGHT_TASK", {
      sessionId: "ordinary",
      behaviorMode: "fixture",
    });
    await started;
    store.revoke(cwd, binding.snapshot.bindingId, binding.snapshot.revision);
    assert.equal(lastSignal.aborted, false);
    assert.ok(
      ownershipHandle.engine
        .getSessionManager()
        .readSessionState("ownership")
        .instructionSnapshots.some(
          (snapshot) => snapshot.bindingId === ownershipBinding.snapshot.bindingId,
        ),
    );

    assert.deepEqual(
      handle.engine
        .getLoadedInstructionSnapshots()
        .map((snapshot) => snapshot.name)
        .sort(),
      [name, secondName].sort(),
    );
    store.revoke(cwd, sessionBinding.snapshot.bindingId, sessionBinding.snapshot.revision);
    assert.equal(lastSignal.aborted, true);
    unblock();
    await pending;
    block = false;
    const session = handle.engine.getSessionManager().resumeForRun("ordinary");
    assert.ok(
      session.transcript
        .getEvents("message")
        .some((event) => JSON.stringify(event.data.content).includes("DERIVED_RESPONSE")),
    );
    const effective = JSON.stringify(session.transcript.toMessages());
    assert.ok(effective.includes("USER_ORIGINAL_TASK"));
    assert.ok(effective.includes("USER_IN_FLIGHT_TASK"));
    assert.ok(!effective.includes(overrideReply));
    assert.ok(!effective.includes(`DERIVED_RESPONSE_${seen.length}`));
    assert.ok(effective.includes(unrestrictedReply));
    assert.deepEqual(
      session.state.instructionSnapshots.map((snapshot) => snapshot.name),
      [secondName],
    );
    await client.run("USER_AFTER_REVOKE", { sessionId: "ordinary", behaviorMode: "fixture" });
    assert.ok(!seen.at(-1).prompt.includes("ADOPTED_INSTRUCTION"));
    assert.ok(!seen.at(-1).prompt.includes("SESSION_ADOPTED"));
    assert.ok(seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    assert.ok(JSON.stringify(seen.at(-1).messages).includes("USER_ORIGINAL_TASK"));
    // A legal restored Session snapshot cannot substitute edited content for the Host record.
    session.state.instructionSnapshots[0].body = "EDITED_PERSISTED_BODY";
    handle.engine.getSessionManager().saveStateOrUpdateFields(session.state, {
      instructionSnapshots: session.state.instructionSnapshots,
    });
    await client.run("USER_AFTER_RESTORE", { sessionId: "ordinary", behaviorMode: "fixture" });
    assert.ok(!seen.at(-1).prompt.includes("EDITED_PERSISTED_BODY"));
    assert.ok(!seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    await client.run("USER_SOURCE_REVISION", {
      sessionId: "source-revision",
      behaviorMode: "fixture",
    });
    assert.ok(seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    const sourceReply = `DERIVED_RESPONSE_${seen.length}`;
    writeFileSync(
      secondFile,
      "---\nname: p2-second\ndescription: Changed source fixture\n---\nEDITED_SOURCE\n",
    );
    await client.run("USER_AFTER_SOURCE_CHANGE", {
      sessionId: "source-revision",
      behaviorMode: "fixture",
    });
    assert.ok(!seen.at(-1).prompt.includes("SECOND_ADOPTED"));
    assert.ok(!JSON.stringify(seen.at(-1).messages).includes(sourceReply));
    store.revoke(cwd, second.snapshot.bindingId, second.snapshot.revision);
    assert.ok(readFileSync(secondFile, "utf8").includes("EDITED_SOURCE"));
  } finally {
    await handle.close();
    client.close();
    await handle.engine.dispose();
    if (ownershipHandle) {
      await ownershipHandle.close();
      ownershipClient.close();
      await ownershipHandle.engine.dispose();
    }
  }
  assert.equal(readFileSync(skillFile, "utf8"), source);
  console.log(
    JSON.stringify({
      ok: true,
      isolatedReceipt: isolated.receipt.id,
      isolatedPhysicalRequests: observations.length,
      meteredAgentRequests: admitted,
      anthropicMeteredAgentRequests: anthropicAdmitted,
      scopeVisibilityAndMultiTurnPreserved: true,
      sessionOverridePreservesOtherSkills: true,
      idleRevocationPreservesActiveSession: true,
      staleOwnerCannotReplaceNewBinding: true,
      sourceRevisionCheckedOnResume: true,
      originalMessagesRetained: true,
      revokedRunSignalAborted: true,
      noNetwork: true,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
