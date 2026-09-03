import { describe, expect, test } from "bun:test";
import {
  IM_SESSION_LIST_LIMIT,
  buildImSessionList,
  hasAmbiguousImSessionTitles,
  imSessionDisplayStatus,
  resolveImSessionOrdinal,
  type ImSessionCandidate,
} from "./im-session-list.js";

function candidate(overrides: Partial<ImSessionCandidate> = {}): ImSessionCandidate {
  return {
    selector: "session-0123456789abcdef0123",
    title: "修复登录问题",
    workspace: "codeshell",
    runState: "idle",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("display status", () => {
  test("a completed run reads completed, any other terminal reads interrupted", () => {
    expect(imSessionDisplayStatus(candidate({ terminal: { status: "completed", at: 1 } }))).toBe(
      "completed",
    );
    expect(imSessionDisplayStatus(candidate({ terminal: { status: "failed", at: 1 } }))).toBe(
      "interrupted",
    );
    expect(imSessionDisplayStatus(candidate({ terminal: { status: "cancelled", at: 1 } }))).toBe(
      "interrupted",
    );
  });

  test("a pending decision outranks running", () => {
    // It is the one state where the user has something to do.
    const status = imSessionDisplayStatus(
      candidate({ runState: "running", pendingDecisionCount: 1 }),
    );
    expect(status).toBe("waiting-approval");
  });

  test("queued counts as running to the user", () => {
    expect(imSessionDisplayStatus(candidate({ runState: "queued" }))).toBe("running");
  });

  test("a crashed session that still claims active is not shown as running", () => {
    // The projection turns a stale active claim into a failed terminal, so the
    // list must never promise a run that cannot answer.
    const crashed = candidate({ runState: "terminal", terminal: { status: "failed", at: 1 } });
    expect(imSessionDisplayStatus(crashed)).toBe("interrupted");
  });
});

describe("building the list", () => {
  test("numbers rows from one and never emits a raw session id", () => {
    const rows = buildImSessionList([
      candidate({ title: "A", selector: "session-aaaaaaaaaaaaaaaaaaaa" }),
      candidate({ title: "B", selector: "session-bbbbbbbbbbbbbbbbbbbb" }),
    ]);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2]);
    expect(Object.keys(rows[0]!)).not.toContain("sessionId");
    expect(JSON.stringify(rows)).not.toContain("s-login");
  });

  test("archived sessions are dropped, not offered then refused", () => {
    const rows = buildImSessionList([
      candidate({ title: "live" }),
      candidate({ title: "old", archived: true }),
    ]);
    expect(rows.map((row) => row.title)).toEqual(["live"]);
    expect(rows[0]!.ordinal).toBe(1);
  });

  test("caps the list so a phone message stays scannable", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({ title: `S${index}`, selector: `session-${String(index).padStart(20, "0")}` }),
    );
    expect(buildImSessionList(many)).toHaveLength(IM_SESSION_LIST_LIMIT);
  });
});

describe("resolving an ordinal", () => {
  const rows = buildImSessionList([
    candidate({ title: "A", selector: "session-aaaaaaaaaaaaaaaaaaaa" }),
    candidate({ title: "B", selector: "session-bbbbbbbbbbbbbbbbbbbb" }),
  ]);

  test("picks the row the user actually saw", () => {
    expect(resolveImSessionOrdinal(rows, 2)?.selector).toBe("session-bbbbbbbbbbbbbbbbbbbb");
  });

  test("an out-of-range or nonsense ordinal resolves to nothing", () => {
    // Falling back to the last row would bind a Session the user never chose.
    for (const bad of [0, 3, -1, 1.5, Number.NaN]) {
      expect(resolveImSessionOrdinal(rows, bad)).toBeUndefined();
    }
  });
});

describe("ambiguity", () => {
  test("duplicate titles are reported so the host keeps asking", () => {
    const rows = buildImSessionList([
      candidate({ title: "登录问题", selector: "session-aaaaaaaaaaaaaaaaaaaa" }),
      candidate({ title: " 登录问题 ", selector: "session-bbbbbbbbbbbbbbbbbbbb" }),
    ]);
    expect(hasAmbiguousImSessionTitles(rows)).toBe(true);
  });

  test("distinct titles are unambiguous", () => {
    const rows = buildImSessionList([
      candidate({ title: "登录", selector: "session-aaaaaaaaaaaaaaaaaaaa" }),
      candidate({ title: "账单", selector: "session-bbbbbbbbbbbbbbbbbbbb" }),
    ]);
    expect(hasAmbiguousImSessionTitles(rows)).toBe(false);
  });
});
