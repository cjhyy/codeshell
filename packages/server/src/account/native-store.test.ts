import { describe, expect, test } from "bun:test";
import {
  NativeAccountStore,
  MemoryAccountStore,
  type NativeAccountStoreRunner,
} from "./native-store.js";
import type { SavedCloudAccount } from "./store.js";
const origin = "https://accounts.example";
const saved: SavedCloudAccount = {
  origin,
  accessToken: "a".repeat(43),
  refreshToken: "b".repeat(43),
  accessTokenExpiresAt: Date.now() + 1000,
  refreshTokenExpiresAt: Date.now() + 2000,
  sessionId: "11111111-1111-4111-8111-111111111111",
  account: { id: "22222222-2222-4222-8222-222222222222", username: "member" },
};
describe("native account stores", () => {
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform} keeps secrets off process argv and isolates each origin`, () => {
      const vault = new Map<string, string>();
      const argsSeen: string[][] = [];
      const run: NativeAccountStoreRunner = (_command, args, input) => {
        argsSeen.push(args);
        let key: string, operation: string;
        if (platform === "darwin") {
          if (input) expect(input.split("\n").filter(Boolean)).toHaveLength(1);
          const tokens = input?.startsWith("add-generic-password")
            ? input.split("\n")[0].split(" ")
            : args;
          key = tokens[tokens.indexOf("-a") + 1];
          operation = tokens[0];
          if (operation === "add-generic-password")
            vault.set(key, tokens[tokens.indexOf("-w") + 1]);
        } else {
          key = args[args.indexOf("account") + 1];
          operation = args[0];
          if (operation === "store") vault.set(key, input!);
        }
        if (["find-generic-password", "lookup"].includes(operation))
          return {
            status: vault.has(key) ? 0 : platform === "darwin" ? 44 : 1,
            stdout: vault.get(key) ?? "",
          };
        if (["delete-generic-password", "clear"].includes(operation)) vault.delete(key);
        return { status: 0, stdout: "" };
      };
      const store = new NativeAccountStore(origin, { platform, run });
      store.preflight();
      expect(vault.size).toBe(0);
      expect(store.load()).toBeUndefined();
      store.save(saved);
      expect(store.load()).toEqual(saved);
      expect(
        new NativeAccountStore("https://other.example", { platform, run }).load(),
      ).toBeUndefined();
      expect(JSON.stringify(argsSeen)).not.toContain(saved.accessToken);
      expect(JSON.stringify(argsSeen)).not.toContain(
        Buffer.from(JSON.stringify(saved)).toString("base64"),
      );
      expect(() => store.save({ ...saved, origin: "https://other.example" })).toThrow();
      store.forget();
      expect(store.load()).toBeUndefined();
    });
  }
  test("unavailable credentials never silently become a plaintext or memory store", () => {
    const store = new NativeAccountStore(origin, {
      platform: "linux",
      run: () => ({ status: null, stdout: "", error: new Error("unavailable") }),
    });
    expect(() => store.preflight()).toThrow("--memory");
    expect(() => store.save(saved)).toThrow("--memory");
    const memory = new MemoryAccountStore();
    memory.save(saved);
    const copy = memory.load()!;
    copy.accessToken = "changed";
    expect(memory.load()).toEqual(saved);
    memory.forget();
    expect(memory.load()).toBeUndefined();
  });
});

test("Windows stores only DPAPI ciphertext and pipes sensitive bytes", async () => {
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "codeshell-native-dpapi-"));
  const seen: string[][] = [];
  try {
    const store = new NativeAccountStore(origin, {
      platform: "win32",
      dataDir,
      run: (command, args, input) => {
        expect(command.toLowerCase()).toEndWith(
          "\\system32\\windowspowershell\\v1.0\\powershell.exe",
        );
        seen.push(args);
        const bytes = Buffer.from(input!, "base64");
        return {
          status: 0,
          stdout: Buffer.from(bytes.map((value) => value ^ 0x55)).toString("base64"),
        };
      },
    });
    store.preflight();
    expect(readdirSync(dataDir)).toEqual([]);
    store.save(saved);
    expect(store.load()).toEqual(saved);
    const bytes = readFileSync(join(dataDir, readdirSync(dataDir)[0]));
    expect(bytes.toString()).not.toContain(saved.accessToken);
    expect(JSON.stringify(seen)).not.toContain(saved.accessToken);
    store.forget();
    expect(store.load()).toBeUndefined();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
