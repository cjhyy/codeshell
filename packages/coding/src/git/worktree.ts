// Coding capability barrel for the split worktree module. The split made the
// query/create APIs async because they now share the async git executor; all
// in-repo callers await them, so this barrel intentionally does not add sync
// wrappers.
export * from "./worktree/index.js";
