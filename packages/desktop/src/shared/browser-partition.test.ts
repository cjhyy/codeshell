import { describe, expect, test } from "bun:test";
import {
  browserPartitionForBucket,
  isQuickChatBucket,
  sanitizeBrowserBucket,
  QUICK_CHAT_BUCKET_PREFIX,
} from "./browser-partition";

describe("browser partition", () => {
  test("keeps the exact strings main and the renderer already agreed on", () => {
    // Both previous copies asserted these literals (renderer
    // app/appUtils.test.ts, main browser-driver/active-guest.test.ts). Pinning
    // them here is what makes collapsing the two copies safe: a partition is a
    // cookie jar, so any change silently repoints login state.
    expect(browserPartitionForBucket("repo::session-a")).toBe("persist:browser:repo::session-a");
    expect(browserPartitionForBucket("__quick_chat__::qchat-a")).toBe(
      "browser:qchat:__quick_chat__::qchat-a",
    );
    expect(browserPartitionForBucket("__quick_chat__::qchat-owned")).toBe(
      "browser:qchat:__quick_chat__::qchat-owned",
    );
  });

  test("Quick Chat never lands on a persistent partition", () => {
    // A quick chat's browser state must not outlive the window.
    const partition = browserPartitionForBucket(`${QUICK_CHAT_BUCKET_PREFIX}whatever`);
    expect(partition.startsWith("persist:")).toBe(false);
    expect(isQuickChatBucket(`${QUICK_CHAT_BUCKET_PREFIX}whatever`)).toBe(true);
    expect(isQuickChatBucket("repo::session-a")).toBe(false);
  });

  test("replaces unsafe characters without trimming", () => {
    // No trim: the result is compared for equality across IPC, so both sides
    // must normalize identically — including surrounding whitespace.
    expect(sanitizeBrowserBucket(" a b/c\\d ")).toBe("_a_b_c_d_");
    expect(browserPartitionForBucket("proj/1::sess 2")).toBe("persist:browser:proj_1::sess_2");
    // Characters that are already safe survive untouched.
    expect(sanitizeBrowserBucket("a-b_c.d@e:f")).toBe("a-b_c.d@e:f");
  });

  test("a real project bucket keeps its :: separator intact", () => {
    // bucketKey joins with "::" (renderer/transcripts.ts), and ":" is in the
    // safe set, so the separator must survive sanitization — the on-disk
    // directory name depends on it.
    expect(browserPartitionForBucket("5ffdbdff-2e0a::s-mtg157x2-1acd78a5")).toBe(
      "persist:browser:5ffdbdff-2e0a::s-mtg157x2-1acd78a5",
    );
  });
});
