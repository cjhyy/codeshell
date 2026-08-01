// Navigation contract: clicking a sidebar item must highlight THAT item.
//
// The Automation entry shipped with `target: "automation"` but
// `isActive: (mode) => mode === "runs"` (carried over verbatim from the
// hardcoded Sidebar, with a comment deferring the fix). Real consequence, seen
// in review screenshots: opening Automation highlighted nothing, while the Runs
// page highlighted Automation — an item that does not navigate there.
//
// This asserts the invariant generically over the registry rather than
// hardcoding the current entries, so a future page cannot reintroduce the drift.
import { describe, expect, test } from "bun:test";
import { PAGE_REGISTRY } from "./PageRegistry.js";

describe("sidebar nav highlight contract", () => {
  const navEntries = PAGE_REGISTRY.navEntries();

  test("the registry exposes nav entries to check", () => {
    expect(navEntries.length).toBeGreaterThan(0);
  });

  test("every nav entry is active on the view mode it navigates to", () => {
    const broken = navEntries
      .filter((entry) => !entry.nav!.isActive(entry.nav!.target))
      .map((entry) => `${entry.key} → target=${entry.nav!.target}`);
    expect(broken).toEqual([]);
  });

  test("no two nav entries claim the same view mode", () => {
    // Two items highlighting on one mode means at least one of them lights up
    // for a page it does not own.
    const collisions: string[] = [];
    for (const entry of navEntries) {
      const alsoActive = navEntries
        .filter((other) => other.key !== entry.key && other.nav!.isActive(entry.nav!.target))
        .map((other) => other.key);
      if (alsoActive.length > 0) {
        collisions.push(`${entry.nav!.target}: ${[entry.key, ...alsoActive].join(", ")}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  test("nav targets are unique", () => {
    const targets = navEntries.map((entry) => entry.nav!.target);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
