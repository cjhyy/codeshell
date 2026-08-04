import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODESHELL_CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from "./chrome-native-protocol.js";

describe("bundled Chrome extension manifest", () => {
  test("has the stable ID used by allowed_origins and only the required privileged APIs", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../resources/chrome-extension/manifest.json"),
        "utf8",
      ),
    ) as { key: string; permissions: string[]; background: { service_worker: string } };
    const der = Buffer.from(manifest.key, "base64");
    const bytes = createHash("sha256").update(der).digest().subarray(0, 16);
    const id = [...bytes]
      .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
      .join("");
    expect(id).toBe(CODESHELL_CHROME_EXTENSION_ID);
    expect(manifest.permissions.sort()).toEqual(
      ["debugger", "nativeMessaging", "storage", "tabGroups", "tabs"].sort(),
    );
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(CHROME_NATIVE_HOST_NAME).toBe("com.cjhyy.codeshell.browser_runtime");
  });
});
