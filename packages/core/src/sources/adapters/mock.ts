/** 本地 fake 源：2 scope / 3 resource，纵切 e2e 与 CI 的载体（DS-13）。 */
import type { ConnectorAdapter } from "../adapter.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import type { SourceResourceMeta } from "../types.js";

const RESOURCES: Array<SourceResourceMeta & { text: string }> = [
  { id: "alpha/doc-1", scopeId: "alpha", name: "doc-1", text: "alpha doc one 内容" },
  { id: "alpha/doc-2", scopeId: "alpha", name: "doc-2", text: "alpha doc two content" },
  { id: "beta/note-1", scopeId: "beta", name: "note-1", text: "beta note one content" },
];

export const mockAdapter: ConnectorAdapter = {
  kind: "mock",

  async listScopes() {
    return [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta" },
    ];
  },

  async listResources(_definition, scopeId) {
    return RESOURCES.filter((resource) => resource.scopeId === scopeId).map(
      ({ text: _text, ...metadata }) => metadata,
    );
  },

  async read(_definition, resourceId, options) {
    const resource = RESOURCES.find((candidate) => candidate.id === resourceId);
    if (!resource) {
      throw new Error(`mock resource not found: ${resourceId}`);
    }

    const truncated = truncateUtf8Text(resource.text, options.maxBytes);
    return {
      resourceId,
      ...truncated,
    };
  },
};
