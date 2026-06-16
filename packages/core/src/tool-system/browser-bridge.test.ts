import { describe, expect, test } from "bun:test";
import { flattenAxTree, renderElementList, cleanPageText, type AXNode } from "./browser-bridge.js";

/** Convenience to build an AXNode terse. */
function ax(p: Partial<AXNode>): AXNode {
  return { nodeId: p.nodeId ?? "n", ...p };
}

describe("flattenAxTree", () => {
  test("keeps interactive roles with a name, assigns sequential refs + backendId map", () => {
    const { elements, refToBackendId } = flattenAxTree([
      ax({ role: { value: "button" }, name: { value: "搜索" }, backendDOMNodeId: 11 }),
      ax({ role: { value: "link" }, name: { value: "登录" }, backendDOMNodeId: 22 }),
    ]);
    expect(elements).toEqual([
      { ref: "e1", role: "button", name: "搜索" },
      { ref: "e2", role: "link", name: "登录" },
    ]);
    expect(refToBackendId).toEqual({ e1: 11, e2: 22 });
  });

  test("drops ignored nodes and roleless nodes", () => {
    const { elements } = flattenAxTree([
      ax({ ignored: true, role: { value: "button" }, name: { value: "hidden" }, backendDOMNodeId: 1 }),
      ax({ name: { value: "no role" }, backendDOMNodeId: 2 }),
      ax({ role: { value: "button" }, name: { value: "ok" }, backendDOMNodeId: 3 }),
    ]);
    expect(elements.map((e) => e.name)).toEqual(["ok"]);
  });

  test("drops nameless non-input noise but keeps nameless value inputs", () => {
    const { elements } = flattenAxTree([
      ax({ role: { value: "button" }, name: { value: "" }, backendDOMNodeId: 1 }), // dropped
      ax({ role: { value: "textbox" }, name: { value: "" }, backendDOMNodeId: 2 }), // kept (value role)
    ]);
    expect(elements).toEqual([{ ref: "e1", role: "textbox", name: "" }]);
  });

  test("includes non-sensitive textbox value but NEVER a sensitive one", () => {
    const { elements } = flattenAxTree([
      ax({ role: { value: "textbox" }, name: { value: "关键词" }, value: { value: "hello" }, backendDOMNodeId: 1 }),
      ax({
        role: { value: "textbox" },
        name: { value: "password" },
        value: { value: "supersecret" },
        backendDOMNodeId: 2,
      }),
      ax({
        role: { value: "textbox" },
        name: { value: "密码" },
        value: { value: "另一个" },
        backendDOMNodeId: 3,
      }),
      ax({
        role: { value: "textbox" },
        name: { value: "card" },
        value: { value: "4111" },
        backendDOMNodeId: 4,
        properties: [{ name: "protected", value: { value: true } }],
      }),
    ]);
    expect(elements[0]).toEqual({ ref: "e1", role: "textbox", name: "关键词", value: "hello" });
    expect(elements[1]).toEqual({ ref: "e2", role: "textbox", name: "password", sensitive: true });
    expect(elements[2]!.sensitive).toBe(true);
    expect(elements[3]!.sensitive).toBe(true);
    // no sensitive value leaks anywhere
    expect(JSON.stringify(elements)).not.toContain("supersecret");
    expect(JSON.stringify(elements)).not.toContain("4111");
  });

  test("keeps a focusable non-standard-role node if it has a name", () => {
    const { elements } = flattenAxTree([
      ax({
        role: { value: "generic" },
        name: { value: "Custom widget" },
        backendDOMNodeId: 7,
        properties: [{ name: "focusable", value: { value: true } }],
      }),
    ]);
    expect(elements).toEqual([{ ref: "e1", role: "generic", name: "Custom widget" }]);
  });

  test("drops actionable-looking node with no backendDOMNodeId (can't act on it)", () => {
    const { elements } = flattenAxTree([
      ax({ role: { value: "button" }, name: { value: "no backend" } }),
    ]);
    expect(elements).toEqual([]);
  });
});

describe("renderElementList", () => {
  test("formats refs, roles, names, values, sensitivity", () => {
    const text = renderElementList([
      { ref: "e1", role: "button", name: "搜索" },
      { ref: "e2", role: "textbox", name: "关键词", value: "hi" },
      { ref: "e3", role: "textbox", name: "password", sensitive: true },
    ]);
    expect(text).toBe(
      '[ref=e1] button "搜索"\n' + '[ref=e2] textbox "关键词" ="hi"\n' + '[ref=e3] textbox "password" [sensitive]',
    );
  });

  test("empty list → placeholder", () => {
    expect(renderElementList([])).toBe("(no interactive elements found)");
  });
});

describe("cleanPageText", () => {
  test("collapses whitespace and blank lines, trims", () => {
    const raw = "  标题\n\n\n\n正文   多   空格\t\t制表  \n  \n  尾部  ";
    // 4+ newlines → paragraph break (\n\n); a single blank line in the middle
    // also collapses to a paragraph break; runs of spaces/tabs → one space.
    expect(cleanPageText(raw).text).toBe("标题\n\n正文 多 空格 制表\n\n尾部");
  });

  test("caps long text and flags truncation", () => {
    const raw = "a".repeat(100);
    const r = cleanPageText(raw, 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("aaaaaaaaaa")).toBe(true);
    expect(r.text).toContain("truncated");
  });

  test("short text → not truncated", () => {
    expect(cleanPageText("hi", 100)).toEqual({ text: "hi", truncated: false });
  });
});
