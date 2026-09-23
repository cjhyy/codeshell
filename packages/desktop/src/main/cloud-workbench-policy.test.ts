import { describe, expect, test } from "bun:test";
import {
  cloudWorkbenchPartition,
  isCloudWorkbenchOrigin,
  normalizeCloudWorkbenchAddress,
} from "./cloud-workbench-policy.js";

describe("cloud workbench boundary", () => {
  test("accepts HTTPS origins and loopback development entries", () => {
    expect(normalizeCloudWorkbenchAddress(" https://CLOUD.example:443/ ")).toBe(
      "https://cloud.example/",
    );
    expect(normalizeCloudWorkbenchAddress("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790/");
  });
  test("rejects setup credentials, paths and unsafe transports", () => {
    for (const value of [
      "https://cloud.example/#setup=secret",
      "https://cloud.example/?token=secret",
      "https://user:secret@cloud.example",
      "https://cloud.example/projects/1",
      "http://cloud.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://cloud.example\\@evil.example",
      null,
    ])
      expect(() => normalizeCloudWorkbenchAddress(value)).toThrow();
  });
  test("keeps each cloud origin's cookies separate from desktop and other hosts", () => {
    const partition = cloudWorkbenchPartition("https://cloud.example/");
    expect(partition).toStartWith("persist:codeshell-cloud-");
    expect(cloudWorkbenchPartition("https://cloud.example/path")).toBe(partition);
    expect(cloudWorkbenchPartition("https://other.example/")).not.toBe(partition);
    expect(cloudWorkbenchPartition("https://cloud.example:8443/")).not.toBe(partition);
  });
  test("only allows same-origin web navigation, including a project's routes", () => {
    expect(
      isCloudWorkbenchOrigin("https://cloud.example/", "https://cloud.example/projects/123"),
    ).toBe(true);
    for (const target of [
      "https://cloud.example.evil.example",
      "http://cloud.example",
      "file:///tmp/file",
      "https://user@cloud.example/",
      "https://cloud.example:8443/",
    ])
      expect(isCloudWorkbenchOrigin("https://cloud.example/", target)).toBe(false);
  });
});
