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

const probe = (queuedAtTerminal = 0) => ({ queuedAtTerminal });

const codexState: PersistedExternalSessionState = {
  provider: "codex",
  model: "gpt-5",
  title: "修登录",
  summary: "帮我修登录",
};

describe("external Session catalog", () => {
  test("a live runtime is known with its title and queue", () => {
    const { catalog: known } = catalog({ "s-codex": probe(1) }, { "s-codex": codexState });
    expect(known.get("s-codex")).toEqual({ sessionId: "s-codex", title: "修登录", busy: true });
    expect(known.has("s-codex")).toBe(true);
    expect(known.isLive("s-codex")).toBe(true);
  });

  test("busy is the queue sampled at the last terminal: a running turn alone is not busy", () => {
    const { catalog: known } = catalog({ "s-cc": probe(0) });
    expect(known.get("s-cc")).toEqual({ sessionId: "s-cc", busy: false });
  });

  test("isLive asks the runtime only, never the persisted state", () => {
    const { catalog: known, reads } = catalog({ live: probe() }, { idle: codexState });
    expect([known.isLive("live"), known.isLive("idle"), known.isLive("missing")]).toEqual([
      true,
      false,
      false,
    ]);
    expect(reads).toEqual([]);
    for (const runtime of ["absent", "throws"] as const)
      expect(catalog({ live: probe() }, {}, runtime).catalog.isLive("live")).toBe(false);
  });

  test("the title falls back to the first-message summary", () => {
    const { catalog: known } = catalog({ s: probe() }, { s: { ...codexState, title: "  " } });
    expect(known.get("s")?.title).toBe("帮我修登录");
  });

  test("a persisted external work Session without a runtime is known, not busy", () => {
    const { catalog: known } = catalog(
      {},
      {
        "s-codex": codexState,
        // An unknown provider whose model key names the runtime.
        "s-keyed": { provider: "legacy-runtime", model: "claude-code/opus" },
      },
    );
    expect(known.get("s-codex")).toEqual({ sessionId: "s-codex", title: "修登录", busy: false });
    expect(known.has("s-keyed")).toBe(true);
    expect(known.isLive("s-codex")).toBe(false);
  });

  const excluded: Record<string, PersistedExternalSessionState> = {
    child: { ...codexState, parentSessionId: "s-parent" },
    subagent: { ...codexState, origin: "subagent" },
    ephemeral: { ...codexState, ephemeral: true },
    archived: { ...codexState, archivedAt: 1 },
    pet: { ...codexState, kind: "pet" },
    hidden: { ...codexState, kind: "automation" },
  };

  test("native, sub-agent, child, ephemeral, archived, non-work and unknown are not external", () => {
    const { catalog: known } = catalog(
      {},
      {
        native: { provider: "anthropic", model: "claude-opus" },
        // A native provider wins over a model key that looks external.
        nativeKeyed: { provider: "anthropic", model: "codex/gpt-5" },
        ...excluded,
      },
    );
    for (const id of ["native", "nativeKeyed", ...Object.keys(excluded), "missing", "broken"])
      expect(known.get(id)).toBeUndefined();
    expect(known.has("missing")).toBe(false);
  });

  test("a live runtime of a Session that is not top-level work is not eligible either", () => {
    const live = Object.fromEntries(Object.keys(excluded).map((id) => [id, probe()]));
    const { catalog: known } = catalog(live, excluded);
    for (const id of Object.keys(excluded)) expect(known.has(id)).toBe(false);
  });

  test("a non-numeric archivedAt does not archive (as core reads it)", () => {
    const { catalog: known } = catalog({}, { s: { ...codexState, archivedAt: null } });
    expect(known.has("s")).toBe(true);
  });

  test("an explicit top-level work Session is external", () => {
    const { catalog: known } = catalog(
      {},
      { s: { ...codexState, kind: "work", parentSessionId: null } },
    );
    expect(known.has("s")).toBe(true);
  });

  test("a live runtime wins over a persisted native provider; identity is still checked", () => {
    const { catalog: known, reads } = catalog(
      { s: probe() },
      { s: { provider: "anthropic", model: "x" } },
    );
    expect(known.has("s")).toBe(true);
    // One read: the identity filter and the title share it.
    expect(reads).toEqual(["s"]);
  });

  test("without the runtime service, only persisted Sessions are known", () => {
    for (const runtime of ["absent", "throws"] as const) {
      const { catalog: known } = catalog({ s: probe(2) }, { s: codexState }, runtime);
      expect(known.get("s")).toMatchObject({ busy: false });
    }
  });
});
