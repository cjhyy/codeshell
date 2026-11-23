import { win32 } from "node:path";

// The ConPTY output worker and console-list agent need filenames on disk.
// node-pty only rewrites VS Code's node_modules.asar, not Electron's app.asar.
export function ptyEntryPath(entry, resources, platform = process.platform) {
  if (platform !== "win32" || !resources) return entry;
  const rel = win32.relative(win32.join(resources, "app.asar"), entry);
  if (rel === ".." || rel.startsWith("..\\") || win32.isAbsolute(rel)) return entry;
  return win32.join(resources, "app.asar.unpacked", rel);
}
