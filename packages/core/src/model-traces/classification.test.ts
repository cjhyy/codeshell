import { expect, test } from "bun:test";
import {
  deriveModelTraceCallType,
  isModelTraceCallType,
  MODEL_TRACE_CALL_TYPES,
} from "./classification.js";

test("classifies actual execution, auxiliary, media and external purposes from metadata", () => {
  const cases = {
    main: "execution",
    subagent: "task",
    aux_summary: "summary",
    tool_summary: "summary",
    manual_compact: "summary",
    context_package: "context",
    title: "title",
    goal_judge: "goal",
    memory_dream_project: "memory",
    memory_dream_user: "memory",
    session_follow_up: "suggestion",
    tts: "speech",
    "tts-clone": "speech",
    "tts-setup-reference": "speech",
    transcribe: "transcription",
    "interview-transcribe": "transcription",
    "voice-separation": "audio",
    external: "external",
    "external-runtime": "external",
  };
  for (const [purpose, expected] of Object.entries(cases))
    expect(deriveModelTraceCallType({ purpose, source: "desktop" })).toBe(expected);
  expect(deriveModelTraceCallType({ purpose: "main", parentSessionId: "parent" })).toBe("task");
  expect(deriveModelTraceCallType({ purpose: "main", parentSessionId: "" })).toBe("execution");
});

test("specific purpose survives Panel namespaces and enclosing task attribution", () => {
  for (const [purpose, expected] of [
    ["aux_summary", "summary"],
    ["title", "title"],
    ["tts-clone", "speech"],
    ["transcribe", "transcription"],
    ["voice-separation", "audio"],
    ["external-runtime", "external"],
  ]) {
    expect(
      deriveModelTraceCallType({ purpose, source: "panel:fixture", parentSessionId: "parent" }),
    ).toBe(expected);
    expect(deriveModelTraceCallType({ purpose: `panel/${purpose}`, source: "panel:fixture" })).toBe(
      expected,
    );
  }
  for (const purpose of ["main", "subagent", "model", "custom-domain-purpose"])
    expect(deriveModelTraceCallType({ purpose, source: "panel:fixture" })).toBe("panel");
});

test("unknown purposes remain explicit other and cannot select inherited object properties", () => {
  for (const purpose of [undefined, null, 1, "", "toString", "__proto__", "MAIN", "my-tts"])
    expect(deriveModelTraceCallType({ purpose, parentSessionId: "parent" })).toBe("other");
  expect(deriveModelTraceCallType({ source: "desktop-example-cli" })).toBe("other");
  expect(
    deriveModelTraceCallType({
      purpose: "unknown",
      source: "fixture",
      callType: "execution",
    } as any),
  ).toBe("other");
});

test("only stable exact call category strings validate", () => {
  expect(new Set(MODEL_TRACE_CALL_TYPES).size).toBe(14);
  for (const value of MODEL_TRACE_CALL_TYPES) expect(isModelTraceCallType(value)).toBe(true);
  for (const value of [undefined, null, 1, [], {}, "", "Execution", "main", "tts", "toString"])
    expect(isModelTraceCallType(value)).toBe(false);
});
