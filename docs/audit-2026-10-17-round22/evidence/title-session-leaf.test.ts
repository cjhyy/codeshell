import { describe, expect, it } from "bun:test";
import { buildSessionTitle } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/session-title.ts";

type LeafClient = Parameters<typeof buildSessionTitle>[0];
type Usage = NonNullable<Parameters<typeof buildSessionTitle>[3]> extends (usage: infer U) => void ? U : never;
const usage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 };
function client(createMessage: (...args: any[]) => any): LeafClient {
  return { createMessage } as unknown as LeafClient;
}
function response(text?: string, billed?: Usage) {
  return { ...(text === undefined ? {} : { text }), ...(billed === undefined ? {} : { usage: billed }) };
}

describe("round22 actual buildSessionTitle owned callback controls", () => {
  it("caps each ASCII input separately and requests the small hidden title operation", async () => {
    let options: any;
    const actual = await buildSessionTitle(client(async (received) => {
      options = received;
      return response("Owned title");
    }), "u".repeat(2100), "a".repeat(2200));
    expect(actual).toBe("Owned title");
    expect(options.messages).toEqual([{ role: "user", content: `User: ${"u".repeat(2000)}\n\nAssistant: ${"a".repeat(2000)}\n\nTitle:` }]);
    expect(options.tools).toEqual([]);
    expect(options.maxTokens).toBe(64);
    expect(options.requestVisible).toBe(false);
    expect(options.usagePurpose).toBe("title");
    expect(options.reasoning).toEqual({ mode: "off" });
    expect(options.systemPrompt).toContain("same language");
  });

  it("retains both empty input fields without making a second callback", async () => {
    const seen: any[] = [];
    const actual = await buildSessionTitle(client(async (options) => {
      seen.push(options);
      return response("Owned title");
    }), "", "");
    expect(actual).toBe("Owned title");
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0].content).toBe("User: \n\nAssistant: \n\nTitle:");
  });

  it("strips nested CJK and single quote wrappers", async () => {
    expect(await buildSessionTitle(client(async () => response("  ‘「'Owned title'」’  ")), "q", "a")).toBe("Owned title");
  });

  it("treats quote-only output as empty", async () => {
    expect(await buildSessionTitle(client(async () => response(" ‘「'」’ ")), "q", "a")).toBeNull();
  });

  it("treats absent text as empty while retaining the billed usage callback", async () => {
    const billed: Usage[] = [];
    const actual = await buildSessionTitle(client(async () => response(undefined, usage)), "q", "a", (value) => billed.push(value));
    expect(actual).toBeNull();
    expect(billed).toEqual([usage]);
    expect(billed[0]).toBe(usage);
  });

  it("does not call a collector when the response omits usage", async () => {
    const billed: Usage[] = [];
    const actual = await buildSessionTitle(client(async () => response("Owned title")), "q", "a", (value) => billed.push(value));
    expect(actual).toBe("Owned title");
    expect(billed).toHaveLength(0);
  });

  it("accepts a usage-bearing response without a collector", async () => {
    expect(await buildSessionTitle(client(async () => response("Owned title", usage)), "q", "a")).toBe("Owned title");
  });

  it("records zero usage as an object rather than dropping it", async () => {
    const billed: Usage[] = [];
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const actual = await buildSessionTitle(client(async () => response("Owned title", zero)), "q", "a", (value) => billed.push(value));
    expect(actual).toBe("Owned title");
    expect(billed).toEqual([zero]);
  });

  it("keeps synchronous createMessage errors best effort", async () => {
    const billed: Usage[] = [];
    const actual = await buildSessionTitle(client(() => { throw new Error("owned sync failure"); }), "q", "a", (value) => billed.push(value));
    expect(actual).toBeNull();
    expect(billed).toHaveLength(0);
  });

  it("keeps non-Error promise rejection best effort", async () => {
    expect(await buildSessionTitle(client(async () => { throw "owned rejection"; }), "q", "a")).toBeNull();
  });

  it("keeps a throwing synchronous collector inside the failure boundary", async () => {
    let calls = 0;
    const actual = await buildSessionTitle(client(async () => response("Owned title", usage)), "q", "a", () => {
      calls++;
      throw new Error("owned collector failure");
    });
    expect(actual).toBeNull();
    expect(calls).toBe(1);
  });

  it("keeps two independently deferred calls and their collectors separate", async () => {
    let finishA!: (value: any) => void;
    let finishB!: (value: any) => void;
    const billedA: Usage[] = [];
    const billedB: Usage[] = [];
    const usageB = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
    const a = buildSessionTitle(client(() => new Promise((resolve) => { finishA = resolve; })), "qA", "aA", (value) => billedA.push(value));
    const b = buildSessionTitle(client(() => new Promise((resolve) => { finishB = resolve; })), "qB", "aB", (value) => billedB.push(value));
    expect(billedA).toHaveLength(0);
    expect(billedB).toHaveLength(0);
    finishB(response("B title", usageB));
    expect(await b).toBe("B title");
    expect(billedB).toEqual([usageB]);
    expect(billedA).toHaveLength(0);
    finishA(response("A title", usage));
    expect(await a).toBe("A title");
    expect(billedA).toEqual([usage]);
    expect(billedB).toEqual([usageB]);
  });
});
