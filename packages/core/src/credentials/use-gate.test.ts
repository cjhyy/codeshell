import { describe, test, expect } from "bun:test";
import {
  credentialUseGate,
  type CredentialAskFn,
  type SessionCredentialAllow,
} from "./use-gate.js";

const REQ = {
  approvalIdentity: "opaque-record-a",
  id: "xhs__a",
  label: "账号A",
  purpose: "拉小红书内容",
};

describe("credentialUseGate", () => {
  test("autoApprove=true skips the prompt", async () => {
    let asked = false;
    const ask: CredentialAskFn = async () => {
      asked = true;
      return "拒绝";
    };
    const d = await credentialUseGate(REQ, { autoApprove: true, sessionAllow: new Set(), ask });
    expect(d.allowed).toBe(true);
    expect(asked).toBe(false);
  });

  test("session-remembered record identity skips the prompt", async () => {
    let asked = false;
    const ask: CredentialAskFn = async () => {
      asked = true;
      return "拒绝";
    };
    const sessionAllow: SessionCredentialAllow = new Set(["opaque-record-a"]);
    const d = await credentialUseGate(REQ, { autoApprove: false, sessionAllow, ask });
    expect(d.allowed).toBe(true);
    expect(asked).toBe(false);
  });

  test("prompt: 允许本次 allows but does NOT remember", async () => {
    const ask: CredentialAskFn = async () => "允许本次";
    const sessionAllow: SessionCredentialAllow = new Set();
    const d = await credentialUseGate(REQ, { autoApprove: false, sessionAllow, ask });
    expect(d.allowed).toBe(true);
    expect(sessionAllow.has("opaque-record-a")).toBe(false); // 不记住
  });

  test("prompt: 本会话都允许 allows AND remembers by record identity", async () => {
    const ask: CredentialAskFn = async () => "本会话都允许";
    const sessionAllow: SessionCredentialAllow = new Set();
    const d = await credentialUseGate(REQ, { autoApprove: false, sessionAllow, ask });
    expect(d.allowed).toBe(true);
    expect(sessionAllow.has("opaque-record-a")).toBe(true); // 记住的是已审批的记录身份
    // 不会放行同 ID 的另一个来源或记录
    expect(sessionAllow.has("youtube__main")).toBe(false);
  });

  test("prompt: 拒绝 denies", async () => {
    const ask: CredentialAskFn = async () => "拒绝";
    const d = await credentialUseGate(REQ, { autoApprove: false, sessionAllow: new Set(), ask });
    expect(d).toEqual({ allowed: false, reason: "denied" });
  });

  test("no ask handler (headless) denies with no-ui", async () => {
    const d = await credentialUseGate(REQ, { autoApprove: false, sessionAllow: new Set() });
    expect(d).toEqual({ allowed: false, reason: "no-ui" });
  });
});
