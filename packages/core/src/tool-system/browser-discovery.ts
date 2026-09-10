import type { RegisteredTool } from "../types.js";

const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_observe",
  "browser_act",
  "browser_inspect",
] as const;

export function isBuiltinBrowserTool(tool: Pick<RegisteredTool, "name" | "source">): boolean {
  return tool.source === "builtin" && BROWSER_TOOLS.some((name) => name === tool.name);
}

/** Prefer the native path for generic browser discovery, without redirecting
 * exact selections, named providers, or DevTools-specific requests. Only the
 * run's already-authorized tools are scored by the caller. */
export function browserDiscoveryScore(tool: RegisteredTool, query: string): number {
  if (!isBuiltinBrowserTool(tool)) return 0;
  if (!/\b(browser|browse|webpage)\b|浏览器|网页/i.test(query)) return 0;
  if (tool.name === "browser_inspect") {
    return /\b(devtools|network|console|performance|dom)\b|网络请求|控制台|性能|页面结构/i.test(
      query,
    ) && !/\b(mcp|chrome|playwright|selenium|firefox|edge)\b/i.test(query)
      ? 40
      : 0;
  }
  if (
    /\b(mcp|chrome|chromium|playwright|selenium|firefox|edge|devtools|network|console|performance|trace)\b|网络请求|控制台|性能/i.test(
      query,
    )
  ) {
    return 0;
  }
  return 40 - BROWSER_TOOLS.findIndex((name) => name === tool.name);
}
