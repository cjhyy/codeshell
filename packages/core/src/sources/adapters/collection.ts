/** Shared document manifests use one scope per explicitly selected file. */
import type { ConnectorAdapter, SourceAdapterContext } from "../adapter.js";
import { collectionConfig } from "../collection.js";
import { collectionLocalDirectoryIdentity, readCollectionLocalFile } from "../collection-local.js";
import {
  collectionUrlDocumentName,
  downloadCollectionUrl,
  type CollectionUrlProof,
} from "../collection-url.js";
import {
  documentIndexText,
  loadUploadedDocumentIndex,
  searchDocumentIndex,
} from "../documents/index-store.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import type { DocumentIndex } from "../documents/types.js";
import type { SourceContent, SourceDefinition } from "../types.js";

/** Host-only receipt from the actual authorized read, never parsed from tool output. */
export interface CollectionDocumentRead {
  content: SourceContent;
  index: DocumentIndex;
  assertCurrent(): void;
  /** Actual credential-free redownload; this is a sequential observation, not an atomic snapshot. */
  revalidateRemote?: () => Promise<void>;
}

export async function readCollectionDocument(
  definition: SourceDefinition,
  resourceId: string,
  options: SourceAdapterContext & {
    maxBytes: number;
    query?: string;
    limit?: number;
    chunk?: string;
    reserveInputBytes?: (bytes: number) => void;
  },
): Promise<CollectionDocumentRead> {
  if (!options.cwd || !options.assertAuthorized)
    throw new Error("Collection reads require the owning workspace authorization");
  options.signal?.throwIfAborted();
  options.assertAuthorized();
  const entry = collectionConfig(definition).entries.find((item) => item.id === resourceId);
  if (!entry) throw new Error("Collection file is no longer selected");
  const directoryIdentity =
    entry.kind === "local" ? collectionLocalDirectoryIdentity(entry) : undefined;
  let bytes: Uint8Array;
  let documentName = entry.name;
  let remoteProof: CollectionUrlProof | undefined;
  if (entry.kind === "local") bytes = readCollectionLocalFile(entry, options);
  else {
    const downloaded = await downloadCollectionUrl({ url: entry.url, expected: entry }, options);
    bytes = downloaded.bytes;
    remoteProof = downloaded.proof;
    documentName = collectionUrlDocumentName(downloaded.proof, entry.name);
  }
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertAuthorized!();
    if (entry.kind === "local") {
      if (collectionLocalDirectoryIdentity(entry) !== directoryIdentity)
        throw new Error("Collection file directory changed during reading");
      // Revalidation reads do not consume the same selected input budget again.
      readCollectionLocalFile(entry, {
        signal: options.signal,
        assertAuthorized: options.assertAuthorized,
      });
    }
  };
  const index = await loadUploadedDocumentIndex(options.cwd, entry.id, bytes, {
    signal: options.signal,
    assertCurrent,
    resolveExecutable: options.documentParserExecutable,
    documentName,
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
  return {
    index,
    assertCurrent,
    ...(entry.kind === "url"
      ? {
          async revalidateRemote() {
            assertCurrent();
            const current = await downloadCollectionUrl(
              { url: entry.url, expected: entry },
              { signal: options.signal, assertAuthorized: options.assertAuthorized },
            );
            assertCurrent();
            if (
              current.proof.finalUrl !== remoteProof!.finalUrl ||
              current.proof.mimeType !== remoteProof!.mimeType
            )
              throw new Error("Static file response identity changed during collection query");
          },
        }
      : {}),
    content: { resourceId: entry.id, ...content, truncated: content.truncated || index.truncated },
  };
}

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
    return (await readCollectionDocument(definition, resourceId, options)).content;
  },
};
