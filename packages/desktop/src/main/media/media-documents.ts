import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  cloneMediaJson,
  mediaDirectory,
  mediaScopeKey,
  readMediaJson,
  writeMediaJson,
} from "./media-storage.js";
import type { MediaScope } from "./media-types.js";

export interface MediaDocumentVersion {
  revision: number;
  updatedAt: number;
  label: string;
}
interface DocumentIndex {
  versions: Array<MediaDocumentVersion & { file: string }>;
}
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_VERSIONS = 20;

/** Host-persisted JSON documents with optimistic writes and immutable versions. */
export class MediaDocumentStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly rootDirectory: string) {}

  private async directory(scope: MediaScope, key: string): Promise<string> {
    if (typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(key))
      throw new Error("Invalid media document key");
    return mediaDirectory(this.rootDirectory, ["scopes", mediaScopeKey(scope), "documents", key]);
  }

  private async index(directory: string): Promise<DocumentIndex> {
    const index = (await readMediaJson(join(directory, "index.json")).catch((error) => {
      if (error.code === "ENOENT") return { versions: [] };
      throw error;
    })) as DocumentIndex;
    if (
      !index ||
      Object.keys(index).some((key) => key !== "versions") ||
      !Array.isArray(index.versions) ||
      index.versions.length > MAX_VERSIONS ||
      index.versions.some(
        (v, position) =>
          !v ||
          Object.keys(v).some((key) => !["revision", "updatedAt", "label", "file"].includes(key)) ||
          !Number.isSafeInteger(v.revision) ||
          v.revision < 1 ||
          !Number.isSafeInteger(v.updatedAt) ||
          v.updatedAt < 0 ||
          typeof v.label !== "string" ||
          v.label.length > 200 ||
          typeof v.file !== "string" ||
          !/^version-[a-f0-9-]+\.json$/.test(v.file) ||
          (position > 0 && index.versions[position - 1]!.revision !== v.revision + 1),
      ) ||
      new Set(index.versions.map((v) => v.file)).size !== index.versions.length
    ) {
      throw new Error("Corrupt media document index; existing data was preserved");
    }
    return index;
  }

  async get(
    scope: MediaScope,
    key: string,
    revision?: number,
  ): Promise<{
    revision: number;
    data: unknown;
    updatedAt?: number;
  }> {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new Error("Invalid media document revision");
    const directory = await this.directory(scope, key);
    return this.serialize(directory, async () => {
      const index = await this.index(directory);
      const entry =
        revision === undefined
          ? index.versions[0]
          : index.versions.find((v) => v.revision === revision);
      if (!entry) {
        if (revision !== undefined) throw new Error("Media document version not found");
        return { revision: 0, data: null };
      }
      return {
        revision: entry.revision,
        updatedAt: entry.updatedAt,
        data: await readMediaJson(join(directory, entry.file)),
      };
    });
  }

  async versions(scope: MediaScope, key: string): Promise<MediaDocumentVersion[]> {
    const directory = await this.directory(scope, key);
    return this.serialize(directory, async () =>
      (await this.index(directory)).versions.map(({ revision, updatedAt, label }) => ({
        revision,
        updatedAt,
        label,
      })),
    );
  }

  private async serialize<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(directory) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.queues.set(directory, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(directory) === operation) this.queues.delete(directory);
    }
  }

  async set(
    scope: MediaScope,
    key: string,
    input: {
      baseRevision: number;
      data: unknown;
      label?: string;
    },
  ): Promise<MediaDocumentVersion> {
    if (
      !Number.isSafeInteger(input.baseRevision) ||
      input.baseRevision < 0 ||
      input.baseRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error("Media document write requires a valid baseRevision");
    if (input.label !== undefined && (typeof input.label !== "string" || input.label.length > 200))
      throw new Error("Invalid media document version label");
    const data = cloneMediaJson(input.data, MAX_DOCUMENT_BYTES);
    const { baseRevision, label } = input;
    const directory = await this.directory(scope, key);
    return this.serialize(directory, async () => {
      const previous = await this.index(directory);
      if ((previous.versions[0]?.revision ?? 0) !== baseRevision)
        throw new Error("Media document changed in another window. Reload before writing.");
      const version = {
        revision: baseRevision + 1,
        updatedAt: Date.now(),
        label: label ?? "Auto save",
      };
      const entry = { ...version, file: `version-${randomUUID()}.json` };
      await writeMediaJson(join(directory, entry.file), data);
      try {
        await writeMediaJson(join(directory, "index.json"), {
          versions: [entry, ...previous.versions].slice(0, MAX_VERSIONS),
        });
      } catch (error) {
        await rm(join(directory, entry.file), { force: true }).catch(() => {});
        throw error;
      }
      await Promise.all(
        previous.versions
          .slice(MAX_VERSIONS - 1)
          .map((old) => rm(join(directory, old.file), { force: true }).catch(() => {})),
      );
      return version;
    });
  }
}
