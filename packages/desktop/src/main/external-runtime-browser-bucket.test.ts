import { describe, expect, test } from "bun:test";

import { externalRuntimeBrowserBucket } from "./external-runtime-browser-bucket.js";

describe("external runtime browser bucket", () => {
  test("uses a per-session bucket that cannot collide with renderer project buckets", () => {
    expect(externalRuntimeBrowserBucket("s-one")).toBe("external-runtime:s-one");
    expect(externalRuntimeBrowserBucket("s-two")).toBe("external-runtime:s-two");
    expect(externalRuntimeBrowserBucket("s-one")).not.toBe("repo::s-one");
  });
});
