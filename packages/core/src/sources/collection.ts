/** A bounded, explicitly selected manifest. Directory membership never expands at read time. */
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { SOURCE_ID_RE, type SourceDefinition } from "./types.js";
import { MAX_DOCUMENT_BYTES } from "./documents/types.js";
import { normalizeCollectionUrl } from "./collection-url.js";

export const MAX_COLLECTION_ENTRIES = 1_000;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"));
const common = {
  id: z.string().regex(SOURCE_ID_RE),
  name: text(512),
  sizeBytes: z.number().int().min(0).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().datetime({ offset: true }),
  relativePath: text(4_096)
    .refine(
      (value) =>
        !value.includes("\\") &&
        !isAbsolute(value) &&
        value.split("/").every((part) => part && part !== "." && part !== ".."),
    )
    .optional(),
};

export const CollectionLocalEntrySchema = z
  .object({
    ...common,
    kind: z.literal("local"),
    path: text(32_768).refine(
      (value) => isAbsolute(value) && resolve(value) === value,
      "local path must be canonical and absolute",
    ),
    dev: z.string().regex(/^(0|[1-9][0-9]*)$/),
    ino: z.string().regex(/^(0|[1-9][0-9]*)$/),
    mtimeMs: z.number().finite(),
  })
  .strict();

export const CollectionUrlEntrySchema = z
  .object({
    ...common,
    kind: z.literal("url"),
    url: text(8_192).refine((value) => {
      try {
        return normalizeCollectionUrl(value) === value;
      } catch {
        return false;
      }
    }, "URL must be a canonical HTTPS address without credentials or fragment"),
  })
  .strict();

export const CollectionEntrySchema = z.discriminatedUnion("kind", [
  CollectionLocalEntrySchema,
  CollectionUrlEntrySchema,
]);
export const CollectionConfigSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().uuid(),
    entries: z
      .array(CollectionEntrySchema)
      .max(MAX_COLLECTION_ENTRIES)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
        "collection entry ids must be unique",
      ),
  })
  .strict();

export type CollectionLocalEntry = z.infer<typeof CollectionLocalEntrySchema>;
export type CollectionUrlEntry = z.infer<typeof CollectionUrlEntrySchema>;
export type LocalCollectionEntry = CollectionLocalEntry;
export type UrlCollectionEntry = CollectionUrlEntry;
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>;
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

export function collectionConfig(definition: SourceDefinition): CollectionConfig {
  if (definition.kind !== "collection") throw new Error("Source is not a document collection");
  if (definition.credentialRef !== undefined)
    throw new Error("Document collections do not accept account credentials");
  return CollectionConfigSchema.parse(definition.adapterConfig);
}
