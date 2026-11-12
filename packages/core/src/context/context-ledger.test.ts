import { describe, expect, test } from "bun:test";
import {
  LEDGER_UPDATE_PREAMBLE,
  contextListSection,
  ledgerStateForSections,
  parseLedgerState,
  planLedgerEmission,
  serializeLedgerState,
  type ContextSection,
  type ContextSectionItem,
  type LedgerState,
} from "./context-ledger.js";

const memoryLine = (name: string, description: string): ContextSectionItem => ({
  id: `project/user/${name}`,
  text: `- [scope="user" location="project" type="user"] ${name}: ${description}`,
});

function memory(entries: ContextSectionItem[], header = "# Persistent Memory (index)\n\n") {
  return contextListSection("memory", {
    header,
    items: [{ id: "## project", text: "## Project memories", structural: true }, ...entries],
    footer: "",
  });
}

function skills(names: string[], footer = "\n\nUse Skill to load one.") {
  return contextListSection("skills", {
    header: "# Available Skills\n\n",
    items: [
      { id: "## g", text: `## g (${names.length})`, structural: true },
      ...names.map((name) => ({ id: name, text: `- ${name}: does ${name}` })),
    ],
    footer,
  });
}

const five = ["a", "b", "c", "d", "e"].map((name) => memoryLine(name, `about ${name}`));
const goal: ContextSection = { key: "goal-tool", text: "Goal state: none." };
const base = (): ContextSection[] => [skills(["s1", "s2", "s3"]), memory(five), goal];

function update(sections: ContextSection[], previous: LedgerState | undefined): string {
  const emission = planLedgerEmission(sections, previous);
  if (emission.kind !== "update") throw new Error(`expected update, got ${emission.kind}`);
  return emission.text;
}

