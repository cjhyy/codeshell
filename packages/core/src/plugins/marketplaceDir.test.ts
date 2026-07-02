import { describe, test, expect } from "bun:test";
import { marketplaceDir, marketplacesRoot } from "./marketplaceManager.js";

/**
 * Defense-in-depth: marketplaceDir(name) feeds gitClone / rmSync in
 * add/remove/refresh. An unvalidated `name` with `..` or a separator could
 * escape marketplacesRoot and rmSync/clone outside it. The single choke point
 * validates every name as a safe path segment. Normal derived names (lowercase
 * repo tails) are unaffected.
 */
describe("marketplaceDir segment validation", () => {
  const prev = process.env.HOME;
  const withHome = (fn: () => void) => {
    process.env.HOME = "/tmp/fakehome-mpd";
    try {
      fn();
    } finally {
      process.env.HOME = prev;
    }
  };

  test("accepts a normal name (child of marketplacesRoot)", () => {
    withHome(() => {
      expect(marketplaceDir("superpowers")).toBe(`${marketplacesRoot()}/superpowers`);
    });
  });

  test("rejects `..` traversal", () => {
    withHome(() => {
      expect(() => marketplaceDir("..")).toThrow();
      expect(() => marketplaceDir("../../etc")).toThrow();
    });
  });

  test("rejects separators and NUL and empty", () => {
    withHome(() => {
      expect(() => marketplaceDir("a/b")).toThrow();
      expect(() => marketplaceDir("a\\b")).toThrow();
      expect(() => marketplaceDir("x\0y")).toThrow();
      expect(() => marketplaceDir("")).toThrow();
    });
  });
});
