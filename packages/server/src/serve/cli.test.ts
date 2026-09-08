import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseServeArgs, resolveWorkerEntry } from "./cli.js";

describe("parseServeArgs", () => {
  test("Docker projects are explicit and require account authentication", () => {
    expect(parseServeArgs([], {}).runtime).toBe("local");
    expect(
      parseServeArgs(["--runtime", "docker", "--runtime-image", "codeshell:test"], {}).runtimeImage,
    ).toBe("codeshell:test");
    expect(() => parseServeArgs(["--runtime", "docker", "--passcode", "secret"], {})).toThrow(
      "require",
    );
    expect(() => parseServeArgs(["--runtime", "invalid"], {})).toThrow("runtime");
    expect(() => parseServeArgs(["--runtime-image", "codeshell:test"], {})).toThrow("requires");
  });
  test("defaults: loopback host, port 8790, dataDir under CODE_SHELL_HOME", () => {
    const args = parseServeArgs([], { CODE_SHELL_HOME: "/tmp/cs-home" } as NodeJS.ProcessEnv);
    expect(args.host).toBe("127.0.0.1");
    expect(args.port).toBe(8790);
    expect(args.dataDir).toBe(join("/tmp/cs-home", "serve"));
    expect(args.passcode).toBeUndefined();
    expect(args.authMode).toBe("hub");
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
    expect(args.authMode).toBe("passcode");
  });

  test("validates Hub mode and the externally trusted HTTPS origin", () => {
    expect(parseServeArgs(["--public-url", "https://hub.example.com/"], {}).publicOrigin).toBe(
      "https://hub.example.com",
    );
    expect(
      parseServeArgs([], { CODE_SHELL_SERVE_PUBLIC_URL: "https://hub.example.com" }).publicOrigin,
    ).toBe("https://hub.example.com");
    expect(() => parseServeArgs(["--auth", "unknown"], {})).toThrow(/auth/);
    expect(() => parseServeArgs(["--auth", "hub", "--passcode", "secret"], {})).toThrow(/passcode/);
    for (const origin of [
      "http://hub.example.com",
      "https://hub.example.com/subpath",
      "https://name:secret@hub.example.com",
      "https://hub.example.com/#token",
    ]) {
      expect(() => parseServeArgs(["--public-url", origin], {})).toThrow(/public-url/);
    }
  });

  test("rejects a bogus port", () => {
    expect(() => parseServeArgs(["--port", "not-a-port"], {} as NodeJS.ProcessEnv)).toThrow(/port/);
  });

  test("rejects unknown arguments and flags without values", () => {
    expect(() => parseServeArgs(["--bogus"], {} as NodeJS.ProcessEnv)).toThrow(/unknown argument/);
    expect(() => parseServeArgs(["--host"], {} as NodeJS.ProcessEnv)).toThrow(/missing value/);
  });
});

describe("resolveWorkerEntry", () => {
  test("resolves the agent-server-stdio worker entry from the coding package", () => {
    expect(resolveWorkerEntry()).toContain("agent-server-stdio");
  });
});
