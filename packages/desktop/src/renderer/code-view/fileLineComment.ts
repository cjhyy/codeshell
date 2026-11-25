import { addAnchor } from "../chat/addAnchor";
import { nativeBasename } from "../nativePath";

/** Platform-aware display name, so `a\b.ts` is one name on POSIX. */
export function fileDisplayName(path: string): string {
  return nativeBasename(path, window.codeshell?.platform);
}

/** Pin a comment on one line of a file into the composer (`name:line`). */
export function addFileLineComment(path: string, line: number, code: string, comment: string) {
  const name = fileDisplayName(path);
  addAnchor({
    kind: "file",
    label: `${name}:${line}`,
    locator: { 文件: path, 行号: String(line), 代码: code.trim().slice(0, 200) },
    comment,
  });
}
