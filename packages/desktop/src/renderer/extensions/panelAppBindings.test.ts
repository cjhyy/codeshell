import { describe, expect, test } from "bun:test";
import {
  bindingBusyKey,
  boundAppsForProject,
  computeProjectBindings,
  sortBindingProjects,
  type BindingProject,
} from "./panelAppBindings";

const appId = "design-studio";

const project = (
  id: string,
  path: string,
  extra: Partial<BindingProject> = {},
): BindingProject => ({
  id,
  path,
  addedAt: 0,
  ...extra,
});

describe("boundAppsForProject", () => {
  test("reads the canonical panelAppBindings list", () => {
    expect([...boundAppsForProject({ panelAppBindings: [appId, "quant-lab"] })]).toEqual([
      appId,
      "quant-lab",
    ]);
  });

  test("treats missing settings as no bindings", () => {
    expect(boundAppsForProject(null).size).toBe(0);
    expect(boundAppsForProject({}).size).toBe(0);
  });

  test("tolerates malformed values", () => {
    expect([...boundAppsForProject({ panelAppBindings: [42, appId, null, ""] })]).toEqual([appId]);
    expect(boundAppsForProject({ panelAppBindings: "nope" }).size).toBe(0);
    expect(boundAppsForProject({ panelAppOverrides: ["not-an-object"] }).size).toBe(0);
  });

  test("legacy panelAppOverrides on counts as a binding", () => {
    expect(boundAppsForProject({ panelAppOverrides: { [appId]: "on" } }).has(appId)).toBe(true);
  });

  test("legacy panelAppOverrides off removes a canonical binding", () => {
    const bound = boundAppsForProject({
      panelAppBindings: [appId],
      panelAppOverrides: { [appId]: "off" },
    });
    expect(bound.has(appId)).toBe(false);
  });

  test("legacy inherit is inert", () => {
    const bound = boundAppsForProject({
      panelAppBindings: [appId],
      panelAppOverrides: { [appId]: "inherit" },
    });
    expect(bound.has(appId)).toBe(true);
  });
});

describe("sortBindingProjects", () => {
  test("pinned first, then oldest added", () => {
    const sorted = sortBindingProjects([
      project("c", "/c", { addedAt: 3 }),
      project("a", "/a", { addedAt: 1 }),
      project("p", "/p", { addedAt: 9, pinned: true }),
      project("b", "/b", { addedAt: 2 }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["p", "a", "b", "c"]);
  });

  test("does not mutate the input", () => {
    const input = [project("b", "/b", { addedAt: 2 }), project("a", "/a", { addedAt: 1 })];
    sortBindingProjects(input);
    expect(input.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("computeProjectBindings", () => {
  const projects = [
    project("one", "/one", { addedAt: 1 }),
    project("two", "/two", { addedAt: 2 }),
    project("three", "/three", { addedAt: 3 }),
  ];

  test("reports per-project state and the bound count", () => {
    const summary = computeProjectBindings(
      projects,
      {
        "/one": { panelAppBindings: [appId] },
        "/two": { panelAppBindings: ["quant-lab"] },
        "/three": {},
      },
      appId,
    );
    expect(summary.rows.map((row) => row.bound)).toEqual([true, false, false]);
    expect(summary.boundCount).toBe(1);
    expect(summary.total).toBe(3);
  });

  test("rows follow project sort order, not settings map order", () => {
    const summary = computeProjectBindings(
      [
        project("late", "/late", { addedAt: 5 }),
        project("pinned", "/pinned", { addedAt: 9, pinned: true }),
      ],
      { "/late": { panelAppBindings: [appId] }, "/pinned": {} },
      appId,
    );
    expect(summary.rows.map((row) => row.projectId)).toEqual(["pinned", "late"]);
  });

  test("a project absent from the settings map is readable and unbound", () => {
    const summary = computeProjectBindings(projects, {}, appId);
    expect(summary.rows.every((row) => !row.bound && !row.unreadable)).toBe(true);
    expect(summary.boundCount).toBe(0);
  });

  test("null settings mark the row unreadable and unbound", () => {
    const summary = computeProjectBindings(projects, { "/one": null }, appId);
    expect(summary.rows[0]).toMatchObject({ unreadable: true, bound: false });
    expect(summary.rows[1]!.unreadable).toBe(false);
  });

  test("the legacy global denylist vetoes an otherwise bound project", () => {
    const summary = computeProjectBindings(
      projects,
      { "/one": { panelAppBindings: [appId] } },
      appId,
      new Set([appId]),
    );
    expect(summary.rows[0]).toMatchObject({ bound: false, vetoedByGlobalDenylist: true });
    expect(summary.boundCount).toBe(0);
  });

  test("the denylist does not flag projects that never bound the app", () => {
    const summary = computeProjectBindings(projects, {}, appId, new Set([appId]));
    expect(summary.rows.every((row) => !row.vetoedByGlobalDenylist)).toBe(true);
  });

  test("a denylist entry for another app is irrelevant", () => {
    const summary = computeProjectBindings(
      projects,
      { "/one": { panelAppBindings: [appId] } },
      appId,
      new Set(["quant-lab"]),
    );
    expect(summary.rows[0]!.bound).toBe(true);
  });

  test("legacy overrides participate in the count", () => {
    const summary = computeProjectBindings(
      projects,
      {
        "/one": { panelAppOverrides: { [appId]: "on" } },
        "/two": { panelAppBindings: [appId], panelAppOverrides: { [appId]: "off" } },
      },
      appId,
    );
    expect(summary.rows.map((row) => row.bound)).toEqual([true, false, false]);
    expect(summary.boundCount).toBe(1);
  });

  test("no tracked projects yields an empty summary", () => {
    const summary = computeProjectBindings([], {}, appId);
    expect(summary).toEqual({ rows: [], boundCount: 0, total: 0 });
  });
});

describe("bindingBusyKey", () => {
  test("is unique per app and project", () => {
    expect(bindingBusyKey(appId, "/one")).toBe("design-studio@/one");
    expect(bindingBusyKey(appId, "/one")).not.toBe(bindingBusyKey(appId, "/two"));
    expect(bindingBusyKey(appId, "/one")).not.toBe(bindingBusyKey("quant-lab", "/one"));
  });
});
