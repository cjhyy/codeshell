/**
 * The key encoding is a routing decision, so it gets assertions.
 *
 * The failure that matters is NOT "Codex didn't start" — that is loud. It is a
 * native model key being mistaken for an external one: the user picks their
 * usual model and silently gets a different backend. Most of these tests exist
 * to pin that direction.
 */
import { describe, expect, test } from "bun:test";
import {
  EXTERNAL_RUNTIME_MODELS,
  externalRuntimeModelEntries,
  externalRuntimeModelKey,
  isExternalRuntimeModelKey,
  parseExternalRuntimeModelKey,
} from "./external-runtime-models.js";

describe("external runtime model keys", () => {
  test("parses a runtime key into kind + model", () => {
    expect(parseExternalRuntimeModelKey("codex/gpt-5.1")).toEqual({
      kind: "codex",
      model: "gpt-5.1",
    });
    expect(parseExternalRuntimeModelKey("claude-code/sonnet")).toEqual({
      kind: "claude-code",
      model: "sonnet",
    });
  });

  test("native model keys containing a slash stay native", () => {
    // The whole reason the check is an exact prefix match on a closed list.
    // "contains a slash" would reroute all of these to a runtime the user
    // never chose — silently, because the picker label would look unchanged.
    for (const key of [
      "openrouter/auto",
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4o",
      "meta-llama/llama-3-70b",
      "google/gemini-2.0-flash",
      "some-vendor/codex/weird",
    ]) {
      expect(parseExternalRuntimeModelKey(key)).toBeNull();
      expect(isExternalRuntimeModelKey(key)).toBe(false);
    }
  });

  test("a prefix that merely starts with a runtime name stays native", () => {
    // "codex-turbo" is a plausible future native model id. Only "codex/" routes.
    for (const key of ["codex-turbo", "codexy/thing", "claude-code-ish/x", "claude/sonnet"]) {
      expect(parseExternalRuntimeModelKey(key)).toBeNull();
    }
  });

  test("empty / missing keys are native, not a crash", () => {
    for (const key of [null, undefined, "", "   "]) {
      expect(parseExternalRuntimeModelKey(key)).toBeNull();
      expect(isExternalRuntimeModelKey(key)).toBe(false);
    }
  });

  test("a bare runtime prefix parses with no model rather than an empty one", () => {
    // `codex/` should mean "the runtime's own default", never model "".
    expect(parseExternalRuntimeModelKey("codex/")).toEqual({ kind: "codex" });
    expect(parseExternalRuntimeModelKey("codex/   ")).toEqual({ kind: "codex" });
  });

  test("key building round-trips through the parser", () => {
    for (const kind of ["codex", "claude-code"] as const) {
      for (const { model } of EXTERNAL_RUNTIME_MODELS[kind]) {
        const key = externalRuntimeModelKey(kind, model);
        expect(parseExternalRuntimeModelKey(key)).toEqual({ kind, model });
      }
    }
  });

  test("only installed runtimes produce entries", () => {
    // An entry for an uninstalled binary is worse than no entry: the user picks
    // it and gets a spawn failure on send.
    expect(externalRuntimeModelEntries([])).toEqual([]);

    const codexOnly = externalRuntimeModelEntries(["codex"]);
    expect(codexOnly.length).toBeGreaterThan(0);
    expect(codexOnly.every((e) => e.kind === "codex")).toBe(true);

    const both = externalRuntimeModelEntries(["codex", "claude-code"]);
    expect(both.length).toBe(
      EXTERNAL_RUNTIME_MODELS.codex.length + EXTERNAL_RUNTIME_MODELS["claude-code"].length,
    );
  });

  test("every generated entry is itself routable", () => {
    // Guards the pairing: if the catalog ever grew a key the parser rejects,
    // the picker would show an option that silently falls through to native.
    for (const entry of externalRuntimeModelEntries(["codex", "claude-code"])) {
      expect(parseExternalRuntimeModelKey(entry.key)?.kind).toBe(entry.kind);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});
