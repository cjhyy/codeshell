import { describe, expect, test } from "bun:test";
import { composeFileEdits, type FileEditOperation } from "../../../../packages/desktop/src/renderer/diff/composeFileEdits";

const operations: FileEditOperation[] = [
  { kind: "edit", oldText: "before();", newText: "shared();" },
  { kind: "edit", oldText: "// later\nshared();", newText: "// later\nfinal();" },
];

// Owned in-memory exact-replacement model only: this does not call the Edit tool.
function applyUnique(text: string): string {
  for (const operation of operations) {
    if (operation.kind !== "edit") throw new Error("Only bounded edit payloads are allowed");
    const at = text.indexOf(operation.oldText);
    if (at < 0 || at !== text.lastIndexOf(operation.oldText)) throw new Error("Fixture old_text is not unique");
    text = text.slice(0, at) + operation.newText + text.slice(at + operation.oldText.length);
  }
  return text;
}

describe("Round27 outer containment evidence", () => {
  test("the two short old strings uniquely identify different locations", () => {
    expect(applyUnique("before();\n// later\nshared();\n")).toBe("shared();\n// later\nfinal();\n");
    expect(applyUnique("// later\nbefore();\n")).toBe("// later\nfinal();\n");
  });

  test("current leaf loses a separate replacement by reconstructing false outer context", () => {
    const actual = composeFileEdits("example.ts", operations);
    const wrong = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n // later\n-before();\n+final();\n";
    console.log(JSON.stringify({ evidence: "disjoint edits share the same payload as overlapping edits", initial: "before();\n// later\nshared();\n", actualFinalFromOwnedModel: applyUnique("before();\n// later\nshared();\n"), observed: actual, expectedChangedLinesForDisjointEdits: ["-before();", "+shared();", "-shared();", "+final();"], expectedAdded: 2, expectedRemoved: 2, assertionMode: "characterize current incorrect result; no fix applied" }));
    expect(actual.diff).toBe(wrong);
    expect(actual.added).toBe(1);
    expect(actual.removed).toBe(1);
    expect(actual.diff).not.toContain("+shared();");
    expect(actual.diff).not.toContain("-shared();");
  });

  test("the same payload really can describe one location gaining outer context", () => {
    const actual = composeFileEdits("example.ts", operations);
    expect(applyUnique("// later\nbefore();\n")).toBe("// later\nfinal();\n");
    expect(actual.diff).toContain(" // later\n-before();\n+final();");
    expect({ added: actual.added, removed: actual.removed }).toEqual({ added: 1, removed: 1 });
  });
});
