import { expect, test } from "bun:test";
import { runInputError } from "./dispatch.js";

test("model trace source remains a bounded label across protocol run ingress", () => {
  expect(runInputError({ task: "fixture", modelTraceSource: "panel:video-studio" })).toBeNull();
  for (const source of ["", "panel:invalid\nsource", "x".repeat(129), {}, null]) {
    expect(runInputError({ task: "fixture", modelTraceSource: source } as any)).toContain(
      "diagnostic label",
    );
  }
});

test("run trigger can only downgrade input to host_message", () => {
  expect(runInputError({ task: "scheduled", trigger: "host_message" })).toBeNull();
  for (const trigger of ["user", "background_wake", true, "", null, {}]) {
    expect(runInputError({ task: "scheduled", trigger } as any)).toContain("host_message");
  }
});
