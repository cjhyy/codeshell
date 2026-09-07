import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema, type Root } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolContext } from "./context.js";
import { canonicalKey, canonicalPath } from "../workspace/canonical-key.js";

export type McpWorkspaceScope = Pick<ToolContext, "cwd" | "workspace">;

export interface McpConnectionScope {
  key: string;
  cwd?: string;
  roots: Root[];
}

/** Scope comes only from the host's ToolContext, never from tool arguments. */
export function mcpConnectionScope(scope?: McpWorkspaceScope): McpConnectionScope {
  if (!scope) return { key: "", roots: [] };
  if (!isAbsolute(scope.cwd)) throw new Error("MCP workspace cwd must be absolute");
  const paths = scope.workspace ? scope.workspace.roots.map((root) => root.path) : [scope.cwd];
  if (!paths.length || paths.some((path) => !isAbsolute(path))) {
    throw new Error("MCP workspace roots must be nonempty absolute paths");
  }
  const cwd = canonicalPath(scope.cwd);
  const roots = [...new Set(paths.map(canonicalPath))]
    .sort()
    .map((path) => ({ uri: pathToFileURL(path).href }));
  return { key: JSON.stringify([cwd, roots.map((root) => root.uri)]), cwd, roots };
}

/** Roots stay immutable for the lifetime of a connection. Different root sets
 * use different transports, so concurrent sessions never borrow each other's
 * filesystem authority or depend on a racing roots/list_changed notification. */
export function createWorkspaceMcpClient(scope: McpConnectionScope): Client {
  const client = new Client(
    { name: "code-shell", version: "0.1.0" },
    { capabilities: { roots: {} } },
  );
  const roots = scope.roots.map((root) => ({ ...root }));
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.map((root) => ({ ...root })),
  }));
  return client;
}

export function mcpConnectionKey(serverName: string, scope: McpConnectionScope): string {
  return scope.key ? JSON.stringify([serverName, scope.key]) : serverName;
}

/** Changing cwd may narrow execution location, but never expands negotiated roots. */
export function mcpScopeAtCwd(scope: McpConnectionScope, cwd: string): McpConnectionScope {
  if (!isAbsolute(cwd)) throw new Error("MCP workspace cwd must be absolute");
  const canonicalCwd = canonicalPath(cwd);
  const inside = scope.roots.some((root) => {
    const suffix = relative(canonicalKey(fileURLToPath(root.uri)), canonicalKey(canonicalCwd));
    return (
      suffix === "" ||
      (suffix !== ".." &&
        !suffix.startsWith("../") &&
        !suffix.startsWith("..\\") &&
        !isAbsolute(suffix))
    );
  });
  if (!inside)
    throw new Error(
      "MCP cwd is outside this run's workspace roots; reconnect the run after switching workspace.",
    );
  return {
    ...scope,
    cwd: canonicalCwd,
    key: JSON.stringify([canonicalCwd, scope.roots.map((root) => root.uri)]),
  };
}
