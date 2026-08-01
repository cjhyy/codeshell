import { describe, expect, test } from "bun:test";
import { buildRuntimeSpawnEnv } from "./spawn-env.js";

describe("buildRuntimeSpawnEnv", () => {
  test("adds the loopback hosts to NO_PROXY", () => {
    const env = buildRuntimeSpawnEnv({ base: {} });
    const entries = (env.NO_PROXY ?? "").split(",");
    expect(entries).toContain("127.0.0.1");
    expect(entries).toContain("localhost");
    expect(entries).toContain("::1");
  });

  test("preserves entries the user already set", () => {
    const env = buildRuntimeSpawnEnv({ base: { NO_PROXY: "example.com,10.0.0.0/8" } });
    const entries = (env.NO_PROXY ?? "").split(",");
    expect(entries).toContain("example.com");
    expect(entries).toContain("10.0.0.0/8");
    expect(entries).toContain("127.0.0.1");
  });

  test("does not duplicate a loopback host that is already present", () => {
    const env = buildRuntimeSpawnEnv({ base: { NO_PROXY: "localhost , 127.0.0.1" } });
    const entries = (env.NO_PROXY ?? "").split(",");
    expect(entries.filter((e) => e === "localhost")).toHaveLength(1);
    expect(entries.filter((e) => e === "127.0.0.1")).toHaveLength(1);
  });

  test("folds in the lowercase twin and then removes it", () => {
    // Rust and Go read both spellings; leaving two behind lets one silently win
    // depending on which library looks first.
    const env = buildRuntimeSpawnEnv({ base: { no_proxy: "corp.internal" } });
    expect(env.NO_PROXY).toContain("corp.internal");
    expect(env.NO_PROXY).toContain("127.0.0.1");
    expect("no_proxy" in env).toBe(false);
  });

  test("carries the bridge token under its configured name", () => {
    const env = buildRuntimeSpawnEnv({
      base: {},
      bridgeToken: { name: "CODESHELL_CODEX_MCP_TOKEN", value: "abc123" },
    });
    expect(env.CODESHELL_CODEX_MCP_TOKEN).toBe("abc123");
  });

  test("does not mutate the base environment", () => {
    const base: NodeJS.ProcessEnv = { NO_PROXY: "example.com", no_proxy: "example.com" };
    buildRuntimeSpawnEnv({ base });
    expect(base.NO_PROXY).toBe("example.com");
    expect(base.no_proxy).toBe("example.com");
  });
});
