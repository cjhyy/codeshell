import { describe, expect, test } from "bun:test";
import type { ModelTraceAttempt, ModelTraceEvent, ModelTraceRecord } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/model-trace-api.ts";
import { modelTraceCallTypes, modelTraceInputBoundary, presentModelTraceCallType } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/components/model-trace-presentation.ts";

const attempt: ModelTraceAttempt = {
  id: "owned-attempt-1", number: 1, startedAt: 1, status: "completed",
  coverage: "logical-input", inputState: "recorded", outputState: "recorded",
  input: { text: "owned metadata" },
};
const record: ModelTraceRecord = {
  version: 1, id: "owned-request-1", traceId: "owned-trace-1",
  source: "panel:owned", purpose: "main", callType: "execution",
  provider: "owned-fixture", model: "owned-model", startedAt: 1,
  status: "completed", stream: false, inputState: "recorded", outputState: "recorded",
  input: { systemPrompt: "owned", messages: [], tools: [], parameters: {} },
  attempts: [attempt],
};

describe("round18 Web trace presentation contracts, memory only", () => {
  test("all 14 explicit categories have distinct labels in each supported language", () => {
    expect([...modelTraceCallTypes]).toEqual([
      "execution", "task", "panel", "summary", "context", "title", "goal",
      "memory", "suggestion", "speech", "transcription", "audio", "external", "other",
    ]);
    for (const lang of ["zh", "en"] as const) {
      const rendered = modelTraceCallTypes.map((type) => presentModelTraceCallType(type, lang));
      expect(rendered.map((item) => item.type)).toEqual([...modelTraceCallTypes]);
      expect(new Set(rendered.map((item) => item.label)).size).toBe(14);
      expect(rendered.every((item) => item.label.length > 0 && item.description.length > 0)).toBe(true);
    }
  });

  test("unknown metadata remains other and does not coerce user objects", () => {
    const noCoercion = { toString() { throw new Error("must not infer intent"); } };
    for (const lang of ["zh", "en"] as const) {
      const other = presentModelTraceCallType("other", lang);
      for (const value of [undefined, null, "main", "panel:owned", "tts", "EXECUTION", 1, noCoercion]) {
        expect(presentModelTraceCallType(value, lang)).toEqual(other);
      }
    }
  });

  test("provider wire takes precedence only for its selected attempt", () => {
    const wire = { ...attempt, coverage: "provider-wire" as const };
    const ordinary = { ...record, attempts: [wire] };
    expect(modelTraceInputBoundary("request", ordinary, ordinary)).toBe("logical");
    expect(modelTraceInputBoundary("attempt", wire, ordinary)).toBe("wire");
    for (const callType of ["speech", "transcription", "audio"] as const) {
      const media = { ...ordinary, callType };
      expect(modelTraceInputBoundary("request", media, media)).toBe("media");
      expect(modelTraceInputBoundary("attempt", wire, media)).toBe("wire");
      expect(modelTraceInputBoundary("attempt", attempt, media)).toBe("media");
    }
  });

  test("external coverage and event identity keep their narrower input boundary", () => {
    const external = { ...attempt, coverage: "external-cli-input" as const };
    const externalRecord = { ...record, callType: "external" as const, attempts: [external] };
    expect(modelTraceInputBoundary("request", externalRecord, externalRecord)).toBe("external");
    expect(modelTraceInputBoundary("attempt", external, externalRecord)).toBe("external");
    const logicalExternal = { ...record, callType: "external" as const };
    expect(modelTraceInputBoundary("request", logicalExternal, logicalExternal)).toBe("logical");
    for (const kind of ["tool", "approval", "lifecycle"] as const) {
      const event: ModelTraceEvent = { id: `owned-${kind}`, traceId: record.traceId, kind,
        name: "owned", startedAt: 1, status: "completed", inputState: "recorded", outputState: "recorded" };
      expect(modelTraceInputBoundary("event", event, externalRecord)).toBe("event");
      expect(modelTraceInputBoundary("event", event, { ...record, callType: "audio" })).toBe("event");
    }
  });

  test("presenting classifications and boundaries does not mutate the snapshots", () => {
    const before = JSON.stringify(record);
    for (const lang of ["zh", "en"] as const) presentModelTraceCallType(record.callType, lang);
    modelTraceInputBoundary("request", record, record);
    modelTraceInputBoundary("attempt", attempt, record);
    expect(JSON.stringify(record)).toBe(before);
    expect(record.attempts[0]).toBe(attempt);
    expect(modelTraceInputBoundary("request", { ...record, callType: undefined }, { ...record, callType: undefined })).toBe("logical");
  });
});
