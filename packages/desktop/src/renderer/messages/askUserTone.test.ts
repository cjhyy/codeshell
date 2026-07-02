import { describe, it, expect } from "bun:test";
import { resolveAnswerTone, toneEchoStyle, normalizeTone } from "./askUserTone";
import type { AskUserOption } from "../types";

const CREDENTIAL_OPTS: AskUserOption[] = [
  { label: "允许本次", description: "仅本次取用该凭证", tone: "ok" },
  { label: "本会话都允许", description: "本会话内不再询问", tone: "ok" },
  { label: "拒绝", description: "拒绝本次取用", tone: "danger" },
];

describe("resolveAnswerTone", () => {
  it("maps the deny option to danger (NOT ok) — the core bug", () => {
    expect(resolveAnswerTone("拒绝", CREDENTIAL_OPTS)).toBe("danger");
  });

  it("maps allow options to ok", () => {
    expect(resolveAnswerTone("允许本次", CREDENTIAL_OPTS)).toBe("ok");
    expect(resolveAnswerTone("本会话都允许", CREDENTIAL_OPTS)).toBe("ok");
  });

  it("is neutral for LLM prompts whose options carry no tone", () => {
    const llmOpts: AskUserOption[] = [
      { label: "方案 A", description: "..." },
      { label: "方案 B", description: "..." },
    ];
    expect(resolveAnswerTone("方案 A", llmOpts)).toBe("neutral");
  });

  it("is neutral when there are no options (free text)", () => {
    expect(resolveAnswerTone("some typed answer", undefined)).toBe("neutral");
    expect(resolveAnswerTone("x", [])).toBe("neutral");
  });

  it("is neutral when the answer doesn't exactly match a label (multiSelect / Other / free text)", () => {
    // multiSelect joins labels with ", " → no single-label match
    expect(resolveAnswerTone("允许本次, 拒绝", CREDENTIAL_OPTS)).toBe("neutral");
    // "Other: …" free typed
    expect(resolveAnswerTone("Other: 别的", CREDENTIAL_OPTS)).toBe("neutral");
  });

  it("is neutral for undefined answer", () => {
    expect(resolveAnswerTone(undefined, CREDENTIAL_OPTS)).toBe("neutral");
  });
});

describe("toneEchoStyle", () => {
  it("ok → green check", () => {
    const s = toneEchoStyle("ok");
    expect(s.icon).toBe("check");
    expect(s.className).toContain("status-ok");
  });

  it("danger → red cross, never green check (the visual bug)", () => {
    const s = toneEchoStyle("danger");
    expect(s.icon).toBe("cross");
    expect(s.className).toContain("status-err");
    expect(s.className).not.toContain("status-ok");
  });

  it("neutral → no icon, muted", () => {
    const s = toneEchoStyle("neutral");
    expect(s.icon).toBe("none");
    expect(s.className).toContain("muted");
  });
});

describe("normalizeTone", () => {
  it("passes through known tones", () => {
    expect(normalizeTone("ok")).toBe("ok");
    expect(normalizeTone("danger")).toBe("danger");
  });
  it("coerces unknown / garbage to neutral", () => {
    expect(normalizeTone("neutral")).toBe("neutral");
    expect(normalizeTone("green")).toBe("neutral");
    expect(normalizeTone(undefined)).toBe("neutral");
    expect(normalizeTone(42)).toBe("neutral");
  });
});
