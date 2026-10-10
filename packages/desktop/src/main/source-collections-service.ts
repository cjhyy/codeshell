import { randomUUID } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SourceDefinitionSchema,
  CollectionConfigSchema,
  type CollectionEntry,
  type SourceDefinition,
} from "@cjhyy/code-shell-core";
import {
  captureCollectionLocalFile,
  collectionConfig,
  deleteSourceDefinition,
  downloadCollectionUrl,
  normalizeCollectionUrl,
  readSourceDefinition,
  saveSourceDefinition,
} from "@cjhyy/code-shell-core/internal";
import type {
  SourceCollectionApi,
  SourceCollectionChange,
  SourceCollectionView,
} from "../shared/source-collections.js";

const MAX_PICK_FILES = 100;
const MAX_PICK_BYTES = 100 * 1024 * 1024;

interface CollectionServiceDeps {
  assertCurrent(): void;
  signal?: AbortSignal;
  pick(mode: "files" | "folder"): Promise<string[] | null>;
  references(id: string): Promise<SourceCollectionView["references"]>;
}

function requireCollection(id: string, revision?: string): SourceDefinition {
  SourceDefinitionSchema.shape.id.parse(id);
  if (arguments.length > 1) CollectionConfigSchema.shape.revision.parse(revision);
  const definition = readSourceDefinition(id);
  if (!definition) throw new Error("资料集不存在，请刷新列表。");
  const config = collectionConfig(definition);
  if (revision !== undefined && config.revision !== revision)
    throw new Error("资料集已在其他窗口更新，请刷新后重试。");
  return definition;
}

function localStatus(entry: CollectionEntry): SourceCollectionView["entries"][number]["status"] {
  if (entry.kind === "url") return "unchecked";
  try {
    const info = lstatSync(entry.path, { bigint: true });
    return info.isFile() &&
      !info.isSymbolicLink() &&
      realpathSync(entry.path) === entry.path &&
      String(info.dev) === entry.dev &&
      String(info.ino) === entry.ino &&
      info.size === BigInt(entry.sizeBytes) &&
      Number(info.mtimeNs) / 1_000_000 === entry.mtimeMs
      ? "ready"
      : "changed";
  } catch {
    return "missing";
  }
}

