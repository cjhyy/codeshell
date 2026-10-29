import { extname, resolve, sep } from "node:path";

/**
 * Directory of the built mobile web app (out/mobile, sibling of the bundled
 * out/main) served by the remote host.
 *
 * A packaged main runs from inside `app.asar`, but the mobile app must be read
 * from real files: Electron's ASAR stat reports a synthetic identity (a fresh
 * inode per call), so streamStaticFile's pinned-handle revalidation can never
 * match an archived file and every page answered 404. Packaging unpacks
 * out/mobile (`asarUnpack`), and this maps the archive segment to its
 * `.unpacked` sibling so no ASAR emulation is involved in serving it.
 */
export function resolveMobileStaticRoot(mainDir: string): string {
  const root = resolve(mainDir, "../mobile");
  const segments = root.split(sep);
  const archive = segments.findIndex((segment) => extname(segment) === ".asar");
  if (archive === -1) return root;
  segments[archive] = `${segments[archive]}.unpacked`;
  return segments.join(sep);
}
