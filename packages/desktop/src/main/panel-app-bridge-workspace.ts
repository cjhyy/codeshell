/**
 * Workspace file capabilities (`workspace.*`) for Panel Apps: metadata, listing,
 * bounded UTF-8 reads, open/reveal, and the request validation for text/PDF
 * writes. Every path is a safe relative path resolved segment-by-segment under
 * the trusted workspace root without following symbolic links. The guarded
 * atomic write itself (`writeWorkspaceFile`) stays on PanelAppBridge.
 */
import { shell } from "electron";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";
import {
  DENIED_WORKSPACE_SEGMENTS,
  MAX_WORKSPACE_LIST_ENTRIES,
  MAX_WORKSPACE_PDF_BYTES,
  MAX_WORKSPACE_READ_BYTES,
  MAX_WORKSPACE_WRITE_BYTES,
  WORKSPACE_TEXT_EXTENSIONS,
  workspaceRevision,
} from "./panel-app-bridge-support.js";

/** Read-only workspace metadata. Git branch is best-effort via .git/HEAD (no exec). */
export async function panelWorkspaceInfo(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
): Promise<unknown> {
  const cwd = binding.cwd;
  if (!cwd) return { name: null, root: null, trusted: false, gitBranch: null };
  let gitBranch: string | null = null;
  try {
    const root = await realpath(cwd);
    const gitPath = join(root, ".git");
    const gitMetadata = await lstat(gitPath);
    if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
      throw new Error("git metadata is not a regular directory");
    }
    const canonicalGitPath = await realpath(gitPath);
    if (!bridge.isWithinWorkspace(root, canonicalGitPath)) {
      throw new Error("git metadata escapes the workspace");
    }
    const headPath = join(canonicalGitPath, "HEAD");
    const headMetadata = await lstat(headPath);
    if (headMetadata.isSymbolicLink() || !headMetadata.isFile() || headMetadata.size > 4 * 1024) {
      throw new Error("git HEAD is unavailable");
    }
    const handle = await open(headPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let head: string;
    try {
      const { buffer } = await bridge.readBoundedWorkspaceFile(handle, 4 * 1024);
      head = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } finally {
      await handle.close();
    }
    const match = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
    const candidate = match?.[1];
    gitBranch =
      candidate && candidate.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(candidate)
        ? candidate
        : null;
  } catch {
    // Non-Git workspaces intentionally report no branch.
  }
  return {
    name: basename(cwd),
    root: cwd,
    trusted: bridge.options.isWorkspaceTrusted(cwd),
    gitBranch,
  };
}

function workspaceRelativePath(params: unknown, allowRoot = false): string {
  const rawPath = (params as { path?: unknown } | null)?.path;
  if (allowRoot && (rawPath === undefined || rawPath === "" || rawPath === ".")) return ".";
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.length > 512 ||
    isAbsolute(rawPath) ||
    rawPath.includes(":") ||
    rawPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(rawPath)
  ) {
    throw new Error("workspace path must be a safe relative path");
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => !isAllowedWorkspaceSegment(segment))) {
    throw new Error("workspace path must be a safe relative path");
  }
  return segments.join("/");
}

function isAllowedWorkspaceSegment(segment: string): boolean {
  const windowsBaseName = (segment.split(".", 1)[0] ?? "").trimEnd().toUpperCase();
  const windowsDeviceName = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsBaseName);
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    !DENIED_WORKSPACE_SEGMENTS.has(segment.toLowerCase()) &&
    !segment.includes(":") &&
    !segment.includes("\\") &&
    !/[. ]$/u.test(segment) &&
    !windowsDeviceName &&
    !/[\u0000-\u001f\u007f]/u.test(segment)
  );
}

function requireWorkspaceFileExtension(relativePath: string): void {
  if (!WORKSPACE_TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    throw new Error("workspace file type is not allowed");
  }
}

async function resolveExistingWorkspacePath(
  bridge: PanelAppBridgeInternals,
  root: string,
  relativePath: string,
): Promise<string> {
  if (relativePath === ".") return root;
  let current = root;
  for (const segment of relativePath.split("/")) {
    const candidate = join(current, segment);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error("workspace path contains an unsafe symbolic link");
    }
    const canonical = await realpath(candidate);
    if (!bridge.isWithinWorkspace(root, canonical)) {
      throw new Error("workspace path escapes the root");
    }
    current = canonical;
  }
  return current;
}

