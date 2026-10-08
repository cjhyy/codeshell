import { randomUUID } from "node:crypto";
import type { ConnectorAdapter } from "../adapter.js";
import { isLinkSourceAvailable, linkSourceView } from "../link-view.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import { boundToolResult } from "../../tool-system/bound-tool-result.js";

/** Fixed views reuse Link's exact account, grant, resource and revocation gates. */
export const linkSourceAdapter: ConnectorAdapter = {
  kind: "link",
  async listScopes(definition) {
    const view = linkSourceView(definition);
    return [{ id: view.scopeId, label: view.title }];
  },
  async listResources(definition, scopeId) {
    const view = linkSourceView(definition);
    return scopeId === view.scopeId
      ? [{ id: "result", scopeId, name: definition.label, mimeType: "application/json" }]
      : [];
  },
  async read(definition, resourceId, options) {
    const view = linkSourceView(definition);
    if (
      resourceId !== "result" ||
      !options.cwd ||
      !definition.enabled ||
      !isLinkSourceAvailable(definition, options)
    ) {
      throw new Error("Link source connection or resource is unavailable");
    }
    options.signal?.throwIfAborted();
    if (!options.executeBoundTool || !options.assertAuthorized)
      throw new Error("Link source reads require the owning tool authorization pipeline");
    const boundExecution = await options.executeBoundTool(
      {
        id: `source-link-${randomUUID()}`,
        toolName: "LinkAction",
        args: {
          provider: view.providerId,
          action: view.action,
          connectionId: definition.credentialRef,
          params: view.params,
        },
      },
      { signal: options.signal, assertAuthorized: options.assertAuthorized },
    );
    const execution = boundToolResult(boundExecution);
    if (execution.isError || typeof execution.result !== "string")
      throw new Error("Link source action was denied or unavailable");
    const output = execution.result;
    options.signal?.throwIfAborted();
    const result = JSON.parse(output);
    if (
      result.kind !== "action_result" ||
      result.connectionId !== definition.credentialRef ||
      result.provider !== view.providerId ||
      result.action !== view.action
    ) {
      throw new Error(
        "Link source action failed or requires reconnection; inspect the saved Link connection",
      );
    }
    if (!isLinkSourceAvailable(definition, options))
      throw new Error("Link source connection changed during the read");
    return { resourceId, ...truncateUtf8Text(JSON.stringify(result.data), options.maxBytes) };
  },
};
