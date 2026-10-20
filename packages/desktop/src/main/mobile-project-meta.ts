import type { MobileProjectMeta } from "@cjhyy/code-shell-server/mobile-remote";
import type { LocalProject } from "./project-store.js";

export function toMobileProjectMeta(project: LocalProject): MobileProjectMeta {
  const primary = project.roots.find((root) => root.id === project.primaryRootId);
  if (!primary) throw new Error("project primary root is missing");
  return {
    id: project.id,
    path: primary.path,
    name: project.displayName ?? project.name,
    addedAt: project.createdAt,
    pinned: project.pinned,
    // Keep the Host canonicalKey policy; the paired browser may run on another OS.
    pathCaseSensitive: process.platform !== "darwin" && process.platform !== "win32",
    primaryRootId: project.primaryRootId,
    roots: project.roots.map((root) => ({
      id: root.id,
      path: root.path,
      name: root.name,
      role: root.id === project.primaryRootId ? "primary" : "secondary",
    })),
  };
}
