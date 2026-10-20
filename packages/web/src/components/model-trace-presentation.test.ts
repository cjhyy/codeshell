import { describe, expect, test } from "bun:test";
import type { ModelTraceAttempt, ModelTraceEvent, ModelTraceRecord } from "../model-trace-api.js";
import { modelTraceInputBoundary, presentModelTraceCallType } from "./model-trace-presentation.js";

const attempt: ModelTraceAttempt = {
  id: "attempt-1",
  number: 1,
  startedAt: 1,
  status: "completed",
  coverage: "provider-wire",
  inputState: "recorded",
  outputState: "recorded",
};
const record: ModelTraceRecord = {
  version: 1,
  id: "request-1",
  traceId: "trace-1",
  source: "panel:test",
  purpose: "unrecognized",
  callType: "execution",
  provider: "fixture",
  model: "fixture-model",
  startedAt: 1,
  status: "completed",
  stream: false,
  inputState: "recorded",
  outputState: "recorded",
  attempts: [attempt],
};

describe("model trace presentation boundaries", () => {
  test("the logical record does not inherit its attempt's provider-wire label", () => {
    expect(modelTraceInputBoundary("request", record, record)).toBe("logical");
    expect(modelTraceInputBoundary("attempt", attempt, record)).toBe("wire");
  });

  test("external CLI entries never imply visibility into internal provider requests", () => {
    const externalAttempt = { ...attempt, coverage: "external-cli-input" as const };
    const externalRecord = {
      ...record,
      callType: "external" as const,
      attempts: [externalAttempt],
    };
    expect(modelTraceInputBoundary("request", externalRecord, externalRecord)).toBe("external");
    expect(modelTraceInputBoundary("attempt", externalAttempt, externalRecord)).toBe("external");
  });

  test("explicit media types use model inputs rather than chat Prompt labels", () => {
    for (const callType of ["speech", "transcription", "audio"] as const) {
      const mediaRecord = { ...record, callType };
      expect(modelTraceInputBoundary("request", mediaRecord, mediaRecord)).toBe("media");
    }
  });

  test("tool events remain separate from model Prompt input", () => {
    const event: ModelTraceEvent = {
      id: "event-1",
      traceId: "trace-1",
      kind: "tool",
      name: "Bash",
      startedAt: 1,
      status: "completed",
      inputState: "recorded",
      outputState: "recorded",
    };
    expect(modelTraceInputBoundary("event", event, record)).toBe("event");
  });

  test("missing and unknown call types stay unknown even for a recognizable source", () => {
    expect(presentModelTraceCallType(undefined, "zh").type).toBe("other");
    expect(presentModelTraceCallType("panel:test", "en").type).toBe("other");
    expect(presentModelTraceCallType("session_follow_up", "zh").type).toBe("other");
    expect(presentModelTraceCallType("suggestion", "zh").label).toBe("后续建议 Prompt");
  });
});
