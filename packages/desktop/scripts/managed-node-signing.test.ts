import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createSigningHooks } = require("./managed-node-signing.cjs");

type SigningOptions = {
  app: string;
  identity?: string;
  keychain?: string;
  ignore?: (file: string) => boolean;
};

type Event = { kind: string; args?: string[]; options?: unknown };

function fixture(platform = "darwin") {
  const appOutDir = "/managed-node-signing-fixture/dist";
  const appPath = join(appOutDir, "code-shell.app");
  const runtimeDir = join(
    platform === "darwin" ? join(appPath, "Contents/Resources") : join(appOutDir, "resources"),
    "runtimes/node",
  );
  const executable = platform === "win32" ? "bin/node.exe" : "bin/node";
  const nodePath = join(runtimeDir, executable);
  const target = { platform, arch: "arm64" };
  const context = {
    electronPlatformName: platform,
    arch: "arm64",
    appOutDir,
    packager: { appInfo: { productFilename: "code-shell" }, forceCodeSigning: false },
  };
  const events: Event[] = [];
  let bytes = "original official Node";
  const digest = () => createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schemaVersion: 1,
    id: "node",
    version: "24.21.0",
    ...target,
    executable,
    sha256: digest(),
  };
  const supply = {
    packagingTarget: () => target,
    packagedRuntimeDirectory: () => runtimeDir,
    stageRuntime: async (options: unknown) => {
      events.push({ kind: "stage", options });
      manifest.sha256 = digest();
      return { runtimeDir, manifest };
    },
    refreshManifest: async (directory: string) => {
      expect(directory).toBe(runtimeDir);
      events.push({ kind: "refresh" });
      manifest.sha256 = digest();
      return manifest;
    },
    verifyRuntime: async (directory: string) => {
      expect(directory).toBe(runtimeDir);
      events.push({ kind: "verify-runtime" });
      if (manifest.sha256 !== digest())
        throw new Error("Managed Node executable checksum mismatch");
      return manifest;
    },
  };
  const run = async (command: string, args: string[]) => {
    expect(command.endsWith("codesign")).toBe(true);
    const file = args.at(-1);
    if (args.includes("--verify")) {
      events.push({ kind: file === nodePath ? "verify-node" : "verify-app", args });
    } else if (args.includes("--sign") || args.includes("-s")) {
      if (file === nodePath) {
        events.push({ kind: "sign-node", args });
        bytes = `Node after explicit signature: ${args.join(" ")}`;
      } else if (args.includes("--deep")) {
        events.push({ kind: "sign-deep", args });
        bytes = "Node changed by recursive bundle signing";
      } else {
        events.push({ kind: "sign-outer", args });
      }
    } else {
      events.push({ kind: "inspect-signature", args });
    }
    return { stdout: "", stderr: "" };
  };
  const signAsync = async (options: SigningOptions) => {
    events.push({ kind: "builder-sign", options });
  };
  return {
    appPath,
    nodePath,
    runtimeDir,
    target,
    context,
    events,
    manifest,
    supply,
    run,
    signAsync,
    changeNodeBytes: () => {
      bytes += " changed after manifest";
    },
    hooks: (overrides: Record<string, unknown> = {}) =>
      createSigningHooks({ supply, run, signAsync, ...overrides }),
  };
}

function ordered(events: Event[], kinds: string[]) {
  let last = -1;
  for (const kind of kinds) {
    const next = events.findIndex((event, index) => index > last && event.kind === kind);
    expect(next).toBeGreaterThan(last);
    last = next;
  }
}

function signingIdentity(args: string[]) {
  const flag = args.includes("--sign") ? "--sign" : "-s";
  return args[args.indexOf(flag) + 1];
}