export async function panelWorkspaceList(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const relativePath = workspaceRelativePath(params, true);
  const root = await bridge.trustedWorkspaceRoot(binding);
  let directory: string;
  try {
    directory = await resolveExistingWorkspacePath(bridge, root, relativePath);
    if (
      !bridge.isWithinWorkspace(root, directory, true) ||
      !(await stat(directory)).isDirectory()
    ) {
      throw new Error("workspace directory is unavailable");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relativePath, entries: [], truncated: false };
    }
    throw error;
  }
  const entries: Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
    size?: number;
    modifiedAt?: number;
  }> = [];
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        isAllowedWorkspaceSegment(entry.name) &&
        !entry.isSymbolicLink() &&
        (entry.isDirectory() ||
          (entry.isFile() && WORKSPACE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))),
    )
    .filter((entry) => {
      const childRelative = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
      return childRelative.length <= 512;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of candidates.slice(0, MAX_WORKSPACE_LIST_ENTRIES)) {
    const childRelative = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
    let metadata: Stats;
    try {
      metadata = await lstat(join(directory, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      entries.push({ name: entry.name, path: childRelative, kind: "directory" });
      continue;
    }
    if (!metadata.isFile()) continue;
    entries.push({
      name: entry.name,
      path: childRelative,
      kind: "file",
      size: metadata.size,
      modifiedAt: metadata.mtimeMs,
    });
  }
  return {
    path: relativePath,
    entries,
    truncated: candidates.length > MAX_WORKSPACE_LIST_ENTRIES,
  };
}

export async function panelWorkspaceReadText(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const relativePath = workspaceRelativePath(params);
  requireWorkspaceFileExtension(relativePath);
  const root = await bridge.trustedWorkspaceRoot(binding);
  const target = await resolveExistingWorkspacePath(bridge, root, relativePath);
  if (!bridge.isWithinWorkspace(root, target)) throw new Error("workspace path escapes the root");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { buffer, metadata } = await bridge.readBoundedWorkspaceFile(handle);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      throw new Error("workspace file is not valid UTF-8 text", { cause: error });
    }
    return {
      path: relativePath,
      content,
      size: buffer.length,
      modifiedAt: metadata.mtimeMs,
      revision: workspaceRevision(buffer),
    };
  } finally {
    await handle.close();
  }
}

async function resolveWorkspaceFileForShell(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
): Promise<string> {
  const relativePath = workspaceRelativePath(params);
  const root = await bridge.trustedWorkspaceRoot(binding);
  const target = await resolveExistingWorkspacePath(bridge, root, relativePath);
  if (!bridge.isWithinWorkspace(root, target)) throw new Error("workspace path escapes the root");
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("workspace path is not a file");
  }
  return target;
}

export async function panelWorkspaceOpenPath(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<boolean> {
  const target = await resolveWorkspaceFileForShell(bridge, binding, params);
  const error = await shell.openPath(target);
  if (error) throw new Error(`failed to open workspace file: ${error}`);
  return true;
}

export async function panelWorkspaceRevealPath(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<boolean> {
  const target = await resolveWorkspaceFileForShell(bridge, binding, params);
  shell.showItemInFolder(target);
  return true;
}

export async function panelWorkspaceWriteText(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const relativePath = workspaceRelativePath(params);
  requireWorkspaceFileExtension(relativePath);
  const content = (params as { content?: unknown } | null)?.content;
  const expectedModifiedAt = (params as { expectedModifiedAt?: unknown } | null)
    ?.expectedModifiedAt;
  const expectedRevision = (params as { expectedRevision?: unknown } | null)?.expectedRevision;
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf-8") > MAX_WORKSPACE_WRITE_BYTES
  ) {
    throw new Error(`workspace text must be at most ${MAX_WORKSPACE_WRITE_BYTES} bytes`);
  }
  if (
    expectedModifiedAt !== undefined &&
    expectedModifiedAt !== null &&
    (typeof expectedModifiedAt !== "number" || !Number.isFinite(expectedModifiedAt))
  ) {
    throw new Error("expectedModifiedAt must be a number, null, or omitted");
  }
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedRevision))
  ) {
    throw new Error("expectedRevision must be a sha256 revision or omitted");
  }
  if (expectedModifiedAt === undefined && expectedRevision === undefined) {
    throw new Error(
      "workspace.writeText requires expectedModifiedAt or expectedRevision to prevent blind overwrites",
    );
  }
  return bridge.writeWorkspaceFile(
    binding,
    relativePath,
    Buffer.from(content, "utf-8"),
    expectedModifiedAt,
    expectedRevision,
    MAX_WORKSPACE_READ_BYTES,
  );
}

export async function panelWorkspaceExportPdf(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const relativePath = workspaceRelativePath(params);
  if (extname(relativePath).toLowerCase() !== ".pdf") {
    throw new Error("workspace.exportPdf requires a .pdf path");
  }
  const expectedModifiedAt = (params as { expectedModifiedAt?: unknown } | null)
    ?.expectedModifiedAt;
  const expectedRevision = (params as { expectedRevision?: unknown } | null)?.expectedRevision;
  if (
    expectedModifiedAt !== undefined &&
    expectedModifiedAt !== null &&
    (typeof expectedModifiedAt !== "number" || !Number.isFinite(expectedModifiedAt))
  ) {
    throw new Error("expectedModifiedAt must be a number, null, or omitted");
  }
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedRevision))
  ) {
    throw new Error("expectedRevision must be a sha256 revision or omitted");
  }
  if (expectedModifiedAt === undefined && expectedRevision === undefined) {
    throw new Error(
      "workspace.exportPdf requires expectedModifiedAt or expectedRevision to prevent blind overwrites",
    );
  }
  if (binding.guest.isDestroyed()) throw new Error("Panel App is no longer available");
  const pdf = await binding.guest.printToPDF({
    pageSize: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  });
  if (
    pdf.length < 8 ||
    pdf.length > MAX_WORKSPACE_PDF_BYTES ||
    pdf.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error(`exported PDF must be between 8 and ${MAX_WORKSPACE_PDF_BYTES} bytes`);
  }
  return bridge.writeWorkspaceFile(
    binding,
    relativePath,
    pdf,
    expectedModifiedAt,
    expectedRevision,
    MAX_WORKSPACE_PDF_BYTES,
  );
}
