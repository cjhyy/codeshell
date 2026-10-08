import { expect, test } from "bun:test";
import { parseSourceAccessDraft } from "./sourceAccessEditor";

test("source policy editor preserves inherit versus explicit deny-all and normalizes ask", () => {
  expect(parseSourceAccessDraft("")).toBeUndefined();
  expect(parseSourceAccessDraft("[]")).toEqual([]);
  expect(parseSourceAccessDraft('[{"sourceId":"docs","scopes":["github:list_issues"]}]')).toEqual([
    { sourceId: "docs", scopes: ["github:list_issues"], readPolicy: "ask" },
  ]);
});
test.each([
  "{}",
  '[{"sourceId":"../bad","scopes":[]}]',
  '[{"sourceId":"docs","scopes":["a","a"]}]',
  '[{"sourceId":"docs","scopes":[],"readPolicy":"allow"}]',
  '[{"sourceId":"docs","scopes":[]},{"sourceId":"docs","scopes":[]}]',
])("source policy editor rejects malformed or widening policy %s", (text) => {
  expect(() => parseSourceAccessDraft(text)).toThrow();
});