/** Enumerate only the picked directory's current regular, non-hidden file list. */
function pickedFiles(paths: string[], mode: "files" | "folder", assertCurrent: () => void) {
  if (
    !Array.isArray(paths) ||
    paths.length > MAX_PICK_FILES ||
    (mode === "folder" && paths.length !== 1)
  )
    throw new Error("一次最多选择 100 个文件或一个文件夹。");
  const files: Array<{ path: string; name: string; relativePath?: string }> = [];
  let totalBytes = 0;
  const add = (path: string, root?: string) => {
    assertCurrent();
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("只支持普通文件，不支持符号链接。");
    const canonical = realpathSync(path);
    if (root && canonical !== resolve(path))
      throw new Error("文件路径发生变化，请重新选择文件夹。");
    const rel = root ? relative(root, canonical) : undefined;
    if (rel !== undefined && (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)))
      throw new Error("文件已离开选中的文件夹，请重新选择。");
    totalBytes += info.size;
    if (
      info.size > 20 * 1024 * 1024 ||
      totalBytes > MAX_PICK_BYTES ||
      files.length >= MAX_PICK_FILES
    )
      throw new Error("每个文件最多 20 MB；一次最多 100 个文件、合计 100 MB。");
    files.push({
      path: canonical,
      name: basename(canonical),
      relativePath: rel?.split(sep).join("/"),
    });
  };
  if (mode === "files") {
    for (const path of paths) {
      if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
        throw new Error("无效文件路径。");
      add(path);
    }
    return files;
  }
  const selected = resolve(paths[0]!);
  const info = lstatSync(selected);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("请选择普通文件夹。");
  const root = realpathSync(selected);
  const directories: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  let visited = 0;
  const walk = (directory: string, depth: number) => {
    assertCurrent();
    if (depth > 12) throw new Error("文件夹层级超过 12 层，请选择更小的文件夹。");
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory)
      throw new Error("文件夹发生变化，请重新选择。");
    directories.push({ path: directory, dev: before.dev, ino: before.ino });
    const handle = opendirSync(directory);
    try {
      for (let item = handle.readSync(); item; item = handle.readSync()) {
        if (++visited > 2_000) throw new Error("文件夹条目超过 2000 个，请选择更小的文件夹。");
        if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
        if (item.isDirectory()) walk(join(directory, item.name), depth + 1);
        else if (item.isFile()) add(join(directory, item.name), root);
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(root, 0);
  return {
    files,
    assertDirectories: () => {
      for (const directory of directories) {
        const current = lstatSync(directory.path, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== directory.dev ||
          current.ino !== directory.ino ||
          realpathSync(directory.path) !== directory.path
        )
          throw new Error("文件夹发生变化，请重新选择。");
      }
    },
  };
}

export function createSourceCollectionService(deps: CollectionServiceDeps): SourceCollectionApi {
  const assertCurrent = () => {
    deps.signal?.throwIfAborted();
    deps.assertCurrent();
  };
  const view = async (definition: SourceDefinition): Promise<SourceCollectionView> => {
    assertCurrent();
    const config = collectionConfig(definition);
    const references = await deps.references(definition.id);
    assertCurrent();
    // Never deliver a view assembled across two catalog revisions.
    requireCollection(definition.id, config.revision);
    return {
      definition,
      revision: config.revision,
      entries: config.entries.map((entry) => ({ entry, status: localStatus(entry) })),
      references,
    };
  };
  const save = (definition: SourceDefinition, revision: string, entries?: CollectionEntry[]) => {
    assertCurrent();
    requireCollection(definition.id, revision);
    const config = collectionConfig(definition);
    const next = {
      ...definition,
      adapterConfig: { ...config, revision: randomUUID(), entries: entries ?? config.entries },
    };
    saveSourceDefinition(next, { expectedCollectionRevision: revision });
    return next;
  };
  const urlEntry = async (url: string, id: string): Promise<CollectionEntry> => {
    const normalized = normalizeCollectionUrl(url);
    const { proof } = await downloadCollectionUrl(
      { url: normalized },
      { signal: deps.signal, assertAuthorized: assertCurrent },
    );
    assertCurrent();
    let name: string;
    try {
      name = decodeURIComponent(new URL(normalized).pathname.split("/").pop() || "document.txt");
    } catch {
      throw new Error("链接文件名无效。");
    }
    return {
      id,
      kind: "url",
      name,
      url: normalized,
      sizeBytes: proof.sizeBytes,
      sha256: proof.sha256,
      checkedAt: new Date().toISOString(),
    };
  };
  return {
    async create(input) {
      assertCurrent();
      const definition = SourceDefinitionSchema.parse({
        id: `collection_${randomUUID()}`,
        kind: "collection",
        label: input.label.trim(),
        description: input.description?.trim(),
        enabled: true,
        adapterConfig: { version: 1, revision: randomUUID(), entries: [] },
      });
      saveSourceDefinition(definition, { expectedCollectionRevision: null });
      return view(definition);
    },
    async get(id) {
      assertCurrent();
      return view(requireCollection(id));
    },
    async pick(id, revision, mode) {
      assertCurrent();
      if (mode !== "files" && mode !== "folder") throw new Error("无效选择类型。");
      const definition = requireCollection(id, revision);
      const paths = await deps.pick(mode);
      assertCurrent();
      requireCollection(id, revision);
      if (!paths || paths.length === 0) return null;
      const picked = pickedFiles(paths, mode, assertCurrent);
      const files = Array.isArray(picked) ? picked : picked.files;
      const entries = [...collectionConfig(definition).entries];
      for (const file of files) {
        assertCurrent();
        const index = entries.findIndex(
          (entry) => entry.kind === "local" && entry.path === file.path,
        );
        const entry = captureCollectionLocalFile(
          file.path,
          entries[index]?.id ?? `entry_${randomUUID()}`,
          file.name,
          {
            signal: deps.signal,
            assertAuthorized: () => {
              assertCurrent();
              if (realpathSync(file.path) !== file.path)
                throw new Error("文件路径发生变化，请重新选择。");
            },
          },
        );
        if (file.relativePath) entry.relativePath = file.relativePath;
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
      if (!Array.isArray(picked)) picked.assertDirectories();
      return view(save(definition, revision, entries));
    },
    async update(id, revision, change: SourceCollectionChange) {
      assertCurrent();
      const definition = requireCollection(id, revision);
      const entries = [...collectionConfig(definition).entries];
      if (change.kind === "metadata") {
        const updated = SourceDefinitionSchema.parse({
          ...definition,
          label: change.label.trim(),
          description: change.description?.trim(),
          enabled: change.enabled,
        });
        return view(save(updated, revision));
      }
      if (change.kind === "url") {
        const url = normalizeCollectionUrl(change.url);
        const index = entries.findIndex((entry) => entry.kind === "url" && entry.url === url);
        const entry = await urlEntry(url, entries[index]?.id ?? `entry_${randomUUID()}`);
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      } else {
        const index = entries.findIndex((entry) => entry.id === change.entryId);
        if (index < 0) throw new Error("文件条目不存在，请刷新。");
        if (change.kind === "remove") entries.splice(index, 1);
        else if (change.kind === "refresh") {
          const old = entries[index]!;
          entries[index] =
            old.kind === "local"
              ? {
                  ...captureCollectionLocalFile(old.path, old.id, old.name, {
                    signal: deps.signal,
                    assertAuthorized: () => {
                      assertCurrent();
                      if (realpathSync(old.path) !== old.path)
                        throw new Error("文件位置发生变化，请重新选择原文件。");
                    },
                  }),
                  ...(old.relativePath ? { relativePath: old.relativePath } : {}),
                }
              : await urlEntry(old.url, old.id);
        } else throw new Error("无效资料集操作。");
      }
      return view(save(definition, revision, entries));
    },
    async delete(id, revision) {
      assertCurrent();
      requireCollection(id, revision);
      deleteSourceDefinition(id, { expectedCollectionRevision: revision });
    },
  };
}
