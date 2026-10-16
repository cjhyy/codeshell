import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import type { Credential, OAuthCredentialSecret } from "./types.js";

/** Normalize an MCP protected endpoint without permitting credential-bearing URLs. */
export function normalizeMcpServerUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096)
    throw new Error("Invalid MCP endpoint binding");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid MCP endpoint binding");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid MCP endpoint binding");
  return url.href;
}

/** A resource indicator may cover a parent path, but never another origin or sibling. */
export function assertMcpResourceTarget(resource: string, serverUrl: string): void {
  const target = new URL(normalizeMcpServerUrl(serverUrl));
  const expected = new URL(normalizeMcpServerUrl(resource));
  const prefix = expected.pathname.endsWith("/") ? expected.pathname : `${expected.pathname}/`;
  if (
    expected.origin !== target.origin ||
    !(target.pathname === expected.pathname || target.pathname.startsWith(prefix)) ||
    (expected.search && expected.search !== target.search)
  )
    throw new Error("MCP OAuth resource does not cover the selected endpoint");
}

/** Host-owned OAuth material is usable only at its verified protected endpoint. */
export function assertMcpOAuthCredentialBinding(
  credential: Pick<Credential, "id" | "type" | "meta">,
  serverUrl: string,
  secret?: OAuthCredentialSecret,
): { serverUrl: string; resource: string; issuer: string } {
  const target = normalizeMcpServerUrl(serverUrl);
  const meta = credential.meta;
  if (
    credential.type !== "oauth" ||
    ((meta?.recordSchemaVersion !== undefined || meta?.linkRecipeId !== undefined) &&
      linkConnectionMetadata(meta).linkExecutionBackend !== "mcp") ||
    linkConnectionMetadata(meta).linkExecutionBackend === "remote" ||
    normalizeMcpServerUrl(meta?.mcpServerUrl) !== target
  )
    throw new Error("MCP OAuth credential is bound to another endpoint");
  const resource = normalizeMcpServerUrl(meta?.resource);
  const issuer = normalizeMcpServerUrl(meta?.issuer);
  assertMcpResourceTarget(resource, target);
  if (
    secret &&
    (normalizeMcpServerUrl(secret.resource) !== resource ||
      normalizeMcpServerUrl(secret.issuer) !== issuer ||
      (secret.clientRegistration?.issuer &&
        normalizeMcpServerUrl(secret.clientRegistration.issuer) !== issuer))
  )
    throw new Error("MCP OAuth credential authority does not match its verified binding");
  return { serverUrl: target, resource, issuer };
}