describe("planLedgerEmission", () => {
  test("first emission is a snapshot identical to the joined dynamic-context message", () => {
    const sections = [...base(), { key: "runtime", text: "Runtime: idle." }];
    const emission = planLedgerEmission(sections, undefined);
    expect(emission).toEqual({
      kind: "snapshot",
      text: `<system-reminder>\n${sections.map((s) => s.text).join("\n\n")}\n</system-reminder>`,
      state: ledgerStateForSections(sections),
    });
  });

  test("empty sections are skipped and an empty context emits nothing", () => {
    expect(planLedgerEmission([{ key: "sources", text: "" }], undefined)).toEqual({
      kind: "none",
      state: { version: 1, sections: {} },
    });
    const emission = planLedgerEmission([{ key: "sources", text: "" }, goal], undefined);
    expect(emission.kind === "snapshot" && emission.text).toBe(
      "<system-reminder>\nGoal state: none.\n</system-reminder>",
    );
  });

  test("unchanged context emits nothing", () => {
    const state = ledgerStateForSections(base());
    expect(planLedgerEmission(base(), state)).toEqual({ kind: "none", state });
  });

  test("one added memory line is the only thing sent", () => {
    const added = memoryLine("f", "brand new");
    const text = update(
      [skills(["s1", "s2", "s3"]), memory([...five, added]), goal],
      ledgerStateForSections(base()),
    );
    expect(text).toBe(
      [
        "<system-reminder>",
        LEDGER_UPDATE_PREAMBLE,
        "",
        '<context-update section="memory">',
        `+ ${added.text}`,
        "</context-update>",
        "</system-reminder>",
      ].join("\n"),
    );
    for (const line of five) expect(text).not.toContain(line.text);
    expect(text).not.toContain("Available Skills");
    expect(text).not.toContain("Goal state");
  });

  test("updated and removed items are listed in item order, removals by id", () => {
    const changed = memoryLine("b", "rewritten");
    const next = [five[0]!, changed, five[2]!, five[3]!];
    const text = update(
      [skills(["s1", "s2", "s3"]), memory(next), goal],
      ledgerStateForSections(base()),
    );
    expect(text).toContain(
      `<context-update section="memory">\n~ ${changed.text}\n- project/user/e\n</context-update>`,
    );
    expect(text).not.toContain(five[0]!.text);
  });

  test("changes are reported in section order", () => {
    const text = update(
      [skills(["s1", "s2", "s3", "s4"]), memory([...five, memoryLine("f", "new")]), goal],
      ledgerStateForSections(base()),
    );
    expect(text.indexOf('section="skills"')).toBeGreaterThan(-1);
    expect(text.indexOf('section="skills"')).toBeLessThan(text.indexOf('section="memory"'));
    // The heading count changed from (3) to (4) but headings are structural.
    expect(text).not.toContain("## g");
  });

  test("whole-text section changed, removed and added", () => {
    const previous = ledgerStateForSections(base());
    const changed = update(
      [skills(["s1", "s2", "s3"]), memory(five), { key: "goal-tool", text: "Goal state: active." }],
      previous,
    );
    expect(changed).toBe(
      `<system-reminder>\n${LEDGER_UPDATE_PREAMBLE}\n\n` +
        `<context-section key="goal-tool">\nGoal state: active.\n</context-section>\n</system-reminder>`,
    );

    const removed = update([skills(["s1", "s2", "s3"]), memory(five)], previous);
    expect(removed).toBe(
      `<system-reminder>\n${LEDGER_UPDATE_PREAMBLE}\n\n` +
        `Section "goal-tool" no longer applies; disregard its earlier content.\n</system-reminder>`,
    );

    const added = update([...base(), { key: "mcp-failures", text: "MCP x failed." }], previous);
    expect(added).toContain(
      '<context-section key="mcp-failures">\nMCP x failed.\n</context-section>',
    );
    expect(added).not.toContain("Goal state");
  });

  test("header or footer change resends the whole list section", () => {
    const previous = ledgerStateForSections(base());
    const header = memory(five, "# Persistent Memory (index, v2)\n\n");
    expect(update([skills(["s1", "s2", "s3"]), header, goal], previous)).toContain(
      `<context-section key="memory">\n${header.text}\n</context-section>`,
    );
    const footer = skills(["s1", "s2", "s3"], "\n\n2 more skills omitted.");
    const text = update([footer, memory(five), goal], previous);
    expect(text).toContain(`<context-section key="skills">\n${footer.text}\n</context-section>`);
    expect(text).not.toContain("context-update");
  });

  test("more than half of the items changing resends the whole section", () => {
    const previous = ledgerStateForSections(base());
    const half = memory([five[0]!, five[1]!, five[2]!, memoryLine("x", "1"), memoryLine("y", "2")]);
    // 2 added + 2 removed = 4 of 5 entries.
    expect(update([skills(["s1", "s2", "s3"]), half, goal], previous)).toContain(
      `<context-section key="memory">\n${half.text}\n</context-section>`,
    );
    const two = memory([...five.slice(0, 4), memoryLine("e", "changed"), memoryLine("f", "new")]);
    // 2 of 6 entries: still an item-level update.
    expect(update([skills(["s1", "s2", "s3"]), two, goal], previous)).toContain(
      '<context-update section="memory">',
    );
  });

  test("a reorder or layout-only change resends the whole section", () => {
    const previous = ledgerStateForSections(base());
    const reordered = memory([five[1]!, five[0]!, ...five.slice(2)]);
    expect(update([skills(["s1", "s2", "s3"]), reordered, goal], previous)).toContain(
      `<context-section key="memory">\n${reordered.text}\n</context-section>`,
    );
  });

  test("ambiguous item ids and list/whole-text transitions fall back to whole text", () => {
    const duplicated = memory([...five, { ...five[0]!, text: "- duplicate id" }]);
    expect(ledgerStateForSections([duplicated]).sections.memory?.items).toBeUndefined();
    const previous = ledgerStateForSections([{ key: "memory", text: "old plain memory" }]);
    expect(update([memory(five)], previous)).toContain('<context-section key="memory">');
  });

  test("state stays consistent across successive plans and output is deterministic", () => {
    const steps: ContextSection[][] = [
      base(),
      [skills(["s1", "s2", "s3"]), memory([...five, memoryLine("f", "new")]), goal],
      [skills(["s1", "s2", "s3"]), memory([...five, memoryLine("f", "newer")])],
      [skills(["s1", "s3"]), memory(five.slice(0, 1)), goal, { key: "runtime", text: "busy" }],
      [],
      base(),
    ];
    let state: LedgerState | undefined;
    for (const sections of steps) {
      const emission = planLedgerEmission(sections, state);
      expect(planLedgerEmission(sections, state)).toEqual(emission);
      expect(emission.kind).not.toBe("none");
      expect(emission.state).toEqual(ledgerStateForSections(sections));
      const stored = parseLedgerState(serializeLedgerState(emission.state));
      expect(stored).toEqual(emission.state);
      expect(planLedgerEmission(sections, stored).kind).toBe("none");
      state = stored;
    }
    expect(steps.length).toBe(6);
  });

  test("section keys that shadow Object.prototype are ordinary keys", () => {
    const sections = [{ key: "constructor", text: "c" }];
    const previous = ledgerStateForSections([goal]);
    expect(update(sections, previous)).toContain('<context-section key="constructor">');
    expect(planLedgerEmission(sections, ledgerStateForSections(sections)).kind).toBe("none");
  });
});

