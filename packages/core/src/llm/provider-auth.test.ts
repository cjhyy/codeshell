import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveHeaderValue,
  resolveHeaders,
  resolveAuthCommand,
  resolveApiKey,
  __clearAuthTokenCache,
} from "./provider-auth.js";

beforeEach(() => __clearAuthTokenCache());

describe("resolveHeaderValue", () => {
  const env = { TOKEN: "secret", EMPTY: "" } as NodeJS.ProcessEnv;
  it("passes through a literal value", () => {
    expect(resolveHeaderValue("application/json", env)).toBe("application/json");
  });
  it("resolves $ENV and ${ENV}", () => {
    expect(resolveHeaderValue("$TOKEN", env)).toBe("secret");
    expect(resolveHeaderValue("${TOKEN}", env)).toBe("secret");
  });
  it("resolves a missing env var to empty", () => {
    expect(resolveHeaderValue("$NOPE", env)).toBe("");
  });
});

describe("resolveHeaders", () => {
  it("resolves all values and drops empties", () => {
    const env = { A: "1" } as NodeJS.ProcessEnv;
    expect(
      resolveHeaders({ "X-A": "$A", "X-B": "$MISSING", "X-C": "lit" }, env),
    ).toEqual({ "X-A": "1", "X-C": "lit" });
  });
  it("returns {} for undefined", () => {
    expect(resolveHeaders(undefined)).toEqual({});
  });
});

describe("resolveAuthCommand", () => {
  it("returns the trimmed first line of stdout", () => {
    const token = resolveAuthCommand("whatever", {
      runCommand: () => "  abc123  \nextra\n",
      now: 1000,
    });
    expect(token).toBe("abc123");
  });

  it("caches by command within the TTL", () => {
    let calls = 0;
    const run = () => {
      calls++;
      return `tok${calls}`;
    };
    const a = resolveAuthCommand("cmd", { runCommand: run, now: 1000 });
    const b = resolveAuthCommand("cmd", { runCommand: run, now: 1000 + 30_000 });
    expect(a).toBe("tok1");
    expect(b).toBe("tok1"); // cached
    expect(calls).toBe(1);
  });

  it("re-runs after the TTL expires", () => {
    let calls = 0;
    const run = () => {
      calls++;
      return `tok${calls}`;
    };
    resolveAuthCommand("cmd", { runCommand: run, now: 1000 });
    const later = resolveAuthCommand("cmd", { runCommand: run, now: 1000 + 61_000 });
    expect(later).toBe("tok2");
    expect(calls).toBe(2);
  });
});

describe("resolveApiKey", () => {
  it("prefers an explicit apiKey", () => {
    expect(
      resolveApiKey({ apiKey: "explicit", authCommand: "cmd" }, "envkey", {
        runCommand: () => "fromcmd",
      }),
    ).toBe("explicit");
  });
  it("runs authCommand when no apiKey", () => {
    expect(
      resolveApiKey({ authCommand: "cmd" }, "envkey", { runCommand: () => "fromcmd" }),
    ).toBe("fromcmd");
  });
  it("falls back to the env key when authCommand yields nothing", () => {
    expect(
      resolveApiKey({ authCommand: "cmd" }, "envkey", { runCommand: () => "" }),
    ).toBe("envkey");
  });
  it("falls back to env key when neither apiKey nor authCommand set", () => {
    expect(resolveApiKey({}, "envkey")).toBe("envkey");
  });
});
