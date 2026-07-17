import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureMiniDom } from "../test-utils/renderHook";
import {
  COMPOSER_SEED_REQUEST_EVENT,
  MAX_COMPOSER_SEED_CHARS,
  normalizeComposerSeedRequest,
  onComposerSeedRequest,
  requestComposerSeed,
} from "./composerSeed";

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  ensureMiniDom();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe("composer seed request bridge", () => {
  test("delivers an exact reviewed plugin prompt to the App listener", () => {
    const received: unknown[] = [];
    unsubscribe = onComposerSeedRequest((request) => received.push(request));

    expect(
      requestComposerSeed({
        text: "Review this edit, but do not send automatically.",
        source: "plugin-starter-prompt",
      }),
    ).toBe(true);
    expect(received).toEqual([
      {
        text: "Review this edit, but do not send automatically.",
        source: "plugin-starter-prompt",
      },
    ]);
  });

  test("rejects empty, oversized, and unrecognized event payloads", () => {
    const received: unknown[] = [];
    unsubscribe = onComposerSeedRequest((request) => received.push(request));

    expect(requestComposerSeed({ text: "   ", source: "plugin-starter-prompt" })).toBe(false);
    expect(
      requestComposerSeed({
        text: "x".repeat(MAX_COMPOSER_SEED_CHARS + 1),
        source: "plugin-starter-prompt",
      }),
    ).toBe(false);
    window.dispatchEvent(
      new CustomEvent(COMPOSER_SEED_REQUEST_EVENT, {
        detail: { text: "spoofed", source: "unknown" },
      }),
    );

    expect(received).toEqual([]);
    expect(normalizeComposerSeedRequest(null)).toBeNull();
  });

  test("cleanup removes the consumer", () => {
    const received: unknown[] = [];
    unsubscribe = onComposerSeedRequest((request) => received.push(request));
    unsubscribe();
    unsubscribe = null;

    requestComposerSeed({ text: "after cleanup", source: "plugin-starter-prompt" });
    expect(received).toEqual([]);
  });
});
