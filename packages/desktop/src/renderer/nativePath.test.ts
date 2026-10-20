import { describe, expect, test } from "bun:test";
import { nativeBasename, nativeDirname } from "./nativePath";

describe("native file display paths", () => {
  test.each([
    ["C:\\owned\\repo\\报告 alpha.txt", "报告 alpha.txt", "C:\\owned\\repo"],
    ["C:/owned/repo/alpha.txt", "alpha.txt", "C:/owned/repo"],
    ["C:\\owned/repo\\alpha.txt", "alpha.txt", "C:\\owned/repo"],
    ["\\\\owned-server\\share\\alpha.txt", "alpha.txt", "\\\\owned-server\\share"],
    ["//owned-server/share/alpha.txt", "alpha.txt", "//owned-server/share"],
    ["C:\\alpha.txt", "alpha.txt", "C:\\"],
    ["C:/alpha.txt", "alpha.txt", "C:/"],
    ["C:alpha.txt", "alpha.txt", "C:"],
    ["relative\\ 报告.txt ", " 报告.txt ", "relative"],
    ["alpha.txt", "alpha.txt", "."],
  ])("displays Windows path %s without rewriting its parent", (path, basename, dirname) => {
    expect(nativeBasename(path, "win32")).toBe(basename);
    expect(nativeDirname(path, "win32")).toBe(dirname);
  });

  test.each(["darwin", "linux", undefined])(
    "preserves literal POSIX backslashes and filename whitespace on %s",
    (platform) => {
      expect(nativeBasename("/owned/ 报告\\part.txt ", platform)).toBe(" 报告\\part.txt ");
      expect(nativeDirname("/owned/ 报告\\part.txt ", platform)).toBe("/owned");
      expect(nativeBasename("C:\\report.txt", platform)).toBe("C:\\report.txt");
      expect(nativeDirname("C:\\report.txt", platform)).toBe(".");
      expect(nativeDirname("/README.md", platform)).toBe("/");
    },
  );

  test("keeps native filesystem roots and strips only trailing separators", () => {
    expect(nativeDirname("C:\\", "win32")).toBe("C:\\");
    expect(nativeDirname("\\\\server\\share", "win32")).toBe("\\\\server\\share");
    expect(nativeDirname("/", "linux")).toBe("/");
    expect(nativeBasename("/owned/ folder /", "linux")).toBe(" folder ");
    expect(nativeBasename("C:\\owned\\ folder \\", "win32")).toBe(" folder ");
    expect(nativeBasename("", "linux")).toBe("");
    expect(nativeDirname("", "linux")).toBe(".");
  });
});
