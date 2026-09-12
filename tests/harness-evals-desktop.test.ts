import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isolatedEnvironment,
  modelSettings,
  workspaceManifest,
} from "../evals/harness/desktop.mjs";
import {
  DESKTOP_CASE_IDS,
  deliveredPrefixMatches,
  scenarioFor,
  sameConversation,
  successfulToolResults,
} from "../evals/harness/scenarios.mjs";

test("all live tasks use catalog input, reproducible nonce and canonical assertions", () => {
  for (const id of DESKTOP_CASE_IDS) {
    const a = scenarioFor(id, "seed", 1);
    assert.deepEqual(a, scenarioFor(id, "seed", 1));
    assert.notEqual(a.nonce, scenarioFor(id, "seed", 2).nonce);
    assert.ok(a.hardAssertions.length);
    assert.ok(a.first);
    assert.ok(!JSON.stringify(a.input).includes("{{caseNonce}}"));
  }
  assert.ok(scenarioFor("interrupted-reply-later-restart", "x").third);
  assert.match(scenarioFor("approval-reload-write", "x").first, /eval-note\.txt/);
  assert.match(scenarioFor("ordinary-steer-cache-cursor", "x").second, /读取 eval-note\.txt/);
  const file = scenarioFor("mimi-file-queue-completed-reload", "x");
  assert.equal(file.input.files[0].path, "验收笔记.txt");
  assert.match(file.second, /无需读取文件或创建任务/);
  assert.throws(() => scenarioFor("unregistered", "x"));
});

test("recovery comparison catches duplicates, reordered turns and missing partials", () => {
  const before = { users: ["same", "same"], answers: ["partial", "reply"] };
  assert.ok(sameConversation(before, structuredClone(before)));
  assert.ok(!sameConversation(before, { users: ["same"], answers: before.answers }));
  assert.ok(!sameConversation(before, { users: before.users, answers: ["reply", "partial"] }));
  assert.ok(
    !sameConversation(before, { users: before.users, answers: ["partial", "reply", "reply"] }),
  );
});

test("tool execution evidence rejects starts/errors and preserves session scope", () => {
  const envelope = (sessionId, result) => ({ sessionId, event: { type: "tool_result", result } });
  const good = {
    ...envelope("own", { id: "write-1", toolName: "Write", output: "written" }),
    epoch: "epoch",
    seq: 11,
  };
  const events = [
    { sessionId: "own", event: { type: "tool_use_start", toolName: "Write", id: "start" } },
    envelope("own", { id: "failed", toolName: "Write", isError: true }),
    envelope("other", { id: "other", toolName: "Write" }),
    good,
    structuredClone(good),
    envelope("own", { id: "read", toolName: "Read" }),
  ];
  assert.deepEqual(successfulToolResults(events, "Write", "own"), [good.event.result]);
  assert.deepEqual(successfulToolResults(events.slice(0, 3), "Write", "own"), []);
});

test("isolated model config preserves explicit reasoning and selected provider", () => {
  for (const adapterKind of ["openai", "openrouter", "deepseek"]) {
    const params = [{ name: "reasoning", default: "high", wireKey: "reasoning.effort" }];
    const cfg = modelSettings(
      {
        model: "real-model",
        adapterKind,
        preset: { params },
        paramValues: { reasoning: "high", include_reasoning: false },
        maxOutputTokens: 4096,
      },
      { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "dummy" },
    );
    assert.equal(cfg.catalog[0].adapterKind, adapterKind);
    assert.deepEqual(cfg.catalog[0].modelPresets[0].params, params);
    assert.equal(cfg.catalog[0].modelPresets[0].maxOutputTokens, 4096);
    assert.deepEqual(cfg.settings.modelConnections[0].paramValues, {
      reasoning: "high",
      include_reasoning: false,
    });
    assert.equal(cfg.settings.credentials[0].apiKey, "dummy");
  }
});

test("environment does not forward credential variables or runtime injection", () => {
  const env = isolatedEnvironment(
    {
      HOME: "/user",
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      CUSTOM_TOKEN: "secret",
      NODE_OPTIONS: "--require private",
      DYLD_INSERT_LIBRARIES: "private",
    },
    "/isolated",
  );
  assert.equal(env.HOME, "/isolated");
  assert.equal(env.PATH, "/bin");
  for (const key of ["OPENAI_API_KEY", "CUSTOM_TOKEN", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"])
    assert.equal(env[key], undefined);
});

test("filesystem evidence detects content changes and unexpected files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codeshell-eval-manifest-"));
  try {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "own.txt"), "original\n");
    const before = await workspaceManifest(dir);
    assert.deepEqual(await workspaceManifest(dir), before);
    await writeFile(join(dir, "nested", "own.txt"), "changed\n");
    assert.notDeepEqual(await workspaceManifest(dir), before);
    await writeFile(join(dir, "unexpected.txt"), "new");
    assert.equal(Object.keys(await workspaceManifest(dir)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same tool id with different delivery cursors is two executions", () => {
  const first = {
    sessionId: "own",
    epoch: "epoch",
    seq: 11,
    event: { type: "tool_result", result: { id: "same-id", toolName: "Write", isError: false } },
  };
  const replay = structuredClone(first);
  const second = { ...first, seq: 12 };
  assert.equal(successfulToolResults([first, replay], "Write", "own").length, 1);
  assert.equal(successfulToolResults([first, second], "Write", "own").length, 2);
  assert.equal(
    successfulToolResults([first, { ...first, epoch: "new-worker" }], "Write", "own").length,
    2,
  );
  const unsequenced = { sessionId: "own", event: first.event };
  assert.equal(successfulToolResults([unsequenced, unsequenced], "Write", "own").length, 2);
});

test("received-prefix baseline waits for animation to display every delivered character", () => {
  const delivered = "第一段：先按书籍的大类给书架划分区域，例如文学、历史、科学、艺术";
  assert.equal(deliveredPrefixMatches([delivered.slice(0, 16)], delivered), false);
  assert.equal(deliveredPrefixMatches([delivered], delivered), true);
  assert.equal(deliveredPrefixMatches([delivered + "额外字符"], delivered), false);
  assert.equal(deliveredPrefixMatches([delivered, delivered], delivered), false);
  assert.equal(deliveredPrefixMatches(["标题"], "**标题**"), false);
});
