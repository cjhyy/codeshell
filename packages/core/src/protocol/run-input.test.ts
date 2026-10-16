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