describe('compare: "ids" sections', () => {
  const ranked = (
    visible: [name: string, description: string][],
    installed: string[] = visible.map(([name]) => name),
  ): ContextSection => ({
    ...contextListSection("skills", {
      header: "# Available Skills\n\n",
      items: [
        { id: "## g", text: `## g (${visible.length})`, structural: true },
        ...visible.map(([name, description]) => ({ id: name, text: `- ${name}: ${description}` })),
      ],
      footer: installed.length > visible.length ? "\n\nmore omitted." : "\n\nUse Skill.",
    }),
    compare: "ids",
    knownIds: installed,
  });
  const first = ranked([
    ["a", "long description of a"],
    ["b", "about b"],
    ["c", "about c"],
  ]);

  test("ranking, description, footer and visibility differences emit nothing", () => {
    const state = ledgerStateForSections([first, goal]);
    const reranked = ranked(
      [
        ["c", "about c, now with the long text"],
        ["a", ""],
      ],
      ["c", "a", "b"],
    );
    expect(planLedgerEmission([reranked, goal], state)).toEqual({ kind: "none", state });
  });

  test("an installed skill is the only line of the update", () => {
    const text = update(
      [
        ranked([
          ["a", "rewritten text for a"],
          ["b", "about b"],
          ["c", "about c"],
          ["d", "brand new"],
        ]),
        goal,
      ],
      ledgerStateForSections([first, goal]),
    );
    expect(text).toBe(
      `<system-reminder>\n${LEDGER_UPDATE_PREAMBLE}\n\n` +
        `<context-update section="skills">\n+ - d: brand new\n</context-update>\n</system-reminder>`,
    );
  });

  test("a removed skill is listed by id; an added but unlisted one by its id alone", () => {
    const text = update(
      [ranked([["a", "long description of a"]], ["a", "c", "hidden"]), goal],
      ledgerStateForSections([first, goal]),
    );
    expect(text).toContain('<context-update section="skills">\n+ hidden\n- b\n</context-update>');
  });

  test("the state survives a round trip and stays stable across plans", () => {
    const state = parseLedgerState(serializeLedgerState(ledgerStateForSections([first])));
    expect(state).toEqual(ledgerStateForSections([first]));
    const next = planLedgerEmission([ranked([["b", "x"]], ["a", "b", "c"])], state);
    expect(next.kind).toBe("none");
    expect(next.state).toEqual(state!);
  });

  test("a section first seen in this mode is sent whole", () => {
    const text = update([first, goal], ledgerStateForSections([goal]));
    expect(text).toContain(`<context-section key="skills">\n${first.text}\n</context-section>`);
  });
});

describe("parseLedgerState", () => {
  test("round-trips a state from JSON text or a parsed value", () => {
    const state = ledgerStateForSections(base());
    expect(parseLedgerState(serializeLedgerState(state))).toEqual(state);
    expect(parseLedgerState(JSON.parse(serializeLedgerState(state)))).toEqual(state);
    expect(state.sections.memory?.digest).toMatch(/^[0-9a-f]{16,32}$/);
  });

  test("unknown or corrupt input yields undefined instead of throwing", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      42,
      "",
      "{not json",
      "[]",
      [],
      {},
      { version: 2, sections: {} },
      { version: 1 },
      { version: 1, sections: [] },
      { version: 1, sections: { memory: "abc" } },
      { version: 1, sections: { memory: { digest: 1 } } },
      { version: 1, sections: { memory: { digest: "a", items: ["x"] } } },
      { version: 1, sections: { memory: { digest: "a", items: { x: 1 } } } },
      { version: 1, sections: { memory: { digest: "a", frame: 3 } } },
    ];
    for (const input of invalid) expect(parseLedgerState(input)).toBeUndefined();
  });
});
