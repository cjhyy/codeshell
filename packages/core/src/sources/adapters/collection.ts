/** Shared document manifests use one scope per explicitly selected file. */
import type { ConnectorAdapter, SourceAdapterContext } from "../adapter.js";
import { collectionConfig } from "../collection.js";
import { readCollectionLocalFile } from "../collection-local.js";
import { downloadCollectionUrl } from "../collection-url.js";
import {
  documentIndexText,
  loadUploadedDocumentIndex,
  searchDocumentIndex,
} from "../documents/index-store.js";
import { truncateUtf8Text } from "../truncate-utf8.js";

export const collectionAdapter: ConnectorAdapter = {
  kind: "collection",
  async listScopes(definition) {
    return collectionConfig(definition).entries.map((entry) => ({
      id: entry.id,
      label: entry.relativePath ?? entry.name,
    }));
  },
  async listResources(definition, scopeId) {
    const entry = collectionConfig(definition).entries.find((item) => item.id === scopeId);
    return entry
      ? [
          {
            id: entry.id,
            scopeId: entry.id,
            name: entry.relativePath ?? entry.name,
            sizeBytes: entry.sizeBytes,
          },
        ]
      : [];
  },
  async read(
    definition,
    resourceId,
    options: SourceAdapterContext & {
      maxBytes: number;
      query?: string;
      limit?: number;
      chunk?: string;
    },
  ) {
    if (!options.cwd || !options.assertAuthorized)
      throw new Error("Collection reads require the owning workspace authorization");
    options.signal?.throwIfAborted();
    options.assertAuthorized();
    const config = collectionConfig(definition);
    const entry = config.entries.find((item) => item.id === resourceId);
    if (!entry) throw new Error("Collection file is no longer selected");
    const bytes =
      entry.kind === "local"
        ? readCollectionLocalFile(entry, options)
        : (await downloadCollectionUrl({ url: entry.url, expected: entry }, options)).bytes;
    const assertCurrent = () => {
      options.signal?.throwIfAborted();
      options.assertAuthorized!();
      if (entry.kind === "local") readCollectionLocalFile(entry, options);
    };
    const index = await loadUploadedDocumentIndex(options.cwd, entry.id, bytes, {
      signal: options.signal,
      assertCurrent,
      resolveExecutable: options.documentParserExecutable,
      documentName: entry.name,
    });
    let text: string;
    if (options.query !== undefined)
      text = JSON.stringify(searchDocumentIndex(index, options.query, options.limit ?? 5));
    else if (options.chunk !== undefined) {
      const chunk = index.chunks.find((item) => item.id === options.chunk);
      if (!chunk)
        throw new Error("Document chunk is not in this file version; query the current file again");
      text = JSON.stringify({ resourceId: entry.id, sourceHash: entry.sha256, ...chunk });
    } else
      text =
        documentIndexText(index) ||
        "This document contains no extractable text; scanned images require OCR or a UTF-8 text export.";
    assertCurrent();
    const content = truncateUtf8Text(text, options.maxBytes);
    return { resourceId: entry.id, ...content, truncated: content.truncated || index.truncated };
  },
};
