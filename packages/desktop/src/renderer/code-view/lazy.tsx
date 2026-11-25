import { lazy } from "react";

/** One chunk holds Pierre, Shiki's core and the worker pool; load it once. */
let views: Promise<typeof import("./pierreViews")> | undefined;
const load = () => (views ??= import("./pierreViews"));

export const LazyFileCodeView = lazy(() =>
  load().then((module) => ({ default: module.PierreFileCodeView })),
);
export const LazyPierreFileDiffBody = lazy(() =>
  load().then((module) => ({ default: module.PierreFileDiffBody })),
);
export const LazyPierreScroller = lazy(() =>
  load().then((module) => ({ default: module.PierreScroller })),
);
