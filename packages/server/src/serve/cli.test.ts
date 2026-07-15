import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseServeArgs, resolveWorkerEntry } from "./cli.js";

describe("parseServeArgs", () => {
  test("defaults: loopback host, port 8790, dataDir under CODE_SHELL_HOME", () => {
    const args = parseServeArgs([], { CODE_SHELL_HOME: "/tmp/cs-home" } as NodeJS.ProcessEnv);
    expect(args.host).toBe("127.0.0.1");
    expect(args.port).toBe(8790);
    expect(args.dataDir).toBe(join("/tmp/cs-home", "serve"));
    expect(args.passcode).toBeUndefined();
  });

  test("parses explicit flags", () => {
    const args = parseServeArgs(
      ["--cwd", "/work/repo", "--port", "9000", "--host", "0.0.0.0", "--passcode", "s3cret"],
      {} as NodeJS.ProcessEnv,
    );
    expect(args.cwd).toBe("/work/repo");
    expect(args.port).toBe(9000);
    expect(args.host).toBe("0.0.0.0");
    expect(args.passcode).toBe("s3cret");
  });

  test("rejects a bogus port", () => {
    expect(() => parseServeArgs(["--port", "not-a-port"], {} as NodeJS.ProcessEnv)).toThrow(/port/);
  });
});

describe("resolveWorkerEntry", () => {
  test("resolves the agent-server-stdio worker entry from the coding package", () => {
    expect(resolveWorkerEntry()).toContain("agent-server-stdio");
  });
});
