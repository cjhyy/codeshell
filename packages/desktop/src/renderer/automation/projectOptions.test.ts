import { describe, it, expect } from "bun:test";
import {
  buildProjectOptions,
  selectedProjectValue,
  cwdFromSelection,
  NO_PROJECT_VALUE,
  type ProjectRepo,
} from "./projectOptions";

const repos: ProjectRepo[] = [
  { id: "a", path: "/work/alpha", name: "alpha" },
  { id: "b", path: "/work/beta", name: "beta", displayName: "Beta!" },
];

describe("buildProjectOptions", () => {
  it("leads with the no-project option, then the repos in order", () => {
    const opts = buildProjectOptions(repos, "/work/alpha");
    expect(opts[0]).toEqual({ value: NO_PROJECT_VALUE, label: "无项目(对话)" });
    expect(opts.slice(1)).toEqual([
      { value: "/work/alpha", label: "alpha" },
      { value: "/work/beta", label: "Beta!" }, // displayName wins over name
    ]);
  });

  it("appends a synthetic entry when the current cwd is not a tracked repo", () => {
    const opts = buildProjectOptions(repos, "/elsewhere/gamma");
    expect(opts.at(-1)).toEqual({ value: "/elsewhere/gamma", label: "/elsewhere/gamma" });
    expect(opts).toHaveLength(repos.length + 2); // no-project + 2 repos + synthetic
  });

  it("does not append a synthetic entry when cwd matches a tracked repo", () => {
    const opts = buildProjectOptions(repos, "/work/beta");
    expect(opts).toHaveLength(repos.length + 1); // no-project + 2 repos
  });

  it("adds no synthetic entry for an empty / missing cwd", () => {
    expect(buildProjectOptions(repos, "")).toHaveLength(repos.length + 1);
    expect(buildProjectOptions(repos, null)).toHaveLength(repos.length + 1);
    expect(buildProjectOptions(repos, undefined)).toHaveLength(repos.length + 1);
  });

  it("dedupes repos that share a path", () => {
    const dup: ProjectRepo[] = [
      { id: "a", path: "/work/alpha", name: "alpha" },
      { id: "a2", path: "/work/alpha", name: "alpha-copy" },
    ];
    const opts = buildProjectOptions(dup, null);
    expect(opts).toHaveLength(2); // no-project + one /work/alpha
  });

  it("skips repos with an empty path", () => {
    const opts = buildProjectOptions([{ id: "x", path: "", name: "ghost" }], null);
    expect(opts).toEqual([{ value: NO_PROJECT_VALUE, label: "无项目(对话)" }]);
  });
});

describe("selectedProjectValue", () => {
  it("returns the cwd when present", () => {
    expect(selectedProjectValue("/work/alpha")).toBe("/work/alpha");
  });
  it("returns the no-project sentinel for empty / missing cwd", () => {
    expect(selectedProjectValue("")).toBe(NO_PROJECT_VALUE);
    expect(selectedProjectValue("   ")).toBe(NO_PROJECT_VALUE);
    expect(selectedProjectValue(null)).toBe(NO_PROJECT_VALUE);
    expect(selectedProjectValue(undefined)).toBe(NO_PROJECT_VALUE);
  });
});

describe("cwdFromSelection", () => {
  it("maps the sentinel back to an empty cwd", () => {
    expect(cwdFromSelection(NO_PROJECT_VALUE)).toBe("");
  });
  it("passes a project path through unchanged", () => {
    expect(cwdFromSelection("/work/alpha")).toBe("/work/alpha");
  });
});
