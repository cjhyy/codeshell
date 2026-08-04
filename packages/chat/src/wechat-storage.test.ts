import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileWechatStateStore,
  hasWechatStoredContextToken,
  wechatCredentialFingerprint,
  WechatStateOwnershipError,
} from "./wechat-storage.js";

let directory: string;
let statePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-wechat-state-"));
  statePath = join(directory, "owner.state.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("WeChat state storage", () => {
  test("adapter loading and host readiness use one context-token parser", async () => {
    const store = new FileWechatStateStore(statePath);
    await store.save({
      cursor: "cursor-1",
      contextTokens: { owner: "context-secret", blank: "" },
    });

    await expect(store.load()).resolves.toEqual({
      cursor: "cursor-1",
      contextTokens: { owner: "context-secret" },
    });
    expect(hasWechatStoredContextToken(statePath, "owner")).toBe(true);
    expect(hasWechatStoredContextToken(statePath, "blank")).toBe(false);
    expect(hasWechatStoredContextToken(statePath, "missing")).toBe(false);
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  test("malformed state hides proactive readiness and blocks adapter startup", async () => {
    writeFileSync(statePath, "not-json", { mode: 0o600 });
    expect(hasWechatStoredContextToken(statePath, "owner")).toBe(false);
    await expect(new FileWechatStateStore(statePath).load()).rejects.toThrow(
      "无法安全读取微信状态文件",
    );
  });

  test("insecure or oversized state fails closed", async () => {
    const store = new FileWechatStateStore(statePath);
    await store.save({ contextTokens: { owner: "context-secret" } });
    if (process.platform !== "win32") {
      chmodSync(statePath, 0o644);
      expect(hasWechatStoredContextToken(statePath, "owner")).toBe(false);
      await expect(store.load()).rejects.toThrow("权限必须为 0600");
    }

    writeFileSync(
      statePath,
      JSON.stringify({ contextTokens: { owner: "x".repeat(1024 * 1024) } }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(statePath, 0o600);
    expect(hasWechatStoredContextToken(statePath, "owner")).toBe(false);
    await expect(store.load()).rejects.toThrow("超过大小限制");
  });

  test("does not follow a symbolic-link state file", async () => {
    if (process.platform === "win32") return;
    const target = join(directory, "target.json");
    writeFileSync(
      target,
      JSON.stringify({ cursor: "cursor-1", contextTokens: { owner: "context-secret" } }),
      { mode: 0o600 },
    );
    symlinkSync(target, statePath);
    expect(hasWechatStoredContextToken(statePath, "owner")).toBe(false);
    await expect(new FileWechatStateStore(statePath).load()).rejects.toThrow("不是普通文件");
  });

  test("a stale credential cannot resurrect state after a QR rebind takeover", async () => {
    const staleStore = new FileWechatStateStore(
      statePath,
      wechatCredentialFingerprint("old-token"),
    );
    await staleStore.save({
      cursor: "cursor-old",
      contextTokens: { "owner-user": "old-context" },
    });

    const rebindStore = new FileWechatStateStore(
      statePath,
      wechatCredentialFingerprint("new-token"),
    );
    await rebindStore.reset({});

    await expect(
      staleStore.save({
        cursor: "cursor-resurrected",
        contextTokens: { "owner-user": "old-context" },
      }),
    ).rejects.toThrow(WechatStateOwnershipError);
    await expect(rebindStore.load()).resolves.toEqual({});
    await expect(staleStore.load()).rejects.toThrow(WechatStateOwnershipError);
  });

  test("a legacy state file without a fingerprint is adopted by the first stamped writer", async () => {
    await new FileWechatStateStore(statePath).save({ cursor: "cursor-legacy" });

    const adopting = new FileWechatStateStore(statePath, wechatCredentialFingerprint("token-a"));
    await expect(adopting.load()).resolves.toEqual({ cursor: "cursor-legacy" });
    await adopting.save({ cursor: "cursor-adopted" });

    const other = new FileWechatStateStore(statePath, wechatCredentialFingerprint("token-b"));
    await expect(other.save({ cursor: "cursor-hijack" })).rejects.toThrow(
      WechatStateOwnershipError,
    );
    await expect(adopting.load()).resolves.toEqual({ cursor: "cursor-adopted" });
  });

  test("refuses to persist an unbounded state file", async () => {
    const store = new FileWechatStateStore(statePath);
    await expect(store.save({ contextTokens: { owner: "x".repeat(1024 * 1024) } })).rejects.toThrow(
      "超过大小限制",
    );
  });
});
