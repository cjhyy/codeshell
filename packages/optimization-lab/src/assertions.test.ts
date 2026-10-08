import { expect, test } from "bun:test";
import { evaluateAssertions } from "./assertions.js";

test("hard assertions never inherit properties or accept unsafe paths", () => {
  const base = { id: "j", kind: "json_field_equals" as const, value: "yes" };
  expect(
    evaluateAssertions('{"ok":{"value":"yes"}}', [{ ...base, path: ["ok", "value"] }])[0]?.passed,
  ).toBe(true);
  for (const path of [["constructor"], ["__proto__"], ["ok.value"], ["toString"]]) {
    expect(evaluateAssertions("{}", [{ ...base, path }])[0]?.passed).toBe(false);
  }
  expect(evaluateAssertions("invalid", [{ ...base, path: ["ok"] }])[0]?.reason).toContain(
    "not valid JSON",
  );
});

test("contains and exclusions are independent hard conditions", () => {
  expect(
    evaluateAssertions("hello secret", [
      { id: "yes", kind: "contains", value: "hello" },
      { id: "no", kind: "not_contains", value: "secret" },
    ]).map((item) => item.passed),
  ).toEqual([true, false]);
});
