import { describe, expect, test } from "bun:test";
import {
  buildMessageWithLocalFilePaths,
  localFileBasename,
  MAX_LOCAL_FILE_PATHS,
  normalizeLocalFilePaths,
} from "./localFilePaths";

describe("local file path references", () => {
  test("keeps unique absolute paths within a bounded list", () => {
    expect(
      normalizeLocalFilePaths([
        "/Users/maki/report.pdf",
        "/Users/maki/report.pdf",
        "relative/report.pdf",
        "C:\\Users\\maki\\report.pdf",
        "bad\npath.pdf",
        ...Array.from({ length: 20 }, (_, index) => `/tmp/file-${index}.pdf`),
      ]),
    ).toEqual([
      "/Users/maki/report.pdf",
      "C:\\Users\\maki\\report.pdf",
      ...Array.from({ length: MAX_LOCAL_FILE_PATHS - 2 }, (_, index) => `/tmp/file-${index}.pdf`),
    ]);
  });

  test("builds an exact file-only path block", () => {
    expect(
      buildMessageWithLocalFilePaths(
        "",
        ["/Users/maki/My PDFs/quarterly report.pdf"],
        "Local file paths",
      ),
    ).toBe('Local file paths:\n- "/Users/maki/My PDFs/quarterly report.pdf"');
  });

  test("gets a readable name from POSIX and Windows paths", () => {
    expect(localFileBasename("/tmp/spec.pdf")).toBe("spec.pdf");
    expect(localFileBasename("C:\\docs\\spec.pdf")).toBe("spec.pdf");
  });
});
