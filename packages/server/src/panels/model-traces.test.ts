import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore } from "@cjhyy/code-shell-core/internal";
import { PanelModelTraceService, panelModelTraceLimits } from "./model-traces.js";
import { PanelModelTraceChannel } from "./model-trace-channel.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "panel-model-traces-"));
  roots.push(root);
  const storageDir = join(root, ".model-traces");
  const store = new ModelTraceStore({ storageDir });
  store.setConfig({ enabled: true, captureContent: true });
  let now = Date.now();
  const service = new PanelModelTraceService({ storageDir, now: () => now++ });
  const owner = {
    ownerKey: "bound-guest",
    appId: "fixture",
    revision: "revision-1",
    workspacePath: join(root, "workspace"),
    sessionId: "session",
    traceId: "host-run",
    taskId: "host-task",
  };
  const start = {
    provider: "fixture-provider",
    model: "fixture-model",
    input: {
      systemPrompt: "actual system",
      messages: [{ role: "user", content: "actual prompt" }],
      tools: [],
      parameters: { headers: { Authorization: "Bearer fixture-credential" } },
    },
  };
  return { store, service, owner, start };
}
function started(f: ReturnType<typeof fixture>) {
  const result = f.service.call(f.owner, "modelTraces.start", f.start);
  if (!("id" in result)) throw new Error("missing observation id");
  return result.id;
}
test("Panel observation stores actual logical input/output and Host-owned attribution with central credential redaction", () => {
  const f = fixture(),
    id = started(f);
  f.service.call(f.owner, "modelTraces.finish", {
    id,
    status: "completed",
    output: { text: "actual output", data: { Authorization: "Bearer output-credential" } },
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  });
  const record = f.store.get(id)!;
  expect(record).toMatchObject({
    source: "panel:fixture",
    workspacePath: f.owner.workspacePath,
    sessionId: "session",
    traceId: "host-run",
    status: "completed",
    provider: "fixture-provider",
    model: "fixture-model",
  });
  expect(record.input?.messages).toEqual(f.start.input.messages);
  expect(record.input?.parameters.codeshellPanel).toEqual({
    appId: "fixture",
    revision: "revision-1",
    taskId: "host-task",
  });
  expect(record.output?.text).toBe("actual output");
  expect(record.attempts[0]?.coverage).toBe("logical-input");
  expect(record.usage?.totalTokens).toBe(14);
  expect(JSON.stringify(record)).not.toContain("fixture-credential");
  expect(JSON.stringify(record)).not.toContain("output-credential");
});
test("Panel observation rejects unknown authority fields, foreign ids, revision/workspace changes and duplicate finish", () => {
  const f = fixture();
  for (const field of ["workspacePath", "storageDir", "source", "id", "startedAt", "config"])
    expect(() =>
      f.service.call(f.owner, "modelTraces.start", { ...f.start, [field]: "forged" }),
    ).toThrow();
  const id = started(f),
    finish = { id, status: "completed", output: { text: "safe" } };
  for (const owner of [
    { ...f.owner, ownerKey: "foreign" },
    { ...f.owner, revision: "replacement" },
    { ...f.owner, workspacePath: "/foreign" },
  ])
    expect(() => f.service.call(owner, "modelTraces.finish", finish)).toThrow();
  f.service.call(f.owner, "modelTraces.finish", finish);
  expect(() => f.service.call(f.owner, "modelTraces.finish", finish)).toThrow();
});
test("Panel observation honors policy generation, limits, partial capture markers and cancellation", () => {
  const f = fixture(),
    id = started(f);
  f.store.setConfig({ captureContent: false });
  f.store.setConfig({ captureContent: true });
  f.service.call(f.owner, "modelTraces.finish", {
    id,
    status: "completed",
    output: { text: "paused secret" },
  });
  expect(f.store.get(id)?.output).toBeUndefined();
  const partial = f.service.call(f.owner, "modelTraces.start", {
    ...f.start,
    inputState: "truncated",
  });
  if (!("id" in partial)) throw new Error("missing id");
  f.service.call(f.owner, "modelTraces.finish", {
    id: partial.id,
    status: "completed",
    output: { text: "part" },
    outputState: "truncated",
  });
  expect(f.store.get(partial.id)).toMatchObject({
    inputState: "truncated",
    outputState: "truncated",
  });
  expect(() =>
    f.service.call(f.owner, "modelTraces.start", {
      ...f.start,
      input: { messages: ["x".repeat(panelModelTraceLimits.maxParamsBytes)] },
    }),
  ).toThrow();
  const cancelled = started(f);
  f.service.cancelOwner(f.owner.ownerKey);
  expect(f.store.get(cancelled)?.status).toBe("cancelled");
  expect(() =>
    f.service.call(f.owner, "modelTraces.finish", { id: cancelled, status: "completed" }),
  ).toThrow();
});
test("disabled Panel recording never resumes an existing observation after being enabled", () => {
  const f = fixture();
  f.store.setConfig({ enabled: false });
  const id = started(f);
  f.store.setConfig({ enabled: true });
  f.service.call(f.owner, "modelTraces.finish", {
    id,
    status: "completed",
    output: { text: "never record" },
  });
  expect(f.store.get(id)).toBeNull();
});
test("native FD3 channel accepts split ordered observations and rejects foreign/oversized payloads without reading stdout", async () => {
  const f = fixture();
  const channel = new PanelModelTraceChannel({
    service: f.service,
    owner: f.owner,
    isAuthorized: async () => true,
  });
  const line =
    JSON.stringify({
      version: 1,
      type: "model_trace",
      phase: "start",
      callId: "native-1",
      ...f.start,
    }) + "\n";
  channel.write(line.slice(0, 11));
  channel.write(line.slice(11));
  channel.write(
    JSON.stringify({
      version: 1,
      type: "model_trace",
      phase: "finish",
      callId: "native-1",
      status: "completed",
      output: { text: "native result" },
    }) + "\n",
  );
  await channel.finish("failed");
  expect(f.store.list().items).toHaveLength(1);
  expect(f.store.get(f.store.list().items[0]!.id)?.output?.text).toBe("native result");
  const rejected = new PanelModelTraceChannel({
    service: f.service,
    owner: f.owner,
    isAuthorized: async () => true,
  });
  rejected.write(
    JSON.stringify({
      version: 1,
      type: "model_trace",
      phase: "finish",
      callId: "foreign",
      status: "completed",
    }) + "\n",
  );
  rejected.write(line);
  await rejected.finish("failed");
  expect(f.store.list().items).toHaveLength(1);
  const oversized = new PanelModelTraceChannel({
    service: f.service,
    owner: f.owner,
    isAuthorized: async () => true,
  });
  oversized.write("x".repeat(panelModelTraceLimits.maxParamsBytes + 1));
  oversized.write(line);
  await oversized.finish("failed");
  expect(f.store.list().items).toHaveLength(1);
});
test("native channel authorization loss and process failure close only their own unfinished spans", async () => {
  const f = fixture();
  let authorized = true;
  const owner = { ...f.owner, ownerKey: "process-1" };
  const channel = new PanelModelTraceChannel({
    service: f.service,
    owner,
    isAuthorized: async () => authorized,
  });
  channel.write(
    JSON.stringify({
      version: 1,
      type: "model_trace",
      phase: "start",
      callId: "native-1",
      ...f.start,
    }) + "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const other = started(f);
  authorized = false;
  channel.write(
    JSON.stringify({
      version: 1,
      type: "model_trace",
      phase: "finish",
      callId: "native-1",
      status: "completed",
      output: { text: "revoked secret" },
    }) + "\n",
  );
  await channel.finish("failed");
  const native = f.store.list().items.find((item) => item.id !== other)!;
  expect(native.status).toBe("cancelled");
  expect(f.store.get(native.id)?.output).toBeUndefined();
  expect(f.store.get(other)?.status).toBe("running");
});

test("Panel observation admission and rate limits are enforced before retaining extra calls", () => {
  const f = fixture();
  for (let n = 0; n < panelModelTraceLimits.maxActivePerOwner; n++) started(f);
  expect(() => started(f)).toThrow("Too many active");
  f.service.cancelOwner(f.owner.ownerKey);
  for (let n = 0; n < panelModelTraceLimits.maxCallsPerMinute; n++) {
    expect(() =>
      f.service.call(f.owner, "modelTraces.finish", {
        id: "00000000-0000-0000-0000-000000000000",
        status: "completed",
      }),
    ).toThrow();
  }
  expect(() => started(f)).toThrow("rate limit");
});

function chunkFrames(message: unknown): string[] {
  const bytes = Buffer.from(JSON.stringify(message));
  const messageId = randomUUID();
  const lines: string[] = [];
  for (let offset = 0, part = 0; offset < bytes.length; offset += 192, part++) {
    const line =
      JSON.stringify({
        version: 1,
        type: "model_trace_chunk",
        messageId,
        part,
        data: bytes.subarray(offset, offset + 192).toString("base64"),
        final: offset + 192 >= bytes.length,
      }) + "\n";
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512);
    lines.push(line);
  }
  return lines;
}
test("interleaved large child frames reassemble before pending-call limits and preserve each native call", async () => {
  const f = fixture();
  const channel = new PanelModelTraceChannel({
    service: f.service,
    owner: f.owner,
    isAuthorized: async () => true,
  });
  const starts = ["alpha", "beta"].map((callId) =>
    chunkFrames({
      version: 1,
      type: "model_trace",
      phase: "start",
      callId,
      ...f.start,
      input: {
        ...f.start.input,
        messages: [{ role: "user", content: callId + " " + "汉字".repeat(16000) }],
      },
    }),
  );
  for (let n = 0; n < Math.max(...starts.map((lines) => lines.length)); n++)
    for (const lines of starts) if (lines[n]) channel.write(lines[n]!);
  for (const callId of ["alpha", "beta"])
    for (const line of chunkFrames({
      version: 1,
      type: "model_trace",
      phase: "finish",
      callId,
      status: "completed",
      output: { text: callId + " output" },
    }))
      channel.write(line);
  await channel.finish("failed");
  const records = f.store.list().items.map((item) => f.store.get(item.id)!);
  expect(records).toHaveLength(2);
  for (const callId of ["alpha", "beta"]) {
    const record = records.find((item) => item.output?.text === callId + " output")!;
    expect(record.status).toBe("completed");
    expect(JSON.stringify(record.input?.messages)).toContain(callId + " ");
  }
});
test("native fragment revocation discards unfinished assembly before it can publish a prompt", async () => {
  const f = fixture();
  const channel = new PanelModelTraceChannel({
    service: f.service,
    owner: f.owner,
    isAuthorized: async () => true,
  });
  const lines = chunkFrames({
    version: 1,
    type: "model_trace",
    phase: "start",
    callId: "revoked",
    ...f.start,
  });
  channel.write(lines[0]!);
  channel.abort();
  for (const line of lines.slice(1)) channel.write(line);
  await channel.finish("cancelled");
  expect(f.store.list().items).toHaveLength(0);
});
