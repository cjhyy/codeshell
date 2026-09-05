import { describe, expect, test } from "bun:test";
import {
  isQuickChatBucket,
  sanitizeBrowserBucket,
  QUICK_CHAT_BUCKET_PREFIX,
  BROWSER_PARTITION_PREFIX,
  QUICK_CHAT_PARTITION_PREFIX,
} from "./browser-partition";

describe("browser partition primitives", () => {
  test("classifies Quick Chat buckets", () => {
    expect(isQuickChatBucket(`${QUICK_CHAT_BUCKET_PREFIX}qchat-a`)).toBe(true);
    expect(isQuickChatBucket("repo::session-a")).toBe(false);
  });

  test("only the Quick Chat prefix is non-persistent", () => {
    // A quick chat's browser state must not outlive the window; everything else
    // must survive a restart or the login it holds is worthless.
    expect(BROWSER_PARTITION_PREFIX.startsWith("persist:")).toBe(true);
    expect(QUICK_CHAT_PARTITION_PREFIX.startsWith("persist:")).toBe(false);
  });

  test("replaces unsafe characters without trimming", () => {
    // No trim: the result is compared for equality across IPC, so both sides
    // must normalize identically — including surrounding whitespace.
    expect(sanitizeBrowserBucket(" a b/c\\d ")).toBe("_a_b_c_d_");
    // Characters that are already safe survive untouched, ":" included — the
    // on-disk directory name depends on it.
    expect(sanitizeBrowserBucket("a-b_c.d@e:f")).toBe("a-b_c.d@e:f");
    expect(sanitizeBrowserBucket("proj::sess")).toBe("proj::sess");
  });
});
