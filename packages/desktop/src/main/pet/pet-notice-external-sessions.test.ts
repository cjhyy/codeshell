import { describe, expect, test } from "bun:test";
import {
  createExternalSessionCatalog,
  type ExternalRuntimeNoticeProbe,
  type PersistedExternalSessionState,
} from "./pet-notice-external-sessions.js";

function catalog(
  live: Record<string, ReturnType<ExternalRuntimeNoticeProbe["noticeProbe"]>> = {},
  persisted: Record<string, PersistedExternalSessionState> = {},
  runtime: "present" | "absent" | "throws" = "present",
) {
  const reads: string[] = [];
  const probe: ExternalRuntimeNoticeProbe = { noticeProbe: (id) => live[id] };
  return {
    reads,
    catalog: createExternalSessionCatalog({
      runtime: () => {
        if (runtime === "throws") throw new Error("service gone");
        return runtime === "present" ? probe : null;
      },
      readState: (id) => {
        reads.push(id);
        if (id === "broken") throw new Error("corrupt state.json");
        return persisted[id];
      },
    }),
  };
}

const codexState: PersistedExternalSessionState = {
  provider: "codex",
  model: "gpt-5",
  title: "修登录",
  summary: "帮我修登录",
};

describe("external Session catalog", () => {
  test("a live runtime is known with its kind, title and queue", () => {
    const { catalog: known } = catalog(
      { "s-codex": { kind: "codex", running: true, queuedTurns: 1 } },
      { "s-codex": codexState },
    );
    expect(known.get("s-codex")).toEqual({
      sessionId: "s-codex",
      runtime: "codex",
      title: "修登录",
      running: true,
      busy: true,
      live: true,
    });
    expect(known.has("s-codex")).toBe(true);
  });

  test("a running turn alone is not busy: busy means work queued behind it", () => {
    const { catalog: known } = catalog({
      "s-cc": { kind: "claude-code", running: true, queuedTurns: 0 },
    });
    expect(known.get("s-cc")).toMatchObject({ runtime: "claude-code", running: true, busy: false });
    // No persisted state (yet): still live, just untitled.
    expect(known.get("s-cc")?.title).toBeUndefined();
  });

  test("the title falls back to the first-message summary", () => {
    const { catalog: known } = catalog(
      { s: { kind: "codex", running: false, queuedTurns: 0 } },
      { s: { ...codexState, title: "  " } },
    );
    expect(known.get("s")?.title).toBe("帮我修登录");
  });

  test("a persisted external work Session without a runtime is known, not live", () => {
    const { catalog: known } = catalog(
      {},
      {
        "s-codex": codexState,
        // An unknown provider whose model key names the runtime.
        "s-keyed": { provider: "legacy-runtime", model: "claude-code/opus" },
      },
    );
    expect(known.get("s-codex")).toEqual({
      sessionId: "s-codex",
      runtime: "codex",
      title: "修登录",
      running: false,
      busy: false,
      live: false,
    });
    expect(known.get("s-keyed")).toMatchObject({ runtime: "claude-code", live: false });
  });

  test("native, child, archived, non-work and unknown Sessions are not external", () => {
    const { catalog: known } = catalog(
      {},
      {
        native: { provider: "anthropic", model: "claude-opus" },
        // A native provider wins over a model key that looks external.
        nativeKeyed: { provider: "anthropic", model: "codex/gpt-5" },
        child: { ...codexState, parentSessionId: "s-parent" },
        archived: { ...codexState, archivedAt: 1 },
        pet: { ...codexState, kind: "pet" },
      },
    );
    for (const id of ["native", "nativeKeyed", "child", "archived", "pet", "missing", "broken"])
      expect(known.get(id)).toBeUndefined();
    expect(known.has("missing")).toBe(false);
  });

  test("an explicit top-level work Session is external", () => {
    const { catalog: known } = catalog(
      {},
      { s: { ...codexState, kind: "work", parentSessionId: null } },
    );
    expect(known.has("s")).toBe(true);
  });

  test("a live runtime is never second-guessed by its persisted state", () => {
    const { catalog: known, reads } = catalog(
      { s: { kind: "codex", running: false, queuedTurns: 0 } },
      { s: { provider: "anthropic", model: "x" } },
    );
    expect(known.get("s")).toMatchObject({ live: true, runtime: "codex" });
    expect(reads).toEqual(["s"]);
  });

  test("without the runtime service, only persisted Sessions are known", () => {
    for (const runtime of ["absent", "throws"] as const) {
      const { catalog: known } = catalog(
        { s: { kind: "codex", running: true, queuedTurns: 2 } },
        { s: codexState },
        runtime,
      );
      expect(known.get("s")).toMatchObject({ live: false, busy: false, running: false });
    }
  });
});