describe("managed Node packaging signature ordering", () => {
  test("ad-hoc packaging records the final Node signature before sealing only the outer app", async () => {
    const f = fixture();
    await f.hooks().afterPack(f.context);

    expect(f.events[0].kind).toBe("stage");
    expect(f.events[0].options).toMatchObject({ ...f.target, runtimeDir: f.runtimeDir });
    ordered(f.events, [
      "stage",
      "sign-deep",
      "sign-node",
      "refresh",
      "sign-outer",
      "verify-runtime",
    ]);
    const refreshIndex = f.events.findIndex(({ kind }) => kind === "refresh");
    const laterSignatures = f.events
      .slice(refreshIndex + 1)
      .filter(({ kind }) => kind.startsWith("sign-"));
    expect(laterSignatures.length).toBeGreaterThan(0);
    for (const event of laterSignatures) {
      expect(event.kind).toBe("sign-outer");
      expect(event.args).not.toContain("--deep");
      expect(event.args?.at(-1)).toBe(f.appPath);
    }
    const nodeSignature = f.events.find(({ kind }) => kind === "sign-node")!.args!;
    expect(signingIdentity(nodeSignature)).toBe("-");
    expect(nodeSignature).toContain("--entitlements");
    expect(nodeSignature).toContain("--options");
    expect(nodeSignature[nodeSignature.indexOf("--options") + 1].split(",")).toContain("runtime");
    expect(f.events.some(({ kind }) => kind === "verify-node")).toBe(true);
    expect(f.events.some(({ kind }) => kind === "verify-app")).toBe(true);
  });

  test("Developer ID signing uses the resolved identity and preserves builder's ignore callback", async () => {
    const f = fixture();
    const ignore = (file: string) => file === f.nodePath || file.endsWith(".kext");
    const options = {
      app: f.appPath,
      identity: "RESOLVED_CERTIFICATE_HASH",
      keychain: "/build/keychain",
      ignore,
    };
    await f.hooks().macSign(options, f.context.packager);

    ordered(f.events, ["sign-node", "refresh", "builder-sign", "verify-runtime"]);
    const nodeSignature = f.events.find(({ kind }) => kind === "sign-node")!.args!;
    expect(signingIdentity(nodeSignature)).toBe(options.identity);
    expect(nodeSignature[nodeSignature.indexOf("--keychain") + 1]).toBe(options.keychain);
    expect(nodeSignature).toContain("--entitlements");
    expect(nodeSignature).toContain("--options");
    const delegated = f.events.find(({ kind }) => kind === "builder-sign")!
      .options as SigningOptions;
    expect(delegated.ignore).toBe(ignore);
    expect(delegated.ignore!(f.nodePath)).toBe(true);
    expect(delegated.identity).toBe(options.identity);
    expect(delegated.keychain).toBe(options.keychain);
    expect(f.events.some(({ kind }) => kind === "stage" || kind === "sign-deep")).toBe(false);
  });

  test("a builder signer that changes Node after hashing blocks completion", async () => {
    const f = fixture();
    const hooks = f.hooks({
      signAsync: async () => {
        f.changeNodeBytes();
      },
    });
    await expect(
      hooks.macSign(
        { app: f.appPath, identity: "certificate", ignore: (file: string) => file === f.nodePath },
        f.context.packager,
      ),
    ).rejects.toThrow("checksum mismatch");
  });

  test("a failed Node signature propagates before the manifest or outer seal is written", async () => {
    const f = fixture();
    const hooks = f.hooks({
      run: async (command: string, args: string[]) => {
        if (args.at(-1) === f.nodePath && !args.includes("--verify"))
          throw new Error("codesign failed");
        return f.run(command, args);
      },
    });
    await expect(hooks.afterPack(f.context)).rejects.toThrow("codesign failed");
    expect(f.events.some(({ kind }) => kind === "refresh" || kind === "sign-outer")).toBe(false);
  });

  test("a manifest refresh failure prevents Developer ID bundle signing", async () => {
    const f = fixture();
    const hooks = f.hooks({
      supply: {
        ...f.supply,
        refreshManifest: async () => {
          throw new Error("manifest write failed");
        },
      },
    });
    await expect(
      hooks.macSign(
        { app: f.appPath, identity: "certificate", ignore: (file: string) => file === f.nodePath },
        f.context.packager,
      ),
    ).rejects.toThrow("manifest write failed");
    expect(f.events.some(({ kind }) => kind === "builder-sign")).toBe(false);
  });

  test("a missing certificate fails when signing is required", async () => {
    const f = fixture();
    await expect(
      f.hooks().macSign({ app: f.appPath }, { ...f.context.packager, forceCodeSigning: true }),
    ).rejects.toThrow();
    expect(
      f.events.some(
        ({ kind }) => kind.startsWith("sign-") || kind === "refresh" || kind === "builder-sign",
      ),
    ).toBe(false);
  });

  test("a missing Node exclusion blocks Developer ID signing before changing any bytes", async () => {
    const f = fixture();
    for (const ignore of [undefined, () => false]) {
      await expect(
        f.hooks().macSign({ app: f.appPath, identity: "certificate", ignore }, f.context.packager),
      ).rejects.toThrow("mac.signIgnore");
    }
    expect(f.events).toEqual([]);
  });

  test("without a certificate the custom hook verifies the existing ad-hoc result without rewriting it", async () => {
    const f = fixture();
    await f.hooks().macSign({ app: f.appPath }, f.context.packager);
    expect(f.events.some(({ kind }) => kind === "verify-runtime")).toBe(true);
    expect(
      f.events.some(
        ({ kind }) =>
          kind.startsWith("sign-") ||
          kind === "stage" ||
          kind === "refresh" ||
          kind === "builder-sign",
      ),
    ).toBe(false);
  });

  test("afterSign only verifies the final macOS runtime and signatures", async () => {
    const f = fixture();
    await f.hooks().afterSign(f.context);
    expect(f.events.some(({ kind }) => kind === "verify-runtime")).toBe(true);
    expect(f.events.some(({ kind }) => kind === "verify-node")).toBe(true);
    expect(f.events.some(({ kind }) => kind === "verify-app")).toBe(true);
    expect(
      f.events.every(({ kind }) => kind.startsWith("verify-") || kind === "inspect-signature"),
    ).toBe(true);
  });

  test("afterSign detects a late change instead of refreshing the manifest to accept it", async () => {
    const f = fixture();
    f.changeNodeBytes();
    await expect(f.hooks().afterSign(f.context)).rejects.toThrow("checksum mismatch");
    expect(f.events.some(({ kind }) => kind === "refresh")).toBe(false);
  });

  for (const platform of ["win32", "linux"]) {
    test(`${platform} stages and verifies Node without invoking codesign`, async () => {
      const f = fixture(platform);
      await f.hooks().afterPack(f.context);
      expect(f.events.map(({ kind }) => kind)).toEqual(["stage", "verify-runtime"]);
      expect(f.events[0].options).toMatchObject({ ...f.target, runtimeDir: f.runtimeDir });
      f.events.length = 0;
      await f.hooks().afterSign(f.context);
      expect(f.events.map(({ kind }) => kind)).toEqual(["verify-runtime"]);
    });
  }

  test("supply failure prevents every signing operation", async () => {
    const f = fixture();
    const hooks = f.hooks({
      supply: {
        ...f.supply,
        stageRuntime: async () => {
          throw new Error("archive checksum mismatch");
        },
      },
    });
    await expect(hooks.afterPack(f.context)).rejects.toThrow("archive checksum mismatch");
    expect(f.events).toEqual([]);
  });
});
